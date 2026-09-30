# relayer

The relayer co-signs a person's transaction as its payer and charges, in their dollar token, what it
spends: the network fee and every storage deposit it puts down. When Solana cuts its storage price,
part of a deposit it put down is freed, and the relayer keeps that refund. So people never need
SOL, and the relayer pays for nobody. It is Kora 2.0.5, configured, with no custom code. It holds
none of the person's keys and decides nothing about the person, the market or the deal.

In forest this was `feepayer/`, the fee payer, which forest's `main` no longer holds. Kora's own
names keep "fee payer": its `fee_payer_policy` settings and its messages.

**Nothing here is shipped.** Its tests run in front of a local validator. The devnet relayer on
Railway still runs the earlier configuration (`deploy/README.md`). Nothing is on mainnet.

## What it does

The person's device:
1. builds the transaction with the relayer as its payer, and one plain token transfer to the relayer
   whose amount it fills in next;
2. asks Kora the price of that transaction in the dollar token (`estimateTransactionFee`);
3. sets the transfer to exactly that price;
4. signs with the person's own keys;
5. hands the transaction to Kora (`signAndSendTransaction`).

Kora then:
1. simulates the transaction and reads every program call inside it;
2. checks it against `kora.toml`;
3. checks the transfer covers the price;
4. adds its signature and sends it.

**The price** is:
- the network fee, per signature, the person's included;
- plus every account the relayer funds, including the ones a program makes inside the
  transaction.

There is no margin: nothing inside Forest charges anything. Kora 2.0.5 finds the deposits by
simulating the transaction and counting every System `CreateAccount` the relayer funds, program
calls included (`fee/fee.rs`, `calculate_fee_payer_outflow`).

**The transfer must be in the transaction when the device asks the price.** Asked without it, Kora
adds a fixed 50 lamports for the payment it expects, and its price misses the signature the
transfer brings. A registry line has no other signature of the person's, so that price falls 5,000
lamports short and Kora refuses the transaction it quoted.

**A registry line.** The registry takes one signature, the payer's: the proof is the person's
consent, and it names their profile (`forest/registry/README.md`). The relayer is the payer. It pays
the network fee and the line's storage deposit and is recorded in the line as its payer. The person
signs only their payment to the relayer. There is no registration fee.

**Nothing it sees lets it take a badge.** It receives the transaction before it lands. It can refuse
to co-sign. It cannot make the proof count for another profile or another label: the proof names
both.

Anything paid on someone's behalf is an outside layer, never in the foundation. Whoever pays for
someone else is just another payer, and the programs cannot tell and never need to.

## Measured, on a local validator

`test/relayer.test.ts`, below. A wallet that never held a lamport writes a registry line, pays for
escrows under v1 and v2, and closes one v1 escrow that was never funded, all in a test dollar. Rent
here is 6,960 lamports a byte, the validator's default. The programs are built as SBPF v3.

| Transaction | Size | Units | Relayer spent | Charged | Of which deposits |
|---|---|---|---|---|---|
| Registry line, a 20-byte label | 702 bytes | 121,083 | 2,104,960 | 2,104,960 | line 2,094,960 |
| Escrow v1, pay (deposit address, create, money in) | 661 | 29,644 | 4,777,600 | 4,777,600 | escrow 2,728,320, deposit address 2,039,280 |
| Escrow v1, release | 488 | 12,768 | 10,000 | 10,000 | none; the deposit address's 2,039,280 go back to the person |
| Escrow v1 in one tap | 710 | 40,835 | 4,777,600 | 4,777,600 | the same two; the deposit address's comes back to the person in the same transaction |
| Escrow v2, pay | 661 | 35,958 | 5,062,960 | 5,062,960 | escrow 3,013,680, deposit address 2,039,280 |
| Escrow v2, release | 488 | 13,029 | 10,000 | 10,000 | none; the deposit address's go back to the person |
| Escrow v2 in one tap | 710 | 60,910 | 5,062,960 | 5,062,960 | the same two; the deposit address's comes back to the person |

All amounts are in lamports. Under Kora's mock price, one base unit of the test dollar buys one
lamport. The network fee was 10,000 lamports each time: two signatures, no priority fee. What each
costs at mainnet's rent, today and after the cuts, is in `forest/registry/README.md` and
`forest/escrow/v2/README.md`.

## Deposits: charged once; what comes back, and to whom

**Can Kora's price count the deposit?** Yes. The test shows it:
- A line's charge is exactly the network fee plus the line the registry program makes inside its
  own call.
- A line paying only the network fee is refused: "Insufficient token payment. Required 2104960
  lamports". Nothing lands.
- An escrow's pay step is charged both accounts the escrow program makes.

**What comes back.** The relayer charges what it spends; what comes back later goes where each
program sends it:

- **A deposit address**, under either escrow version: its rent goes back to the person, who
  created the escrow, at every ending. The person paid for it, and gets it back.
- **An escrow never funded**, closed: both rents go back to the person.
- **What Solana's storage price cuts free** on an account the relayer fronted goes back to the
  relayer, which keeps it:
  - a registry line: `refund` sends what a line holds above its minimum to the payer the line
    records, the relayer;
  - an escrow v2 receipt: `sweep_rent` sends it to the payer the escrow records, the relayer.
- **An escrow v1 receipt**: `sweep_rent` sends it to the person, who created the escrow. v1 records
  no payer.

Anyone may send `refund` or `sweep_rent`; they need no signature. The test stands in for a rent cut
with a gift of SOL to the account, which leaves it holding more than its minimum, as a cut would.
Here the person got 13,924,720 lamports back (five deposit addresses' rents, a never-funded
escrow's rent and a swept gift). The relayer got 2,000,000 back (a line's refund and a v2 sweep).
What the person gets back arrives as SOL in a wallet that otherwise holds none; what an app does
with it is open (`forest/docs/handoff.md`, Open).

## What it refuses

Tested, each with nothing landing and nothing moving:

| Attempt | Kora's answer |
|---|---|
| A program not on the list (Memo) | `Program MemoSq4g… is not in the allowed list` |
| A priority fee (the compute budget program is not on the list) | `Program ComputeBudget111… is not in the allowed list` |
| The relayer's SOL sent anywhere | `Fee payer cannot be used for 'System Transfer'` |
| The payment taken back out of the relayer's token account, under the signature it adds | `Fee payer cannot be used for 'SPL Token Transfer'` |
| No payment | `Insufficient token payment. Required 10050 lamports` |
| A line paying the network fee but not the deposit | `Insufficient token payment. Required 2104960 lamports` |
| A second issuer's root on a line (`add_proof`, below) | `Fee payer cannot be used for 'System Transfer'` |
| An escrow whose deposit address only the escrow program makes (below) | `Account BbCZ… not found` |

Also enforced by the config, not provoked here:
- more than 0.01 SOL of deposits in one transaction (`max_allowed_lamports`);
- more than three signatures;
- the relayer's key used as the owner, authority or signer of any token instruction, or to
  assign or allocate its own account.

Kora checks the program list against every call inside the transaction, not only the top-level
ones.

**`add_proof` does not pass.** It grows a line by 32 bytes, and the program pays for that with a
System transfer from the payer inside its own call. `kora.toml` lets the relayer's key create
accounts, never transfer SOL, so Kora refuses. A line through this relayer holds one issuer's root.
A second root needs another payer, or a change to the config: open.

### One thing a product must do for Kora: make the deposit address at the top

Kora 2.0.5 looks up the destination of every token transfer before it signs. It accepts one that
does not exist yet only when the same transaction creates it with a top-level associated-token-account
instruction (`token/token.rs`, `find_ata_creation_for_destination`). An account a program creates
inside its own call is invisible to it.

An escrow's "Pay" that leaves the deposit address to `create` (create, then a transfer into it) is
refused. Putting `CreateIdempotent` for the deposit address, paid by the relayer, before `create`
fixes it:
- the escrow's `init_if_needed` finds the account made;
- Kora counts its rent;
- the transaction grows by about 10 bytes.

Both escrow clients do this in every builder that funds in the same transaction (`createAndFund`,
`payInOneTap`, with `makeDepositAddressIx`), and the test pays through them.

## Files

| | |
|---|---|
| `KORA` | the version pinned: `2.0.5`, the latest stable release |
| `build.sh` | `cargo install kora-cli --version 2.0.5 --locked` into `.kora/` |
| `kora.toml` | the rules: programs, the dollar token, the price, what the relayer's key may do |
| `signers.toml` | the one key, read from `FOREST_RELAYER_KEY` |
| `run.sh` | starts Kora with both files; refuses a key file inside this repo |
| `test/relayer.test.ts` | the local run |
| `deploy/` | the foundation's devnet instance: its Dockerfile, the devnet `kora.toml`, Railway ([deploy/README.md](deploy/README.md)) |

`.kora/` and `node_modules/` are not committed.

## Build, run, test

```
cd relayer && ./build.sh                   # Kora 2.0.5 into .kora/ (Rust; about 6 to 12 minutes)
cd relayer && FOREST_RELAYER_KEY=/path/outside/repo/relayer.json \
              RPC_URL=https://<rpc> JUPITER_API_KEY=<key> ./run.sh       # :8080
./forest.sh registry/client escrow/client escrow/v2/client               # forest's three clients, from the repo root
cd relayer && npm ci && npm run check                                     # type-check the local run
cd relayer && npm run test:local                                          # the local run
```

**The local run** needs:
- `solana-test-validator` on the PATH (Solana CLI 4.2.2);
- the three programs built (`cargo build-sbf --arch v3` in `forest/registry/program`,
  `forest/escrow/program` and `forest/escrow/v2/program`);
- the registry's proving files (`npm run fetch` in `forest/registry/artifacts`);
- the three clients' dependencies (`./forest.sh registry/client escrow/client escrow/v2/client`);
- `./build.sh`.

If one is missing it says which and skips. About 30 seconds. What it does:

1. Starts a validator with the three programs and a six-decimal test dollar planted at USDC's
   address, the one token `kora.toml` accepts payment in.
2. Writes the relayer's key to a file outside the repo and starts Kora through `run.sh`, on a copy
   of `kora.toml` with exactly one line changed: `price_source = "Mock"`. The mock prices any mint
   but two at 0.001 SOL a token.
3. Runs the refusals above, the line, and the escrows.
4. Checks every balance: the person's SOL (0 until its own refunds come back), their tokens, and
   the relayer's SOL and tokens.

**The key.** `FOREST_RELAYER_KEY` holds the path to a keypair file in the Solana CLI's JSON form,
outside this repo. Kora 2.0.5, built `--locked`, uses solana-keychain 0.1.0, which reads a path
first and otherwise takes the key itself, as that JSON array or as base58. Kora's `main` (2.2
betas) takes the key itself only, not a path.

## Environment variables

| | |
|---|---|
| `FOREST_RELAYER_KEY` | path to the relayer's keypair file, outside this repo (or the key itself, where a host has no files) |
| `RPC_URL` | the Solana RPC Kora simulates and sends through (`run.sh` requires it) |
| `JUPITER_API_KEY` | Kora's price source on mainnet (`price_source = "Jupiter"`) |
| `PORT` | default 8080 |
| `KORA_CONFIG` | default `kora.toml` |

## What running it on Railway will need

`deploy/` does this on devnet (`deploy/README.md`).

- **A build:** a Dockerfile that runs `build.sh` (Rust, about 12 minutes on four cores), or Kora's
  own image at 2.0.5 (`ghcr.io/solana-foundation/kora`, not checked for that tag), plus
  `kora.toml`, `signers.toml` and `run.sh`.
- **The key as a variable.** Railway has no secret files. `FOREST_RELAYER_KEY` holds the key
  itself, as the JSON array, which 2.0.5 accepts. A volume holding a key file would also do. Either
  way it is a secret, never in the repo.
- **A mainnet RPC** that allows `simulateTransaction` with inner instructions (`RPC_URL`), and a
  Jupiter API key (`JUPITER_API_KEY`).
- **SOL on the relayer's key** before the first transaction: enough for the deposits in flight.
  It is paid back in dollars, which someone must turn back into SOL: an operations loop, not code.
- **The relayer's USDC account**, created once. `kora rpc initialize-atas` does it, or any
  transfer that makes it.
- **The port:** `PORT` from Railway, and a health check on `GET /liveness`.
- **Devnet** needs its own `kora.toml`: the three devnet program ids (`deploy/devnet-config.sh`
  names where each is recorded), the devnet test dollar or devnet USDC, and
  `price_source = "Mock"`, since Jupiter prices mainnet only.

## Chosen, not decided

Where the handoff was silent the simplest option was taken. Each is reversible, since nothing is
deployed, and each is in `forest/docs/changes.md` or this repo's `docs/changes.md`.

1. **Kora 2.0.5**, the latest stable release, not the 2.2 betas on `main`. The betas harden the fee
   payer against draining, change the price, and no longer read the key from a path.
2. **Margin 0.** The charge is the cost.
3. **Paid to the relayer's own token account** (`payment_address` unset). Kora refuses any token
   instruction that key owns, so what it is paid stays put until someone moves it with the key.
4. **`max_allowed_lamports` = 0.01 SOL of deposits per transaction**, about twice an escrow's.
5. **`max_signatures` = 3**: the relayer, and an escrow's two parties when both sign a split.
6. **No compute budget program**, so no priority fee. A registry line fits the default compute
   limit (121,083 of 200,000).
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
- **Kora 2.2.** It hardens the relayer against being drained and no longer reads the key from a
  path. It was read, not run.
- **Load, rate limits, several relayer keys**, and the operations loop that turns collected
  dollars back into SOL.
- **A second issuer's root through the relayer.** Kora refuses `add_proof` (above).
