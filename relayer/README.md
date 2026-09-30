# feepayer

The fee payer co-signs a person's transaction as its payer and charges, in their dollar token,
exactly what that transaction costs it: the network fee plus every storage deposit it puts down.
So people never need SOL, and the fee payer pays for nobody. It is Kora 2.0.5, configured, with no
custom code. It holds none of the person's keys and decides nothing about the person, the market or
the deal.

**Nothing here is shipped.** It runs on devnet, on Railway, in front of both programs
(`docs/services.md`), and its tests run in front of a local validator. Nothing is on mainnet.

## What it does

The person's device:
1. builds the transaction with the fee payer as its payer;
2. asks Kora its price in the dollar token (`estimateTransactionFee`);
3. adds one plain token transfer of exactly that price to the fee payer;
4. signs with the person's own keys;
5. hands the transaction to Kora (`signAndSendTransaction`).

Kora then:
1. simulates the transaction and reads every program call inside it;
2. checks it against `kora.toml`;
3. checks the transfer covers the price;
4. adds its signature and sends it.

**The price** is:
- the network fee;
- plus every account the fee payer funds, including the ones a program makes inside the
  transaction;
- plus 50 lamports, Kora's fixed allowance for the payment instruction.

There is no margin: nothing inside Forest charges a fee except the registry's. Kora 2.0.5 finds the
deposits by simulating the transaction and counting every System `CreateAccount` the fee payer
funds, program calls included (`fee/fee.rs`, `calculate_fee_payer_outflow`).

**A registration** has three signing roles, in three account slots of `register`:
- **the payer** pays the network fee and the code account's storage deposit;
- **the fee authority** owns the token account the 25 cents come from;
- **the profile's wallet** consents, and the proof names it.

The fee payer is the payer. The profile's wallet pays the 25 cents and the fee payer's price, and
signs. The program refuses a registration the profile's wallet did not sign.

**Nothing it sees lets it take a badge.** It receives the profile-signed transaction before it
lands. It can refuse to co-sign, but it cannot land the proof under its own key: the proof would not
verify, and the person's code stays unused.

Anything paid on someone's behalf is an outside layer, never in the foundation. Whoever pays for
someone else is just another payer, and the programs cannot tell and never need to.

## Measured, on a local validator

`test/feepayer.test.ts`, below. A wallet that never held a lamport registers once, pays for two
escrows and closes a third that was never funded, all in a test dollar. Rent here is 6,960
lamports a byte, the validator's default.

| Transaction | Size | Units | Fee payer spent | Charged | Of which deposits |
|---|---|---|---|---|---|
| Registration | 839 bytes | 133,013 | 963,520 | 963,570 | code account 953,520 |
| Escrow, pay (deposit address, create, money in) | 661 | 32,676 | 4,777,600 | 4,777,650 | escrow 2,728,320, deposit address 2,039,280 |
| Escrow, release | 488 | 12,791 | 10,000 | 10,050 | none; the deposit address's 2,039,280 go back to the person |
| Escrow in one tap (all of the above in one) | 710 | 42,390 | 4,777,600 | 4,777,650 | the same two; the deposit address's comes back to the person in the same transaction |

All amounts are in lamports. Under Kora's mock price, one base unit of the test dollar buys one
lamport. The network fee was 10,000 lamports each time: two signatures, no priority fee.

At the rent rates `registry/README.md` uses for mainnet (5,080 lamports a byte today, 696 after the
cuts) and $100 a SOL:

| | Today | After the cuts |
|---|---|---|
| Registration: network fee + code account | $0.071 (plus the 0.25 registry fee) | $0.011 |
| Escrow, pay: network fee + both accounts | $0.35, of which $0.15 comes back at the end | $0.049, of which $0.020 comes back |
| Escrow, release | $0.001 | $0.001 |

## The deposit: charged once, and given back to the person

**Can Kora's price count the deposit?** Yes. The test shows it:
- The registration's charge is exactly the network fee plus the code account the registry program
  makes inside its own call, plus 50 lamports.
- A registration paying only the network fee is refused: "Insufficient token payment. Required
  963520 lamports". Nothing lands, and the code stays unused.
- The escrow's pay step is charged both accounts the escrow program makes.

The fee payer never pays for anyone.

**Every deposit that comes back comes back to the person, never to the fee payer.** The escrow
records its creator as the key its rent goes back to, whoever fronted it (`escrow/README.md`):

- **Pay, then release.** The person pays for the deposit address when the escrow is made. When it
  ends, the escrow closes the address and its rent goes to the person. The release is charged its
  network fee only.
- **One tap.** The deposit address is made and closed in the same transaction, and its rent goes to
  the person there. The charge is what the fee payer spent, plus 50 lamports.
- **The receipt.** The escrow account stays forever as the deal's receipt, with its rent. As Solana
  cuts rent, anyone may sweep what it holds above the new minimum, and it goes to the person.
- **Never funded.** Closing an escrow that never held the amount sends both rents to the person.
- **The registration.** A code account never closes. Its rent above the minimum sweeps to the
  treasury (the registry's open item, not this one's).

In the local run the person got 9,846,160 lamports back (three deposit rents, one escrow rent and a
swept tip) and the fee payer none. They arrive as SOL in a wallet that otherwise holds none; what
an app does with them is open (`docs/handoff.md`, Open).

## What it refuses

Tested, each with nothing landing and nothing moving:

| Attempt | Kora's answer |
|---|---|
| A program not on the list (Memo) | `Program MemoSq4g… is not in the allowed list` |
| A priority fee (the compute budget program is not on the list) | `Program ComputeBudget111… is not in the allowed list` |
| The fee payer's SOL sent anywhere | `Fee payer cannot be used for 'System Transfer'` |
| The payment taken back out of the fee payer's token account, under the signature it adds | `Fee payer cannot be used for 'SPL Token Transfer'` |
| No payment | `Insufficient token payment. Required 10050 lamports` |
| A registration paying the network fee but not the deposit | `Insufficient token payment. Required 963520 lamports` |
| An escrow whose deposit address only the escrow program makes (below) | `Account 9HHg… not found` |

Also enforced by the config, not provoked here:
- more than 0.01 SOL of deposits in one transaction (`max_allowed_lamports`);
- more than three signatures;
- the fee payer's key used as the owner, authority or signer of any token instruction, or to
  assign or allocate its own account.

Kora checks the program list against every call inside the transaction, not only the top-level
ones.

### One thing a product must do for Kora: make the deposit address at the top

Kora 2.0.5 looks up the destination of every token transfer before it signs. It accepts one that
does not exist yet only when the same transaction creates it with a top-level associated-token-account
instruction (`token/token.rs`, `find_ata_creation_for_destination`). An account a program creates
inside its own call is invisible to it.

An escrow's "Pay" that leaves the deposit address to `create` (create, then a transfer into it) is
refused. Putting `CreateIdempotent` for the deposit address, paid by the fee payer, before `create`
fixes it:
- the escrow's `init_if_needed` finds the account made;
- Kora counts its rent;
- the transaction grows by about 10 bytes.

The escrow client does this in every builder that funds in the same transaction (`createAndFund`,
`payInOneTap`, with `makeDepositAddressIx`), and the test pays through them.

## Files

| | |
|---|---|
| `KORA` | the version pinned: `2.0.5`, the latest stable release |
| `build.sh` | `cargo install kora-cli --version 2.0.5 --locked` into `.kora/` |
| `kora.toml` | the rules: programs, the dollar token, the price, what the fee payer's key may do |
| `signers.toml` | the one key, read from `FOREST_FEEPAYER_KEY` |
| `run.sh` | starts Kora with both files; refuses a key file inside this repo |
| `test/feepayer.test.ts` | the local run |

`.kora/` and `node_modules/` are not committed.

## Build, run, test

```
cd feepayer && ./build.sh                  # Kora 2.0.5 into .kora/ (Rust; about 12 minutes here, sharing four cores)
cd feepayer && FOREST_FEEPAYER_KEY=/path/outside/repo/fee-payer.json \
               RPC_URL=https://<rpc> JUPITER_API_KEY=<key> ./run.sh      # :8080
cd feepayer && npm install && npm run test:local                          # the local run
```

**The local run** needs:
- `solana-test-validator` on the PATH (Solana CLI 4.2.2);
- both programs built (`cargo build-sbf` in `registry/program` and `escrow/program`);
- the registry's proving files (`npm run fetch` in `registry/artifacts`);
- both clients' dependencies (`npm ci` in `registry/client` and `escrow/client`);
- `./build.sh`.

If one is missing it says which and skips. About 20 seconds. What it does:

1. Starts a validator with both programs and a six-decimal test dollar planted at USDC's address,
   which is what the registry charges in and what `kora.toml` accepts.
2. Writes the fee payer's key to a file outside the repo and starts Kora through `run.sh`, on a copy
   of `kora.toml` with exactly one line changed: `price_source = "Mock"`. The mock prices any mint
   but two at 0.001 SOL a token.
3. Runs the refusals above, the registration, and the two escrows.
4. Checks every balance: the person's SOL (0 throughout), their tokens, the treasury's, and the fee
   payer's SOL and tokens.

**The key.** `FOREST_FEEPAYER_KEY` holds the path to a keypair file in the Solana CLI's JSON form,
outside this repo. Kora 2.0.5, built `--locked`, uses solana-keychain 0.1.0, which reads a path
first and otherwise takes the key itself, as that JSON array or as base58. Kora's `main` (2.2
betas) takes the key itself only, not a path.

## Environment variables

| | |
|---|---|
| `FOREST_FEEPAYER_KEY` | path to the fee payer's keypair file, outside this repo (or the key itself, where a host has no files) |
| `RPC_URL` | the Solana RPC Kora simulates and sends through (`run.sh` requires it) |
| `JUPITER_API_KEY` | Kora's price source on mainnet (`price_source = "Jupiter"`) |
| `PORT` | default 8080 |
| `KORA_CONFIG` | default `kora.toml` |

## What running it on Railway will need

`deploy/` does this on devnet (`deploy/README.md`).

- **A build:** a Dockerfile that runs `build.sh` (Rust, about 12 minutes on four cores), or Kora's
  own image at 2.0.5 (`ghcr.io/solana-foundation/kora`, not checked for that tag), plus
  `kora.toml`, `signers.toml` and `run.sh`.
- **The key as a variable.** Railway has no secret files. `FOREST_FEEPAYER_KEY` holds the key
  itself, as the JSON array, which 2.0.5 accepts. A volume holding a key file would also do. Either
  way it is a secret, never in the repo.
- **A mainnet RPC** that allows `simulateTransaction` with inner instructions (`RPC_URL`), and a
  Jupiter API key (`JUPITER_API_KEY`).
- **SOL on the fee payer's key** before the first transaction: enough for the deposits in flight.
  It is paid back in dollars, which someone must turn back into SOL: an operations loop, not code.
- **The fee payer's USDC account**, created once. `kora rpc initialize-atas` does it, or any
  transfer that makes it.
- **The port:** `PORT` from Railway, and a health check on `GET /liveness`.
- **Devnet** needs its own `kora.toml`: the devnet program ids from `devnet/devnet.json`, the devnet
  test dollar or devnet USDC, and `price_source = "Mock"`, since Jupiter prices mainnet only.

## Chosen, not decided

Where the handoff was silent the simplest option was taken. Each is reversible, since nothing is
deployed, and each is in `docs/changes.md`.

1. **Kora 2.0.5**, the latest stable release, not the 2.2 betas on `main`. The betas harden the fee
   payer against draining, change the price, and no longer read the key from a path.
2. **Margin 0.** The charge is the cost, plus Kora's fixed 50 lamports for the payment instruction.
3. **Paid to the fee payer's own token account** (`payment_address` unset). Kora refuses any token
   instruction that key owns, so what it is paid stays put until someone moves it with the key.
4. **`max_allowed_lamports` = 0.01 SOL of deposits per transaction**, about twice an escrow's.
5. **`max_signatures` = 3**, register's three roles.
6. **No compute budget program**, so no priority fee. A registration fits the default compute limit
   (133,013 of 200,000).
7. **No API key or HMAC.** A page in a browser cannot keep a secret, and every transaction pays its
   way. Kora's rate limit (100 a second, across all callers) stays.
8. **Kora's three warnings on `config validate` left as they are:**
   - no auth, as above;
   - `allow_create_account`, which is priced, capped and tested;
   - Token-2022's permanent delegate, which cannot arise, since the Token-2022 program is not on the
     list.

## What is not done

- **Mainnet.** Nothing deployed; on devnet Kora prices the test dollar with its mock, and Jupiter's
  price was not called.
- **Kora 2.2.** It hardens the fee payer against being drained and no longer reads the key from a
  path. It was read, not run.
- **Load, rate limits, several fee payer keys**, and the operations loop that turns collected
  dollars back into SOL.
