# host

A host keeps people's signed records, messages and photos, and serves them to anyone who asks.

The foundation runs this one, on devnet, at https://host.devnet.forest.foundation: forest's
reference host with the policy below. Anyone can run another, with this code, forest's host alone,
or their own. What every host must do is forest's
([records](https://github.com/foundationforest/forest/blob/main/records/README.md#hosts)); this
README says only what this one adds and chooses.

Up: [the repo](../README.md).

## How it works

Forest's host (`standard/records/src/host.ts`), unchanged, listens on loopback. In front of it, one
thing only: a front that answers `GET /` with one line saying what this is, and passes every other
request, untouched, to forest's host. So the routes are forest's six: records in and out, messages
in and pulled, blobs in and out. Forest's host checks every record, message and blob, as its
standard says, before it keeps anything.

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
- **The photo rule** (forest's blob policy), always. Forest's host takes bytes only while a current
  record names them; this host takes them only when one of the folders whose current records name
  them holds a registry row from an issuer in `PHOTOS`, read with the registry lookup, and the bytes
  it holds that the folder's current records name, these included, stay within that folder's limit.
  A size is the bytes' own, never what a record says of them: learned when it takes them, and read
  back once, after a start, for bytes taken before. Without `SOLANA_RPC_URL` no row can be read, so
  it takes no photo or video.

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

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | none: a temporary directory, removed on stop | The data directory |
| `IMPORT_FROM` | none | A single SQLite file to move in, when there is no `host.sqlite` yet |
| `PORT` | `8080` | |
| `SOLANA_RPC_URL` | none: no lookup | The Solana RPC the registry lookup reads |
| `REGISTRY_PROGRAM_ID` | the devnet registry | The registry the lookup reads |
| `SENDER_CACHE_SECONDS` | `60` | How long a sender's records are kept once read; `0`: not kept |
| `S3_ENDPOINT`, `S3_BUCKET` | none: blobs on disk | The bucket |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none | The bucket's key |
| `S3_REGION` | `us-east-1` | The region requests are signed for, as the bucket's service names it |
| `S3_STYLE` | `path` | `path` or `virtual`, as the bucket's service asks |

The bucket takes all four of its first variables, or none: any `S3_` variable without all four
stops the start.

### Run it

```sh
./standard.sh keys records registry/client
cd host && npm ci
npm test
DATA_DIR=./data/host npm start
```

The test checks:

- `/` says what this is, and every other path is forest's host, with this policy; a request whose
  URL cannot be read (`//`) gets 400, and the host goes on.
- The settings; records in and back out through the front, for the whole host and by profile.
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
- The photo rule: photos are taken for a folder with a row from the devnet issuer, and refused
  (`policy`) for one with another issuer's row, with none, or with no RPC; a folder's bytes are
  counted as they are, though its records say 1 byte each, refused past its limit, taken through
  another folder that names them and has room, and read back after a restart.

### On devnet

The build context is the repo root; `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`standard.sh records registry/client`, `npm ci`). Railway, project `forest-devnet`, service `host`,
at https://host.devnet.forest.foundation:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=host/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080, health check `/`.
- **Variables:** `DATA_DIR=/data/host`, `IMPORT_FROM=/data/host.sqlite`, `PORT=8080`,
  `SENDER_CACHE_SECONDS=60`, `SOLANA_RPC_URL` (Helius's devnet RPC, whose URL holds the key), and
  Railway's bucket by reference: `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` (`auto`),
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_STYLE=virtual`.

The devnet index reads it ([`index/lists/hosts.json`](../index/lists/hosts.json)), and the CLI
([`mcp/`](../mcp/README.md)) starts there when it is given no host (it reads that list).

## Policy

Every number here is set in `src/host.ts` (`POLICY`, `PHOTOS`, `SENDER_READ_MS`) or by a setting,
so moving the forest pin cannot change it without a pull request here; two are forest's defaults,
not set here: the largest record or message, and the blob types.

- **Sizes:** records and messages up to **65,536 bytes** each (forest's default); **100** of them a
  request; **1,000** a page, and at most **4,194,304 bytes** a page, though always one line.
- **Photos and videos (blobs):** png, jpeg and mp4 (forest's default), up to **50,000,000 bytes**
  each; only for a folder holding a registry row from the foundation's devnet issuer, under any
  label; and up to **250,000,000 bytes** a folder: the bytes held here that its current records
  name, the new ones included. Bytes several folders name come in through any one of them that
  qualifies.
- **Inboxes:** it takes a message for any profile whose card here declares an inbox, under each of
  forest's rules: anyone, one issuer's rows (through the registry lookup; without an RPC, refused as
  `rule_unsupported`), one message per sender, and a largest size.
- **Message keys:** it takes a message a message key signed. It reads the sender's records from the
  host the message names within **5 seconds**, only at a public address and with no redirect, and
  keeps what it read for **60 seconds** on devnet: one read a sender a minute, at most, and a past
  key stops within it.
- **Keeps** a replaced record, a message, and bytes no current record names any more for **30
  days**, by its own clock. A current record stays.
- **Who may write:** anyone, records and messages; photos and videos by the rule above. It refuses
  no record or message by a policy of its own, and has no rate limit.
- **Where it keeps things:** a SQLite file per folder and one log across them, on the volume; blob
  bytes in an S3-compatible bucket. When one machine is not enough, forest's records say the way
  ("When it grows").
- **No request logs.** Neither forest's host nor the front logs a request or keeps an address.
- **Providers, on devnet:** Railway runs it, with a volume and a Railway bucket; the registry
  lookup reads Helius's devnet RPC.

## Promises

- **Forest's host, unchanged.** The front adds the line at `/` and nothing else.
- **No accounts.** Nobody signs up or logs in: a record's signature is its only credential, and a
  pull's is the profile's main key's or a message key's.
- **No address logs.** Neither forest's host nor the front logs a request or keeps an address. On
  Railway, Railway's own request logs exist.

## Limits

- **Anyone can write records and messages here,** anything forest's host accepts.
- **On devnet it may be wiped at any time,** and with it every record the e2e runs left.
- **One machine, one replica.** The folders are files on one volume; more than one machine is a
  change to forest's storage first.
- **It trusts its RPC** for the registry lookups. A lookup that fails refuses the message
  (`lookup`), and the sender sends it again; for a photo, the put gets 500, and the app puts it
  again.
- **No photo before a row.** Bytes are taken only once a folder naming them holds a row, so an app
  that puts a photo before the person registers is refused (`policy`) and must put it again after.
- **After a start, sizes are read back.** The first put for a folder after a start reads back the
  bytes held that its records name, once each, to learn their sizes.
- **A past message key can still send here for up to 60 seconds:** until what this host read of
  the sender's records expires. Its pulls stop at once.
- **Taking a message key's message tells the sender's host something:** this host asks it for the
  sender's records, so it sees that this host asked, and when.
- **A host that holds one person's profiles links them;** a shared host is the crowd.

## Who decides what

- **The standard (forest):** the six requests, what makes a record, a message and a blob valid, and
  the inbox's rules.
- **This host, by its policy:** the numbers above, which issuers' rows let a folder put photos, the
  RPC it asks, how long it keeps a sender's records, its logs and its storage.
- **The person, through their app:** which hosts their hosts record names, who may write to their
  inbox, and which message keys may send for them.

## FAQ

**Why run forest's host, and not one written here?**
Forest's host is the reference for what a host does. A host written here could drift from it, and
the e2e run would test the wrong thing.

**Why does a row from the devnet issuer, under any label, let a folder put photos?**
A row from an issuer the foundation trusts is a person a face check found once, which is what makes
a folder's photos someone's and not anyone's. The index also checks that the label is a market it
uses and the profile's own; the host has no list of markets, and needs none to bound its bytes.

**Can I run it at home?**
Yes: the same program on your own machine works the moment it is reachable with an address and
HTTPS, which at home means a tunnel.
