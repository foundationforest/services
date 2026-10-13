# host

Part of Forest's services: [the top README](../README.md).

A host keeps people's signed records, messages and photos, paid for in credits (prepaid units a
person buys), and serves them to anyone who asks.

The Open Forest Foundation runs this one, on devnet, at https://host.devnet.forest.foundation: the
standard's reference host with the choices in [How we run it](#how-we-run-it). Anyone can run
another, with this code, the standard's host alone, or their own. What every host must do is the
standard's
([records](https://github.com/foundationforest/standard/blob/main/records/README.md#hosts)); this
README says only what this one adds and chooses.


## How it works

The standard's host (`standard/records/src/host.ts`), unchanged, listens on loopback. In front of it, one
thing only: a front that answers `GET /` with one line saying what this is, answers the credit
routes ([Credits](#credits)), and passes every other request, untouched, to the standard's host. So the
routes are the standard's six (records in and out, messages in and pulled, blobs in and out) and four for
credits. The standard's host checks every record, message and blob, as its standard says, before it keeps
anything.

`src/host.ts` hands the standard's host this host's numbers ([How we run it](#how-we-run-it)) and three things of its own:

- **The registry lookup,** when `SOLANA_RPC_URL` is set: whether a key holds a row (the registry's public entry that says a profile holds a note) from an issuer,
  read with the standard's registry client (`fetchRows`, filtered on the key and on the issuer's key as an
  inbox names it: 128 hex characters, x then y). Any such row counts: the registry wrote it only
  after checking the person proof against that issuer's key. The standard's host asks it for an inbox
  (where a profile takes messages) open to one issuer's rows.
- **The sender check** (the standard's `readSender`), always: to take a message a message key (a key
  a profile lists to send messages for it) signed, the standard's host needs the sender's hosts and
  permissions records (where its records live, and which keys may act for it) from the host the
  message names.
  This host reads them with the standard's client (`readPage`, every page) and keeps what it read for a
  while, per sender and host. It reads only from a public address and follows no redirect: the standard's
  public fetch (`publicFetch`, records/src/public.ts) refuses, before connecting, a host whose
  address, written or looked up, is in any range IANA marks as not globally reachable, and follows
  no redirect. A read that fails, or is refused, is not kept: the standard's host answers `lookup`, and the
  sender tries again.
- **The price of each write** (the standard's record, message and blob choices), always: each takes the
  write's price, a floor and its bytes by the kilobyte, from a folder's balance here (a folder is
  what one main key signs on a host), or refuses it (`refused`), saying what it costs and what the
  folder holds ([Credits](#credits)).

**Storage** is the standard's: a data directory (`DATA_DIR`) holding a SQLite file per folder and
`host.sqlite`, the log across them; the blobs go in that directory, or in an S3-compatible bucket
when the `S3_` variables are set. Before it listens, a start makes two moves, each once, and the log
says what each moved:

1. **A single file, moved in.** If `IMPORT_FROM` names a file and the data directory holds no
   `host.sqlite` yet, the standard's import script (`standard/records/scripts/import-single-file.ts`) moves
   that file in, under the same numbers, so the cursors readers hold go on working. It runs into a
   directory beside the data directory, renamed onto it when whole, and never over one that holds
   folders: the start fails instead. The file is left as it was.
2. **Bytes on disk, to the bucket.** With a bucket, blobs left in the data directory move to it,
   under the same names and types, and leave the disk: `host.sqlite` lists which bytes the host
   holds, and bytes left on disk would be listed and never found.

### Credits

A credit here is a prepaid unit of this host, `one cent of writes`. The host sells and takes them
with the code in `credits/`: a copy of the service's side of Forest's credits, trimmed to what the
host uses, on the same wire format as the registry payer's, so one buyer works at both (the
buyer's client in [`e2e/credits/`](../e2e/README.md) is one). `src/credits.ts` keeps the balances
and the price.

**A credit** is a Privacy Pass credit of type 2, Blind RSA (RFC 9576, RFC 9577, RFC 9578): the host
signs it blind, over a number only the buyer's app knows, so when the credit comes back to be
spent, the host sees a good signature and nothing that ties it to the buy.

- Every credit of this host answers one challenge: credit type 2, the host's name as the issuer's
  name, no redemption context and no origin info. With no context, credits can be bought ahead and
  kept.
- A credit is these bytes: its type (2 bytes), a nonce (32), the challenge's SHA-256 (32), the
  key's id, SHA-256 of the key (32), and the signature (256). 354 bytes, written in base64url.
- The signature is RSABSSA-SHA384-PSS-Deterministic (RFC 9474) over the first 98 bytes. The host
  made it blind: it signed a number the app had blinded, and never saw the nonce. Each signature is
  Node's own RSA (OpenSSL); privacypass-ts's issuer signs with JavaScript big integers, hundreds of
  times slower.
- A credit's id, on the spent list (the ids of the credits already spent), is its nonce in hex.

**Its directory,** `GET /.well-known/private-token-issuer-directory`, is Privacy Pass's issuer
directory as RFC 9578 writes it, with one more field:

```
{ "issuer-request-uri": "/credits/buy",
  "token-keys": [{ "token-type": 2, "token-key": <base64url> }],
  "forest-credit": { "unit": "one cent of writes", "address": <Solana address>,
                     "mint": <mint address> | "SOL", "price": <decimal text>,
                     "write": <decimal text>, "kilobyte": <decimal text> } }
```

`price` is one credit's price, in whole units of `mint`, paid to `address`. `write` and `kilobyte`
are what a write costs here, in credits: `write` for each write, and `kilobyte` for each 1,000 bytes
of it ([How we run it](#how-we-run-it)); the registry payer's directory has neither. An app takes
the latest type 2 key whose `not-before` has passed; this host lists one key, with no
`not-before`.

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
   header. The host checks that the proof pays for this buy and answers the `n` blind signatures.
   Signing is deterministic, so the same buy collected again with the same proof gets the same
   answer: a lost answer costs nothing, and gives no credit more.
4. **Finish.** The app finishes the buy: it unblinds each signature, checks it against the host's
   key, and keeps the credits. An answer for another buy, or with an empty slot, finishes nothing,
   and the app collects again.

**The ways to pay.** A proof pays for one buy: the host keeps which proof paid which reference, and
refuses a proof it took for another.

- **A Solana payment,** `Forest-Payment: solana <transaction signature>`. The buy's pay link is a
  Solana Pay transfer request,
  `solana:<address>?amount=<n × price>[&spl-token=<mint>]&reference=<reference>&label=<host>`,
  which anyone pays from any wallet app that reads Solana Pay. The host checks that one
  transaction, at finalized, in one `getTransaction`: no error, the buy's reference among its
  accounts, and `address` gained at least `n` × `price` in `mint`.
- **A sponsor's ticket,** `Forest-Payment: ticket <ticket>`. A sponsor is a key listed in
  `SPONSORS`, such as the issuer's, that pays for other people's buys. The app sends the sponsor
  the buy's reference; the sponsor signs, with Ed25519,
  `forest credit ticket\n<origin>\n<reference>\n<n>` in UTF-8, so the ticket pays for that buy at
  this host, of `n` credits, and no other. The ticket is
  `<sponsor's address>.<n>.<signature in base64url>`. The host keeps a bill: how many credits each
  sponsor's tickets paid for.

The buyer or the sponsor sees the reference, never the credits; the host sees who paid, or which
sponsor, and the blinded buy, never which spends they become.

| Route | What |
|---|---|
| `GET /.well-known/private-token-issuer-directory` | Its directory, above |
| `POST /credits/buy` | A buy's bytes, with what paid for it in the `Forest-Payment` header. Its blind signatures, the same each time it is collected with that proof. Refused: `not_a_buy`, `too_many` (over `CREDITS_PER_BUY`), `bad_payment` (a header it cannot read), `not_paid` (402, with what to pay), `proof_used` (409, the proof paid for another buy), `payment_check_unavailable` (503, the RPC did not answer, or there is none) |
| `POST /credits/spend` | `{ folder, credits }`: from 1 to 100 credits, each in base64url, as the credits client's `creditList` writes them, all go into that folder's balance, or none; the answer is `{ folder, credits }`, the balance, a number with up to six decimals. Refused: `bad_request` (with `from 1 to 100 credits` when the list is empty or longer), `credit` (402: one does not hold, or one is there twice: its type, this host's challenge, its key and its signature, `checkCredits` in `credits/credit.ts`), `spent` or `held` (409: one is spent, or held by another request) |
| `GET /credits/balance/<folder>` | `{ folder, credits }`, `credits` a number with up to six decimals |

**A folder's balance** is kept in millionths of a credit, so the fraction of a cent each write
costs adds up. Anyone holding credits can add them to any folder, a whole credit each; only that
folder's writes draw from it. A spend holds its credits, spends them and adds them to the balance
in one transaction: all of it, or none. The spent list keeps each spent credit's id, and nothing
ties it to the folder. A balance this host kept in whole credits, before writes cost fractions of
one, is counted in millionths at the next start, once.

**What a write costs:** `WRITE_PRICE` for the write, plus its bytes at `KILOBYTE_PRICE` for each
1,000 bytes, rounded up to a millionth of a credit. The bytes are the record's or the message's
canonical text, or the blob's own. A record is paid from its own folder's balance, and a message
from its sender's. Bytes (a photo or a video) are paid by a folder whose current records here name
them: the first such folder whose balance holds the price. The standard's host never asks about a hosts or permissions record, so
those are free: a person can always move and always remove an access key (a key the person's app
gave someone, such as their assistant, to act for a profile). A record, a message or bytes already
here cost nothing again. A write is paid once, and a write that becomes current stays as long as
it is current.

**A write costs exactly its price or nothing.**

- **A record or a message** is charged before it is stored: its price is taken, and the write
  claimed by its id, in one transaction; then the standard's host stores it. A second copy in
  flight at once, or the same write sent again after a stop between its price and its store, costs
  nothing.
- **Bytes** are reserved, stored, then charged. Their price is reserved on the folder, so no other
  write can spend it; the standard's host keeps them; then the price is taken. If they are not
  kept, the reservation is released. The front sends on one put of the same bytes at a time, so a
  second copy finds them kept and pays nothing.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | none: a temporary directory, removed on stop | The data directory |
| `IMPORT_FROM` | none | A single SQLite file to move in, when there is no `host.sqlite` yet |
| `PORT` | `8080` | |
| `PUBLIC_ORIGIN` | required | Its public origin, `https://<host>`: the name every credit's challenge carries, so it must be the address apps use |
| `CREDIT_KEY` | required | Its credit key: RSA-2048, PKCS #8 DER, in base64, as `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \| openssl pkcs8 -topk8 -nocrypt -outform DER \| base64 -w0` writes one. Read once and removed from the environment |
| `CREDIT_ADDRESS` | required | The address a credit is paid to |
| `CREDIT_MINT` | required | The dollar a credit is paid in, by its mint, or `SOL` |
| `CREDIT_PRICE` | required | One credit's price, decimal text in whole dollars |
| `WRITE_PRICE` | `0.01` | What each write costs, in credits: decimal text, at most six decimals |
| `KILOBYTE_PRICE` | `0.001` | What each 1,000 bytes of a write add, in credits: decimal text, at most six decimals |
| `CREDITS_PER_BUY` | `1000` | The most credits one buy may ask for |
| `SPONSORS` | none | The sponsors whose tickets pay for a buy, by address, comma-separated |
| `SOLANA_RPC_URL` | none: no lookup, and no buy paid on Solana | The Solana RPC the registry lookup reads and a Solana payment is checked through |
| `REGISTRY_PROGRAM_ID` | the devnet registry | The registry the lookup reads |
| `SENDER_CACHE_SECONDS` | `60` | How long a sender's records are kept once read; `0`: not kept |
| `S3_ENDPOINT`, `S3_BUCKET` | none: blobs on disk | The bucket |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none | The bucket's key |
| `S3_REGION` | `us-east-1` | The region requests are signed for, as the bucket's service names it |
| `S3_STYLE` | `path` | `path` or `virtual`, as the bucket's service asks |

The bucket takes all four of its first variables, or none: any `S3_` variable without all four
stops the start. The credit settings are all needed: without one, the host does not start, so it is
never free by mistake. The two prices have defaults, so they are never unset. Its credits are kept in one file, `credits/credits.sqlite` in the data
directory: the spent list, the proofs it took, its sponsors' bill, the balances, and the id of each
write it took a price for. An older host kept the balances in a second file,
`credits/balances.sqlite`; a start moves them into the one file, once. A spend that older host
stopped halfway, between its two files, is settled then: its credits count as spent if the older
host had marked them so, and are free to show again if not.

### Run it

```sh
./standard.sh keys records registry/client
(cd e2e && npm ci)
cd host && npm ci
npm test
DATA_DIR=./data/host npm start
```

The test checks:

- `/` says what this is, and every other path is the standard's host, with these choices; a request whose
  URL cannot be read (`//`) gets 400, and the host goes on.
- The settings, the credit settings each needed, and a credit key that is not PKCS #8 refused
  without being echoed; records in and back out through the front, for the whole host and by
  profile.
- The standard's single-file fixture moves in once, under the same numbers, and never over a directory
  that holds folders; with a bucket (a stand-in on loopback that checks the standard's signature, in
  region `auto`), its bytes go straight there, and bytes an earlier start left on disk move there.
- The lookup counts a row of the sender's with the issuer's key on it, and no other; a message to
  an inbox open to one issuer's rows is taken with the lookup and refused without it.
- A message key's message is taken while the sender's host lists the key, still taken within the
  cache time once it is past, refused (`permission`) after, and refused (`lookup`) when the named
  host does not answer; a past message key's pull is refused at once.
- The sender check: an address that is not public is refused, written or looked up (`localhost`),
  before anything is sent; a message key's message is refused (`lookup`) when its sender's host is
  on loopback, or redirects.
- Credits, through the routes: the directory; a buy refused with no payment, with one the RPC does
  not have, over the most a buy may hold, with no RPC, or not a buy; collected twice with its
  payment, the same answer; finished with the buyer's credits client, and spent into a folder, one or
  several in a request, each once, with every refusal, none taken when one is refused; the balance;
  a page's preflight.
- Credits, the code in `credits/` (`test/credits.test.ts`): the key from PKCS #8; the directory as
  the buyer's client reads it; a buy answered byte for byte as privacypass-ts's own issuer answers it, and
  under another key an empty slot, nothing logged; a Solana payment checked in one call (short by
  one unit, another mint, a failed transaction, no reference, SOL, a reference from a lookup
  table); a sponsor's ticket as the issuer signs it (`issuer/src/ticket.ts`), refused from another
  sponsor, for another count, service or buy, and billed once; every refusal; the check of a
  spend's list, all or none, and of a changed byte, another key or another service's credit; the
  spent list across a restart and inside the balance's transaction.
- What writes cost, at the prices this host runs with: both published in the directory; the price of
  0, 1, 1,000, 1,001 and 5,000,000 bytes; a hosts and a permissions record taken with nothing in
  the balance; a record refused with the price in its words, then taken from one credit, nothing for
  one already here; twenty records whose fractions add up to the millionth, and the balance answered
  in credits; bytes of two megabytes and one refused short, taken once paid, nothing again; bytes two
  folders name, through one that can pay; a message from its sender, never its recipient.
- Who pays and how often, at a whole credit a write (`WRITE_PRICE=1`, `KILOBYTE_PRICE=0`), so these
  tests count in credits:
  a write costs exactly its price or nothing: two copies of one message in flight at once, paid
  once; a record paid before a stop, kept free when sent again; two copies of one blob, paid once;
  two blobs and a balance for one, one kept and paid and the balance never below zero; a reservation
  a record cannot spend; a bucket that refuses every put, nothing paid.
- One file: an older host's balances, and a spend it cut short, moved in once; balances kept in
  whole credits counted in millionths, once.

### On devnet

The build context is the repo root; `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`standard.sh records registry/client`, and `npm ci`). Railway, project `forest-devnet`, service `host`,
at https://host.devnet.forest.foundation:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=host/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080, health check `/`.
- **Variables:** `DATA_DIR=/data/host`, `IMPORT_FROM=/data/host.sqlite`, `PORT=8080`,
  `SENDER_CACHE_SECONDS=60`, `SOLANA_RPC_URL` (Helius's devnet RPC, whose URL holds the key), and
  Railway's bucket by reference: `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` (`auto`),
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_STYLE=virtual`.
- **Credits:** `PUBLIC_ORIGIN=https://host.devnet.forest.foundation`, `CREDIT_KEY` (secret, an
  RSA-2048 key made for it), `CREDIT_ADDRESS=2JuNCurwpbDj4YDaMEPQprnGod5cAJFZrAdqHVQogyr9` (the
  devnet `host` key's address, from the devnet phrase by the recipe in standard's
  `devnet/deploy.sh` scripts; the host never signs with it),
  `CREDIT_MINT=J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` (the classic test dollar),
  `CREDIT_PRICE=0.01`, `SPONSORS=FAWrifUUu84ck7tS5SVzNsQzzVamjx3JwzkDNhX3em86` (the issuer's sponsor key, whose tickets give a
  person's first credits); `WRITE_PRICE` and `KILOBYTE_PRICE` unset, so 0.01 and
  0.001.

The devnet index reads it ([`index/lists/hosts.json`](../index/lists/hosts.json)), and mcp
([`mcp/`](../mcp/README.md)) starts there when it is given no host (it reads that list).

## How you pay us

You pay for writes in credits. A credit is a cent: on devnet, 0.01 of the classic test dollar. A
write costs a hundredth of a cent, plus a thousandth of a cent for each kilobyte (1,000 bytes) in
it: a text record or a message of about a kilobyte costs about 0.011 cent, so one cent pays for
about ninety of them, and a 5 MB photo costs about 5 cents. Each is taken from the balance of the
folder it belongs to, which keeps the fractions of a cent. Hosts and permissions records are free.
A write is paid once.

You buy credits with a payment, or with a sponsor's ticket (someone else, such as the issuer,
signing to pay for your buy). The host signs credits blind, so it cannot tell which buy a credit
came from. The details: [Credits](#credits).

## How we run it

Every number here is set in `src/host.ts` (`choice`, `SENDER_READ_MS`, `WRITE_PRICE`, `KILOBYTE_PRICE`), `src/credits.ts` (`MILLIONTHS`, `KILOBYTE`, `SPEND_MAX`) or by a setting,
so moving the standard's pin cannot change it without a pull request here; two are the standard's defaults,
not set here: the largest record or message, and the blob types.

- **Sizes:** records and messages up to **65,536 bytes** each (the standard's default); **100** of them a
  request; **1,000** a page, and at most **4,194,304 bytes** a page, though always one line.
- **Photos and videos (blobs):** png, jpeg and mp4 (the standard's default), up to **50,000,000 bytes**
  each.
- **The price of a write:** **0.01 credit** a write (`WRITE_PRICE`), plus **0.001 credit** a
  kilobyte of it, 1,000 bytes (`KILOBYTE_PRICE`), rounded up to a millionth of a credit: a 1 KB
  record or message about 0.011 credit, a 5 MB photo about 5.01. Both are in the directory, where
  an app reads them. A hosts or permissions record is free. Paid from a folder's balance here, kept
  in millionths of a credit: a record's own folder, a message's sender, bytes any folder that names
  them.
- **One credit is one cent:** **0.01** of the classic test dollar on devnet, a placeholder, paid to
  the devnet `host` key's address. At most **1,000** credits a buy, and **100** a spend (`SPEND_MAX`).
  A payment counts once it is finalized.
- **No free tier; reads are free.** A write is paid once and, while it is current, kept for as
  long as we run the host. How keeping gets paid for in the long run is not settled; when it is,
  it is a change here, applied to new writes.
- **Inboxes:** it takes a message for any profile whose card here declares an inbox, under each of
  the standard's rules: anyone, one issuer's rows (through the registry lookup; without an RPC, refused as
  `rule_unsupported`), one message per sender, and a largest size.
- **Message keys:** it takes a message a message key signed. It reads the sender's records from the
  host the message names within **5 seconds**, only at a public address and with no redirect, and
  keeps what it read for **60 seconds** on devnet: one read a sender a minute, at most, and a past
  key stops within it.
- **Keeps** a replaced record, a message, and bytes no current record names any more for **30
  days**, by its own clock. A current record stays.
- **Who may write:** anyone who pays, records, messages and bytes. It refuses no write by a rule
  of its own but its price, and has no rate limit.
- **Where it keeps things:** a SQLite file per folder and one log across them, on the volume; blob
  bytes in an S3-compatible bucket. When one machine is not enough, the standard's records say the way
  ("When it grows").
- **No request logs.** Neither the standard's host nor the front logs a request or keeps an address.
- **What it keeps for credits:** the spent list (each spent credit's id), each proof it took with the
  buy's reference, how many credits each sponsor paid for, each folder's balance, and the id of each
  write it took a price for.
  Nothing ties a credit to the folder it went into.
- **Providers, on devnet:** Railway runs it, with a volume and a Railway bucket; the registry
  lookup and the payment check read Helius's devnet RPC.

## Promises

- **The standard's host, unchanged.** The front adds the line at `/` and the credit routes, and nothing
  else.
- **No sign-ups:** a folder's balance is just a number next to its address. Nobody logs in: a record's signature is its only proof, and a pull's is the profile's main key's or a message
  key's.
- **No address logs.** Neither the standard's host nor the front logs a request or keeps an address. On
  Railway, Railway's own request logs exist.
- **It cannot tell which buy a credit came from.** It signed the credit blind and never saw its
  nonce (but see Limits).
- **A credit is spent once.**
- **A buy is paid once.** Collecting it again gives the same credits, never more.
- **Credits are never refunded, never move between people, and never stand in for money.** One
  credit is one cent of writes here, and nothing anywhere else.

## Limits

- **Anyone can write records and messages here who pays,** anything the standard's host accepts.
- **A balance is never refunded,** and never moves to another folder.
- **A network address can tie a buy to a folder.** The foundation runs this host and the issuer
  that buys a person's first credits; a buy collected and spent into a folder from one network
  address can be matched, and the issuer knows whose buy it paid. An app that spends over a VPN
  makes that harder.
- **A credit names nobody, so it is a bearer credit.** That is what makes it unlinkable. There is
  no way to move a credit here, but nothing stops a person from handing its bytes to someone else,
  and whoever holds them can spend it. Credits are as safe as the vault.
- **One key for everyone.** The app takes the key from the host's directory. A host could give one
  person a key of their own and so know their credits, and blinding holds only when the key is a
  real RSA key. An app can compare the key with what others see; this code cannot rule this out.
- **The count can show.** A buy of an unusual number of credits, spent in a burst, is easier to
  tell apart.
- **Not post-quantum.** A large quantum computer could break RSA-2048 and make credits; the host
  would change its key. It could still not link a spend to its buy: blinding hides that from any
  computer.
- **A sponsor's bill is counted, not capped.** A sponsor the host takes can sign for any number of
  buys.
- **The batch is a draft.** `draft-ietf-privacypass-batched-tokens` is not an RFC yet; its encoding
  is the one `privacypass-ts` 0.9.0 writes.
- **The credits code is not audited.**
- **Hosts and permissions records are free, on purpose:** a person can always leave a host or
  revoke a key with an empty balance.
- **A stop between storing bytes and taking their price** leaves them kept and unpaid.
- **Two different messages from one sender to an inbox that takes one from each,** in flight at
  once, may both pay, though the standard's host keeps one: it checks that rule after the price.
- **On devnet it may be wiped at any time,** and with it every record the e2e runs left.
- **One machine, one replica.** The folders are files on one volume; more than one machine is a
  change to the standard's storage first.
- **It trusts its RPC** for the registry lookups and for payments. A lookup that fails refuses the
  message (`lookup`), and the sender sends it again; a payment check that fails refuses the buy
  (503), and the app collects it again.
- **A past message key can still send here for up to 60 seconds:** until what this host read of
  the sender's records expires. Its pulls stop at once.
- **Taking a message key's message tells the sender's host something:** this host asks it for the
  sender's records, so it sees that this host asked, and when.
- **A host that holds one person's profiles links them;** a shared host is the crowd.

## Who decides what

- **The standard:** the six requests, what makes a record, a message and a blob valid, and
  the inbox's rules.
- **This host, by its own choice:** the numbers above, its price and what one credit buys, which
  sponsors it takes, the RPC it asks, how long it keeps a sender's records, its logs and its
  storage; and its credit's format (type 2, its challenge, its id, the directory's `forest-credit`
  entry, the buy and its reference, the pay link, the ticket, the headers), which it keeps the same
  as the registry payer's, so one buyer works at both.
- **Anyone holding a credit:** which folder it goes into.
- **A buyer or a sponsor:** whom it pays for.
- **The person, through their app:** which hosts their hosts record names, who may write to their
  inbox, and which message keys may send for them.

## FAQ

**Why run the standard's host, and not one written here?**
The standard's host is the reference for what a host does. A host written here could drift from it, and
the e2e run would test the wrong thing.

**Why a balance per folder, and not a credit shown on each write?**
A write costs a fraction of a credit, and an app should not have to show credits on every write.
The standard's host also takes records and messages in batches, and an app rewrites its vault often. A
balance takes credits once, through one route, and every write after draws from it.

**Can I run it at home?**
Yes: the same program on your own machine works the moment it is reachable with an address and
HTTPS, which at home means a tunnel.

**Why Privacy Pass, and why type 2?**
Privacy Pass is the IETF's standard for exactly this, with maintained libraries. Of its two credit
types, type 2 (Blind RSA) fits credits for three reasons:
- anyone can check a type 2 credit with the host's public key, so the app knows what it holds;
  only the host can check a type 1 credit;
- its blinding state is plain bytes, so a buy someone else pays days later can be finished on
  another device, from the vault; `privacypass-ts`'s type 1 client keeps that state in memory only;
- it is the type deployed most widely, in Apple's Private Access Tokens and at Cloudflare.

The cost: a credit is 354 bytes rather than 146, and the host makes one RSA signature per credit.

**Why is a credit never refunded?**
A refund pays someone back, so the host would need to know whom: and a credit names nobody.
Refunding would mean linking the credit to its buyer, which is what credits exist to prevent.
