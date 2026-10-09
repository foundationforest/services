# fee payer

The fee payer pays Solana's costs for a person's transactions, at cost, paid back in the dollar
they hold.

The foundation runs this one, on devnet. Anyone can run another, from Kora's published binary and
this configuration, or from their own: whoever signs a transaction as payer pays for it, and the
programs care nothing for who that is
([forest](https://github.com/foundationforest/forest/blob/main/README.md#for-builders)).

Up: [the repo](../README.md).

## How it works

### Kora, configured

The fee payer is one address, and behind it one copy of
[Kora](https://github.com/solana-foundation/kora) 2.0.5, the Solana Foundation's open fee payer,
configured and nothing else: `at-cost/kora.toml`. Nothing of ours runs in front of it. Kora answers
its own JSON-RPC at `/` (POST) and `GET /liveness`. It co-signs any transaction its rules allow,
pays the network fee and any deposit, and charges the person exactly what that cost it, in the
dollar they pay with. A request whose URL cannot be read (`//`) gets 405 from Kora, which goes on.

Inside a transaction its key may do one thing, fund a new account it is paid for, and Kora refuses
any transfer of its SOL or tokens. It holds no key of the person's, and decides nothing about the
person, the market or the deal.

This folder also holds the [registry payer](registry/README.md), which pays for registry rows
against credits, with its own key, as a service of its own. `at-cost/` holds the fee payer's
configuration and its local run, `registry/` the registry payer's. What both use stays at the
top: Kora's version (`KORA`), `build.sh`, `run.sh`, `signers.toml` and `deploy/devnet-config.sh`.

### Paying at cost

The person's device:

1. builds the transaction with the fee payer as payer, plus one plain token transfer to the fee
   payer whose amount it fills in next;
2. asks Kora the price of exactly that transaction, in that token (`estimateTransactionFee`);
3. sets the transfer to that price, and signs with the main key;
4. hands it to Kora (`signAndSendTransaction`).

The at-cost Kora simulates it, reads every program call inside it, checks it against
`at-cost/kora.toml`, checks the transfer covers the price, adds its signature and sends it.

**The price** is the network fee (per signature, the person's included) plus every account the
fee payer funds, counted from the simulation, including accounts a program creates inside its own
call. The transfer must already be in the transaction when the device asks: without it, Kora adds a
fixed 50 lamports for the payment it expects and misses that payment's signature, so the quote
falls 5,000 lamports short and Kora refuses the transaction it quoted.

**A registry row** through the fee payer takes two signatures: the fee payer's, which pays the network
fee and the row's deposit and is recorded in the row as its payer, and the main key's, which signs
the row and the payment. The proof names the profile and the label, so nothing the fee payer sees
lets it take the row.

### What the at-cost Kora allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the registry and the escrow at their devnet addresses, SPL Token, Token-2022, Associated Token Account, System | Kora checks every program a transaction calls, inner calls included |
| No compute budget program | | So no priority fee: the fee payer never pays one it did not agree to |
| `max_allowed_lamports` | 0.01 SOL | Deposits per transaction; an escrow's creation takes about 0.0037 |
| `max_signatures` | 3 | The fee payer, and an escrow's two parties when both sign a split |
| `price` | margin 0 | The charge is the cost |
| `price_source` | `Jupiter` (needs `JUPITER_API_KEY`) | Jupiter prices mainnet only; devnet uses Kora's mock |
| `rate_limit` | 100 a second, across all callers | Kora's own limiter, at Kora's example value |
| `payment_address` | unset | Payments go to token accounts the fee payer's own key owns |
| `fee_payer_policy` | only `allow_create_account` | The fee payer's key may fund a new account it is paid for, and nothing else: no transfer, assign, allocate or nonce use, and no SPL Token or Token-2022 instruction as owner or authority |
| No API key or HMAC | | A page in a browser cannot keep a secret, and every transaction pays its way |

The programs are the registry `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4` and the escrow
`FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`, as forest records them on devnet. The tokens it is
paid in, in `at-cost/kora.toml`, are mainnet's, each its maker's own mint:

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
in. `deploy/devnet-config.sh` prints a Kora's `kora.toml` with exactly three lines changed, and
stops if any is not there exactly once: the two paid-token lists (the two devnet test dollars in
place of the four mainnet tokens), and `price_source = "Mock"`. Kora's mock values the test dollars
at 0.001 SOL a whole token: one base unit buys one lamport.

Refused, each checked by the local run ([Run it](#run-it)) with nothing landing: a program not on
the list (`… is not in the allowed list`); a priority fee; the fee payer's SOL sent anywhere
(`Fee payer cannot be used for 'System Transfer'`); the payment taken back out of the fee payer's
account; no payment, or one short of the deposits (`Insufficient token payment. Required …
lamports`).

### Rent

Every account on Solana holds a deposit, its rent, and gives it back when the account closes. A
cut in Solana's rent frees part of it, which only the program that owns the account can send on
([forest's escrow, Rent](https://github.com/foundationforest/forest/blob/main/escrow/README.md#rent)).
The registry and the escrow send every rent back to whoever fronted it, here the fee payer:

- **An escrow's deposit address:** its rent goes back to the escrow's payer, the fee payer, at
  every ending. The person was charged for it when the escrow opened, so the person pays an escrow's deposits and does not get them back; the fee payer keeps them.
- **An escrow never funded, closed:** both rents go back to the fee payer.
- **What a cut in Solana's rent frees** on an account the fee payer funded goes to the fee payer,
  which keeps it: a registry row's (`refund`, to the payer the row records) and an escrow
  receipt's (`sweep_rent`, to the payer it records). Anyone may send either.

The fee payer fronted those deposits and charged only their cost, so it keeps what comes back. A
row never grows after `register`, so nothing a row needs later asks the fee payer for SOL.

What a row costs is in forest's
[registry](https://github.com/foundationforest/forest/blob/main/registry/README.md#what-one-row-costs),
and an escrow's in forest's
[escrow](https://github.com/foundationforest/forest/blob/main/escrow/README.md#run-it-and-what-one-escrow-costs).
The local run checks, for every transaction it sends, that the charge is exactly what the fee payer
spent.

### Settings

Kora, `run.sh`, for the fee payer and the registry payer alike:

| Variable | What |
|---|---|
| `FOREST_FEE_PAYER_KEY` | The payer's key: a path to a keypair file (the Solana CLI's JSON form) outside this repo, or, where a hosting platform has no files, the key itself, as that JSON array or base58. Kora 2.0.5 built `--locked` uses solana-keychain 0.1.0, which reads a path first and otherwise takes the key itself. If it is unset, `run.sh` takes the key from `FOREST_RELAYER_KEY`, the name the devnet fee payer holds it under |
| `RPC_URL` | The Solana RPC Kora simulates and sends through. Required. It must return inner instructions from `simulateTransaction` |
| `JUPITER_API_KEY` | For `price_source = "Jupiter"` |
| `PORT` | Default `8080` |
| `KORA_CONFIG` | Default `at-cost/kora.toml`; the fee payer's image sets its devnet config, and `deploy/registry.sh` passes the registry payer's |
| `KORA_BIN` | Default `.kora/bin/kora` |
| `RUST_LOG` | Kora's log filter. Unset, Kora logs at `info`, which writes the body of every request: each transaction it is asked to price or sign. `warn` writes no request |

`run.sh` refuses a key file inside this repo.

### Run it

```
./build.sh          # Kora 2.0.5 into .kora/ (cargo install kora-cli --locked; Rust, 6 to 12 minutes)
FOREST_FEE_PAYER_KEY=/outside/repo/fee-payer.json RPC_URL=https://… JUPITER_API_KEY=… ./run.sh   # the at-cost Kora alone, :8080
```

Checks:

```
./standard.sh registry/client escrow/client                         # from the repo root
cd fee-payer
bash deploy/devnet-config.sh at-cost/kora.toml > /dev/null          # the devnet config still applies
(cd at-cost && npm ci && npm run check)                             # type-check the local run
(cd at-cost && npm run test:local)                                  # the local run, about 30 seconds
```

**The local run** starts a validator with the two programs at the ids in their source (as a local
build has them), a six-decimal test dollar planted at USDC's address and Open USD planted from its
mainnet account, and Kora through `run.sh` on a copy of `at-cost/kora.toml` with exactly three lines
changed: the two programs' devnet ids to their source ids, and `price_source = "Mock"`. A main key
that never held a lamport then writes a registry row, from a note a test issuer signs, pays escrows
(one in Open USD), closes one never funded, and provokes every refusal above; every balance is
checked. It needs `solana-test-validator` (Solana CLI 4.2.2), the two programs built
(`cargo build-sbf --arch v3` in `standard/registry/program` and `standard/escrow/program`) and
`./build.sh`. It skips, saying which, if one is missing. Not in CI. The registry payer's checks
are in [its README](registry/README.md#run-it).

### On devnet

`deploy/Dockerfile` builds one image from Node's image: Kora's binary, copied from Kora's own
published image `ghcr.io/solana-foundation/kora:v2.0.5`, pinned by digest, and checked against
`KORA`; `at-cost/kora.toml` with the devnet lines `deploy/devnet-config.sh` changes; and
`signers.toml` and `run.sh`, with `RUST_LOG=warn` set in the image. Before the first transaction,
the key needs SOL for the deposits it funds, and a token account for each token it is paid in.

The foundation's fee payer runs that image on Railway, service `fee payer`, at
https://fee-payer.devnet.forest.foundation, the address [`../e2e/devnet.json`](../e2e/devnet.json)
names: Kora's JSON-RPC at `/` (POST) and `GET /liveness`.

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=fee-payer/deploy/Dockerfile`.
- **One replica,** health check `GET /liveness`, a public domain to port 8080. It keeps nothing,
  so it needs no volume.
- **Signs as** the devnet `payer` key, which is also the Open-USD-shaped test dollar's mint
  authority; **paid in** the two test dollars. Both are in
  [the repo's devnet facts](../README.md#on-devnet).

| Variable | On devnet | Secret |
|---|---|---|
| `FOREST_RELAYER_KEY` | the `payer` key, as its JSON array; `run.sh` passes it to Kora as `FOREST_FEE_PAYER_KEY` | yes |
| `RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `RUST_LOG` | `warn`, as the image sets it | no |
| `PORT` | `8080` | no |

## Policy

- **Kora,** 2.0.5, configured by `at-cost/kora.toml`, with no code of ours inside it or in front of
  it.
- **At cost:** the charge is the network fee and every deposit it puts down. It pays for no one: a
  transaction that does not pay its cost is refused.
- **Rent it fronts and later gets back stays with it:** an escrow's deposits, and what a cut in
  Solana's rent frees on a row or a receipt ([Rent](#rent)).
- **Paid in four tokens on mainnet's configuration:** USDC, USDT, Open USD and EURC, each its
  maker's own mint, since people pay in what they hold. The makers' freeze and Open USD's permanent
  delegate are accepted. On devnet, the two test dollars.
- **Prices:** Jupiter's, on mainnet's configuration; on devnet, Kora's mock.
- **What its key may do:** fund a new account it is paid for, and nothing else; no priority fee.
- **The float:** the SOL in its key, apart from the registry payer's. Nothing refills it but a
  person; when it runs out, it refuses. It is paid back in tokens; turning them back into SOL is
  done by hand, not by code.
- **The rate limit:** Kora signs at most 100 transactions a second, across all callers.
- **No API key for callers.** A page in a browser cannot keep a secret, and every transaction pays
  its way.
- **No request logs:** Kora runs at `RUST_LOG=warn`, which writes no request, since at its
  default level Kora logs every request's body, and nothing server-side should hold a person's
  transactions next to the hosting provider's record of their address. Kora still logs errors: a
  token instruction type it cannot read, by its type alone, and an instruction with too few
  accounts, whole.
- **What it keeps:** nothing.
- **Where it runs:** Railway, one container, one replica; Helius's devnet RPC.

## Promises

- **It holds no key of the person's.** The person signs on their own device; the fee payer adds only
  its own signature as payer.
- **Its key can do one thing in a transaction:** fund a new account it is paid for.
- **No code of ours runs inside Kora:** the fee payer is Kora, configured, with nothing in front of
  it.
- **No accounts.**
- **It keeps no network address.** Kora runs at a level that writes no request.

## Limits

- **A one tap in a Token-2022 dollar is refused** by Kora 2.0.5 ([FAQ](#faq)): two transactions
  instead.
- **One container.** When Kora stops, the fee payer stops, until the hosting platform starts it
  again.
- **Mainnet is not deployed,** and Jupiter's price was never called. No test pays the fee payer in
  USDT or EURC; Kora handles them as it handles USDC.
- **No priority fee,** so under congestion a transaction may land late.
- **It trusts its RPC's simulation** of each transaction, for what it calls and what it costs, and
  Jupiter's price for each paid token against SOL, with nothing for that price's error.
- **What it collects sits under its signing key,** in the key's own token accounts; nothing moves
  it but someone holding the key.
- **Each dollar's maker can freeze the fee payer's account in it,** and Open USD's maker holds a
  permanent delegate that can take back what the fee payer collected in it.
- **Address logs.** A hosting provider's own request logs are the operator's choice; on Railway
  they exist, with each request's client address and path.

## Who decides what

- **The standard (forest):** nothing about the price. The registry and the escrow take no fee and
  care nothing for who pays; every rent goes back to whoever fronted it.
- **This fee payer, by its policy:** which programs and transactions it pays for, which tokens it is
  paid in, and its price.
- **An app, with the person:** which fee payer to use, or none, and which token to pay in.

## FAQ

**Why Kora 2.0.5, configured only?**
No custom code inside Kora. The 2.2 betas are not stable, and no longer read the key from a path,
which `FOREST_FEE_PAYER_KEY` allows.

**Why no key on Kora, when the registry payer's Kora has one?**
Kora 2.0.5 always listens on every interface, so other services in the same project could reach it
over the private network. Whatever reaches the fee payer pays its way, from the public address or
the private one, so it needs no key; the registry payer's Kora pays for free what its front lets
through, so only its front may reach it ([registry payer, FAQ](registry/README.md#faq)).

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
classic dollar. An app paying in Open USD through this fee payer sends two transactions from one
approval, the second once the first is confirmed.
