# host

A host keeps people's signed records, messages and photos, paid for in credits, and serves them to
anyone who asks.

The foundation runs this one, on devnet, at https://host.devnet.forest.foundation: forest's
reference host with the policy below. Anyone can run another, with this code, forest's host alone,
or their own. What every host must do is forest's
([records](https://github.com/foundationforest/forest/blob/main/records/README.md#hosts)); this
README says only what this one adds and chooses.

Up: [the repo](../README.md).

## How it works

Forest's host (`standard/records/src/host.ts`), unchanged, listens on loopback. In front of it, one
thing only: a front that answers `GET /` with one line saying what this is, answers the credit
routes ([Credits](#credits)), and passes every other request, untouched, to forest's host. So the
routes are forest's six (records in and out, messages in and pulled, blobs in and out) and four for
credits. Forest's host checks every record, message and blob, as its standard says, before it keeps
anything.

`src/host.ts` hands forest's host this host's numbers (Policy) and three things of its own:

- **The registry lookup,** when `SOLANA_RPC_URL` is set: whether a key holds a row from an issuer,
  read with forest's registry client (`fetchRows`, filtered on the key and on the issuer's key as an
  inbox names it: 128 hex characters, x then y). Any such row counts: the registry wrote it only
  after checking the person proof against that issuer's key. Forest's host asks it for an inbox open
  to one issuer's rows.
- **The sender check** (forest's `readSender`), always: to take a message a message key signed,
  forest's host needs the sender's hosts and permissions records from the host the message names.
  This host reads them with forest's client (`readPage`, every page) and keeps what it read for a
  while, per sender and host. It reads only from a public address and follows no redirect: forest's
  public fetch (`publicFetch`, records/src/public.ts) refuses, before connecting, a host whose
  address, written or looked up, is in any range IANA marks as not globally reachable, and follows
  no redirect. A read that fails, or is refused, is not kept: forest's host answers `lookup`, and the
  sender tries again.
- **The price of each write** (forest's record, message and blob policies), always: each takes the
  write's price from a folder's balance here, or refuses it (`policy`), saying what it costs and
  what the folder holds ([Credits](#credits)).

**Storage** is forest's: a data directory (`DATA_DIR`) holding a SQLite file per folder and
`host.sqlite`, the log across them; the blobs go in that directory, or in an S3-compatible bucket
when the `S3_` variables are set. Before it listens, a start makes two moves, each once, and the log
says what each moved:

1. **A single file, moved in.** If `IMPORT_FROM` names a file and the data directory holds no
   `host.sqlite` yet, forest's import script (`standard/records/scripts/import-single-file.ts`) moves
   that file in, under the same numbers, so the cursors readers hold go on working. It runs into a
   directory beside the data directory, renamed onto it when whole, and never over one that holds
   folders: the start fails instead. The file is left as it was.
2. **Bytes on disk, to the bucket.** With a bucket, blobs left in the data directory move to it,
   under the same names and types, and leave the disk: `host.sqlite` lists which bytes the host
   holds, and bytes left on disk would be listed and never found.

### Credits

A credit here is a [Forest credit](https://github.com/foundationforest/standard/blob/main/credits/README.md)
whose unit is `one cent of writes`. The host sells and takes them with standard's seller,
unchanged ([Selling credits](https://github.com/foundationforest/standard/blob/main/credits/README.md#selling-credits)),
in `src/credits.ts`:

| Route | What |
|---|---|
| `GET /.well-known/private-token-issuer-directory` | Its credit key, where a buy goes, and its `forest-credit` entry: the unit, the address a credit is paid to, the token and one credit's price |
| `POST /credits/buy` | A buy's bytes, with what paid for it in the `Forest-Payment` header: `solana <signature>`, a finalized transaction naming the buy's reference and paying for every credit, or `ticket <ticket>`, from a sponsor in `SPONSORS`. Its blind signatures, the same each time it is collected with that proof. Refused: `not_a_buy`, `too_many` (over `CREDITS_PER_BUY`), `bad_payment` (a header it cannot read), `not_paid` (402, with what to pay), `proof_used` (409, the proof paid for another buy), `payment_check_unavailable` (503, the RPC did not answer, or there is none) |
| `POST /credits/spend` | `{ folder, credits }`: from 1 to 100 credits, as standard's `creditList` writes them, all go into that folder's balance, or none; the answer is `{ folder, credits }`, the balance. Refused: `bad_request` (with `from 1 to 100 credits` when the list is empty or longer), `credit` (402: one does not hold, or one is there twice, checked with standard's `checkCredits`), `spent` or `held` (409: one is spent, or held by another request) |
| `GET /credits/balance/<folder>` | `{ folder, credits }` |

**A folder's balance** is a count of credits. Anyone holding credits can add them to any folder;
only that folder's writes draw from it. A spend holds its credits, spends them and adds them to
the balance in one transaction: all of it, or none. A 500-credit gift fills a folder in five
spends.

**What a write costs:** one credit a started megabyte (1,048,576 bytes) of it, one at the least. A
record is paid from its own folder's balance, a message from its sender's, and bytes from the first
folder whose current records here name them that holds the price. Forest's host asks no policy
about a hosts or permissions record, so those are free: a person can always move and always remove
an access key. A record, a message or bytes already here cost nothing again. A write that becomes
current stays as long as it is current; the price covers that.

**A write costs exactly its price or nothing.**

- **A record or a message** is claimed by its id in the same transaction that takes its price. A
  second copy in flight at once, or the same write sent again after a stop between its price and
  its store, costs nothing.
- **Bytes** are stored first and charged after. Their price is reserved on the folder, so no other
  write can spend it; forest's host keeps them; then the price is taken. If they are not kept, the
  reservation is released. The front sends on one put of the same bytes at a time, so a second copy
  finds them kept and pays nothing.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | none: a temporary directory, removed on stop | The data directory |
| `IMPORT_FROM` | none | A single SQLite file to move in, when there is no `host.sqlite` yet |
| `PORT` | `8080` | |
| `PUBLIC_ORIGIN` | required | Its public origin, `https://<host>`: the name every credit's challenge carries, so it must be the address apps use |
| `CREDIT_KEY` | required | Its credit key: RSA-2048, PKCS #8 DER, in base64, as `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \| openssl pkcs8 -topk8 -nocrypt -outform DER \| base64 -w0` writes one. Read once and removed from the environment |
| `CREDIT_ADDRESS` | required | The address a credit is paid to |
| `CREDIT_MINT` | required | The token a credit is paid in, or `SOL` |
| `CREDIT_PRICE` | required | One credit's price, decimal text in whole tokens |
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
never free by mistake. Its credits are kept in one file, `credits/credits.sqlite` in the data
directory: the spent list, the proofs it took, its sponsors' bill, the balances, and the id of each
write it took a price for. A start moves an older host's `credits/balances.sqlite` into it, once,
settling a spend that host cut short between its two files.

### Run it

```sh
./standard.sh keys records registry/client credits
cd host && npm ci
npm test
DATA_DIR=./data/host npm start
```

The test checks:

- `/` says what this is, and every other path is forest's host, with this policy; a request whose
  URL cannot be read (`//`) gets 400, and the host goes on.
- The settings, the credit settings each needed, and a credit key that is not PKCS #8 refused
  without being echoed; records in and back out through the front, for the whole host and by
  profile.
- Forest's single-file fixture moves in once, under the same numbers, and never over a directory
  that holds folders; with a bucket (a stand-in on loopback that checks forest's signature, in
  region `auto`), its bytes go straight there, and bytes an earlier start left on disk move there.
- The lookup counts a row of the sender's with the issuer's key on it, and no other; a message to
  an inbox open to one issuer's rows is taken with the lookup and refused without it.
- A message key's message is taken while the sender's host lists the key, still taken within the
  cache time once it is past, refused (`permission`) after, and refused (`lookup`) when the named
  host does not answer; a past message key's pull is refused at once.
- The sender check: an address that is not public is refused, written or looked up (`localhost`),
  before anything is sent; a message key's message is refused (`lookup`) when its sender's host is
  on loopback, or redirects.
- Credits: the directory; a buy refused with no payment, with one the RPC does not have, over the
  most a buy may hold, with no RPC, or not a buy; collected twice with its payment, the same answer; finished with standard's client, and spent into a folder,
  one or several in a request, each once, with every refusal, none taken when one is refused; the
  balance; a page's preflight.
- What writes cost: a hosts and a permissions record taken with nothing in the balance; a record
  one credit, refused without it, nothing for one already here; bytes of a megabyte and one, two
  credits, refused short, taken once paid, nothing again; bytes two folders name, through the one
  that can pay; a message one credit, from its sender.
- A write costs exactly its price or nothing: two copies of one message in flight at once, paid
  once; a record paid before a stop, kept free when sent again; two copies of one blob, paid once;
  two blobs and a balance for one, one kept and paid and the balance never below zero; a reservation
  a record cannot spend; a bucket that refuses every put, nothing paid.
- One file: an older host's balances, and a spend it cut short, moved in once.

### On devnet

The build context is the repo root; `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`standard.sh records registry/client credits`, `npm ci`). Railway, project `forest-devnet`, service `host`,
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
  `CREDIT_PRICE=0.01`.

The devnet index reads it ([`index/lists/hosts.json`](../index/lists/hosts.json)), and the CLI
([`mcp/`](../mcp/README.md)) starts there when it is given no host (it reads that list).

## Policy

Every number here is set in `src/host.ts` (`POLICY`, `SENDER_READ_MS`), `src/credits.ts` (`priceOf`, `SPEND_MAX`) or by a setting,
so moving the forest pin cannot change it without a pull request here; two are forest's defaults,
not set here: the largest record or message, and the blob types.

- **Sizes:** records and messages up to **65,536 bytes** each (forest's default); **100** of them a
  request; **1,000** a page, and at most **4,194,304 bytes** a page, though always one line.
- **Photos and videos (blobs):** png, jpeg and mp4 (forest's default), up to **50,000,000 bytes**
  each.
- **The price of a write:** **one credit a started megabyte** of it, one at the least: a record or a
  message one credit, a 5 MB photo five. A hosts or permissions record is free. Paid from a
  folder's balance here: a record's own folder, a message's sender, bytes any folder that names
  them.
- **One credit is one cent:** **0.01** of the classic test dollar on devnet, a placeholder, paid to
  the devnet `host` key's address. At most **1,000** credits a buy, and **100** a spend (`SPEND_MAX`).
  A payment counts once it is finalized.
- **No monthly fee and no free tier.** A write that is current stays; reads are free.
- **Inboxes:** it takes a message for any profile whose card here declares an inbox, under each of
  forest's rules: anyone, one issuer's rows (through the registry lookup; without an RPC, refused as
  `rule_unsupported`), one message per sender, and a largest size.
- **Message keys:** it takes a message a message key signed. It reads the sender's records from the
  host the message names within **5 seconds**, only at a public address and with no redirect, and
  keeps what it read for **60 seconds** on devnet: one read a sender a minute, at most, and a past
  key stops within it.
- **Keeps** a replaced record, a message, and bytes no current record names any more for **30
  days**, by its own clock. A current record stays.
- **Who may write:** anyone who pays, records, messages and bytes. It refuses no write by a policy
  of its own but its price, and has no rate limit.
- **Where it keeps things:** a SQLite file per folder and one log across them, on the volume; blob
  bytes in an S3-compatible bucket. When one machine is not enough, forest's records say the way
  ("When it grows").
- **No request logs.** Neither forest's host nor the front logs a request or keeps an address.
- **What it keeps for credits:** the spent list (each spent credit's id), each proof it took with the
  buy's reference, how many credits each sponsor paid for, each folder's balance, and the id of each
  write it took a price for.
  Nothing ties a credit to the folder it went into.
- **Providers, on devnet:** Railway runs it, with a volume and a Railway bucket; the registry
  lookup and the payment check read Helius's devnet RPC.

## Promises

- **Forest's host, unchanged.** The front adds the line at `/` and the credit routes, and nothing
  else.
- **No sign-ups:** a folder's balance is just a number next to its address. Nobody logs in: a
  record's signature is its only credential, and a pull's is the profile's main key's or a message
  key's.
- **No address logs.** Neither forest's host nor the front logs a request or keeps an address. On
  Railway, Railway's own request logs exist.

## Limits

- **Anyone can write records and messages here who pays,** anything forest's host accepts.
- **A balance is never refunded,** and never moves to another folder: credits are never refunded
  (standard's credits).
- **Timing can tie a buy to a folder.** The foundation runs this host and the issuer that buys a
  person's first credits; a buy collected and spent into a folder moments later, from one network
  address, can be matched, and the issuer knows whose buy it paid. An app that waits between
  collecting and spending, or spends over a VPN, makes that harder (standard's
  [credits, Limits](https://github.com/foundationforest/standard/blob/main/credits/README.md#limits)).
- **Hosts and permissions records are free, on purpose:** a person can always leave a host or
  revoke a key with an empty balance.
- **A stop between storing bytes and taking their price** leaves them kept and unpaid.
- **Two different messages from one sender to an inbox that takes one from each,** in flight at
  once, may both pay, though forest's host keeps one: it checks that rule after the price.
- **On devnet it may be wiped at any time,** and with it every record the e2e runs left.
- **One machine, one replica.** The folders are files on one volume; more than one machine is a
  change to forest's storage first.
- **It trusts its RPC** for the registry lookups and for payments. A lookup that fails refuses the
  message (`lookup`), and the sender sends it again; a payment check that fails refuses the buy
  (503), and the app collects it again.
- **A past message key can still send here for up to 60 seconds:** until what this host read of
  the sender's records expires. Its pulls stop at once.
- **Taking a message key's message tells the sender's host something:** this host asks it for the
  sender's records, so it sees that this host asked, and when.
- **A host that holds one person's profiles links them;** a shared host is the crowd.

## Who decides what

- **The standard (forest):** the six requests, what makes a record, a message and a blob valid, and
  the inbox's rules.
- **This host, by its policy:** the numbers above, its price and what one credit buys, the RPC it
  asks, how long it keeps a sender's records, its logs and its storage.
- **Anyone holding a credit:** which folder it goes into.
- **The person, through their app:** which hosts their hosts record names, who may write to their
  inbox, and which message keys may send for them.

## FAQ

**Why run forest's host, and not one written here?**
Forest's host is the reference for what a host does. A host written here could drift from it, and
the e2e run would test the wrong thing.

**Why a balance per folder, and not a credit shown on each write?**
A write can cost more than one credit, and an app should not have to show credits on every write.
Forest's host also takes records and messages in batches, and an app rewrites its vault often. A
balance takes credits once, through one route, and every write after draws from it.

**Can I run it at home?**
Yes: the same program on your own machine works the moment it is reachable with an address and
HTTPS, which at home means a tunnel.
