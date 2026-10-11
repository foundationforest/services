# registry payer

The registry payer pays for a person's registry row against one credit, which anyone can buy for
them.

The foundation runs this one, on devnet. Anyone can run another, from this code or their own:
whoever signs a transaction as payer pays for it, and the registry cares nothing for who that is
([standard](https://github.com/foundationforest/standard/blob/main/README.md#for-builders)).

Up: [the fee payer's folder](../README.md).

## How it works

### One address, one program

The registry payer is one address, its own key, and one program of ours (`src/`), which signs
every row it pays for and sends it itself:

```
         GET  /.well-known/private-token-issuer-directory   its credit key and price
  app ──▶ POST /credits/buy    a paid buy, answered with its credits
         POST /register       one row and one credit ──▶ signed, simulated, sent ──▶ Solana
         POST / (getPayerSigner), GET /liveness            its address; that it runs
```

It shares nothing with the [fee payer](../README.md) in the same folder: its own key, its own
address, its own container.

### Credits

A credit here is a [Forest credit](../../credits/README.md)
whose unit is `one registration`. It sells and spends them with the seller in
[`credits/`](../../credits/README.md), unchanged
([Selling credits](../../credits/README.md#selling-credits)).

**Its directory,** `GET /.well-known/private-token-issuer-directory`, names its credit key, where a
buy goes (`/credits/buy`), and its `forest-credit` entry: the unit, the address a credit is paid
to, the token and one credit's price ([Policy](#policy)).

**Buying.** The app makes a buy of `n` credits (standard's `buy`), and it is paid in one of two
ways: anyone pays its pay link, `n` × the price to the registry payer's address naming the buy's
reference, and hands over the transaction's signature; or a sponsor in `SPONSORS` signs a ticket
for it. Then anyone posts the buy's bytes to `POST /credits/buy`, with the proof in the
`Forest-Payment` header. It checks the proof (a Solana payment in one `getTransaction` at
finalized), and answers with the `n` blind signatures, the same each time the buy is collected with
that proof. The app finishes the credits and keeps them.

| Check | Refusal |
|---|---|
| The bytes are a buy | `not_a_buy` (400) |
| It asks for at most `CREDITS_PER_BUY` credits | `too_many` (400) |
| The header is `solana <signature>` or `ticket <ticket>` | `bad_payment` (400) |
| The proof pays for this buy: the transaction is finalized, names its reference and pays for every credit; or the ticket is a listed sponsor's, for this buy and its count | `not_paid` (402), with what to pay, to whom |
| The proof paid for no other buy | `proof_used` (409) |
| The RPC answers | `payment_check_unavailable` (503) |

### Registering

The person's device:

1. builds the row's transaction with the registry payer as payer (`getPayerSigner` at its address
   names it), and signs it with the main key;
2. sends it to `POST /register`, as `{ transaction }` in base64, with one credit in
   `Authorization: PrivateToken token="<credit>"`.

It checks, in this order, and refuses by name at the first that fails:

| Check | Refusal |
|---|---|
| The body is `{ transaction }` and nothing else | `bad_request` (400) |
| The transaction decodes, whole, with nothing after it | `bad_transaction` (400) |
| It is one instruction, `register`, to the registry, with a whole label and its four accounts (the row, the main key, the payer, System); the registry payer pays its fee and is the row's payer; no address lookup table and no other account | `not_one_registration` (400) |
| The main key it names signed it | `not_signed_by_main_key` (400) |
| The request shows a credit | `no_credit` (401) |
| The credit is this registry payer's: its challenge, its key, its signature (standard's `checkCredit`) | `credit` (402) |
| The row does not exist yet | `row_exists` (409) |
| The credit is not spent | `spent` (409) |
| No other request holds it now | `held` (409) |

Then the credit is held, with the row's address and the transaction's blockhash, and:

1. the registry payer signs the transaction as payer;
2. one simulation must pass, or the credit is freed and the answer is `row_refused` (400), with the
   simulation's error: a row that would fail costs nothing, not even a network fee;
3. **the lamport cap:** beyond the network fee, the registry payer may fund no more than the row's
   rent (`getMinimumBalanceForRentExemption` for the row's size, from its label): every System
   instruction the simulation ran with the registry payer as source counts, and one the RPC did not
   parse counts as too much. Otherwise the credit is freed and the answer is `over_cap` (400);
4. it sends the transaction and answers `{ signature }`. If the RPC does not take it, the answer is
   `not_sent` (502), and the credit stays held: it may have gone out.

An RPC that does not answer before the credit is held, or during the simulation, is
`rpc_unavailable` (503), and the credit is free.

### When a credit is spent

One rule: a credit is spent once its row exists on chain. One settle round at a time, the next
three seconds after the last ends, it looks at each credit it holds, through its RPC, at
`confirmed`:

- **the row exists:** the credit is spent, for good;
- **no row, and its blockhash expired:** the credit is freed. The blockhash is asked first, so a row
  absent after it expired can never land;
- **otherwise,** or the RPC does not answer: the credit waits for the next round.

Holds are kept in its file, so a restart settles them. No clock decides anything.

### Settings

`src/main.ts`:

| Variable | Required | Default | What |
|---|---|---|---|
| `FOREST_FEE_PAYER_KEY` | yes | | Its own key: the Solana CLI's JSON array of 64 numbers, or a path to that file outside this repo. Read once at start and removed from the environment |
| `PUBLIC_ORIGIN` | yes | | Its public origin, `https://<host>`: the name every credit's challenge carries, so it must be the address apps use |
| `CREDIT_KEY` | yes | | Its credit key: RSA-2048, PKCS #8 DER, in base64, as `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \| openssl pkcs8 -topk8 -nocrypt -outform DER \| base64 -w0` writes one. Read once at start and removed from the environment |
| `CREDIT_ADDRESS` | yes | | The address a credit is paid to |
| `CREDIT_MINT` | yes | | The token a credit is paid in, or `SOL` |
| `CREDIT_PRICE` | yes | | One credit's price, decimal text in whole tokens |
| `CREDITS_PER_BUY` | no | `10` | The most credits one buy may ask for |
| `SPONSORS` | no | none | The sponsors whose tickets pay for a buy, by address, comma-separated |
| `REGISTRY_PROGRAM` | yes | | The registry a row is written by |
| `RPC_URL` | yes | | The Solana RPC it checks payments, simulates, sends and watches rows through. It must return inner instructions from `simulateTransaction`, parsed |
| `DATABASE_PATH` | no | `./data/credits.sqlite` | Its seller's one file: the spent list, the proofs it took, its sponsors' bill |
| `PORT` | no | `8080` | The registry payer's one address |

### Run it

```
./standard.sh registry/client                            # from the repo root
(cd credits && npm ci)                                   # from the repo root
(cd fee-payer/registry && npm ci && npm run check && npm test)   # real credits, a stand-in RPC; seconds
```

The tests buy real credits, paid on Solana and by a sponsor's ticket, collect and finish them,
register with them, and check every refusal above, nothing held or sent for any of them; a credit
held before its row is sent, spent once the row exists, freed once the row is absent and its
blockhash expired; one settle round at a time; and a hold kept across a restart.

### On devnet

`deploy/registry.Dockerfile` builds one image from Node's image: the registry payer, with
standard's `registry/client` and `credits` at the commit in `STANDARD`. Before the first row, its
key needs SOL for the deposits it funds.

The foundation's registry payer runs that image on Railway, service `registry payer`, at
https://registry-payer.devnet.forest.foundation.

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=fee-payer/deploy/registry.Dockerfile`.
- **One replica,** health check `GET /liveness`, a public domain to port 8080, a volume at `/data`
  for its file.
- **Signs as** a key of its own, `7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA`: a random key made for it, not mixed
  from the devnet phrase; **credits are paid to** the same address, in the classic test dollar.

| Variable | On devnet | Secret |
|---|---|---|
| `FOREST_FEE_PAYER_KEY` | its random key, as its JSON array | yes |
| `RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `CREDIT_KEY` | an RSA-2048 key made for it | yes |
| `PUBLIC_ORIGIN` | `https://registry-payer.devnet.forest.foundation` | no |
| `CREDIT_ADDRESS` | `7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA` | no |
| `CREDIT_MINT` | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa`, the classic test dollar | no |
| `CREDIT_PRICE` | `0.5` | no |
| `REGISTRY_PROGRAM` | `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4` | no |
| `SPONSORS` | `CS5PvzxdfYuvaTWzfoCZmSLWK8bF91vQqwzbRxrDeBwW`, the issuer's sponsor key | no |
| `DATABASE_PATH` | `/data/credits.sqlite` | no |
| `PORT` | `8080` | no |

## Policy

- **One program of ours, with its own key,** signing and sending each row it pays for.
- **Rows only:** one `register` in a transaction and nothing else, the row under any issuer and any
  label; two signatures; a row that already exists refused before anything is held.
- **The cap:** beyond the network fee, the row's rent for its size, at the RPC's rent; checked in one
  simulation before it sends.
- **One credit, one registration,** at 0.5 of the classic test dollar on devnet (`CREDIT_PRICE`), a
  placeholder. It covers a row's deposit with margin.
- **At most ten credits a buy** (`CREDITS_PER_BUY`).
- **Paid by a Solana payment, at finalized, or a sponsor's ticket** (`SPONSORS`). It counts each
  sponsor's credits, its bill, and caps nothing.
- **A credit is spent once its row exists on chain,** and freed if the simulation fails, or once its
  blockhash expired with no row.
- **One credit key,** in `CREDIT_KEY`. Its credits count for as long as it is the key.
- **The float:** the SOL in its own key, apart from the fee payer's. Nothing refills it but a person;
  when it runs out, simulations fail, rows are refused, and their credits freed. The dollars credits
  are paid in sit under the same key; turning them into SOL is done by hand, not by code.
- **No API key for callers.** A page in a browser cannot keep a secret; every row needs a credit.
- **No request logs:** it logs nothing.
- **What it keeps:** its seller's file, for as long as it runs: each spent credit's id, with no time
  and no main key; for a credit held now, until it settles, the row's address and blockhash and
  when; each proof it took, with the buy's reference; and how many credits each sponsor paid for.
- **Where it runs:** Railway, one container, one replica; Helius's devnet RPC.

## Promises

- **It pays only for registry rows:** one per credit, and a credit is spent only once its row
  lands.
- **It holds no key of the person's.** The person signs on their own device; the registry payer adds
  only its own signature as payer.
- **Its key can do one thing in a transaction:** fund a new account, a registry row.
- **No accounts.**
- **It keeps no network address.** It logs nothing.
- **Nothing it keeps ties a spent credit to its row,** or a credit to its buy: the spent list holds
  each spent credit's id alone.

## Limits

- **What bounds it.** A payer that pays for anyone is a faucet. This one pays only for a registry
  row, and a row's deposit stays in the row, which never closes; nobody can move it out but
  `refund`, which sends only what a cut in Solana's rent frees, and only to the payer the row
  records. So nobody takes SOL out of it; they can only make it lock SOL up in rows, one per credit,
  and each credit is paid for.
- **On devnet credits are paid in a test dollar,** which its maker mints at will, so credits are
  unlimited there, and nothing bounds rows but the float.
- **No rate limit.** Every buy collected with a Solana payment costs an RPC call, and every row shown
  costs a credit's check and, past it, two RPC calls and a simulation.
- **A row that fails on chain after its simulation passed** costs the registry payer its network
  fee; its credit is freed once its blockhash expires.
- **A row another payer writes first,** while this one's is in flight, spends this one's credit:
  the row exists.
- **Uniqueness is per label, by design.** One person holds at most one row per label, market and
  role, at one issuer; every other label is another row, and another credit
  ([standard's registry](https://github.com/foundationforest/standard/blob/main/registry/README.md)).
- **One container.** When it stops, the registry payer stops, until the hosting platform starts it
  again.
- **A credit is a bearer token, and timing can link.** A buy collected and a credit spent moments
  later, from one network address, can be matched
  ([credits, Limits](../../credits/README.md#limits)).
- **It trusts its RPC,** for a payment, a simulation, and whether a row exists.
- **What it collects sits under its signing key,** in the key's own token account; nothing moves it
  but someone holding the key.
- **Address logs.** A hosting provider's own request logs are the operator's choice; on Railway
  they exist, with each request's client address and path.

## Who decides what

- **`credits/`:** the credit, its directory entry, the buy, the ways to pay, and the rules: a
  proof pays for one buy; a credit is spent once, only when its action lands, and never refunded.
  The registry takes no fee and cares nothing for who pays.
- **This registry payer, by its policy:** what it pays for, its price, token and address, which
  sponsors it takes, how many credits a buy may hold, and when a row has landed.
- **An app, with the person:** which registry payer to use, or none, and when to spend a credit.
- **A buyer or a sponsor:** whom it pays for.

## FAQ

**Why is the registry payer its own service, with its own key?**
It and the fee payer are two money pots. The registry payer is funded by whoever buys its credits;
the fee payer recovers its costs from what it charges. Separate keys keep the accounting apart, and
if one is abused, the other keeps running.

**Why only one instruction, when the registry calls System inside it?**
The registry creates the row with System, inside its own call. At the top of a transaction, a System
instruction the payer funds could hand its SOL to the person: on devnet, a Kora that allowed System
signed a row with a `CreateAccountWithSeed` beside it, which put 660,000 of the payer's lamports in
an account the main key can empty. So it pays for the one `register` and nothing beside it.

**Why no Kora, when the fee payer is Kora?**
A Kora pays for whatever its rules allow, so this one needed a program of ours in front of it and a
key between the two: two processes in one container. Every check that mattered was already the
program's; what Kora added, a simulation and a cap on what the payer spends, is two RPC calls here.
