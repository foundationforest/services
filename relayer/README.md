# relayer

Devnet only: the foundation's relayer runs on devnet, paid in two test dollars. `kora.toml` is
written for mainnet, where nothing is deployed. Nothing is shipped.

Up: [the repo](../README.md). The issue drafted for Kora: [docs/kora-issue.md](../docs/kora-issue.md).

The relayer lets a person send a transaction without holding SOL. It co-signs the transaction as
its payer, pays the network fee and any storage deposit, and charges the person exactly what that
cost it, in the token they pay with: **USDC, USDT, Open USD or EURC** on mainnet; on devnet, two
test dollars. No margin, and it pays for no one.

It is [Kora](https://github.com/solana-foundation/kora) 2.0.5, configured, with no custom code. It
holds none of the person's keys and decides nothing about the person, the market or the deal. Kora's
own names say "fee payer" (`fee_payer_policy`, its messages).

## How a transaction goes through it

The person's device:

1. builds the transaction with the relayer as payer, plus one plain token transfer to the relayer
   whose amount it fills in next;
2. asks Kora the price of exactly that transaction, in that token (`estimateTransactionFee`);
3. sets the transfer to that price, and signs with the person's own key;
4. hands it to Kora (`signAndSendTransaction`).

Kora simulates it, reads every program call inside it, checks it against `kora.toml`, checks the
transfer covers the price, adds its signature and sends it.

**The price** is the network fee (per signature, the person's included) plus every account the
relayer funds, counted from the simulation, including accounts a program creates inside its own
call. The transfer must already be in the transaction when the device asks: without it, Kora adds a
fixed 50 lamports for the payment it expects and misses that payment's signature, so on a registry
line the quote falls 5,000 lamports short and Kora refuses the transaction it quoted.

**A registry line** takes one signature, the payer's: the relayer pays the network fee and the
line's deposit, and is recorded in the line as its payer. The person signs only their payment. The
proof names their profile and label, so nothing the relayer sees lets it take the badge.

## Paid in four tokens

On mainnet, `kora.toml` takes the fee in each issuer's own mint:

| Token | Mint | Program |
|---|---|---|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL Token |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | SPL Token |
| Open USD | `ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB` | Token-2022, eight extensions, no transfer fee |
| EURC | `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | SPL Token; a euro |

- All four have six decimals and no transfer fee, so each quote holds.
- **The charge is the same SOL cost in whichever token.** Kora's Jupiter price source prices each
  token in dollars and divides by SOL's price, so EURC is charged at the euro's rate.
- **Each issuer can freeze the relayer's account in its token,** and Open USD's issuer holds a
  permanent delegate that can take back what the relayer collected in it. The foundation accepts
  both.
- In Kora 2.0.5, `allowed_tokens` gates only Kora's own `transferTransaction` helper; an escrow in
  another token still passes. `allowed_spl_paid_tokens` is the list it is paid in.

## What it allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the registry, escrow v1, escrow v2, SPL Token, Token-2022, Associated Token Account, System | Kora checks every program a transaction calls, inner calls included |
| No compute budget program | | So no priority fee: the relayer never pays one it did not agree to |
| `max_allowed_lamports` | 0.01 SOL | Deposits per transaction; an escrow v2's creation takes about 0.0037 at mainnet rent |
| `max_signatures` | 3 | The relayer, and an escrow's two parties when both sign a split |
| `price` | margin 0 | The charge is the cost |
| `price_source` | `Jupiter` (needs `JUPITER_API_KEY`) | Jupiter prices mainnet only; devnet uses Kora's mock |
| `rate_limit` | 100 a second, across all callers | Kora's own limiter |
| `payment_address` | unset | Payments go to token accounts the relayer's own key owns |
| `fee_payer_policy` | only `allow_create_account` | The relayer's key may fund a new account it is paid for, and nothing else: no transfer, assign, allocate or nonce use, and no SPL Token or Token-2022 instruction as owner or authority |
| No API key or HMAC | | A page in a browser cannot keep a secret, and every transaction pays its way |

Refused, each tested with nothing landing: a program not on the list (`… is not in the allowed
list`); a priority fee; the relayer's SOL sent anywhere (`Fee payer cannot be used for 'System
Transfer'`); the payment taken back out of the relayer's account (`… 'SPL Token Transfer'`); no
payment, or one short of the deposits (`Insufficient token payment. Required … lamports`).

## What comes back, and to whom

The relayer charges what it spends. What comes back later goes where each program sends it:

- **An escrow's deposit address:** its rent goes back to the person who created the escrow, at
  every ending.
- **An escrow never funded, closed:** both rents go back to the person.
- **What Solana's storage price cuts free** on an account the relayer funded goes to the relayer,
  which keeps it: a registry line's (`refund`, to the payer the line records) and an escrow v2
  receipt's (`sweep_rent`, to the payer it records).
- **An escrow v1 receipt:** `sweep_rent` sends it to the person who created it; v1 records no payer.

Anyone may send `refund` or `sweep_rent`. A line never grows after `register`, so nothing a line
needs later asks the relayer for SOL.

## Token-2022 and the one tap

Escrow v2 takes Token-2022 dollars such as Open USD, so `kora.toml` allows the Token-2022 program,
while the relayer's own key may do nothing in it.

**A one tap in a Token-2022 dollar does not pass Kora 2.0.5.** In a one tap (deposit address,
create, pay and release in one transaction), the escrow's payout to the seller is a Token-2022
transfer out of the deposit address the same transaction creates. Kora reads the source of every
Token-2022 transfer whose destination exists before checking whether it pays Kora, finds no
account, and refuses (`Account … not found`). Paying, then releasing, in two transactions, passes;
so does a one tap in a classic dollar. So an app paying in Open USD through this relayer sends two
transactions from one approval, the second once the first is confirmed. The cause and the fix are
in [docs/kora-issue.md](../docs/kora-issue.md); Kora's `2.2.0-beta.8` appears to fix it.

**Every payment that creates its deposit address does so at the top.** Kora 2.0.5 accepts a
transfer to an account that does not exist yet only when the same transaction creates it with a
top-level associated-token-account instruction; an account a program creates inside its own call
is invisible to it. Both escrow clients put `CreateIdempotent` for the deposit address first in
every builder that pays in the same transaction (`makeDepositAddressIx`).

## What it trusts

- **Its RPC's simulation** of each transaction, for what it calls and what it costs.
- **Jupiter's price** for each paid token against SOL (mainnet), with nothing for that price's
  error, since there is no margin.
- **Its own `kora.toml`,** and nothing about the person.

## Measured, on a local validator

`test/relayer.test.ts`, the programs built as SBPF v3, rent at the validator's default (6,960
lamports a byte), Kora's mock price (one base unit of the test dollar buys one lamport). All
amounts in lamports. Charged equals spent in every row.

| Transaction | Size | Charged | Of which deposits |
|---|---|---|---|
| Registry line, a 20-byte label | 702 bytes | 2,077,120 | the line, 2,067,120 |
| Escrow v1, pay (deposit address, create, money in) | 661 | 4,777,600 | escrow 2,728,320, deposit address 2,039,280 |
| Escrow v1, release | 488 | 10,000 | none |
| Escrow v1, one tap | 710 | 4,777,600 | the same two |
| Escrow v2, pay | 661 | 5,062,960 | escrow 3,013,680, deposit address 2,039,280 |
| Escrow v2, release | 488 | 10,000 | none |
| Escrow v2, one tap | 710 | 5,062,960 | the same two |
| Escrow v2 in Open USD, pay | 727 | 5,160,400 | escrow 3,013,680, deposit address 2,136,720 |
| Escrow v2 in Open USD, release | 553 | 10,000 | none |

The network fee was 10,000 each time: two signatures, no priority fee.

## Settings

| Variable | What |
|---|---|
| `FOREST_RELAYER_KEY` | The relayer's key: a path to a keypair file (the Solana CLI's JSON form) outside this repo, or, where a hosting platform has no files, the key itself, as that JSON array or base58. Kora 2.0.5 built `--locked` uses solana-keychain 0.1.0, which reads a path first and otherwise takes the key itself; Kora 2.2 takes the key only |
| `RPC_URL` | The Solana RPC Kora simulates and sends through. Required. It must return inner instructions from `simulateTransaction` |
| `JUPITER_API_KEY` | For `price_source = "Jupiter"` |
| `PORT` | Default `8080` |
| `KORA_CONFIG` | Default `kora.toml` |
| `KORA_BIN` | Default `.kora/bin/kora` |

`run.sh` refuses a key file inside this repo.

## Run it

```
./build.sh          # Kora 2.0.5 into .kora/ (cargo install kora-cli --locked; Rust, 6 to 12 minutes)
FOREST_RELAYER_KEY=/outside/repo/relayer.json RPC_URL=https://… JUPITER_API_KEY=… ./run.sh   # :8080
```

Checks:

```
./forest.sh registry/client escrow/client escrow/v2/client        # from the repo root
cd relayer && npm ci && npm run check                               # type-check the local run
bash deploy/devnet-config.sh kora.toml > /dev/null                  # the devnet config still applies
npm run test:local                                                  # the local run, about 30 seconds
```

**The local run** starts a validator with the three programs, a six-decimal test dollar planted at
USDC's address and Open USD planted from its mainnet account, and Kora through `run.sh` on a copy of
`kora.toml` with one line changed: `price_source = "Mock"`. A wallet that never held a lamport then
writes a registry line, pays escrows under v1 and v2 (one in Open USD), closes one never funded, and
provokes every refusal above; every balance is checked. It needs `solana-test-validator` (Solana CLI
4.2.2), the three programs built (`cargo build-sbf --arch v3` in `forest/registry/program`,
`forest/escrow/program`, `forest/escrow/v2/program`), the proving files (`npm run fetch` in
`forest/registry/artifacts`) and `./build.sh`. It skips, saying which, if one is missing. Not in CI.

## Deploy

Kora's own published image, `ghcr.io/solana-foundation/kora:v2.0.5`, pinned by digest, with
`kora.toml`, `signers.toml` and `run.sh`. `deploy/Dockerfile` checks the image is the version in
`KORA` and writes the devnet config with `deploy/devnet-config.sh`, which prints `kora.toml` with
exactly six lines changed and stops if any is not there exactly once: the three programs' devnet
ids, the two paid-token lists (the two devnet test dollars in place of the four mainnet tokens), and
`price_source = "Mock"`, since Jupiter prices mainnet only. Kora's mock values the test dollars at
0.001 SOL a whole token: one base unit buys one lamport.

Before the first transaction, the key needs SOL for the deposits it funds, and a token account for
each token it is paid in (`kora rpc initialize-atas`, or any transfer that makes them). It is paid
back in tokens; turning them back into SOL is an operations loop, not code.

**The foundation's devnet relayer** runs that image on Railway, project `forest-devnet`, service
`relayer`:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=relayer/deploy/Dockerfile`.
- **One replica,** health check `GET /liveness`, a public domain to port 8080, no volume.
- **Signs as** `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` (forest's `devnet/keys.sh` calls it
  `payer`; it is also the Open-USD-shaped test dollar's issuer).
- **Paid in** the USDC-shaped test dollar `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` and the
  Open-USD-shaped one `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz`.

| Variable | On devnet | Sealed |
|---|---|---|
| `FOREST_RELAYER_KEY` | the `payer` key, as its JSON array | yes |
| `RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `PORT` | `8080` | no |

## Limits

- **Mainnet is not deployed,** and Jupiter's price was never called. No test pays the relayer in
  USDT or EURC; Kora handles them as it handles USDC.
- **A one tap in a Token-2022 dollar is refused** by Kora 2.0.5 (above): two transactions instead.
- **No priority fee,** so under congestion a transaction may land late.
- **What it collects sits under its signing key,** in the key's own token accounts; nothing moves
  it but someone holding the key.
- **What comes back to a person arrives as SOL** in a wallet that otherwise holds none.
- **Kora 2.2** hardens a relayer against being drained and no longer reads the key from a path; it
  is not stable, and not taken.
- **Address logs.** No code of ours runs in the relayer. Kora 2.0.5, as it runs here, logs no
  network address, but it logs the body of every request: each transaction it is asked to price or
  sign, refused ones included, which never reach the chain. A hosting provider's own request logs
  are the operator's choice; on Railway they exist, with each request's client address and time, so
  the two can be matched by time.
