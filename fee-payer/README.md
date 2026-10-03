# fee payer

The fee payer pays Solana's fee for a person's transaction, and the person pays it back, at cost, in
the dollar they hold.

Soil runs this one, on devnet, paid in two test dollars. Anyone can run another, from this
configuration or their own: whoever signs a transaction as payer pays for it, and the programs care
nothing for who that is. Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md).

It is [Kora](https://github.com/solana-foundation/kora) 2.0.5, configured, with no custom code. It
co-signs the transaction as its payer, pays the network fee and any storage deposit, and charges the
person exactly what that cost it, in the token they pay with. It holds none of the person's keys
and decides nothing about the person, the market or the deal.

## How it works

The person's device:

1. builds the transaction with the fee payer as payer, plus one plain token transfer to the fee
   payer whose amount it fills in next;
2. asks Kora the price of exactly that transaction, in that token (`estimateTransactionFee`);
3. sets the transfer to that price, and signs with the main key;
4. hands it to Kora (`signAndSendTransaction`).

Kora simulates it, reads every program call inside it, checks it against `kora.toml`, checks the
transfer covers the price, adds its signature and sends it.

**The price** is the network fee (per signature, the person's included) plus every account the
fee payer funds, counted from the simulation, including accounts a program creates inside its own
call. The transfer must already be in the transaction when the device asks: without it, Kora adds a
fixed 50 lamports for the payment it expects and misses that payment's signature, so the quote
falls 5,000 lamports short and Kora refuses the transaction it quoted.

**A registry row** takes two signatures: the fee payer's, which pays the network fee and the row's
deposit and is recorded in the row as its payer, and the main key's, which signs the row and the
payment. The proof names the profile and the label, so nothing the fee payer sees lets it take the
row.

### What it allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the registry and the escrow at their devnet addresses, SPL Token, Token-2022, Associated Token Account, System | Kora checks every program a transaction calls, inner calls included |
| No compute budget program | | So no priority fee: the fee payer never pays one it did not agree to |
| `max_allowed_lamports` | 0.01 SOL | Deposits per transaction; an escrow's creation takes about 0.0037 |
| `max_signatures` | 3 | The fee payer, and an escrow's two parties when both sign a split |
| `price` | margin 0 | The charge is the cost |
| `price_source` | `Jupiter` (needs `JUPITER_API_KEY`) | Jupiter prices mainnet only; devnet uses Kora's mock |
| `rate_limit` | 100 a second, across all callers | Kora's own limiter |
| `payment_address` | unset | Payments go to token accounts the fee payer's own key owns |
| `fee_payer_policy` | only `allow_create_account` | The fee payer's key may fund a new account it is paid for, and nothing else: no transfer, assign, allocate or nonce use, and no SPL Token or Token-2022 instruction as owner or authority |
| No API key or HMAC | | A page in a browser cannot keep a secret, and every transaction pays its way |

The programs: the registry `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC` and the escrow
`FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`, as forest records them on devnet. The tokens it is
paid in, in `kora.toml`, are mainnet's: **USDC, USDT, Open USD and EURC**, each its maker's own
mint. `deploy/devnet-config.sh` prints `kora.toml` with exactly three lines changed, and stops if
any is not there exactly once: the two paid-token lists (the two devnet test dollars in place of the
four mainnet tokens), and `price_source = "Mock"`. Kora's mock values the test dollars at 0.001 SOL
a whole token: one base unit buys one lamport.

| Token (mainnet) | Mint | Program |
|---|---|---|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL Token |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | SPL Token |
| Open USD | `ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB` | Token-2022, eight extensions, no transfer fee |
| EURC | `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | SPL Token; a euro |

All four have six decimals and no transfer fee, so each quote holds. Kora's Jupiter price source
prices each in dollars against SOL, so the charge is the same SOL cost in whichever is paid, EURC
at the euro's rate. In Kora 2.0.5, `allowed_tokens` gates only Kora's own `transferTransaction`
helper; an escrow in another token still passes. `allowed_spl_paid_tokens` is the list it is paid
in.

Refused, each tested with nothing landing: a program not on the list (`… is not in the allowed
list`); a priority fee; the fee payer's SOL sent anywhere (`Fee payer cannot be used for 'System
Transfer'`); the payment taken back out of the fee payer's account (`… 'SPL Token Transfer'`); no
payment, or one short of the deposits (`Insufficient token payment. Required … lamports`).

### What comes back, and to whom

The fee payer charges what it spends. What comes back later goes where each program sends it:

- **An escrow's deposit address:** its rent goes back to the person who created the escrow, at
  every ending.
- **An escrow never funded, closed:** both rents go back to the person.
- **What Solana's storage price cuts free** on an account the fee payer funded goes to the fee
  payer, which keeps it: a registry row's (`refund`, to the payer the row records) and an escrow
  receipt's (`sweep_rent`, to the payer it records).

Anyone may send `refund` or `sweep_rent`. A row never grows after `register`, so nothing a row needs
later asks the fee payer for SOL.

### Measured, on a local validator

`test/fee-payer.test.ts`, both programs built as SBPF v3, rent at the validator's default (6,960
lamports a byte), Kora's mock price (one base unit of the test dollar buys one lamport). All amounts
in lamports. Charged equals spent in every row; the network fee was 10,000 each time: two
signatures, no priority fee.

| Transaction | Size | Charged | Of which deposits |
|---|---|---|---|
| Registry row, a 20-byte label | 767 bytes | 2,466,880 | the row, 2,456,880 |
| Escrow, pay (deposit address, create, money in) | 663 | 5,062,960 | escrow 3,013,680, deposit address 2,039,280 |
| Escrow, release | 521 | 10,000 | none |
| Escrow, one tap | 713 | 5,062,960 | the same two |
| Escrow in Open USD, pay | 727 | 5,160,400 | escrow 3,013,680, deposit address 2,136,720 |
| Escrow in Open USD, release | 553 | 10,000 | none |

### Settings

| Variable | What |
|---|---|
| `FOREST_FEE_PAYER_KEY` | The fee payer's key: a path to a keypair file (the Solana CLI's JSON form) outside this repo, or, where a hosting platform has no files, the key itself, as that JSON array or base58. Kora 2.0.5 built `--locked` uses solana-keychain 0.1.0, which reads a path first and otherwise takes the key itself |
| `RPC_URL` | The Solana RPC Kora simulates and sends through. Required. It must return inner instructions from `simulateTransaction` |
| `JUPITER_API_KEY` | For `price_source = "Jupiter"` |
| `PORT` | Default `8080` |
| `KORA_CONFIG` | Default `kora.toml` |
| `KORA_BIN` | Default `.kora/bin/kora` |
| `RUST_LOG` | Kora's log filter. Unset, Kora logs at `info`, which writes the body of every request: each transaction it is asked to price or sign. `warn` writes no request |

`run.sh` refuses a key file inside this repo.

### Run it

```
./build.sh          # Kora 2.0.5 into .kora/ (cargo install kora-cli --locked; Rust, 6 to 12 minutes)
FOREST_FEE_PAYER_KEY=/outside/repo/fee-payer.json RPC_URL=https://… JUPITER_API_KEY=… ./run.sh   # :8080
```

Checks:

```
./forest.sh registry/client escrow/client                           # from the repo root
cd fee-payer && npm ci && npm run check                             # type-check the local run
bash deploy/devnet-config.sh kora.toml > /dev/null                  # the devnet config still applies
npm run test:local                                                  # the local run, about 30 seconds
```

**The local run** starts a validator with the two programs at the ids in their source (as a local
build has them), a six-decimal test dollar planted at USDC's address and Open USD planted from its
mainnet account, and Kora through `run.sh` on a copy of `kora.toml` with exactly three lines changed:
the two programs' devnet ids to their source ids, and `price_source = "Mock"`. A main key that
never held a lamport then writes a registry row, pays escrows (one in Open USD), closes one never
funded, and provokes every refusal above; every balance is checked. It needs `solana-test-validator`
(Solana CLI 4.2.2), the two programs built (`cargo build-sbf --arch v3` in
`forest/registry/program` and `forest/escrow/program`), the proving files (`npm run fetch` in
`forest/registry/artifacts`) and `./build.sh`. It skips, saying which, if one is missing. Not in CI.

### On devnet

Kora's own published image, `ghcr.io/solana-foundation/kora:v2.0.5`, pinned by digest, with
`kora.toml`, `signers.toml` and `run.sh`. `deploy/Dockerfile` checks the image is the version in
`KORA` and writes the devnet config with `deploy/devnet-config.sh`. Before the first transaction,
the key needs SOL for the deposits it funds, and a token account for each token it is paid in. It
is paid back in tokens; turning them back into SOL is an operations loop, not code.

Soil's devnet fee payer runs that image on Railway, project `forest-devnet`, service `fee-payer`,
at https://relayer-production-8d40.up.railway.app (Kora's JSON-RPC at `/`, POST; `GET /liveness`):

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=fee-payer/deploy/Dockerfile`.
- **One replica,** health check `GET /liveness`, a public domain to port 8080, no volume.
- **Signs as** `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd`, the devnet `payer` key, which is also
  the Open-USD-shaped test dollar's mint authority.
- **Paid in** the classic test dollar `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` and the
  Open-USD-shaped one `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz`.

| Variable | On devnet | Sealed |
|---|---|---|
| `FOREST_FEE_PAYER_KEY` | the `payer` key, as its JSON array | yes |
| `RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `RUST_LOG` | `warn` | no |
| `PORT` | `8080` | no |

With `RUST_LOG=warn`, Kora logs no request. It still logs errors: a token instruction type it
cannot read, by its type alone, and an instruction with too few accounts, whole.

## Policy

- **Kora,** 2.0.5, configured by `kora.toml`, with no code of ours inside it.
- **At cost:** the charge is the network fee and every storage deposit it puts down, with a margin
  of 0. It pays for no one: a transaction that does not pay its cost is refused.
- **Paid in four tokens on mainnet:** USDC, USDT, Open USD and EURC, each its maker's own mint, the
  makers' freeze and Open USD's permanent delegate accepted. On devnet, the two test dollars.
- **What its key may do:** fund a new account it is paid for, and nothing else; no priority fee.
- **No request logs:** Kora runs at `RUST_LOG=warn`, which writes no request.
- **Not built:** the sponsored node and vouchers are the next session's.

## Promises

- **It charges what a transaction costs it,** the network fee and every storage deposit it puts
  down, in the token the person pays with, with no margin.
- **It pays for no one:** a transaction that does not pay its cost is refused.
- **It holds no key of the person's.** The person signs on their own device; the fee payer adds only
  its own signature as payer.
- **Its key can do one thing in a transaction:** fund a new account it is paid for.
- **No code of ours runs in it:** Kora, configured.

## Limits

- **A one tap in a Token-2022 dollar is refused** by Kora 2.0.5 (FAQ): two transactions instead.
- **Mainnet is not deployed,** and Jupiter's price was never called. No test pays the fee payer in
  USDT or EURC; Kora handles them as it handles USDC.
- **No priority fee,** so under congestion a transaction may land late.
- **It trusts its RPC's simulation** of each transaction, for what it calls and what it costs, and
  Jupiter's price for each paid token against SOL, with nothing for that price's error.
- **What it collects sits under its signing key,** in the key's own token accounts; nothing moves
  it but someone holding the key.
- **What comes back to a person arrives as SOL** in a key that otherwise holds none.
- **Each dollar's maker can freeze the fee payer's account in it,** and Open USD's maker holds a
  permanent delegate that can take back what the fee payer collected in it.
- **Kora 2.2** hardens a fee payer against being drained and no longer reads the key from a path;
  it is not stable, and not taken.
- **Address logs.** No code of ours runs in the fee payer, and Kora 2.0.5 logs no network address.
  At its default level it logs the body of every request; `RUST_LOG=warn` stops that, and the
  devnet fee payer sets it. A hosting provider's own request logs are the operator's choice; on
  Railway they exist, with each request's client address and path.

## Who decides what

- **The standard (forest):** nothing here. The registry and the escrow take no fee and care nothing
  for who pays.
- **This fee payer, by its policy:** which programs and transactions it pays for, which tokens it is
  paid in, and its price.
- **An app, with the person:** which fee payer to use, or none, and which token to pay in.

## FAQ

**Why Kora 2.0.5, configured only?**
No custom code, and the 2.2 betas are not stable.

**Why may its key only fund new accounts it is paid for?**
So no transaction can make it move its own SOL or tokens.

**Why paid in USDC, USDT, Open USD or EURC on mainnet, the makers' freeze and Open USD's permanent
delegate accepted?**
People pay in what they hold (the founder's choice, 2026-10-01).

**Why no API key?**
A page in a browser cannot keep a secret, and every transaction pays its way.

**Why does the devnet fee payer run Kora at `RUST_LOG=warn`?**
At its default level Kora logs every request's body, and nothing server-side should hold a person's
transactions next to the hosting provider's record of their address.

**Why does every payment that creates its deposit address do so at the top of the transaction?**
Kora 2.0.5 accepts a transfer to an account that does not exist yet only when the same transaction
creates it with a top-level associated-token-account instruction; an account a program creates
inside its own call is invisible to it. The escrow client puts `CreateIdempotent` for the deposit
address first in every builder that pays in the same transaction.

**Why does a one tap in Open USD fail through this fee payer?**
In a one tap (deposit address, create, pay and release in one transaction), the escrow's payout to
the seller is a Token-2022 transfer out of the deposit address the same transaction creates.
Kora 2.0.5 (`kora-lib`, `src/token/token.rs`, `verify_token_payment`) runs its Token-2022 extension
check on every transfer whose destination exists, which fetches the transfer's source by RPC, before
it checks whether the transfer pays Kora at all; the source is not on chain yet, so it refuses with
`Account … not found`. Paying, then releasing, in two transactions passes; so does a one tap in a
classic dollar. The fix for 2.0.x is to check the destination is Kora's payment address before the
extension check; `2.2.0-beta.8` appears to fix it, untried. An app paying in Open USD through this
fee payer sends two transactions from one approval, the second once the first is confirmed.

**Why does what Solana's rent cuts free go to the fee payer?**
The programs send it to whoever fronted the deposit, and the fee payer fronted it and charged only
the cost.

**Could someone rebuild this fee payer from public data?**
It is Kora's published image and this configuration; anyone can run the same with their own key.

**Why is its address `relayer-production-8d40…`?**
It is the address the service had before forest's 3 October words. Renaming the service leaves the
address as it is, and apps that already name it keep working.
