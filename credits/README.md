# credits

Up: [the repo](../README.md).

## What it is

How our host and registry payer sell and take credits, and how our issuer gifts them. It is the
code they share, at one version, and it is open: any operator can run the same, from this code or
their own.

A credit is a prepaid unit for one service, bought once and spent without the service being able
to tell who bought it. A service that sells them says what one buys: for the foundation's registry
payer, one registration; for its host, a cent of storage. Anyone can pay for someone else's
credits, without learning which spends are theirs: that is how an issuer gives its people their
first credits, as a sponsor.

A credit is a Privacy Pass token (RFC 9576, RFC 9577, RFC 9578) of type 2, Blind RSA: the service
signs it blind, over a number only the buyer's app knows, so when the credit comes back to be
spent, the service sees a good signature and nothing that ties it to the buy.

The library in `src/` is built on Cloudflare's `privacypass-ts`, used unchanged. It talks to no
network of its own. On devnet:

| Who | Does what | Where |
|---|---|---|
| host | sells credits (a cent of writes each) and takes them into a folder's balance | [`host/`](../host/README.md#credits) |
| registry payer | sells credits (a registration each) and takes one per registry row | [`fee-payer/registry/`](../fee-payer/registry/README.md#credits) |
| issuer | gifts a person's first credits, as a sponsor: it signs a ticket for each buy | [`issuer/`](../issuer/README.md) |
| the run on devnet | buys, pays, collects and spends them both ways | [`e2e/`](../e2e/README.md) |

## How it works

### A service's key and price

A service that sells credits has an RSA-2048 key, and publishes it in its Privacy Pass issuer
directory, `GET /.well-known/private-token-issuer-directory`, as RFC 9578 writes it, with one
more field:

```
{ "issuer-request-uri": <where a buy goes>,
  "token-keys": [{ "token-type": 2, "token-key": <base64url>, "not-before"?: <Unix seconds> }, …],
  "forest-credit": { "unit": <text>, "address": <Solana address>,
                     "mint": <mint address> | "SOL", "price": <decimal text> } }
```

- `unit` says what one credit buys, in the service's own words. This code never fixes it.
- `price` is one credit's price, in whole units of `mint`, paid to `address`.
- The latest type 2 key whose `not-before` has passed signs new credits. The service counts a key's
  credits for as long as its policy says.

### A credit

- Every credit of one service answers one challenge: token type 2, the service's host as the
  issuer's name, no redemption context and no origin info. With no context, credits can be bought
  ahead and kept.
- A credit is the token: its type (2 bytes), a nonce (32), the challenge's SHA-256 (32), the key's
  id, SHA-256 of the key (32), and the signature (256). 354 bytes, written in base64url.
- The signature is RSABSSA-SHA384-PSS-Deterministic (RFC 9474) over the first 98 bytes. The service
  made it blind: it signed a number the app had blinded, and never saw the nonce.
- A credit's id, on the service's spent list, is its nonce in hex.

### Buying

The app makes a buy, then three steps: pay, get signed, open.

1. **The buy.** `n` requests, each the blinded first 98 bytes of a credit to be, in one batch, as
   `draft-ietf-privacypass-batched-tokens` writes it. The app keeps each nonce, and each blinding's
   inverse: what it needs to finish, kept in the vault
   ([records](https://github.com/foundationforest/standard/blob/main/records/README.md#the-vault)),
   as the app's own data. The buy's reference is SHA-256 of its bytes,
   written as a Solana address.
2. **Pay.** Someone pays for the buy, in one of the ways below, and the app gets the proof.
3. **Get signed.** Anyone holding the buy collects it: a POST of its bytes to the
   `issuer-request-uri`, as `application/private-token-generic-batch-request`, with the proof in
   the `Forest-Payment` header. The service checks that the proof pays for this buy and answers with
   the `n` blind signatures. Signing is deterministic, so the same buy collected again with the
   same proof gets the same answer: a lost answer costs nothing, and gives no credit more.
4. **Open.** The app finishes: it unblinds each signature and checks it against the service's key.
   An answer for another buy, or with an empty slot, finishes nothing, and the app collects again.

### The ways to pay

A proof pays for one buy. The service keeps which proof paid which reference, and refuses a proof
it took for another.

| Way | The header | What the service checks |
|---|---|---|
| A Solana payment | `Forest-Payment: solana <transaction signature>` | That one transaction, at finalized: no error, the buy's reference among its accounts, and the service's `address` gained at least `n` × `price` in `mint` |
| A sponsor's ticket | `Forest-Payment: ticket <ticket>` | A sponsor the service takes signed it, for this service, this buy and its `n` |
| A card session | | Planned, not built |

**A Solana payment.** The buy's pay link is a Solana Pay transfer request:
`solana:<address>?amount=<n × price>[&spl-token=<mint>]&reference=<reference>&label=<host>`.
Anyone pays it, from any wallet app that reads Solana Pay; the payment names the buy by carrying its
reference. The app hands the service the transaction's signature.

**A sponsor's ticket.** A sponsor is a key whose tickets a service takes, by its own policy: an
issuer giving its people their first credits, say. The app sends the sponsor the buy's reference.
The sponsor signs, with Ed25519, `forest credit ticket\n<origin>\n<reference>\n<n>` in UTF-8
(`ticketMessage`): the service's origin, the buy's reference and how many credits it holds, so the
ticket pays for that buy at that service and no other. The ticket is
`<sponsor's address>.<n>.<signature in base64url>` (`ticket`). The service keeps a bill: how many
credits each sponsor's tickets paid for.

### Spending

- A credit is shown on the request whose action it pays for: one in RFC 9577's header,
  `Authorization: PrivateToken token="<credit>"`, or several in the request's body, as a list of
  credits in base64url, up to as many as the service takes in one request.
- The service checks it: type 2, its own challenge, a key it still counts, and the signature
  [`credit`]. Then it holds the id: an id already spent [`spent`], or held by another request in
  flight [`held`], is refused.
- Several shown together are checked, held and spent together: one that does not hold, a credit
  twice, or one spent or held refuses them all, and none is taken.
- A credit counts as spent only once its action lands; then its id joins the spent list. If the
  action fails, or can no longer land, the id is freed and the credit can be shown again, so a
  failed registration can retry.
- What the action is, and when it lands, is each service's to say, with its unit. For the registry
  payer, the action is a registry row, and its README says when it lands.
- The spent list holds ids only.

### Buying for someone else

The person's app hands the buyer the pay link, or a sponsor the buy's reference; the buyer pays, or
the sponsor signs a ticket; the person's app collects and finishes.

- The buyer or the sponsor sees the reference, never the credits.
- The service sees who paid, or which sponsor, and the blinded buy, never which spends they become.
- An issuer gives its people their first credits as a sponsor: a ticket for each buy.

### Use it

| Function | Gives |
|---|---|
| `serviceOf(origin, directory, now?)` | The service, from its directory: the key that counts, where a buy goes, its unit, address, mint and price |
| `buy(service, count)` | The buy's bytes, its reference, its pay link, and `pending`: what to keep to finish |
| `finish(pending, answer)` | The credits, each `{ service, credit }` and checked against the key; refuses any other answer |
| `ticketMessage(origin, reference, n)`, `ticket(sponsor, n, signature)` | What a sponsor signs for a buy, and the ticket it hands the app; `PAYMENT_HEADER` is the header a proof goes in |
| `authorization(credit)`, `creditOf(header)` | The header that shows one credit, and the credit back from it |
| `creditList(credits)` | Several credits as a request's body lists them |
| `checkCredit(credit, { origin, keys })` | For a service: the credit's id, or a refusal |
| `checkCredits(list, { origin, keys }, max)` | For a service: the ids of several credits shown together, at most `max`, or a refusal of them all |
| `creditId(credit)`, `referenceOf(buy)`, `challengeOf(origin)`, `checkPending(value)` | A credit's id; a buy's reference; a service's challenge; a pending buy's shape |

```ts
import { PAYMENT_HEADER, authorization, buy, finish, serviceOf } from '../credits/src/index.ts'

const service = serviceOf(origin, directory)          // its directory, read at DIRECTORY_PATH
const b = await buy(service, 1)                       // keep b.pending in the vault
// Anyone pays b.payLink from a wallet app, or a sponsor signs a ticket for b.reference. Then anyone collects:
const res = await fetch(service.requestUri, { method: 'POST', body: b.buy, headers: {
  'content-type': 'application/private-token-generic-batch-request', [PAYMENT_HEADER]: `solana ${signature}` } })
const credits = await finish(b.pending, new Uint8Array(await res.arrayBuffer()))
// Spend one: fetch(url, { headers: { authorization: authorization(credits[0]) }, … })
```

### Selling credits

A service's side, in `src/service.ts` (Node only, like forest's records host: its seller's file is SQLite):

| Function | Gives |
|---|---|
| `keyFrom(pkcs8)` | The service's credit key from its private key, RSA-2048 in PKCS #8: what it signs with, and the bytes its directory publishes |
| `seller({ origin, key, unit, requestUri, credit, maxBuy, sponsors, rpc, path })` | The service's seller, in one SQLite file: `directory()`, to serve at `DIRECTORY_PATH`; `collect(buy, header)`, the buy's blind signatures once the header's proof pays for it, or a refusal; `spent`, the spent list; `bill()`; and the file, `db`, with `together(work)` for one transaction, so the service keeps its own tables in it |
| `answer(buy, key)` | The blind signatures for a buy: one per request under the key, an empty slot for any other, the same every time |
| `SpentList` | The spent list: `hold` (held, spent or busy), `land`, `free`, each of one id or several together, all or none; and `holds`, what is held now, with the service's note on each. In its own file or the seller's; inside a transaction the service opened, it is part of that one |

`collect` refuses by name:

| Refusal | When |
|---|---|
| `not_a_buy` (400) | The bytes are not a buy |
| `too_many` (400) | It asks for more than `maxBuy` credits |
| `not_paid` (402) | No proof, or one that does not pay for this buy; with what to pay, and where |
| `bad_payment` (400) | A header it cannot read |
| `proof_used` (409) | The proof paid for another buy |
| `payment_check_unavailable` (503) | No RPC, or it did not answer |

A Solana payment costs one call through the RPC the service passes, `getTransaction`. Each
signature is Node's own RSA (OpenSSL), `m^d mod n` checked by `s^e mod n` as RFC 9474 signs; the
privacypass-ts issuer signs with JavaScript big integers, hundreds of times slower.

A service spends a credit this way: `checkCredit` (or, for several, `checkCredits`), then `hold`
its id (or their ids, together) with a note of what to look for, and `land` or `free` it once it
knows whether the action landed; it settles each of `holds()` as its policy says. Nothing in it
logs what it is sent.

### Run it

```
cd credits
npm ci
npm run check   # type-check
npm test        # against a stand-in service made of Cloudflare's own issuer and origin, and the service side against a stand-in RPC
```

Node 22.18 or later. Built from existing pieces, used unchanged: `@cloudflare/privacypass-ts` 0.9.0,
and its `@cloudflare/blindrsa-ts`, for the tokens, the blinding and the batch; Node's own crypto for
a service's RSA signatures and a sponsor's Ed25519; `@scure/base` for base58 and base64url.

## Promises

- **A service cannot tell which buy a credit came from.** It signed the credit blind and never saw
  its nonce (but see Limits).
- **A credit is spent once, and only once its action lands.**
- **A buy is paid once.** Collecting it again gives the same credits, never more.
- **Credits are never refunded, never move between people, and never stand in for money.** One
  credit is one unit of one service, and nothing anywhere else.

## Limits

- **A credit names nobody, so it is a bearer token.** That is what makes it unlinkable. There is
  no way to move a credit here, but nothing stops a person from handing its bytes to
  someone else, and whoever holds them can spend it. Credits are as safe as the vault.
- **Timing and network address.** A service that sees a buy collected and a credit spent moments
  later, or both from one network address, can match them. Wait between them, or use a VPN.
- **One key for everyone.** The app takes the key from the service's directory. A service could give
  one person a key of their own and so know their credits, and blinding holds only when the key is
  a real RSA key. An app can compare the key with what others see; this code cannot rule this
  out.
- **The count can show.** A buy of an unusual number of credits, spent in a burst, is easier to tell
  apart.
- **Not post-quantum.** A large quantum computer could break RSA-2048 and make credits; the service
  would change its key. It could still not link a spend to its buy: blinding hides that from any
  computer.
- **A sponsor's bill is counted, not capped.** A service counts how many credits each sponsor's
  tickets paid for, and limits nothing: a sponsor it takes can sign for any number of buys.
- **The batch is a draft.** `draft-ietf-privacypass-batched-tokens` is not an RFC yet; its encoding
  is the one `privacypass-ts` 0.9.0 writes.
- **Not audited.**

## Who decides what

- **This directory:** the credit (type 2, its challenge, its id), the directory's `forest-credit`
  entry, the buy and its reference, the ways to pay (the pay link, the ticket), the headers, and the
  rules: a proof pays for one buy; spent once, only when the action lands; never refunded. Whoever
  runs another service may use these or their own.
- **A service, by its own policy:** its unit, price, mint and address; which keys it counts and for
  how long; which sponsors it takes; how many credits one buy may hold, and how many one request
  may show; what its action is and when it lands.
- **An app, with the person:** when to buy, how many, and whom to ask to pay.
- **A buyer or a sponsor:** whom it pays for.

## FAQ

**Why Privacy Pass, and why type 2?**
Privacy Pass is the IETF's standard for exactly this, with maintained libraries. Of its two token
types, type 2 (Blind RSA) fits credits for three reasons:
- anyone can check a type 2 token with the service's public key, so the app knows what it holds;
  only the service can check a type 1 token;
- its blinding state is plain bytes, so a buy someone else pays days later can be finished on
  another device, from the vault; `privacypass-ts`'s type 1 client keeps that state in memory only;
- it is the type deployed most widely, in Apple's Private Access Tokens and at Cloudflare.

The cost: a credit is 354 bytes rather than 146, and a service makes one RSA signature per credit.

**Why is a credit never refunded?**
A refund pays someone back, so the service would need to know whom: and a credit names nobody.
Refunding would mean linking the credit to its buyer, which is what credits exist to prevent.
