# host

Part of Forest's services: [the top README](../README.md).

The foundation's host keeps people's signed records, messages and photos, serves the records and
photos to anyone, and takes each write's price in credits: prepaid units of its writes.

Forest is one seed and its profiles, verified once, with offers and reviews in public that indexes
rank. A host serves two of these: it keeps the folder of each profile a seed gives (every record
that profile's main key signs here), and serves the offers and reviews in it to anyone. The rest it
only carries:

- the stamp proofs on a profile record, which a verifier's stamp (its signature saying it checked
  the person) made possible and readers check (this host checks one only for an inbox that asks
  for it);
- the records an index reads to rank profiles;
- no money but its own credits.

This is one copy, run by the Open Forest Foundation. Anyone can run another; the main way is this
code, or the standard's reference host alone, or one of their own that answers the same requests
([records](https://github.com/foundationforest/standard/blob/main/records/README.md#hosts)).

Of the person's, it keeps copies: the records each of their profiles' main keys signed, a private
one encrypted, each of a profile's rules among them (who may ask the person's signers, the devices
of theirs that hold the seed, to act as that profile); the messages to each inbox, encrypted; and
the blobs each folder put. Anyone can copy a folder out of it; the main way is the person's app
reading every record (`GET /v1/records?profile=<address>`) and every blob
(`GET /v1/blobs/<sha256>`), and posting them to another host. The only thing here about a folder
that no key signed is its balance of credits.

## How it works

The standard's reference host (`@foundationforest/records/host`), unchanged, listens on loopback. In
front of it is one small front. It does three things:

- answers `GET /` with one line saying what this is;
- answers the credit routes ([Credits](#credits));
- passes every other request, untouched, to the reference host.

So the routes are the standard's eight (records in and out, read by GET or POST, messages in and
pulled, blobs in, out and deleted), the four credit routes, and `/`. The reference host checks every
record, message and blob, as the standard says, before it keeps anything.

`src/host.ts` hands the reference host this host's numbers ([How we run it](#how-we-run-it)), three
hooks that charge for writes, and two of the standard's pieces:

- **`recordChoice`** charges a record to its own folder's balance, or refuses it (`refused`, with
  what it costs and what the folder holds). The reference host asks it about every content record,
  and about a hosts record only while the folder holds no record yet, so a folder's first record
  costs a write, whatever it is; it never asks about a hosts record after that, so leaving and
  updating are free.
- **`blobChoice`** takes the standard's blob types, then reserves the bytes' price on the folder
  that puts them. The front takes the price once the reference host answers that it kept them, or
  releases it.
- **`messageChoice`** charges a message whose `from` is its `to` (a profile writing to its own
  inbox, its devices passing things to each other) to that folder's balance, as a record of the
  same size, or refuses it. Others' messages are free, and an inbox takes 1,000 of them a day,
  counted from midnight UTC; past that it refuses them (`refused`) until the next day.
- **`readSender`** reads a sender's records, for a message to an inbox that takes messages only
  from a verifier's stamp holders. It uses the standard's client
  (`readPage`, every page) through the standard's `publicFetch`, so it reaches only public
  addresses and follows no redirect. It keeps what it read for a while, per sender and host. A
  read that fails is not kept: the reference host answers `lookup`, and the sender tries again.
- **`checkStamp`**, the stamp client's (`@foundationforest/stamp`), checks the stamp proof on that
  sender's profile record, as the standard's `stampCheck` gives it. Its key is in the stamp client,
  so the check reads no file and asks no network.

**Taking your own things down is never blocked by money.**

- A record with a null body at a path where a live record stands costs the floor. When the
  balance cannot pay, it goes through free.
- A blob delete that the reference host carries out costs the floor too. The front checks the
  signed delete with the standard's `checkBlobRequest` to find the folder, and reserves the floor
  if the balance holds it. It passes the delete on either way, and takes the floor only if the
  bytes were deleted.
- A null body at a path where nothing stands takes nothing down. It is a write like any other,
  so an empty folder cannot fill paths for free.

**One request for the same bytes at a time.** The front sends on one put or delete of the same
bytes at a time, so a second put of them by the same folder finds them kept and pays nothing.

**Where it keeps things** is the standard's storage, in the data directory (`DATA_DIR`):

- `folders/<address>.sqlite`: one SQLite file per folder, with its records, its inbox and its
  blobs' names;
- `host.sqlite`: the log across them;
- the blobs: in `blobs/`, or in an S3-compatible bucket with `BLOBS=s3`.

The credits keep their own two files in `credits/`:

- `credits.sqlite`: the spent list, the proofs it took, the bill of its sponsors (the keys whose
  tickets pay for a buy, [Credits](#credits)), the balances, and the id of each record and message
  it took a price for;
- `key.der`: the credit key.

### Credits

A credit here is a prepaid unit of this host's writes. The host sells and takes them with the code
in `credits/`; `src/credits.ts` keeps the balances and the price. The buyer's side, what an app
runs to buy and spend them, is `client/client.ts`: the loop buys with it, and so do the verifier's
tests.

**A credit** is a Privacy Pass credit (the IETF's standard for tokens that cannot be tied to their
buy) of type 2, Blind RSA (RFC 9576, RFC 9577, RFC 9578). The host signs it blind, over a number
only the buyer's app knows, so when the credit comes back to be spent the host sees a good signature
and nothing that ties it to the buy.

- Every credit of this host answers one challenge: credit type 2, the host's name (from
  `PUBLIC_ORIGIN`) as its `issuer_name`, no redemption context and no origin info. With no
  context, credits can be bought ahead and kept.
- A credit is these bytes: its type (2 bytes), a nonce (32), the challenge's SHA-256 (32), the
  key's id, SHA-256 of the key (32), and the signature (256). 354 bytes, written in base64url.
- The signature is RSABSSA-SHA384-PSS-Deterministic (RFC 9474) over the first 98 bytes. Each
  signature is Node's own RSA (OpenSSL); privacypass-ts's `Issuer` signs with JavaScript big
  integers, hundreds of times slower.
- A credit's id, on the spent list, is its nonce in hex.

**The credit key** is RSA-2048. The host makes it at its first start, in `credits/key.der` on its
volume (PKCS #8, only its own user may read it), and reads it on every start after. It is in no
setting and no variable.

**Its directory,** `GET /.well-known/private-token-issuer-directory`, is Privacy Pass's
directory as RFC 9578 writes it, with one more field:

```
{ "issuer-request-uri": "/credits/buy",
  "token-keys": [{ "token-type": 2, "token-key": <base64url> }],
  "forest-credit": { "unit": "writes at this host", "price": <decimal text>,
                     "write": <decimal text>, "kilobyte": <decimal text>,
                     "address"?: <Solana address>, "mint"?: <mint address> } }
```

- `price` is one credit's price in dollars.
- `write` and `kilobyte` are what a write costs here, in credits: `write` for each write, and
  `kilobyte` for each 1,000 bytes it stores.
- `address` and `mint` are there only when the host takes a payment on Solana: where it is paid,
  and in which dollar.
- An app takes the latest type 2 key whose `not-before` has passed. This host lists one key, with
  no `not-before`.

**Buying** is four steps:

1. **The buy.** The app makes `n` requests, each the blinded first 98 bytes of a credit to be, in
   one batch, as `draft-ietf-privacypass-batched-tokens` writes it. It keeps each nonce and each
   blinding's inverse to finish later. The buy's reference is SHA-256 of its bytes, written as a
   Solana address.
2. **Pay.** Someone pays for the buy, in one of the ways below.
3. **Get signed.** Anyone holding the buy collects it: its bytes to `POST /credits/buy`, as
   `application/private-token-generic-batch-request`, with the proof in the `Forest-Payment`
   header. The host checks that the proof pays for this buy and answers the `n` blind signatures.
   Signing is deterministic: the same buy collected again with the same proof gets the same
   answer, so a lost answer costs nothing and gives no credit more.
4. **Finish.** The app unblinds each signature, checks it against the host's key, and keeps the
   credits.

**The ways to pay.** A proof pays for one buy: the host keeps which proof paid which reference.
Anyone can buy credits for any folder; the main way is a sponsor's ticket.

- **A sponsor's ticket,** `Forest-Payment: ticket <ticket>`.
  - A sponsor is an Ed25519 key listed in `SPONSORS`: the verifier's sponsor address, whose tickets
    are the welcome gift.
  - The app sends the sponsor the buy's reference. The sponsor signs
    `forest credit ticket\n<origin>\n<reference>\n<n>` in UTF-8, so the ticket pays for that buy at
    this host, of `n` credits, and no other. The ticket is
    `<sponsor's address>.<n>.<signature in base64url>`.
  - The host keeps a bill: how many credits each sponsor's tickets paid for.
- **A dollar payment on Solana,** `Forest-Payment: solana <transaction signature>`, when
  `CREDIT_MINT`, `CREDIT_PAY_TO` and `RPC_URL` are set.
  - Anyone pays it from any wallet app that reads Solana Pay:
    `solana:<address>?amount=<n × price>&spl-token=<mint>&reference=<reference>&label=<host>`.
  - The host checks that one transaction, at finalized, in one `getTransaction` over `RPC_URL`, its
    RPC (the access point it reads the chain through): no error, the buy's reference among its
    accounts, and `address` gained at least `n` × `price` of the dollar, at face value.
  - Unset, only tickets buy, and a Solana proof is answered 503.

The buyer or the sponsor sees the reference, never the credits; the host sees who paid, or which
sponsor, and the blinded buy, never which spends they become.

| Route | What |
|---|---|
| `GET /.well-known/private-token-issuer-directory` | Its directory, above |
| `POST /credits/buy` | A buy's bytes, with what paid for it in the `Forest-Payment` header. Answers its blind signatures, the same each time it is collected with that proof. Refused: `not_a_buy`; `too_many` (over `MAX_BUY`); `bad_payment` (a header it cannot read); `not_paid` (402, with what to pay); `proof_used` (409, the proof paid for another buy); `payment_check_unavailable` (503: no payment on Solana here, or the RPC did not answer) |
| `POST /credits/spend` | `{ folder, credits }`: from 1 to 100 credits, each in base64url. All go into that folder's balance, or none. The answer is `{ folder, credits }`, the balance, a number with up to six decimals. Refused: `bad_request`; `credit` (402: one does not hold, or one is there twice); `spent` (409: one was spent) |
| `GET /credits/balance/<folder>` | `{ folder, credits }`. Refused: `bad_request` (not a folder's address) |

A credit route asked with a method it does not take answers `method` (405), and a POST body over
512 KB answers `too_big` (413).

**A folder's balance** is kept in millionths of a credit, so the fractions of a cent each write
costs add up.

- Anyone can add credits to any folder, a whole credit each; the main way is the person's own app,
  right after a buy. Only that folder's writes draw from it.
- A spend marks its credits spent and adds them to the balance in one transaction: all of it, or
  none.
- The spent list keeps each spent credit's id, and nothing ties it to the folder.

**What a write costs:**

- The floor (`WRITE_FLOOR`), plus what it stores at `PER_KB` for each 1,000 bytes, rounded up to a
  millionth of a credit. What it stores is a record's canonical text, a message's to its own inbox,
  or a blob's bytes.
- A delete costs the floor.
- Each is paid from its own folder's balance.
- A write is paid once: a record, or a message to its own inbox, is claimed by its id in the
  transaction that takes its price, so the same one sent again, or two copies at once, pay once;
  bytes the folder holds already cost nothing again.

## How we run it

Every number here is set in `src/host.ts` (`choice`, `SENDER_READ_MS`, `MESSAGES_A_DAY`),
`src/credits.ts` (`MILLIONTHS`, `KILOBYTE`, `SPEND_MAX`) or by a setting, so moving the standard's
pin cannot change it without a pull request here. Two are the standard's defaults, not set here: the
largest record or message, and the blob types.

- **One credit is one US cent** (`CREDIT_PRICE_CENTS`). Paid on Solana, it is 0.01 of the dollar
  `CREDIT_MINT` names, at face value. On Railway that dollar is Circle's USDC on Solana's devnet,
  the chain things run on today, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, six decimals,
  which anyone gets from [Circle's faucet](https://faucet.circle.com).
- **A write costs 0.01 credit** (`WRITE_FLOOR`), **plus 0.01 credit for each kilobyte** (1,000 bytes)
  **it stores** (`PER_KB`), rounded up to a millionth of a credit.
  - A 1 kB record costs 0.02 credit, a 200 kB photo 2.01, and a 50 MB video 500.01: five dollars.
  - A delete costs the floor, 0.01, and goes through free when the folder cannot pay.
  - A folder's first record, whatever it is, costs what any record does, and is refused when the
    folder cannot pay: joining costs a write. A hosts record after it, which leaves or updates, is
    free.
  - A message to its own inbox costs what a record of its size does. Others' messages are free, up
    to **1,000** an inbox a day (`MESSAGES_A_DAY`), counted from midnight UTC. Reads are free.
  - Both prices are in the directory, where an app reads them.
- **Why these prices:** ten years of keeping at Railway's prices today, plus reads, plus 40%. The
  numbers move when Railway's prices do.
  - At 0.01 credit a kilobyte, a gigabyte costs 10,000 credits, $100.
  - Keeping a gigabyte for ten years costs $18 on Railway's volume ($0.15 a GB a month), where
    records live, and $1.80 in its bucket ($0.015 a GB a month), where blobs live.
  - Take off the 40% and $71 a gigabyte is left. After the keeping, the rest pays for serving each
    byte about 1,070 times from the volume, or about 1,390 times from the bucket, at Railway's $0.05
    a GB out.
  - The floor is the price of one kilobyte: a small write is checked and logged like a large one.
- **Buying:** at most **1,000** credits a buy (`MAX_BUY`), and **100** a spend (`SPEND_MAX`).
  Tickets from the sponsors in `SPONSORS`; we list the verifier's sponsor address, whose tickets are
  a person's first credits. A payment on Solana counts once it is finalized, and only when
  `CREDIT_MINT`, `CREDIT_PAY_TO` and `RPC_URL` are set.
- **Sizes:** records and messages up to **65,536 bytes** each (the standard's default); **100** of
  them a request; **1,000** a page, and at most **4,194,304 bytes** a page, though always one line.
- **Blobs:** png, jpeg and mp4 (the standard's default), up to **50,000,000 bytes** each, kept until
  their folder deletes them.
- **Keeps** a replaced record and a message for **30 days**, by its own clock. A current record stays.
- **Inboxes:** it takes a message for any profile whose profile record here declares an inbox. It
  follows each of the standard's `senders` kinds: anyone, or the holders of a stamp from one
  verifier, checked by the stamp proof on the sender's profile record. It also follows a largest
  size (`maxBytes`).
- **Senders' records:** to take a message for a verifier's stamp holders, it reads the sender's
  records from the host the message names. The read takes at most **5 seconds**, goes only to a
  public address, and follows no redirect. What it read is kept for **60 seconds**
  (`SENDER_CACHE_SECONDS`): at most one read a minute for each sender at each host. A read that
  fails is not kept.
- **Who may write:** anyone can, who pays; the main way is the person's app, posting each record to
  every host its hosts record names. It refuses no write by its own choice but its price, and no
  message but its price and an inbox's day of others' messages; it has no other rate limit.
- **Who may read:** anyone can read any folder here, for free; the main way is an index reading
  every page, or an app reading one profile.
- **No request logs.** Neither the reference host nor the front logs a request or keeps an address.
- **What it keeps for credits:** the spent list (each spent credit's id), each proof it took with
  the buy's reference, how many credits each sponsor paid for, each folder's balance, and the id of
  each record and message it took a price for. Nothing ties a credit to the folder it went into.
- **Where:** one copy on Railway: one replica built from `deploy/Dockerfile`, with this repo's root
  as the build context, and the data directory on its volume. Blobs go in a Railway bucket
  (`BLOBS=s3`).

### Settings

The host's own key, the credit key, is a file on the volume, never a setting. The settings hold
only the bucket's key, the RPC's address and this host's choices.

| Setting | Default | What |
|---|---|---|
| `DATA_DIR` | required | The data directory: the folders, the credits and their key |
| `PUBLIC_ORIGIN` | required | Its public origin, `https://<host>`: the name every credit's challenge carries and every ticket signs, so it must be the address apps use |
| `PORT` | `8080` | |
| `BLOBS` | `disk` | `disk`: blobs in `DATA_DIR/blobs`; `s3`: in a bucket |
| `BLOBS_ENDPOINT`, `BLOBS_BUCKET` | none | The bucket, needed with `s3` |
| `BLOBS_ACCESS_KEY_ID`, `BLOBS_SECRET_ACCESS_KEY` | none | The bucket's key, needed with `s3` |
| `BLOBS_REGION` | `us-east-1` | The region requests are signed for, as the bucket's service names it |
| `BLOBS_STYLE` | `path` | `path` or `virtual`, as the bucket's service asks |
| `CREDIT_PRICE_CENTS` | `1` | One credit's price, in whole US cents |
| `WRITE_FLOOR` | `0.01` | What each write costs, in credits: decimal text, at most six decimals |
| `PER_KB` | `0.01` | What each 1,000 bytes a write stores add, in credits: decimal text, at most six decimals |
| `MAX_BUY` | `1000` | The most credits one buy may ask for |
| `SPONSORS` | none | The sponsors whose tickets pay for a buy, by address, comma-separated |
| `CREDIT_MINT`, `CREDIT_PAY_TO`, `RPC_URL` | none: only tickets buy | The dollar a credit is paid in, by its mint; the address it is paid to; the Solana RPC that checks the payment. All three, or none |
| `SENDER_CACHE_SECONDS` | `60` | How long a sender's records are kept once read; `0`: not kept |

A setting that cannot be read stops the start: a partial bucket, a partial payment, a price that is
not decimal text.

### Run it

```sh
./standard.sh                         # the standard at STANDARD, installed and built
cd host && npm ci                     # the standard's packages by name, linked into standard/
npm run check && npm test
DATA_DIR=./data PUBLIC_ORIGIN=http://127.0.0.1:8080 npm start
```

Node 22.18 or later. The tests (`test/credits.test.ts`) run the real reference host on loopback,
and buy with `test/buyer.ts`, which blinds with privacypass-ts as an app does:

- the price of a 1 kB record (0.02), a 200 kB blob (2.01), and taking each down (0.01); the same
  record or bytes again for nothing; a blob delete that finds nothing, for nothing;
- joining: a folder's first hosts record at its price, and refused with no balance; a later one, an
  update or leaving, taken with none;
- a write refused with no balance, bytes too. With no balance, a live record and a blob are still
  taken down, for nothing, and a null body where nothing stands is refused;
- a message to its own inbox charged as a record, at a flat one credit a write, and refused with
  no balance; someone else's taken free; on the cap's own code, with a cap of 2 and a stand-in
  clock, an inbox taking a day's cap of others' messages, the next refused, another inbox counted
  on its own, and the next UTC day counted again;
- a ticket collected, the same answer twice and billed once. A ticket is refused from a sponsor
  not listed, for another count, or for another buy, and a credit is spent once;
- a payment checked against a stand-in RPC: refused short by one unit, in another dollar, or naming
  another buy; with no payment set, only tickets buy and the directory names no address;
- the credit key made at the first start, readable only by the host's user, and the same at the
  next start;
- end to end: a folder's hosts record, profile record and offer, and a photo, written with credits
  and read back with the standard's client, the balance down by exactly their prices.

What every host must do, and its tests, are the standard's.

## Promises

- **The standard's host, unchanged.** The front adds the line at `/`, the credit routes and the
  price of each write, and nothing else.
- **Taking your own things down is never blocked by money.** A delete of a live record, or of a
  blob the folder holds, goes through when the balance cannot pay its floor.
- **A person can always leave; joining costs a write.** A folder's first record here costs a write,
  whatever it is. Later hosts records, which leave this host or update the list, the reference host
  never asks about, so they are free.
- **No sign-ups.** A folder's balance is just a number next to its address. Nobody logs in: a
  record's signature is its only proof, and a pull's is the profile's main key's.
- **No address logs.** Neither the reference host nor the front logs a request or keeps an
  address. On Railway, Railway's own request logs exist.
- **It cannot tell which buy a credit came from, as long as it gave everyone the same key.** It
  signed the credit blind and never saw its nonce.
- **A credit is spent once, and a buy's credits are signed once.** A second payment for the same
  buy is taken and gives nothing more; collecting a buy again gives the same credits, never more.
- **A write is paid once.** The same record, or the same bytes, sent again cost nothing.
- **Credits are never refunded, and once in a folder never move to another.** One credit is a cent
  of writes here, and nothing anywhere else.

## Limits

- **Anyone who pays can write here** anything the reference host accepts.
- **Others' messages are free, so an inbox open to anyone can be filled.** 1,000 a day reach it,
  and past them the inbox's own friends wait for the next day. The inbox's own fields (a verifier's
  stamp holders only, a largest size) are what limit who may write.
- **Others' messages are free, so they can keep bytes here for free.** A message from any key but
  the profile's own costs nothing: up to 64 KB each, 1,000 an inbox a day, each kept for 30 days, in
  any number of inboxes. The day's count is kept in memory, so a restart counts it again from none.
- **A folder's balance is public.** Anyone who knows its address can ask for it.
- **A credit names nobody, so it is a bearer credit.** That is what makes it unlinkable. Nothing
  stops a person from handing its bytes to someone else, and whoever holds them can spend it.
- **One key for everyone, as far as the app can tell.** The app takes the key from the host's
  directory. A host could give one person a key of their own and so know their credits, and
  blinding holds only when the key is a real RSA key. An app can compare the key with what others
  see; this code cannot prevent it.
- **Not post-quantum.** A large quantum computer could break RSA-2048 and make credits; the host
  would change its key. It could still not link a spend to its buy: blinding hides that from any
  computer.
- **A sponsor's bill is counted, not capped.** A sponsor the host takes can sign for any number of
  buys.
- **The batch is a draft.** `draft-ietf-privacypass-batched-tokens` is not an RFC yet; its encoding
  is the one `privacypass-ts` 0.9.0 writes.
- **The credits code is not audited.**
- **The price is a guess about reads.** Keeping is a small part of it; most of it pays for about a
  thousand reads of every byte over ten years. Bytes read less pay more than they cost, and bytes
  read far more pay less.
- **A stop between storing bytes and taking their price** leaves them kept and unpaid, and one
  between deleting them and taking the floor leaves the delete free. A reservation is held in
  memory, in this one process.
- **It trusts its RPC** for payments. A payment check that fails refuses the buy (503), and the app
  collects it again.
- **Taking a message for a verifier's stamp holders tells the sender's host something:** this host
  asks it for the sender's records, so it sees that this host asked, and when.
- **One machine, one replica.** The folders are files on one volume; more than one machine is a
  change to the standard's storage first.

## Who decides what

- **The standard:** the eight requests, what makes a record, a message and a blob valid, an inbox's
  fields, and the stamp proof.
- **This host, by its own choice:**
  - the numbers above: its prices, what one credit costs, and what is free;
  - which sponsors it takes, and which dollar and RPC a payment is checked in;
  - how long it keeps a sender's records;
  - its logs and its storage;
  - its credit's format: type 2, its challenge, its id, the directory's `forest-credit` entry, the
    buy and its reference, the pay link, the ticket, the headers.
- **Anyone holding a credit:** which folder it goes into.
- **A buyer or a sponsor:** whom it pays for.
- **The person, through their app:** which hosts their hosts record names, and who may send to
  their inbox.

## FAQ

**Why run the standard's host, and not one written here?**
The standard's host is the reference for what a host does. A host written here could drift from it.

**Why a balance per folder, and not a credit shown with each write?**
A write costs a fraction of a credit, and an app should not have to show credits on every write.
The reference host also takes records in batches. A balance takes credits once, through one route,
and every write after draws from it.

**Why are others' messages free, and yours priced?**
A message from someone else is paid by no folder here: the sender's folder usually lives on another
host, and charging it here would mean a sender needs credits at every host it writes to. So it is
free, and capped at 1,000 an inbox a day instead. A message whose `from` is its `to` is a profile
writing to its own inbox, and that folder is here, with a balance of its own: it pays as for any
record it writes, so its own inbox is no free store.

**Why is a null body free over a live record, but not where nothing stands?**
Over a live record it takes something down, and a person can always take down what they put up. A
null body where nothing stands takes nothing down: it is a new record at a new path. If it were free,
an empty folder could write any number of them.

**Why does the host need its own origin?**
Each credit's challenge carries the host's name, and each ticket signs its origin, so a credit and
a ticket count at one host only. The host cannot learn its public name from a request it is sent:
`PUBLIC_ORIGIN` tells it.

**Can I run it at home?**
Yes: the same program on your own machine works the moment it is reachable with an address and
HTTPS, which at home means a tunnel.

**Why Privacy Pass, and why type 2?**
Privacy Pass is the IETF's standard for exactly this, with maintained libraries. Of its two credit
types, type 2 (Blind RSA) fits credits for three reasons:
- anyone can check a type 2 credit with the host's public key, so the app knows what it holds;
  only the host can check a type 1 credit;
- its blinding state is plain bytes, so a buy someone else pays days later can be finished on
  another device;
- it is the type deployed most widely, in Apple's Private Access Tokens and at Cloudflare.

The cost: a credit is 354 bytes rather than 146, and the host makes one RSA signature per credit.

**Why is a credit never refunded?**
A refund pays someone back, so the host would need to know whom, and a credit names nobody.
Refunding would mean linking the credit to its buyer, which is what credits exist to prevent.
