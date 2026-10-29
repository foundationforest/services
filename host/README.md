# host

Part of Forest's services: [the top README](../README.md).

The foundation's host keeps profiles' folders, their entries, their inboxes and the files their
entries name, serves the entries and files to anyone, and takes each write's price in credits:
prepaid units of its writes.

Forest is one seed and its profiles, verified, with offers and reviews in public that indexes
rank. A host serves two of these: it keeps the folder of each profile a seed gives (every entry
signed for that profile here, by its main key or an access key its profile entry lists), and serves
the offers and reviews in it to anyone. The rest it only carries:

- the verifications on a profile entry, which a verifier's stamp (its signature saying it checked
  the person) made possible and readers check;
- the entries an index reads to rank profiles;
- no money but its own credits.

This is one copy, run by the Open Forest Foundation. Anyone can run another; the main way is this
code, or one of their own that answers the same requests, the plug, and passes the standard's host
check ([folders](https://github.com/foundationforest/standard/blob/main/folders/README.md#hosts)).

Of the person's, it keeps copies: the entries signed for each of their profiles, a locked one as an
envelope only the keys it was locked to open; the inbox entries left in each folder, locked too; and
the files their current entries name. Anyone can copy a folder out of it; the main way is the
person's app reading every entry (`POST /v1/entries/read`) and every file (`GET /v1/files/<sha256>`),
and writing them to another host. The only thing here about a folder that no key signed is its
balance of credits.

## How it works

Two parts, in one process:

- **The plug** (`src/plug.ts`, over `src/storage.ts`): the seven requests every host answers
  ([folders](https://github.com/foundationforest/standard/blob/main/folders/README.md#hosts)):
  entries in, and out, one folder's by POST or everyone's by GET; inbox entries in, and listed;
  files in and out. It checks every entry, inbox entry and file as the standard says before it
  keeps anything, and listens on loopback.
- **The front** (`src/host.ts`), the only part the internet reaches. It does three things:
  - answers `GET /` with one line saying what this is;
  - answers the credit routes ([Credits](#credits));
  - passes every other request, untouched, to the plug.

So the routes are the standard's seven, the four credit routes, and `/`. The standard's host check
(`@foundationforest/folders/check`) shows the whole host fits the plug: its tests run it, and anyone
runs it against the deployed copy ([Run it](#run-it)).

**Who writes for a folder.** The plug takes an entry when the folder's main key signed it, or an
access key the folder's current profile entry here lists with `write`; one by any other key is
refused (`unlisted`), and no access key writes the profile entry. At each path it keeps the entry
that counts and is newest, as every reader works it out (the standard's `viewFolder`). An access key
removed from the profile entry stops counting, and its entries with it: at each path it wrote, the
newest entry that still counts is current again.

`src/host.ts` hands the plug this host's numbers ([How we run it](#how-we-run-it)) and three hooks:

- **`entryChoice`** charges an entry to its own folder's balance, or refuses it (`refused`, with what
  it costs and what the folder holds). The plug asks it about every entry but the profile entry, and
  about a profile entry only while it holds no entry of that folder yet, so a folder's first entry
  costs a write, whatever it is; it never asks about a profile entry after that, so leaving and
  updating are free.
- **`fileChoice`** takes the plug's file types, then reserves the bytes' price on a folder whose
  current entry names them: the newest naming entry's folder first, then the next, until one holds
  the price. The front takes it once the plug answers that it stored them, or releases it.
- **`inboxChoice`** takes 1,000 inbox entries an inbox a day, counted from midnight UTC; past that it
  refuses them (`refused`) until the next day. Inbox entries cost nothing: the sender and the message
  are locked inside, so the host cannot tell whose an inbox entry is, and no folder here could be
  asked to pay for it.

**Inboxes.** The plug takes an inbox entry for any folder whose profile entry here has `openKey`,
from anyone, and lists a folder's inbox to anyone, after a cursor: only the envelopes protect it. It
checks no sender and no signature inside: that is the recipient's app's. Nobody deletes an inbox
entry: it goes after the keep days.

**Files.** A file is the bytes an entry's body names in `files`, by their SHA-256, type and size. The
plug takes them only while a current entry here names them with that type and size, and keeps them
while one does; once none does, for its keep days. Bytes several folders name are stored once.

**Taking your own things down is never blocked by money.**

- An entry with a null body at a path where a live entry stands costs the floor. When the balance
  cannot pay, it goes through free.
- A null body at a path where nothing stands takes nothing down. It is a write like any other, so
  an empty folder cannot fill paths for free.

**One upload of the same bytes at a time.** The front sends on one upload of the same bytes at a
time, so a second finds them stored and pays nothing.

**Where it keeps things** is `src/storage.ts`'s, in the data directory (`DATA_DIR`):

- `folders/<address>.sqlite`: one SQLite file per folder, with its entries and its inbox. With the
  host stopped, deleting a folder's file removes that folder; the next prune dates the files only it
  named, which go keep days later.
- `host.sqlite`: the log, which numbers every folder's entries in the order taken; which files each
  folder's current entries name; and which files are stored. It holds nothing that exists only there
  but when each stored file stopped being named: `rebuild(dir)` makes it again, and dates at the
  rebuild each stored file no current entry names. A new number, an entry's or an inbox entry's, is
  the larger of the last one plus 1 and the clock in microseconds, so a rebuilt `host.sqlite`, or a
  folder's file made again, never reuses one, unless the clock is set back.
- the files: in `files/`, or with `FILES=s3` in a bucket of any S3-compatible service. It serves only
  the bytes `host.sqlite` lists as stored.
- A folder file in any layout but this one's, that of a host from before folders among them, is
  refused and left as it was.
- A folder file it cannot open is left out of the feed and the prune, which go on with the rest
  and log one line for it: its error, any address taken out. Its own read answers 500. A host may
  withhold an entry, never forge one.

The credits keep their own two files in `credits/`:

- `credits.sqlite`: the spent list, the proofs it took, the bill of its sponsors (the keys whose
  tickets pay for a buy, [Credits](#credits)), the balances, and the id of each entry it took a price
  for;
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
                     "write": <decimal text>, "kilobyte": <decimal text> } }
```

- `price` is one credit's price in dollars.
- `write` and `kilobyte` are what a write costs here, in credits: `write` for each write, and
  `kilobyte` for each 1,000 bytes it stores.
- An app takes the latest type 2 key whose `not-before` has passed. This host lists one key, with
  no `not-before`.

**Buying** is four steps:

1. **The buy.** The app makes `n` requests, each the blinded first 98 bytes of a credit to be, in
   one batch, as `draft-ietf-privacypass-batched-tokens` writes it. It keeps each nonce and each
   blinding's inverse to finish later. The buy's reference is SHA-256 of its bytes, in base58.
2. **Pay.** A sponsor pays for the buy with a ticket (below).
3. **Get signed.** Anyone holding the buy collects it: its bytes to `POST /credits/buy`, as
   `application/private-token-generic-batch-request`, with the proof in the `Forest-Payment`
   header. The host checks that the proof pays for this buy and answers the `n` blind signatures.
   Signing is deterministic: the same buy collected again with the same proof gets the same
   answer, so a lost answer costs nothing and gives no credit more.
4. **Finish.** The app unblinds each signature, checks it against the host's key, and keeps the
   credits.

**How a buy is paid.** A proof pays for one buy, since a ticket signs that buy's reference: the host
keeps each proof it took, so a buy collected again is billed once.
Anyone can buy credits for any folder; the main way is a sponsor's ticket, the only way this host
takes today. Other ways to pay for credits are this host's to add.

- **A sponsor's ticket,** `Forest-Payment: ticket <ticket>`.
  - A sponsor is an Ed25519 key listed in `SPONSORS`: the verifier's sponsor address, whose tickets
    are the welcome gift.
  - The app sends the sponsor the buy's reference. The sponsor signs
    `forest credit ticket\n<origin>\n<reference>\n<n>` in UTF-8, so the ticket pays for that buy at
    this host, of `n` credits, and no other. The ticket is
    `<sponsor's address>.<n>.<signature in base64url>`.
  - The host keeps a bill: how many credits each sponsor's tickets paid for.

The buyer or the sponsor sees the reference, never the credits; the host sees which sponsor paid,
and the blinded buy, never which spends they become.

| Route | What |
|---|---|
| `GET /.well-known/private-token-issuer-directory` | Its directory, above |
| `POST /credits/buy` | A buy's bytes, with what paid for it in the `Forest-Payment` header. Answers its blind signatures, the same each time it is collected with that proof. Refused: `not_a_buy`; `too_many` (over `MAX_BUY`); `bad_payment` (a header that is no ticket); `not_paid` (402, with what to pay) |
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
  millionth of a credit. A write is an entry, which stores its canonical text, or a file, which
  stores its bytes.
- A delete costs the floor.
- An entry is paid from its own folder's balance; a file from the balance of a folder whose current
  entry names it.
- A write is paid once: an entry is claimed by its id in the transaction that takes its price, so
  the same one sent again, or two copies at once, pay once; bytes stored already cost nothing again.

## How we run it

Every number here is set in `src/host.ts` (`choice`, `INBOX_A_DAY`), `src/plug.ts` (its `DEFAULT_*`
numbers), `src/credits.ts` (`MILLIONTHS`, `KILOBYTE`, `SPEND_MAX`) or by a setting, all in this
directory, so nothing outside it changes one.

- **One credit is one US cent** (`CREDIT_PRICE_CENTS`).
- **A write costs 0.01 credit** (`WRITE_FLOOR`), **plus 0.01 credit for each kilobyte** (1,000 bytes)
  **it stores** (`PER_KB`), rounded up to a millionth of a credit.
  - A 1 kB entry costs 0.02 credit, a 200 kB photo 2.01, and a 50 MB video 500.01: five dollars.
  - A delete costs the floor, 0.01, and goes through free when the folder cannot pay.
  - A folder's first entry, whatever it is, costs what any entry does, and is refused when the
    folder cannot pay: joining costs a write. A profile entry after it, which leaves or updates, is
    free.
  - Inbox entries are free, up to **1,000** an inbox a day (`INBOX_A_DAY`), counted from midnight
    UTC. Inbox reads are free.
  - Both prices are in the directory, where an app reads them.
- **Why these prices:** ten years of keeping at Railway's prices today, plus reads, plus 40%. The
  numbers move when Railway's prices do.
  - At 0.01 credit a kilobyte, a gigabyte costs 10,000 credits, $100.
  - Keeping a gigabyte for ten years costs $18 on Railway's volume ($0.15 a GB a month), where
    entries live, and $1.80 in its bucket ($0.015 a GB a month), where files live.
  - Take off the 40% and $71 a gigabyte is left. After the keeping, the rest pays for serving each
    byte about 1,070 times from the volume, or about 1,390 times from the bucket, at Railway's $0.05
    a GB out.
  - The floor is the price of one kilobyte: a small write is checked and logged like a large one.
- **Buying:** at most **1,000** credits a buy (`MAX_BUY`), and **100** a spend (`SPEND_MAX`).
  Tickets from the sponsors in `SPONSORS`, the only way this host takes today; we list the
  verifier's sponsor address, whose tickets are a person's first credits. Other ways to pay for
  credits are this host's to add.
- **Sizes:** entries up to **50,000,000 bytes** each in UTF-8, as a file (`choice`): each write is
  paid by the byte. Inbox entries up to **65,536 bytes** (`DEFAULT_MAX_INBOX_BYTES`): they are free,
  and others leave them in your folder. **100** lines a request, its body at most a full batch of
  the largest inbox entries, or one largest entry, so a batch of large entries gets 413 and the
  client sends it again in halves; **1,000** a page, and at most **4,194,304 bytes** a page, though
  always one line. A read request is at most 1,024 bytes.
- **Files:** png, jpeg and mp4 (`DEFAULT_FILE_TYPES`), up to **50,000,000 bytes** each, kept while a
  current entry here names them. A declared size over that is answered 413, unread.
- **Keeps** an entry that stopped being current or counting, an inbox entry, and a file no current
  entry names any more for **30 days**, by its own clock, and prunes every hour. A current entry
  stays.
- **Inboxes:** it takes an inbox entry for any folder whose profile entry here has `openKey`, from
  anyone, and lists any inbox to anyone.
- **A request** has **60 seconds** to arrive in full; past that it gets 408.
- **Its speed:** on one core of the machine this was written on, it checks and stores about **175
  entries a second**, and serves about 9,800 (`npm run bench`). Pure JavaScript checks about 235
  signatures a second there.
- **Its storage:** one process, a SQLite file per folder and `host.sqlite` beside them, in the data
  directory on its volume; files in the bucket ([How it works](#how-it-works)).
- **Who may write:** anyone can, who pays, with the folder's main key or an access key its profile
  entry lists with `write`; the main way is the person's app, writing each entry to every host its
  profile entry names. It refuses no write by its own choice but its price, and no inbox entry but
  an inbox's day; it has no other rate limit.
- **Who may read:** anyone can read any folder here, and list any inbox, for free; the main way is an
  index reading every page, or an app reading one profile.
- **No request logs.** Neither the plug nor the front logs a request or keeps an address. A request
  it answers 500 logs one line: its path and the error's message, any address in them taken out. A
  folder file the feed or the prune cannot open logs one line too: its error, any address taken out.
- **What it keeps for credits:** the spent list (each spent credit's id), each proof it took, how
  many credits each sponsor paid for, each folder's balance, and the id of
  each entry it took a price for. Nothing ties a credit to the folder it went into.
- **Where:** one copy on Railway: one replica built from `deploy/Dockerfile`, with this repo's root
  as the build context, and the data directory on its volume. Files go in a Railway bucket
  (`FILES=s3`).

### Settings

The host's own key, the credit key, is a file on the volume, never a setting. The settings hold
only the bucket's key and this host's choices.

| Setting | Default | What |
|---|---|---|
| `DATA_DIR` | required | The data directory: the folders, the credits and their key |
| `PUBLIC_ORIGIN` | required | Its public origin, `https://<host>`: the name every credit's challenge carries and every ticket signs, so it must be the address apps use |
| `PORT` | `8080` | |
| `FILES` | `disk` | `disk`: files in `DATA_DIR/files`; `s3`: in a bucket |
| `FILES_ENDPOINT`, `FILES_BUCKET` | none | The bucket, needed with `s3` |
| `FILES_ACCESS_KEY_ID`, `FILES_SECRET_ACCESS_KEY` | none | The bucket's key, needed with `s3` |
| `FILES_REGION` | `us-east-1` | The region requests are signed for, as the bucket's service names it |
| `FILES_STYLE` | `path` | `path` or `virtual`, as the bucket's service asks |
| `CREDIT_PRICE_CENTS` | `1` | One credit's price, in whole US cents |
| `WRITE_FLOOR` | `0.01` | What each write costs, in credits: decimal text, at most six decimals |
| `PER_KB` | `0.01` | What each 1,000 bytes a write stores add, in credits: decimal text, at most six decimals |
| `MAX_BUY` | `1000` | The most credits one buy may ask for |
| `SPONSORS` | none | The sponsors whose tickets pay for a buy, by address, comma-separated |

A setting that cannot be read stops the start: a partial bucket, a price that is not decimal text.

### Run it

```sh
./standard.sh                         # the standard at STANDARD, installed and built
cd host && npm ci                     # the standard's packages by name, linked into standard/
npm run check && npm test
DATA_DIR=./data PUBLIC_ORIGIN=http://127.0.0.1:8080 npm start
npm run bench                         # its speed on this machine
SEED=<64 hex characters> npm run check-host -- https://host.forest.foundation
```

Node 22.18 or later.

**The host check against the deployed copy.** `npm run check-host -- <origin>` runs the
standard's own host check (`standard/folders/scripts/check-host.ts`, unchanged) against a host. It
writes from two profiles of one seed, under `check/a` and `check/b`, and an access key it makes, and
prints each check: ok, unchecked, or FAILED, exiting 1 if any failed. This host charges every write,
so with a new seed it refuses the first one by its own choice, and the check says the rest is
unchecked. To check it all, give it `SEED`, 64 hex characters, whose two folders hold credits here:
buy a few credits ([Credits](#credits)) and spend some into each folder's balance
(`POST /credits/spend`) first. At this host's prices, the first run costs `check/a` about 0.14
credit and `check/b` about 0.03, joining included, and each run after about 0.09 and nothing.

The tests, on loopback:

- `test/check.test.ts`: the standard's host check against the plug alone, every check ok; and
  against the whole host with credits: a new seed stops at its first write, refused for credits,
  with nothing failed, and a seed whose two folders hold credits passes every check.
- `test/plug.test.ts`, `test/files.test.ts`, `test/inbox.test.ts` and `test/storage.test.ts`: the
  plug's own tests.
  - Keep days and the prune: what a version replaced goes after them, a delete stays, and an access
    key's entry goes keep days after its key is removed, or counts again if listed again before.
  - The socket: 404, 405, a cursor that is no whole number, a read body with a field it does not know
    or no folder, a GET of everyone's with any query but `after`, a target that is no path, 408.
  - What it refuses: a forged entry, one signed by a key that is not the main key, one by an access
    key not listed with `write`, a profile entry by an access key, one dated ahead, one not
    canonical; and its sizes, batches and pages.
  - A host's own choice for entries, files and inbox entries: joining can cost, and a later profile
    entry is never asked about.
  - Files: taken only while a current entry names them, with that type and size, and not one
    replaced, deleted, or written by a key no longer listed; stored once for two folders, and kept
    keep days after neither names them; their types and sizes; the folders a choice sees.
  - The inbox: inbox entries checked in the plug's order, a folder with no `openKey` here refused as
    `no_inbox`, and listed to anyone after a cursor.
  - The storage: a file per folder, the feed across them, removing a folder, `rebuild` and the files
    it dates, a folder file in another layout refused, a read of it answering 500 and logging one
    line with no address, and the feed and the prune skipping it among good folders, one line each;
    and the S3 driver.
- `test/credits.test.ts`, through the whole host, buying with `test/buyer.ts`, which blinds with
  privacypass-ts as an app does:
  - the price of joining, of a 1 kB entry (0.02), of a 200 kB file (2.01), and of taking an entry
    down (0.01); the same entry or bytes again for nothing;
  - joining: a folder's first profile entry at its price, and refused with no balance; a later one,
    an update or leaving, taken with none;
  - a write refused with no balance, bytes too. With no balance, a live entry is still taken down,
    for nothing, and a null body where nothing stands is refused;
  - a file paid by the folder that can, when the newest folder naming it cannot, and refused when
    none can;
  - inbox entries free; on the cap's own code, with a cap of 2 and a stand-in
    clock, an inbox taking a day's cap, the next refused, another inbox counted on its own, and the
    next UTC day counted again;
  - a ticket collected, the same answer twice and billed once. A ticket is refused from a sponsor
    not listed, for another count, or for another buy, and a credit is spent once;
  - only tickets buy: the directory names no address, and a proof of any other kind is refused;
  - the credit key made at the first start, readable only by the host's user, and the same at the
    next start;
  - a credit route that fails answering 500 and logging one line, its path and the error, with no
    address;
  - end to end: a folder's profile entry naming a photo, an offer, and the photo, written with
    credits and read back with the standard's client, the balance down by exactly their prices.

## Promises

- **It fits the standard's plug.** The standard's host check passes against it, and anyone can run
  it against the deployed copy. The front adds the line at `/`, the credit routes and the price of
  each write, and nothing else.
- **Taking your own things down is never blocked by money.** A delete of a live entry goes through
  when the balance cannot pay its floor.
- **A person can always leave; joining costs a write.** A folder's first entry here costs a write,
  whatever it is. Later profile entries, which leave this host or update the list, the plug never
  asks about, so they are free.
- **No sign-ups.** A folder's balance is just a number next to its address. Nobody logs in: an
  entry's signature is its only proof.
- **No address logs.** Neither the plug nor the front logs an address or keeps one. It logs no
  request but one it answers 500: its path and the error's message, any address in them taken
  out. On Railway, Railway's own request logs exist.
- **It cannot tell which buy a credit came from, as long as it gave everyone the same key.** It
  signed the credit blind and never saw its nonce.
- **A credit is spent once, and a buy's credits are signed once.** A second ticket for the same
  buy is taken and gives nothing more; collecting a buy again gives the same credits, never more.
- **A write is paid once.** The same entry, or the same bytes, sent again cost nothing.
- **Credits are never refunded, and once in a folder never move to another.** One credit is a cent
  of writes here, and nothing anywhere else.

## Limits

- **Anyone who pays can write here** anything the plug accepts.
- **An entry is read and checked before its price is asked,** so anyone can make the host read up to
  50 MB a request that it then refuses.
- **Inbox entries are free, so any inbox can be filled.** 1,000 a day reach it, and past them the
  inbox's own friends wait for the next day. Who may leave one is never limited here: choosing what
  to show is the recipient's app's.
- **Inbox entries are free, so they can keep bytes here for free:** up to 64 KB each, 1,000 an inbox
  a day, each kept for 30 days, in any inbox whose profile entry here has `openKey`. The day's count
  is kept in memory, so a restart counts it again from none.
- **Anyone can list any inbox here:** whom each inbox entry is for, when it came and its size, never
  who wrote it or what it says.
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
- **Bytes are paid by one of the folders that name them.** Another folder that names the same bytes
  keeps them here for the price of its entry alone.
- **A stop between storing bytes and taking their price** leaves them stored and unpaid. A
  reservation is held in memory, in this one process.
- **Slow for a busy folder.** The plug checks each entry against everything it stores for that
  folder, and checks signatures in JavaScript: about 175 entries a second on one core.
- **A folder file it cannot open is withheld from the feed.** A reader whose cursor passes its
  entries while it is left out gets them, once it opens, from that folder's own read or by reading
  the feed from the start.
- **One machine, one replica.** The folders are files on one volume; more than one machine is a
  change to `src/storage.ts` first.

## Who decides what

- **The standard:** the seven requests; what makes an entry, an inbox entry and a file valid; the profile entry's fields and what each access key can do; and the host check.
- **This host, by its own choice:**
  - the numbers above: its prices, what one credit costs, and what is free;
  - which sponsors it takes, and any other way it takes to pay for credits;
  - its logs and its storage;
  - its credit's format: type 2, its challenge, its id, the directory's `forest-credit` entry, the
    buy and its reference, the ticket, the headers.
- **Anyone holding a credit:** which folder it goes into.
- **A buyer or a sponsor:** whom it pays for.
- **The person, through their app:** which hosts their profile entry names, which access keys it
  lists and what each can do, and whether their folder takes inbox entries (its `openKey`).

## FAQ

**Why is the host's code here, and not in the standard?**
The standard holds only what two strangers' programs must agree on: for a host, the seven requests
and the check that shows a host answers them. A host is a program someone runs, with its own
storage and its own numbers, so its code lives with whoever runs it, and the check keeps it honest.

**Why does the front pass requests to the plug on loopback, and not answer them in one server?**
The credits stand in front of the plug, never inside it: the plug knows only the three hooks it
asks. Each is tested on its own, and a change to one leaves the other as it was.

**Why a balance per folder, and not a credit shown with each write?**
A write costs a fraction of a credit, and an app should not have to show credits on every write.
The plug also takes entries in batches. A balance takes credits once, through one route, and every
write after draws from it.

**Why is a file paid at its upload, by a folder that names it, and not with the entry that names it?**
An upload is not signed: the entry that names the bytes is, and anyone may upload what it names. So
the price goes to a folder whose current entry names them, the newest first, since the app that
wrote that entry is almost always the one uploading; a folder that cannot pay is passed over, so
naming someone else's bytes from an empty folder blocks nothing. Priced with the entry instead, the
bytes a profile entry names would be free, since a host never refuses a profile entry for a folder it
holds but for its size.

**Why is a null body free over a live entry, but not where nothing stands?**
Over a live entry it takes something down, and a person can always take down what they put up. A
null body where nothing stands takes nothing down: it is a new entry at a new path. If it were free,
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
