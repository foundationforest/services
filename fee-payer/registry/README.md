# registry payer

The registry payer pays for a person's registry row against one credit, which anyone can buy for
them.

The foundation runs this one, on devnet. Anyone can run another, from Kora's published binary,
this configuration and its front's code, or from their own: whoever signs a transaction as payer
pays for it, and the registry cares nothing for who that is
([standard](https://github.com/foundationforest/standard/blob/main/README.md#for-builders)).

Up: [the fee payer's folder](../README.md).

## How it works

### One address, one Kora, one front

The registry payer is one address. Behind it, in one container, run one copy of
[Kora](https://github.com/solana-foundation/kora) 2.0.5, configured and nothing else
(`kora.toml`), and one program of ours in front of it, the front (`src/`):

```
         GET  /.well-known/private-token-issuer-directory   its credit key and price
  app ──▶ POST /credits/buy    a paid buy, answered with its credits
         POST /register       one row and one credit ───▶ its Kora (kora.toml) ──▶ Solana
         POST / (getPayerSigner), GET /liveness ─────────▶ its Kora
```

It shares Kora's version, `build.sh`, `run.sh`, `signers.toml` and `deploy/devnet-config.sh` with
the [fee payer](../README.md), in the same folder, and nothing else: its own key, its own address,
its own container.

### Credits

A credit here is a [Forest credit](https://github.com/foundationforest/standard/blob/main/credits/README.md)
whose unit is `one registration`. The front sells and spends them with standard's service side,
unchanged ([Selling credits](https://github.com/foundationforest/standard/blob/main/credits/README.md#selling-credits)).

**Its directory,** `GET /.well-known/private-token-issuer-directory`, names its credit key, where a
buy goes (`/credits/buy`), and its `forest-credit` entry: the unit, the address a credit is paid
to, the token and one credit's price ([Policy](#policy)).

**Buying.** The app makes a buy of `n` credits (standard's `buy`), and anyone pays its pay link:
`n` × the price, to the registry payer's address, naming the buy's reference. Then anyone posts the
buy's bytes to `POST /credits/buy`. The front counts it, asks its RPC for a finalized payment that
names the buy's reference and pays at least `n` × the price, and answers with the `n` blind
signatures, the same each time the buy is collected. The app finishes the credits and keeps them.

| Check | Refusal |
|---|---|
| The bytes are a buy | `not_a_buy` (400) |
| It asks for at most `CREDITS_PER_BUY` credits | `too_many` (400) |
| A finalized payment names its reference and pays for every credit | `not_paid` (402), with what to pay, to whom |
| The RPC answers | `payment_check_unavailable` (503) |

### Registering

The person's device:

1. builds the row's transaction with the registry payer as payer (`getPayerSigner` at its address
   names it), and signs it with the main key;
2. sends it to `POST /register`, as `{ transaction }` in base64, with one credit in
   `Authorization: PrivateToken token="<credit>"`.

The front checks, in this order, and refuses by name at the first that fails:

| Check | Refusal |
|---|---|
| The body is `{ transaction }` and nothing else | `bad_request` (400) |
| The transaction decodes, whole, with nothing after it | `bad_transaction` (400) |
| It is one instruction, `register`, to the registry, with its four accounts (the row, the main key, the payer, System), no address lookup table and no other account | `not_one_registration` (400) |
| The main key it names signed it | `not_signed_by_main_key` (400) |
| The request shows a credit | `no_credit` (401) |
| The credit is this registry payer's: its challenge, its key, its signature (standard's `checkCredit`) | `credit` (402) |
| The credit is not spent | `spent` (409) |
| No other request holds it now | `held` (409) |

Then the credit is held, and the front hands the transaction, unchanged, to its Kora's
`signAndSendTransaction` and answers `{ signature }`. If Kora refuses, or does not answer, the
credit is freed at once and the answer is `fee_payer_refused` (502), with Kora's reason: the credit
can be shown again. Kora checks the transaction against `kora.toml`, adds its signature and sends
it: the registry payer pays the network fee and the row's deposit, and is recorded in the row as
its payer.

### When a credit is spent

A credit is spent only once its row lands. Every three seconds the front settles each credit it
holds, through its RPC:

- **the row's transaction confirmed:** the credit is spent, for good;
- **the transaction failed:** the credit is freed;
- **not seen, and its blockhash no longer valid:** the front asks once more, and frees the credit
  if the row still has not landed;
- **the RPC does not answer:** the credit waits for the next round.

A credit held with no row sent (the container stopped between the two) is freed after two minutes,
longer than any blockhash lives. Holds are kept in the spent list, so a restart settles them.

### What its Kora allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the registry at its devnet address, System | The registry creates the row with System, inside its own call |
| `max_allowed_lamports` | 0.0024 SOL | The largest row (a 128-byte label, 308 bytes) takes 2,214,880 lamports at today's rent of 5,080 lamports a byte, on devnet and mainnet |
| `max_signatures` | 2 | The registry payer and the main key |
| `price` | free | Kora charges nothing: the credit paid for the row |
| `rate_limit` | 1 a second, across all callers | Kora's own limiter. It holds a request over the limit until the next second rather than refusing it |
| `fee_payer_policy` | only `allow_create_account` | Its key may fund a new account, the row, and nothing else. Kora warns about it at start, and runs |
| `allowed_tokens`, `allowed_spl_paid_tokens`, `price_source` | the at-cost Kora's | Never used when free ([FAQ](#faq)) |
| `KORA_API_KEY` | made at each start, given to the front alone; a call without it gets 401 | Kora listens on every interface ([FAQ](#faq)) |

### Settings

Its Kora takes `run.sh`'s settings ([the fee payer's Settings](../README.md#settings)). The front,
`src/main.ts`:

| Variable | Required | Default | What |
|---|---|---|---|
| `PUBLIC_ORIGIN` | yes | | Its public origin, `https://<host>`: the name every credit's challenge carries, so it must be the address apps use |
| `CREDIT_KEY` | yes | | Its credit key: RSA-2048, PKCS #8 DER, in base64, as `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \| openssl pkcs8 -topk8 -nocrypt -outform DER \| base64 -w0` writes one. Read once at start and removed from the environment |
| `CREDIT_ADDRESS` | yes | | The address a credit is paid to |
| `CREDIT_MINT` | yes | | The token a credit is paid in, or `SOL` |
| `CREDIT_PRICE` | yes | | One credit's price, decimal text in whole tokens |
| `CREDITS_PER_BUY` | no | `10` | The most credits one buy may ask for |
| `REGISTRY_PROGRAM` | yes | | The registry a row is written by: the one `kora.toml` allows |
| `RPC_URL` | yes | | The Solana RPC it finds payments and watches rows through (its Kora sends through the same) |
| `KORA_URL`, `KORA_API_KEY` | yes | | Its Kora and the key it asks for; `deploy/registry.sh` sets both |
| `DATABASE_PATH` | no | `./data/credits.sqlite` | The spent list's one file |
| `PORT` | no | `8080` | The registry payer's one address |

`deploy/registry.sh` starts, in one container, its Kora (`run.sh` on `registry/kora.devnet.toml`,
on port 8082, with a key made at each start) and the front on `PORT`, and stops the container when
either stops.

### Run it

```
./standard.sh registry/client credits                    # from the repo root
cd fee-payer
bash deploy/devnet-config.sh registry/kora.toml > /dev/null   # the devnet config still applies
(cd registry && npm ci && npm run check && npm test)     # real credits, a stand-in Kora and RPC; seconds
```

The tests buy real credits from the front, collect and finish them, register with them, and check
every refusal above, a credit spent once its row lands, freed when Kora refuses or the blockhash
passes, and a hold kept across a restart.

### On devnet

`deploy/registry.Dockerfile` builds one image from Node's image: Kora's binary, copied from Kora's
own published image `ghcr.io/solana-foundation/kora:v2.0.5`, pinned by digest, and checked against
`KORA`; `kora.toml` with the devnet lines `deploy/devnet-config.sh` changes; `signers.toml`,
`run.sh` and `deploy/registry.sh`; and the front, with standard's `registry/client` and `credits`
at the commit in `STANDARD`, and `RUST_LOG=warn` set in the image. Before the first row, its key
needs SOL for the deposits it funds.

The foundation's registry payer runs that image on Railway, service `registry payer`, at
https://registry-payer.devnet.forest.foundation.

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=fee-payer/deploy/registry.Dockerfile`.
- **One replica,** health check `GET /liveness` (its Kora's, through the front), a public domain to
  port 8080, a volume at `/data` for the spent list.
- **Signs as** the devnet `registry-payer` key, `G4okQqEUk9WMVfheCHhjQL4ZerAKqKj3Y97UMq8TUsjZ`,
  from the devnet phrase by the recipe in standard's `devnet/deploy.sh` scripts; **credits are paid
  to** the same address, in the classic test dollar.

| Variable | On devnet | Secret |
|---|---|---|
| `FOREST_FEE_PAYER_KEY` | the `registry-payer` key, as its JSON array | yes |
| `RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `CREDIT_KEY` | an RSA-2048 key made for it | yes |
| `PUBLIC_ORIGIN` | `https://registry-payer.devnet.forest.foundation` | no |
| `CREDIT_ADDRESS` | `G4okQqEUk9WMVfheCHhjQL4ZerAKqKj3Y97UMq8TUsjZ` | no |
| `CREDIT_MINT` | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa`, the classic test dollar | no |
| `CREDIT_PRICE` | `0.5` | no |
| `REGISTRY_PROGRAM` | `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4` | no |
| `DATABASE_PATH` | `/data/credits.sqlite` | no |
| `RUST_LOG` | `warn`, as the image sets it | no |
| `PORT` | `8080` | no |

## Policy

- **Kora,** 2.0.5, configured by `kora.toml`, with no code of ours inside it. The one program of
  ours, the front, stands in front of it.
- **Rows only:** one `register` in a transaction and nothing else, the row under any issuer and any
  label; at most 0.0024 SOL a row beyond the network fee; two signatures.
- **One credit, one registration,** at 0.5 of the classic test dollar on devnet (`CREDIT_PRICE`), a
  placeholder. It covers a row's deposit with margin.
- **At most ten credits a buy** (`CREDITS_PER_BUY`).
- **A payment counts once it is finalized.**
- **A credit is spent once its row is confirmed,** and freed if Kora refuses the row, the row fails,
  or its blockhash passes with the row not landed.
- **One credit key,** in `CREDIT_KEY`. Its credits count for as long as it is the key.
- **The float:** the SOL in its own key, apart from the fee payer's. Nothing refills it but a person;
  when it runs out, rows are refused, and their credits freed. The dollars credits are paid in sit
  under the same key; turning them into SOL is done by hand, not by code.
- **The rate limit:** its Kora signs at most one transaction a second, across all callers; the rest
  wait their turn.
- **No API key for callers.** A page in a browser cannot keep a secret; every row needs a credit.
- **No request logs:** its Kora runs at `RUST_LOG=warn`, which writes no request, and the front logs
  nothing.
- **What it keeps:** the spent list, for as long as it runs: each spent credit's id, with no time and
  no main key; for a credit held now, until it settles, the row's signature and blockhash and when.
- **Where it runs:** Railway, one container, one replica; Helius's devnet RPC.

## Promises

- **It pays only for registry rows:** one per credit, and a credit is spent only once its row
  lands.
- **It holds no key of the person's.** The person signs on their own device; the registry payer adds
  only its own signature as payer.
- **Its key can do one thing in a transaction:** fund a new account, a registry row.
- **No code of ours runs inside Kora:** its Kora is Kora, configured; the front runs in front of it.
- **No accounts.**
- **It keeps no network address.** The front logs nothing, and its Kora runs at a level that writes
  no request.
- **Nothing it keeps ties a spent credit to its row,** or a credit to its buy: the spent list holds
  each spent credit's id alone.

## Limits

- **What bounds it.** A payer that pays for anyone is a faucet. This one pays only for a registry
  row, and a row's deposit stays in the row, which never closes; nobody can move it out but
  `refund`, which sends only what a cut in Solana's rent frees, and only to the payer the row
  records. So nobody takes SOL out of it; they can only make it lock SOL up in rows, one per credit,
  and each credit is paid for.
- **On devnet credits are paid in a test dollar,** which its maker mints at will, so credits are
  unlimited there. Only the rate limit bounds it: one row a second, about 8 SOL an hour of the
  largest rows, until the float is empty.
- **A row that fails on chain frees its credit,** and its network fee is the registry payer's.
- **One container.** When its Kora or the front stops, the container stops, until the hosting
  platform starts it again.
- **The front has no limit of its own.** Every buy collected costs RPC calls, and every row shown
  costs a credit's check; Kora's limiter counts only what reaches Kora.
- **A credit is a bearer token, and timing can link.** A buy collected and a credit spent moments
  later, from one network address, can be matched (standard's
  [credits, Limits](https://github.com/foundationforest/standard/blob/main/credits/README.md#limits)).
- **Its Kora has no local test.** The front's tests use a stand-in Kora; only
  [`e2e/`](../../e2e/README.md)'s devnet run sends a row through it.
- **It trusts its RPC,** for a payment and for whether a row landed.
- **What it collects sits under its signing key,** in the key's own token account; nothing moves it
  but someone holding the key.
- **Address logs.** A hosting provider's own request logs are the operator's choice; on Railway
  they exist, with each request's client address and path.

## Who decides what

- **The standard:** the credit, its directory entry, the buy and its pay link, and the rules: a
  credit is spent once, only when its action lands, and never refunded. The registry takes no fee
  and cares nothing for who pays.
- **This registry payer, by its policy:** what it pays for, its price, token and address, how many
  credits a buy may hold, and when a row has landed.
- **An app, with the person:** which registry payer to use, or none, and when to spend a credit.
- **A buyer:** whom it buys credits for.

## FAQ

**Why is the registry payer its own service, with its own key?**
It and the fee payer are two money pots. The registry payer is funded by whoever buys its credits;
the fee payer recovers its costs from what it charges. Separate keys keep the accounting apart, and
if one is abused, the other keeps running.

**Why does the front allow only one instruction, when its Kora allows System?**
Kora sees System inside `register`, where the registry creates the row with it. At the top of a
transaction, a System instruction the payer funds could hand its SOL to the person: on devnet,
Kora on `kora.toml` signed a row with a `CreateAccountWithSeed` beside it, which put 660,000 of the
payer's lamports in an account the main key can empty. So the front lets through the one `register`
and nothing beside it.

**Why does the front pass only `getPayerSigner` to its Kora?**
Its Kora signs, for free, anything `kora.toml` allows. Only `/register`'s checks stand between it
and a row with no credit, so nothing else that would sign reaches it.

**Why a key between the front and its Kora?**
Kora 2.0.5 always listens on every interface (`kora-lib`, `src/rpc_server/server.rs`); nothing in it
changes that. Railway's public address reaches only the front's port, but other services in the
same project could reach Kora's over the private network. So its Kora asks every caller for a key
(`KORA_API_KEY`) that `deploy/registry.sh` makes at each start and gives only to the front.

**Why does `kora.toml` list tokens it is never paid in, and a price source?**
Kora 2.0.5 refuses to start without an allowed token, even when it charges nothing. They are
`at-cost/kora.toml`'s own three lines, so `deploy/devnet-config.sh` changes both files the same way.
On mainnet, `price_source = "Jupiter"` would still need `JUPITER_API_KEY` to start.
