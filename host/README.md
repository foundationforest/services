# host

The host keeps your profiles' folders (posts, reviews, photos, inbox) and serves them to anyone. A
folder is a profile's entries on a host, each signed by its main key or an access key its profile
entry lists. A small write costs a fraction of a cent, paid from the folder's balance of credits,
prepaid units of this host's writes, and a message carries one credit; your first credits are a gift
from the verifier. The Forest Foundation runs this copy, at https://host.forest.foundation. Anyone
can run another; the main way is this code, or their own that passes the standard's host check
([folders](https://github.com/foundationforest/standard/blob/main/folders/README.md#hosts)). It
keeps copies: the entries signed for each profile (a locked one as an envelope only the keys it was
locked to open), its inbox entries, locked too, and the files its current entries name. Anyone can
copy a folder out; the main way is the person's app reading every entry and file and writing them to
another host. The only thing here no key signed is a folder's balance of credits. No key of yours,
no money but its own credits, no account.

## How it works

Two parts, in one process. The standard holds only what two strangers' programs must agree on, so a
host's code lives with whoever runs it, and the host check keeps it honest.

- **The plug** (`src/plug.ts`, over `src/storage.ts`) answers the seven requests every host answers,
  on loopback. It checks every entry, inbox entry and file as the standard says before it keeps
  anything.
- **The front** (`src/host.ts`), the only part the internet reaches, answers `GET /` with one line
  saying what this is, answers the credit routes, and passes every other request, untouched, to the
  plug. The credits stand in front of the plug, never inside it: the plug knows only the three hooks
  it asks, so each part is tested, and changes, alone.

**Who writes.** The plug takes an entry signed by the folder's main key, or by an access key the
folder's current profile entry here lists with `write`; any other key is refused (`unlisted`), and
no access key writes the profile entry. At each path it keeps the entry that counts and is newest,
as every reader works it out (the standard's `viewFolder`). An access key removed from the profile
entry stops counting, and its entries with it: at each path it wrote, the newest entry that still
counts is current again.

**The three hooks** `src/host.ts` gives the plug, with this host's numbers:

| Hook | What it decides |
|---|---|
| `entryChoice` | Charges an entry to its own folder's balance, or refuses it (`refused`, with the price and the balance). Asked about every entry but a profile entry, and about a profile entry only while the folder has no entry here: a folder's first entry costs a write, whatever it is, and leaving or updating after that is free |
| `fileChoice` | Takes the plug's file types, then reserves the bytes' price on a folder whose current entry names them, the newest naming entry's folder first, until one can pay. The front takes it once the plug has stored them, or releases it |
| `inboxChoice` | Takes the one credit an inbox entry carries in its request's payment, keeps the entry's price and puts the rest into the recipient folder's balance, or refuses it (`refused`): the sender is locked inside, so no folder could be asked to pay |

**Inboxes.** The plug takes an inbox entry for any folder whose profile entry here has `openKey`
(the open key envelopes for it are locked to), from anyone who sends its credit, and lists any inbox
to anyone, after a cursor: only the envelopes protect it. It checks no sender and no signature
inside; that is the recipient's app's. Nobody deletes an inbox entry: it goes after the keep days.

**Files.** A file is the bytes an entry's body names in `files`, by SHA-256, type and size. The plug
takes them only while a current entry here names them with that type and size, keeps them while one
does, and for the keep days after. Bytes several folders name are stored once. The front sends on
one upload of the same bytes at a time, so a second finds them stored and pays nothing. From a
bucket, a read is a redirect to a short-lived link straight to the bytes there.

**Where it keeps things,** in the data directory (`DATA_DIR`):

| Where | What |
|---|---|
| `folders/<address>.sqlite` | One SQLite file per folder: its entries and its inbox. With the host stopped, deleting the file removes the folder; the files only it named go keep days after the next prune |
| `host.sqlite` | The log numbering every folder's entries in the order taken, which files each folder's current entries name, and which files are stored. All but when each stored file stopped being named comes back: `rebuild(dir)` makes it again, dating at the rebuild each file no current entry names |
| `files/`, or a bucket | The files, on disk or, with `FILES=s3`, in any S3-compatible bucket. It serves only the bytes `host.sqlite` lists as stored |
| `credits/credits.sqlite` | The spent list, the reference of each buy it was paid for, its sponsors' bill, the balances, and the id of each entry it took a price for |
| `credits/key.der` | The credit key |

- A new number, an entry's or an inbox entry's, is the larger of the last plus 1 and the clock in
  microseconds, so a rebuilt `host.sqlite` or folder file never reuses one, unless the clock is set
  back.
- A folder file in any other layout, a host's from before folders among them, is refused and left
  as it was.
- A folder file it cannot open is left out of the feed and the prune, which go on with the rest and
  log one line, any address taken out; its own read answers 500. A host may withhold an entry, never
  forge one.

### Credits

`credits/` sells and takes them, and `src/credits.ts` keeps the balances and the prices. The buyer's
side is `client/client.ts`: the loop, the reference app and the mcp buy with it, and the host's own
credit code reads the wire format from it.

**A credit** is a Privacy Pass credit (the IETF's standard for tokens that cannot be tied to their
buy) of type 2, Blind RSA (RFC 9576, 9577, 9578). The host signs it blind, over a number only the
buyer's app knows, so when it comes back to be spent the host sees a good signature and nothing that
ties it to the buy.

- Every credit answers one challenge: type 2, the host's name (from `PUBLIC_ORIGIN`) as its
  `issuer_name`, no redemption context and no origin info, so credits can be bought ahead and kept.
- Its bytes: type (2), nonce (32), the challenge's SHA-256 (32), the key's id, SHA-256 of the key
  (32), and the signature (256): 354 bytes, in base64url. Its spent-list id is its nonce, in hex.
- The signature is RSABSSA-SHA384-PSS-Deterministic (RFC 9474) over the first 98 bytes, by Node's
  own RSA (OpenSSL), hundreds of times faster than privacypass-ts's JavaScript `Issuer`.
- **The credit key** is RSA-2048, made at the first start in `credits/key.der` (PKCS #8, readable by
  its own user only) and read on every start after. It is in no setting.

**Its directory,** `GET /.well-known/private-token-issuer-directory`, is Privacy Pass's (RFC 9578),
with one more field:

```
{ "issuer-request-uri": "/credits/buy",
  "token-keys": [{ "token-type": 2, "token-key": <base64url> }],
  "forest-credit": { "unit": "writes at this host", "price": <decimal text>,
                     "entry": <decimal text>, "file": <decimal text> } }
```

`price` is a credit's price in dollars; `entry` and `file` are what 1,000 bytes cost, in credits, on
the disk and in the bucket. An app takes the latest type 2 key whose `not-before` has passed; this
host lists one, with none.

**Buying,** in three steps:

1. **The buy.** The app makes `n` blinded requests in one batch, as
   `draft-ietf-privacypass-batched-tokens` writes it, and keeps each nonce and blinding's inverse.
   The buy's reference is the SHA-256 of its bytes, in base58.
2. **Get signed.** Anyone holding the buy sends its bytes to `POST /credits/buy` with a payment, one
   of the ways below, in `Forest-Payment`, and gets the `n` blind signatures. The payment signs the
   reference: it pays for that buy here, of `n` credits, and no other. A buy is paid once: collected
   again, whatever pays, it gets the same answer, and nothing more is billed or taken.
3. **Finish.** The app unblinds each signature, checks it against the host's key, and keeps them.

**Anyone can pay for any buy; the main way is the person's app, from its wallet,** the Profiles
folder's balance. Other ways (a card, say) are added beside these two, each signing UTF-8 text. The
host sees what paid and the blinded buy, never which spends they become: a credit says nothing about
who paid for it.

| Way | `Forest-Payment` | Signed by, over |
|---|---|---|
| A sponsor's ticket | `ticket <sponsor's address>.<n>.<signature>` | An Ed25519 key in `SPONSORS`, over `forest credit ticket\n<origin>\n<reference>\n<n>`. The host keeps a bill of how many credits each sponsor's tickets paid for |
| A folder's balance | `balance <folder>.<key>.<signature>` | The folder's main key (then `key` is the folder), or an access key its profile entry here lists with `message`, over `forest credit balance\n<origin>\n<folder>\n<reference>\n<n>`. The host takes `n` credits from the balance, or refuses (`not_paid`, with what it holds) |

**A folder's balance** is kept in millionths of a credit. Anyone can add credits to any folder, a
whole credit each; the main way is the person's own app, right after a buy. A spend marks them spent
and adds them in one transaction, all or none; the spent list ties no credit to a folder. The
folder's writes, and the buys it pays for, draw from it: credits move between folders only as blind
credits, are never refunded, and are a cent of writes here each, and nothing anywhere else.

**What a write costs:** what it stores, counted as at least 1,000 bytes, rounded up to a millionth:
an entry's canonical text at `ENTRY_PER_KB`, on the disk; a file's bytes at `FILE_PER_KB`, in the
bucket. An entry pays from its own folder, a file from a folder whose current entry names it, once:
an entry is claimed by its id as its price is taken, and stored bytes cost nothing again. Taking
your own things down is free: a null body over a live entry costs nothing; one where nothing stands
takes nothing down, so it is paid like any other, or an empty folder could fill paths for free.

**An inbox entry carries one credit,** in its request's `Forest-Payment`: `credits <credit> …`, one
a line, in order. The host keeps the entry's price and puts the rest into the recipient folder's
balance. No credit that holds, no inbox entry (`refused`); a line refused before its price leaves
its credit unspent.

## Its API

| Route | What | Refused |
|---|---|---|
| `GET /` | One line saying what this is | |
| `POST /v1/entries` | NDJSON of canonical entries; one NDJSON result each | `unlisted`, `refused` (with price and balance), the standard's checks |
| `POST /v1/entries/read` | `{ profile, after? }`: that folder's entries after the cursor, as NDJSON in the order taken; header `forest-cursor` | |
| `GET /v1/entries?after=` | Every folder's entries after the cursor, the same way | |
| `POST /v1/inbox` | NDJSON of canonical inbox entries, with their credits in `Forest-Payment`; one result each | `no_inbox` (no `openKey` here), `refused` (no credit that holds) |
| `POST /v1/inbox/read` | `{ to, after? }`: the inbox entries left for that folder after the cursor, in arrival order; `forest-cursor` | |
| `PUT /v1/files/<sha256>` | The bytes, `content-type` their type | `unnamed` (no current entry names them), `shape` (another type or size), `hash`, `size`, `refused` (no folder can pay); `413` when declared over 50,000,000 bytes, unread |
| `GET /v1/files/<sha256>` | The bytes, with their type; from a bucket, `302` to a link to them there | |
| `GET /.well-known/private-token-issuer-directory` | [Its directory](#credits) | |
| `POST /credits/buy` | A buy's bytes, as `application/private-token-generic-batch-request`, with `Forest-Payment`, a ticket or a balance; answers its blind signatures | `not_a_buy`, `too_many` (over `MAX_BUY`), `bad_payment`, `not_paid` (402, with what to pay) |
| `POST /credits/spend` | `{ folder, credits }`, 1 to 100 credits in base64url, all into that folder or none; answers `{ folder, credits }`, the balance, up to six decimals | `bad_request`, `credit` (402: one does not hold, or twice), `spent` (409) |
| `GET /credits/balance/<folder>` | `{ folder, credits }` | `bad_request` |

A credit route asked with another method answers `method` (405), and a POST body over 512 KB
`too_big` (413).

## How we run it

Every number is set in this directory: `src/host.ts` (`choice`), `src/plug.ts` (its `DEFAULT_*`,
`MAX_HEADER_BYTES`), `src/credits.ts` (`MILLIONTHS`, `KILOBYTE`, `SPEND_MAX`), `src/storage.ts`
(`LINK_SECONDS`), or a setting.

- **One credit is one US cent,** and a price is our cost divided by 0.6: 40% of it is our margin.
  The cost is keeping a gigabyte 10 years at Railway's prices:

  | A gigabyte | On the disk: entries, inbox entries | In the bucket: files |
  |---|---|---|
  | Kept, a month | $0.15 | $0.015 |
  | Kept 10 years, and uploaded | $18.00 | $1.80, and $0.05 uploaded: $1.85 |
  | ÷ 0.6 | $30.00 | $3.08 |
  | 1,000 bytes, in credits | **0.003** | **0.00031**, 0.000308 rounded up |

  A write is paid once and kept as long as we run the host; the 10 years is how we price it, since
  storage keeps getting cheaper. A 1 kB entry costs 0.003, a 200 kB photo 0.062, a 50 MB video 15.5,
  a message one credit, of which its inbox entry keeps about 0.015 and the recipient gets the rest.
- **Buying:** at most **1,000** credits a buy, **100** a spend. `SPONSORS`: the verifier's sponsor.
- **Sizes:** entries up to **50,000,000 bytes**, as large as a file, since each write is paid by the
  byte; inbox entries up to **65,536**, a message's. **100** lines a request, its body at most a
  full batch of the largest inbox entries or one largest entry, so a batch of large entries gets 413
  and the client sends it again in halves; its headers up to **64 KiB**, room for a credit a line,
  but Railway's edge answers 431 to headers over about **32 KB** before the host sees them: room for
  about **65** credits a request here, not 100.
  **1,000** lines and **4,194,304 bytes** a page, though always one line. A read request is at most
  1,024 bytes. A request has **60 seconds** to arrive in full, or gets 408.
- **Files:** png, jpeg and mp4, up to 50,000,000 bytes each, read through a link straight from the
  bucket, good for **5 minutes**, whose egress Railway does not charge. A browser app that fetches
  one needs the bucket's CORS to let any origin GET: a setting of the bucket's, not of this code.
- **Keeps** an entry that stopped being current or counting, an inbox entry, and a file no current
  entry names for **30 days**, by its own clock, pruning every hour. A current entry stays.
- **Its speed,** on one core of the machine this was written on: about **175 entries a second**
  checked and stored, about 9,800 served (`npm run bench`); pure JavaScript checks about 235
  signatures a second there.
- **Who may write:** anyone who pays, with the folder's main key or an access key listed with
  `write`; the main way is the person's app, writing each entry to every host its profile entry
  names. It refuses no write by its own choice but for its price, and no inbox entry but for its
  credit: no other rate limit. **Who may read:** anyone, any folder and any inbox, for free; the
  main way is an index reading every page, or an app reading one profile.
- **Public:** every entry here (a locked one as an envelope), every file, any folder's balance, the
  directory. **Secret:** the credit key and the bucket's key. **Kept, not published:** what
  `credits/credits.sqlite` holds.
- **Where:** Railway, one replica of `deploy/Dockerfile` built from the repo root, the data
  directory on its volume, files in a Railway bucket (`FILES=s3`).

### Settings

The credit key is a file on the volume, never a setting; the settings hold only the bucket's key and
this host's choices. One that cannot be read (a partial bucket, a price not decimal text) stops it.

| Setting | Default | What |
|---|---|---|
| `DATA_DIR` | required | The folders, the credits and their key |
| `PUBLIC_ORIGIN` | required | Its public origin, `https://<host>`: the name every credit's challenge carries and every ticket signs, so a credit and a ticket count here only. A host cannot learn this from a request, so it must be the address apps use |
| `PORT` | `8080` | |
| `FILES` | `disk` | `disk`, in `DATA_DIR/files`; or `s3`, a bucket |
| `FILES_ENDPOINT`, `FILES_BUCKET` | none | The bucket, needed with `s3` |
| `FILES_ACCESS_KEY_ID`, `FILES_SECRET_ACCESS_KEY` | none | The bucket's key, needed with `s3` |
| `FILES_REGION` | `us-east-1` | The region requests are signed for |
| `FILES_STYLE` | `path` | `path` or `virtual`, as the bucket's service asks |
| `CREDIT_PRICE_CENTS` | `1` | One credit's price, in whole US cents |
| `ENTRY_PER_KB` | `0.003` | Each 1,000 bytes of an entry or inbox entry, on the disk, in credits: decimal text, at most six decimals |
| `FILE_PER_KB` | `0.00031` | Each 1,000 bytes of a file, in the bucket, the same |
| `MAX_BUY` | `1000` | The most credits one buy may ask for |
| `SPONSORS` | none | The sponsors whose tickets pay for a buy, by address, comma-separated |

### Run it

```sh
./standard.sh                         # from the repo root: the standard at STANDARD, built
cd host && npm ci                     # the standard's packages by name, linked into standard/
npm run check && npm test
DATA_DIR=./data PUBLIC_ORIGIN=http://127.0.0.1:8080 npm start
npm run bench                         # its speed on this machine
SEED=<64 hex characters> npm run check-host -- https://host.forest.foundation
```

`check-host` runs the standard's host check, unchanged, against any host (`check-host.ts`): it
writes from two profiles of one seed, `check/a` and `check/b`, and an access key it makes, pays for
each inbox entry with a credit bought from `check/b`'s balance, and prints each check ok, unchecked
or FAILED, exiting 1 on a failure. Give it a `SEED` whose two folders hold credits, or the rest is
unchecked. Each run costs `check/b` about 7 credits; `check/a`, their recipient, gets 3.9 back.

`test/` covers, on loopback: the host check against the plug and the whole host, paying; the plug
and its storage, the S3 driver and its links among it; and every price, payment and refusal above.

## Promises

- **It fits the standard's plug.** The standard's host check (`@foundationforest/folders/check`)
  passes against it, and anyone can run it against the deployed copy. The front adds the line at
  `/`, the credit routes and the price of each write, and nothing else.
- **Taking your own things down, and leaving, are free; joining costs a write.** A delete of a live
  entry costs nothing. A folder's first entry costs a write, whatever it is; later profile entries,
  which leave this host or update the list, the plug never asks about.
- **No sign-ups, and no address logs.** A folder's balance is a number next to its address, and an
  entry's signature is its only proof. Neither part logs or keeps an address, and it logs no request
  but one it answers 500: its path and the error's message, any address taken out.
- **A credit says nothing about who paid for it, as long as the host gave everyone the same key.**
  It signed the credit blind and never saw its nonce.
- **A credit is spent once, a buy's credits are signed once, and a write is paid once.** A second
  payment for the same buy gives nothing more, collecting a buy again gives the same credits, and
  the same entry or bytes sent again cost nothing.

## Limits

- **Anyone who pays can write here** anything the plug accepts, and anyone with a credit can leave
  an inbox entry in any inbox with `openKey`; choosing what to show is the recipient's app's.
- **An entry is read and checked before its price is asked,** so anyone can make the host read up to
  50 MB a request it then refuses.
- **A sender needs a balance at each of the recipient's hosts:** a credit counts at its own host
  only, so a message reaches only those where the sender's app can buy one.
- **About 65 messages a request here, not 100:** their credits ride in its headers, which Railway's
  edge cuts at about 32 KB; the mcp and apps send one message at a time.
- **A reader that refuses redirects cannot read a file from the bucket:** each read is one.
- **Anyone can list any inbox:** whom each entry is for, when it came and its size, never who wrote
  it or what it says.
- **A folder's balance is public** to anyone who knows its address.
- **A credit names nobody, so it is a bearer credit:** whoever holds its bytes can spend it.
- **One key for everyone, as far as the app can tell:** a host could give one person a key of their
  own, and blinding holds only for a real RSA key. An app can compare keys with others; this code
  cannot prevent it.
- **Not post-quantum:** a large quantum computer could break RSA-2048 and make credits, though never
  link a spend to its buy.
- **A sponsor's bill is counted, not capped.**
- **The batch is a draft:** `draft-ietf-privacypass-batched-tokens` is not an RFC; its encoding is
  `privacypass-ts` 0.9.0's.
- **The credits code is not audited.**
- **Reads are free and not in the price:** a folder read very often costs the host more than its
  writes paid.
- **Bytes are paid by one folder that names them;** another naming them pays only for its entry.
- **A stop between storing bytes and taking their price** leaves them stored and unpaid: the
  reservation is in this one process's memory.
- **Slow for a busy folder:** about 175 entries a second on one core.
- **A folder file it cannot open is withheld from the feed;** a reader whose cursor passed it gets
  its entries later from that folder's own read, or the feed from the start.
- **One machine, one replica:** more is a change to `src/storage.ts` first.
- **Railway's own request logs exist.**

## FAQ

**Why a balance per folder, and not a credit shown with each write?**
A write costs a fraction of a credit, and the plug takes entries in batches. A balance takes credits
once, through one route, and every write after draws from it. An inbox entry is the one write that
carries its own: its sender is locked inside, so no balance here is theirs.

**Why is a file paid at its upload, by a folder that names it?**
An upload is not signed; the entry naming the bytes is, and anyone may upload what it names. So the
price goes to a folder whose current entry names them, the newest first, since its app is almost
always the uploader; one that cannot pay is passed over, so naming someone else's bytes from an
empty folder blocks nothing. Priced with the entry, a profile entry's photo would be free, since a
host never refuses a later profile entry but for its size.

**Why Privacy Pass, and why type 2?**
It is the IETF's standard for exactly this, with maintained libraries. Type 2 (Blind RSA) fits:
anyone can check a type 2 credit with the host's public key, so the app knows what it holds, where
only the host can check type 1; its blinding state is plain bytes, so a buy someone pays days later
finishes on another device; and it is the most widely deployed, in Apple's Private Access Tokens and
at Cloudflare. The cost: 354 bytes a credit rather than 146, and one RSA signature each.

**Why is a credit never refunded?**
A refund pays someone back, so the host would need to know whom, and a credit names nobody.

**Can I run it at home?**
Yes, once it is reachable with an address and HTTPS, which at home means a tunnel.
