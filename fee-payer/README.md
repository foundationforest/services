# fee payer

Part of Forest's services: [the top README](../README.md).

The fee payer pays the chain's fees for a person's transaction, so the person needs no coin, and
charges them what that cost in the dollar they pay with.

Forest is one seed and its profiles, verified once, with offers and reviews in public that indexes
rank; the deals behind them are paid directly, between people. The fee payer serves the paying: it
lets a person who holds dollars and no SOL open an escrow, pay into it and settle it. This is one
copy, which the Open Forest Foundation runs; anyone can run another, and an app can use any fee
payer or none. It keeps nothing of the person's: it holds no key of theirs, it signs only as the
transaction's payer, and the money in an escrow moves only as the escrow allows
([the standard's escrow](https://github.com/foundationforest/standard/blob/0facafe182ab3768cd2a7177a38c01caf51e0d4a/escrows/solana/README.md)).

**Where it stands:** the chain the escrow runs on today is Solana's devnet, so this fee payer runs
there, paid in two test dollars, at https://fee-payer.forest.foundation.

## How it works

### Kora, configured

The fee payer is one address, and behind it one copy of
[Kora](https://github.com/solana-foundation/kora) 2.0.5, the Solana Foundation's open fee payer,
configured and nothing else: `kora.toml`. Nothing of ours runs inside it or in front of it. Kora
answers its own JSON-RPC at `/` (POST) and `GET /liveness`. It co-signs any transaction `kora.toml`
allows, pays the network fee and any deposit, and charges the person what that cost it, in the
dollar they pay with.

Anyone can pay a transaction's fees: whoever signs as its payer pays them, and the escrow cares
nothing for who that is. The main way, for a person who holds dollars and no SOL, is a fee payer
like this one. Anyone can run another; the main way is Kora's published image with this
`kora.toml`.

### Paying at cost

The person's device:

1. builds the transaction with the fee payer as payer, plus one plain dollar transfer to the fee
   payer whose amount it fills in next;
2. asks Kora the price of exactly that transaction, in that dollar (`estimateTransactionFee`);
3. sets the transfer to that price, and signs with the person's key;
4. hands it to Kora (`signAndSendTransaction`).

Kora simulates it, reads every program call inside it, checks it against `kora.toml`, checks the
transfer covers the price, adds its signature and sends it. The transfer is in the transaction when
the device asks the price, because the network fee is per signature and the transfer brings the
person's.

**The price** is the network fee plus every account the fee payer funds, counted from the
simulation, including the ones a program creates inside its own call: opening an escrow funds the
escrow's account, made inside `create`, and its deposit address. One unit short is refused, and
nothing lands.

The escrow's client makes the deposit address at the top of every transaction that pays into an
escrow, before `create`, so a fee payer that checks each transfer's destination before it signs
finds it made.

### What kora.toml allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the escrow, SPL Token, Token-2022, Associated Token Account, System, Memo | Kora checks every program a transaction calls, inner calls included. Memo moves no money: an app may add a memo to a payment, and nothing reads it |
| No compute budget program | | So no priority fee: the fee payer never pays one it did not agree to |
| `max_allowed_lamports` | 0.01 SOL | The most deposits one transaction may take; the largest, a one tap that also makes the recipient's token account, takes 5,354,320 lamports at 5,080 a byte |
| `max_signatures` | 3 | The fee payer, and the payer and the recipient when both sign a split (`agree`), the way out of a stop with no arbiter |
| `price` | margin 0 | The charge is the cost |
| `price_source` | `Jupiter` (needs `JUPITER_API_KEY`) | For real dollars; `deploy/devnet-config.sh` sets Kora's mock for the test dollars |
| `rate_limit` | 100 a second, across all callers | Kora's own limiter, at Kora's example value |
| `payment_address` | unset | Payments go to token accounts the fee payer's own key owns |
| What its own key may do | create an account, and nothing else | It may fund a new account it is paid for; no transfer, assign, allocate or nonce use, and no SPL Token or Token-2022 instruction as owner or authority |
| No API key or HMAC | | A page in a browser cannot keep a secret, and every transaction pays its way |

The escrow is `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`, as the standard records it
(`standard/escrows/solana/devnet/devnet.json`). The dollars it is paid in, in `kora.toml`, are real
ones, each its maker's own mint:

| Dollar | Mint | Program |
|---|---|---|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL Token |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | SPL Token |
| Open USD | `ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB` | Token-2022, eight extensions, no transfer fee |
| EURC | `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | SPL Token; a euro |

All four have six decimals and no transfer fee, so each quote holds. Kora's Jupiter price source
prices each against SOL, so the charge is the same SOL cost in whichever is paid, EURC at the
euro's rate. In Kora 2.0.5, `allowed_tokens` limits only Kora's own `transferTransaction` helper,
so an escrow in a dollar not on that list still goes through; the list of dollars the fee payer is
paid in is `allowed_spl_paid_tokens`.

`deploy/devnet-config.sh` prints `kora.toml` with exactly three lines changed, and stops if any is
not there exactly once: the two lists of dollars it is paid in (the two test dollars in place of
the four) and `price_source = "Mock"`. Kora's mock values a test dollar at 0.001 SOL a whole
dollar: one base unit buys one lamport.

Refused, each checked by the local run ([Run it](#run-it)), with nothing landing: a program not on
the list (`… is not in the allowed list`): the compute budget program; the fee payer's
SOL sent anywhere (`Fee payer cannot be used for 'System Transfer'`); the dollars it collected sent
anywhere (`… 'SPL Token Transfer'`); a payment one unit short of the price (`Insufficient …`).

### Rent

Every account on Solana holds a deposit, its rent, and gives it back when the account closes. The
fee payer fronts an escrow's two deposits, charges the person for them when the escrow opens, and
the escrow records it as the key that fronted the rent and sends every rent back to it
([the standard's escrow, Rent](https://github.com/foundationforest/standard/blob/0facafe182ab3768cd2a7177a38c01caf51e0d4a/escrows/solana/README.md#rent)):

- **The escrow's account,** 312 bytes (2,235,200 lamports at 5,080 a byte), stays as the receipt
  for good and keeps its rent; it comes back whole only if the escrow closes unfunded.
- **The deposit address,** 165 bytes for a classic dollar (1,488,440 lamports) or 179 for Open
  USD's extensions (1,559,560), comes back to the fee payer at every ending.
- **What a cut in Solana's rent frees** on the receipt goes to the fee payer, by `sweep_rent`,
  which anyone may send.

What comes back goes to the fee payer, which keeps it: the person was charged for the deposit
address when the escrow opened and does not get it back.

### Its key

`run.sh` makes the fee payer's key at its first start, if the file at `KEY_PATH` is absent: a fresh
ed25519 key, from no phrase, written in the Solana CLI's JSON form with mode 0600. It prints the
key's address once (`fee payer address …`) and never the key, then runs Kora with
`FOREST_FEE_PAYER_KEY` set to the file's path; `signers.toml` reads it from there. Every later
start finds the file and uses it. `run.sh` refuses a key path inside this repo. Before its first
transaction, the key needs SOL for the deposits it funds, and a token account for each dollar it is
paid in.

### Settings

`run.sh`:

| Variable | What |
|---|---|
| `KEY_PATH` | The key file. Default `/data/fee-payer-keypair.json`, on the volume |
| `RPC_URL` | The Solana RPC Kora simulates and sends through. Required. It must return inner instructions from `simulateTransaction` |
| `JUPITER_API_KEY` | For `price_source = "Jupiter"` |
| `PORT` | Default `8080` |
| `KORA_CONFIG` | Default `kora.toml`; the image sets `kora.devnet.toml`, which `deploy/devnet-config.sh` makes |
| `KORA_BIN` | Default `.kora/bin/kora` |
| `RUST_LOG` | Kora's log filter. Unset, Kora logs at `info`, which writes the body of every request: each transaction it is asked to price or sign. `warn` writes no request |

### Run it

```
./standard.sh                                        # from the repo root: the standard, installed and built
cd fee-payer && npm ci
npm run check                                        # CI: the local run's type-check
bash deploy/devnet-config.sh kora.toml > /dev/null   # CI: the image's kora.toml still comes out
./build.sh                                           # Kora 2.0.5 into .kora/ (Rust; 6 to 12 minutes)
(cd ../standard/escrows/solana/program && cargo build-sbf --arch v3)   # the escrow (Solana CLI 4.2.2)
npm run test:local                                   # the local run, about 20 seconds
RPC_URL=https://… JUPITER_API_KEY=… KEY_PATH=/outside/the/repo/fee-payer.json ./run.sh   # the fee payer alone, :8080
```

**The local run** (`test/fee-payer.test.ts`) starts a validator with the escrow at the id in its
source (as a local build has it) and a six-decimal test dollar planted at USDC's address, then Kora
through `run.sh` on an empty volume and a copy of `kora.toml` with exactly two lines changed: the
escrow's address to that id, and `price_source = "Mock"`. It checks that `run.sh` made the key
(mode 0600, its address printed once, the key never); that a person whose key never held a lamport
opens an escrow with a schedule and pays into it in one transaction, co-signed and charged in the
test dollar exactly what it cost the fee payer (one unit short refused first); and the refusals
above. Every balance is checked. It needs `solana-test-validator` (Solana CLI 4.2.2), the escrow
built, the standard built and `./build.sh`, and skips, saying which, if one is missing. Not in CI.

What it measured, at the local validator's 6,960 lamports a byte: opening and paying into an
escrow with a schedule is 691 bytes and about 36,000 to 41,000 compute units, varying with the keys'
address derivations; the fee payer spent a 10,000-lamport
network fee (two signatures), 3,062,400 for the escrow's account and 2,039,280 for its deposit
address, and charged 5,111,680 test-dollar units.

## How we run it

- **Kora,** 2.0.5, configured by `kora.toml`, with no code of ours inside it or in front of it. Its
  binary comes from Kora's own published image, `ghcr.io/solana-foundation/kora:v2.0.5`, pinned by
  digest, and the image build checks its version against `KORA`.
- **At cost:** the charge is the network fee and every deposit it puts down, at margin 0. It pays
  for no one: a transaction that pays less is refused.
- **The programs it pays for:** the escrow, SPL Token, Token-2022, Associated Token Account,
  System and Memo, and no others. Memo moves no money: an app may add a memo to a payment, and
  nothing reads it. No compute budget program, so no priority fee.
- **At most 0.01 SOL of deposits** in one transaction, and **at most three signatures.**
- **Paid in four dollars by `kora.toml`:** USDC, USDT, Open USD and EURC, each its maker's own
  mint, since people pay in what they hold. The makers' freeze and Open USD's permanent delegate (a
  key Open USD's maker holds, which can move or burn Open USD out of any account) are accepted.
  Where it stands, in two test dollars instead: the classic one,
  `537LFFpTfrbvopMQwi8wSTc767PsWjqwptNmBtUGj7bt`, and the one shaped like Open USD,
  `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz`.
- **Prices:** Jupiter's, for real dollars; for the test dollars, Kora's mock, one base unit a
  lamport.
- **What its key may do:** fund a new account it is paid for, and nothing else.
- **Its key:** one key of its own, random, made by `run.sh` at the first start and kept at
  `/data/fee-payer-keypair.json` on the volume, mode 0600. No phrase gives it, and no variable
  holds it.
- **The float:** the SOL in its key. Nothing refills it but a person sending it SOL. It is paid back
  in dollars; turning them back into SOL is done by hand, not by code.
- **The rate limit:** Kora signs at most 100 transactions a second, across all callers.
- **No API key for callers.** A page in a browser cannot keep a secret, and every transaction pays
  its way.
- **No request logs:** Kora runs at `RUST_LOG=warn`, which writes no request, since at its default
  level Kora logs every request's body, and nothing server-side should hold a person's
  transactions next to the hosting provider's record of their address. Kora still logs errors.
- **What it keeps:** its key, on the volume. Nothing else.
- **Where it runs:** Railway, service `fee payer`, built from `deploy/Dockerfile` on this repo's
  `main` (`RAILWAY_DOCKERFILE_PATH=fee-payer/deploy/Dockerfile`, build context the repo root), one
  replica, health check `GET /liveness`, a public domain to port 8080, and a volume at `/data`. Its
  variables: `RPC_URL`, Helius's RPC, whose URL holds a key (secret); `RUST_LOG=warn` and
  `PORT=8080`, as the image sets them.

## Promises

- **At cost, never above.** Each transaction is charged what it costs the fee payer: the network
  fee and every deposit it puts down, at margin 0, and nothing more.
- **It never moves its own money.** Kora signs no transaction that sends the fee payer's SOL or
  dollars anywhere; its key only funds a new account the same transaction pays it for.

## Limits

- **A deposit that comes back is not passed back.** The person is charged for an escrow's deposit
  address when it opens; when the escrow ends, that rent goes back to the fee payer, which keeps it
  ([Rent](#rent)). Over a whole deal, the fee payer ends up that rent ahead.
- **A one tap (an escrow opened, paid into and paid out in one transaction) in a Token-2022 dollar
  is refused** by Kora 2.0.5 ([FAQ](#faq)): two transactions instead. In a classic dollar it goes
  through.
- **The key lives only on the volume.** Lose the volume and the key is gone, with the SOL and
  dollars it holds; the next start makes a new key, at a new address.
- **What it collects sits under its key,** in the key's own token accounts; nothing moves it but
  someone holding the key file.
- **One container.** When Kora stops, the fee payer stops, until the hosting platform starts it
  again.
- **It takes EURC too,** a euro, on purpose: people pay in what they hold, and Jupiter prices it
  against SOL like the dollars, so the charge is the same SOL cost at the euro's rate.
- **The four real dollars and Jupiter's price have never run here.** No transaction has paid it in
  USDC, USDT, Open USD or EURC; Kora handles them as it handles the test dollars.
- **No priority fee,** so under congestion a transaction may land late.
- **It trusts its RPC's simulation** of each transaction, for what it calls and what it costs, and
  Jupiter's price for each dollar against SOL, with nothing for that price's error.
- **Each dollar's maker can freeze the fee payer's account in it,** and Open USD's maker holds a
  permanent delegate that can take back what the fee payer collected in it.
- **Address logs.** A hosting provider's own request logs are the operator's choice; on Railway
  they exist, with each request's client address and path.

## Who decides what

- **The standard:** nothing about the price. The escrow takes no fee and cares nothing for who
  pays; every rent goes back to whoever fronted it.
- **This fee payer, by its own choice:** which programs and transactions it pays for, which dollars
  it is paid in, its price source and its margin.
- **An app, with the person:** which fee payer to use, or none, and which dollar to pay in.

## FAQ

**Why Kora 2.0.5, configured only?**
No code of ours inside Kora. The 2.2 betas are not stable, and no longer read the key from a path,
which `FOREST_FEE_PAYER_KEY` gives it.

**Why does a one tap in Open USD fail through this fee payer?**
In a one tap (deposit address, `create`, the money in and `pay` in one transaction), the escrow's
payout to the recipient is a Token-2022 transfer out of the deposit address the same transaction
creates. Kora 2.0.5 (`kora-lib`, `src/token/token.rs`, `verify_token_payment`) runs its Token-2022
extension check on every transfer whose destination exists, which fetches the transfer's source by
RPC, before it checks whether the transfer pays Kora at all; the source is not on chain yet, so it
refuses with `Account … not found`. Opening and paying in, then paying out, in two transactions
passes; so does a one tap in a classic dollar. An app paying in Open USD through this fee payer
sends two transactions from one approval, the second once the first is confirmed.
