# registry payer

Part of Forest's services: [the top README](../../README.md).

The registry payer pays for a person's registry row (the registry's public entry that says a profile
holds a note) against one credit (a prepaid unit it sells), which anyone can buy for them.

The Open Forest Foundation runs this one, on devnet. Anyone can run another, from this code or
their own: whoever signs a transaction as payer pays for it, and the registry cares nothing for who
that is
([the standard](https://github.com/foundationforest/standard/blob/main/README.md#for-builders)).


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

A credit here is a prepaid unit of this registry payer, `one registration`. It sells and takes
them with the code in `credits/`: a copy of the service's side of Forest's credits, trimmed to what
the registry payer uses, on the same wire format as the host's, so one buyer works at both (mcp's
client, [`mcp/`](../../mcp/README.md#credits)).

**A credit** is a Privacy Pass credit of type 2, Blind RSA (RFC 9576, RFC 9577, RFC 9578): the
registry payer signs it blind, over a number only the buyer's app knows, so when the credit comes
back to be spent, it sees a good signature and nothing that ties it to the buy.

- Every credit of this registry payer answers one challenge: credit type 2, its host name as the
  issuer's name, no redemption context and no origin info. With no context, credits can be bought
  ahead and kept.
- A credit is these bytes: its type (2 bytes), a nonce (32), the challenge's SHA-256 (32), the
  key's id, SHA-256 of the key (32), and the signature (256). 354 bytes, written in base64url.
- The signature is RSABSSA-SHA384-PSS-Deterministic (RFC 9474) over the first 98 bytes. The
  registry payer made it blind: it signed a number the app had blinded, and never saw the nonce.
  Each signature is Node's own RSA (OpenSSL); privacypass-ts's issuer signs with JavaScript big
  integers, hundreds of times slower.
- A credit's id, on the spent list (the ids of the credits already spent), is its nonce in hex.

**Its directory,** `GET /.well-known/private-token-issuer-directory`, is Privacy Pass's issuer
directory as RFC 9578 writes it, with one more field:

```
{ "issuer-request-uri": "/credits/buy",
  "token-keys": [{ "token-type": 2, "token-key": <base64url> }],
  "forest-credit": { "unit": "one registration", "address": <Solana address>,
                     "mint": <mint address> | "SOL", "price": <decimal text> } }
```

`price` is one credit's price, in whole units of `mint`, paid to `address`
([How we run it](#how-we-run-it)). An app takes the latest type 2 key whose `not-before` has
passed; this registry payer lists one key, with no `not-before`.

**Buying** is four steps:

1. **The buy.** The app makes `n` requests, each the blinded first 98 bytes of a credit to be, in
   one batch, as `draft-ietf-privacypass-batched-tokens` writes it. It keeps each nonce and each
   blinding's inverse, what it needs to finish, in the vault (the person's own folder for what the
   seed alone cannot give back,
   [records](https://github.com/foundationforest/standard/blob/main/records/README.md#the-vault)).
   The buy's reference is SHA-256 of its bytes, written as a Solana address.
2. **Pay.** Someone pays for the buy, in one of the two ways below.
3. **Get signed.** Anyone holding the buy collects it: its bytes to `POST /credits/buy`, as
   `application/private-token-generic-batch-request`, with the proof in the `Forest-Payment`
   header. The registry payer checks that the proof pays for this buy and answers the `n` blind
   signatures. Signing is deterministic, so the same buy collected again with the same proof gets
   the same answer: a lost answer costs nothing, and gives no credit more.
4. **Finish.** The app finishes the buy: it unblinds each signature, checks it against the
   registry payer's key, and keeps the credits. An answer for another buy, or with an empty slot,
   finishes nothing, and the app collects again.

**The ways to pay.** A proof pays for one buy: the registry payer keeps which proof paid which
reference, and refuses a proof it took for another.

- **A Solana payment,** `Forest-Payment: solana <transaction signature>`. The buy's pay link is a
  Solana Pay transfer request,
  `solana:<address>?amount=<n × price>[&spl-token=<mint>]&reference=<reference>&label=<host>`,
  which anyone pays from any wallet app that reads Solana Pay. The registry payer checks that one
  transaction, at finalized, in one `getTransaction`: no error, the buy's reference among its
  accounts, and `address` gained at least `n` × `price` in `mint`.
- **A sponsor's ticket,** `Forest-Payment: ticket <ticket>`. A sponsor is a key listed in
  `SPONSORS`, such as the issuer's, that pays for other people's buys. The app sends the sponsor
  the buy's reference; the sponsor signs, with Ed25519,
  `forest credit ticket\n<origin>\n<reference>\n<n>` in UTF-8, so the ticket pays for that buy at
  this registry payer, of `n` credits, and no other. The ticket is
  `<sponsor's address>.<n>.<signature in base64url>`. The registry payer keeps a bill: how many
  credits each sponsor's tickets paid for.

The buyer or the sponsor sees the reference, never the credits; the registry payer sees who paid,
or which sponsor, and the blinded buy, never which spends they become.

`POST /credits/buy` checks, and refuses by name:

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
   `Authorization: PrivateToken token="<credit>"`, as RFC 9577 shows one (mcp's `authorization`).

It checks, in this order, and refuses by name at the first that fails:

| Check | Refusal |
|---|---|
| The body is `{ transaction }` and nothing else | `bad_request` (400) |
| The transaction decodes, whole, with nothing after it | `bad_transaction` (400) |
| It is one instruction, `register`, to the registry, with a whole label and its four accounts (the row, the main key, the payer, System); the registry payer pays its fee and is the row's payer; no address lookup table and no other account | `not_one_registration` (400) |
| The main key it names signed it | `not_signed_by_main_key` (400) |
| The request shows a credit | `no_credit` (401) |
| The credit is this registry payer's: its type, its challenge, its key, its signature (`checkCredit` in `credits/credit.ts`) | `credit` (402) |
| The row does not exist yet | `row_exists` (409) |
| The credit is not spent | `spent` (409) |
| No other request holds it now | `held` (409) |

Then the credit is held, with the row's address and the transaction's blockhash, and:

1. the registry payer signs the transaction as payer;
2. one simulation must pass, or the credit is freed and the answer is `row_refused` (400), with the
   simulation's error: a row that would fail costs nothing, not even a network fee;
3. **the lamport cap** (a lamport is the smallest unit of SOL): beyond the network fee, the
   registry payer pays for nothing but the row's rent, the deposit Solana holds to keep the row
   (`getMinimumBalanceForRentExemption` for the row's size, which its label sets). It adds up every
   System instruction in the simulation that takes from the registry payer; one the RPC could not
   read counts as too much. Over the cap, the credit is freed and the answer is `over_cap` (400);
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
| `CREDIT_MINT` | yes | | The dollar a credit is paid in, by its mint, or `SOL` |
| `CREDIT_PRICE` | yes | | One credit's price, decimal text in whole dollars |
| `CREDITS_PER_BUY` | no | `10` | The most credits one buy may ask for |
| `SPONSORS` | no | none | The sponsors whose tickets pay for a buy, by address, comma-separated |
| `REGISTRY_PROGRAM` | yes | | The registry a row is written by |
| `RPC_URL` | yes | | The Solana RPC it checks payments, simulates, sends and watches rows through. It must return inner instructions from `simulateTransaction`, parsed |
| `DATABASE_PATH` | no | `./data/credits.sqlite` | Its seller's one file: the spent list, the proofs it took, its sponsors' bill |
| `PORT` | no | `8080` | The registry payer's one address |

### Run it

```
./standard.sh registry/client records                           # from the repo root
(cd mcp && npm ci)                                              # from the repo root
(cd fee-payer/registry && npm ci && npm run check && npm test)   # real credits, a stand-in RPC; seconds
```

The tests buy real credits with mcp's credits client, paid on Solana and by a sponsor's ticket as
the issuer signs one (`issuer/src/ticket.ts`), collect and finish them, register with them, and
check every refusal above, nothing held or sent for any of them; a credit held before its row is
sent, spent once the row exists, freed once the row is absent and its blockhash expired; one settle
round at a time; and a hold kept across a restart. `test/credits.test.ts` checks the code in
`credits/` on its own: the key from PKCS #8; the directory as mcp's client reads it; a buy answered
byte for byte as privacypass-ts's own issuer answers it, and under another key an empty slot,
nothing logged; a Solana payment checked in one call (short by one unit, another mint, a failed
transaction, no reference, SOL, a reference from a lookup table); a ticket refused from another
sponsor, for another count, service or buy, and billed once; every refusal; one credit read from
the Authorization header; a changed byte, another key or another service's credit refused; and the
spent list across a restart.

### On devnet

`deploy/registry.Dockerfile` builds one image from Node's image: the registry payer, its
`credits/`, and the standard's `registry/client` at the commit in `STANDARD`. Before the first row, its
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

## How you pay us

One credit pays for one registration. You buy credits with a payment, or with a sponsor's ticket
(someone else, such as the issuer, signing to pay for your buy). The registry payer signs credits
blind, so it cannot tell which buy a credit came from. A credit you show is spent once the row
exists on chain; if the row never lands, the credit is yours to show again. The details:
[Credits](#credits) and [When a credit is spent](#when-a-credit-is-spent).

## How we run it

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
- **It cannot tell which buy a credit came from.** It signed the credit blind and never saw its
  nonce (but see Limits).
- **A buy is paid once.** Collecting it again gives the same credits, never more.
- **Credits are never refunded, never move between people, and never stand in for money.** One
  credit is one registration here, and nothing anywhere else.

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
- **A credit names nobody, so it is a bearer credit.** That is what makes it unlinkable. There is
  no way to move a credit here, but nothing stops a person from handing its bytes to someone else,
  and whoever holds them can spend it. Credits are as safe as the vault.
- **A network address can link.** A buy collected and a credit spent from one network address can
  be matched. Use a VPN.
- **One key for everyone.** The app takes the key from the registry payer's directory. A registry
  payer could give one person a key of their own and so know their credits, and blinding holds only
  when the key is a real RSA key. An app can compare the key with what others see; this code cannot
  rule this out.
- **The count can show.** A buy of an unusual number of credits, spent in a burst, is easier to
  tell apart.
- **Not post-quantum.** A large quantum computer could break RSA-2048 and make credits; the
  registry payer would change its key. It could still not link a spend to its buy: blinding hides
  that from any computer.
- **The batch is a draft.** `draft-ietf-privacypass-batched-tokens` is not an RFC yet; its encoding
  is the one `privacypass-ts` 0.9.0 writes.
- **The credits code is not audited.**
- **It trusts its RPC,** for a payment, a simulation, and whether a row exists.
- **What it collects sits under its signing key,** in the key's own token account; nothing moves it
  but someone holding the key.
- **Address logs.** A hosting provider's own request logs are the operator's choice; on Railway
  they exist, with each request's client address and path.

## Who decides what

- **The standard's registry:** it takes no fee and cares nothing for who pays.
- **This registry payer, by its own choice:** what it pays for, its price, dollar and address, which
  sponsors it takes, how many credits a buy may hold, and when a row has landed; and its credit's
  format (type 2, its challenge, its id, the directory's `forest-credit` entry, the buy and its
  reference, the pay link, the ticket, the headers), which it keeps the same as the host's, so one
  buyer works at both.
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

**Why Privacy Pass, and why type 2?**
Privacy Pass is the IETF's standard for exactly this, with maintained libraries. Of its two credit
types, type 2 (Blind RSA) fits credits for three reasons:
- anyone can check a type 2 credit with the registry payer's public key, so the app knows what it
  holds; only the registry payer can check a type 1 credit;
- its blinding state is plain bytes, so a buy someone else pays days later can be finished on
  another device, from the vault; `privacypass-ts`'s type 1 client keeps that state in memory only;
- it is the type deployed most widely, in Apple's Private Access Tokens and at Cloudflare.

The cost: a credit is 354 bytes rather than 146, and the registry payer makes one RSA signature per
credit.

**Why is a credit never refunded?**
A refund pays someone back, so the registry payer would need to know whom: and a credit names
nobody. Refunding would mean linking the credit to its buyer, which is what credits exist to
prevent.
