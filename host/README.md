# host

A host keeps people's signed records, messages and photos, and serves them to anyone who asks.

The foundation runs this one, on devnet: forest's reference host with the policy below. Anyone can
run another, with this code, forest's host alone, or their own. Nothing is on mainnet, and nothing
is shipped.

Up: [the repo](../README.md).

## How it works

Forest's host (`forest/records/src/host.ts`), unchanged, listens on loopback. In front of it, one
thing only: a front that answers `GET /` with one line saying what this is, and passes every other
request, untouched, to forest's host. So the routes are forest's six (forest's
[records](https://github.com/foundationforest/forest/blob/main/records/README.md), "Hosts"): records
in and out, messages in and pulled, blobs in and out. Forest's host checks every record's signature
and the access rule, every message's signature and its inbox's rule, and every blob's hash and the
record that names it, before it keeps anything.

`src/host.ts` hands forest's host the numbers in `POLICY`, where to keep things, and two lookups:

- **The registry lookup,** when `SOLANA_RPC_URL` is set: whether a key holds a row from an issuer,
  read with forest's registry client (`fetchRows`, filtered on the key and the issuer's key, as an
  inbox names it: 128 hex characters, x then y). Any such row counts: the registry wrote it only
  after checking the person proof against that issuer's key.
- **The sender's records** (forest's `readSender`), always: to take a message a message key signed,
  forest's host needs the sender's hosts and permissions records from the host the message names.
  This host reads them with forest's client (`readPage`, every page, all within 5 seconds) and keeps
  what it read for `SENDER_CACHE_SECONDS`, per sender and host. A read that fails is kept for
  nothing: forest's host answers `lookup`, and the sender tries again.

**Storage** is forest's: a data directory (`DATA_DIR`) holding a SQLite file per folder and
`host.sqlite`, the log across them; the blobs go in that directory, or in an S3-compatible bucket
when the `S3_` variables are set. Two moves happen on start, each once, before the host listens:

1. **The old single file.** If `IMPORT_FROM` names a file and the data directory holds no
   `host.sqlite` yet, forest's import script (`forest/records/scripts/import-single-file.ts`) moves
   it in: every folder, record, message and once pair under the same numbers, so the cursors
   readers hold go on working, and its blobs to wherever blobs go. It runs into a directory beside
   the data directory, renamed onto it when whole. The old file is left as it was.
2. **Bytes on disk, to the bucket.** With a bucket, blobs an earlier start left in the data
   directory move to it, under the same names and types, and leave the disk.

The log says what each moved.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | none: a temporary directory, removed on stop | The data directory |
| `IMPORT_FROM` | none | The single SQLite file this host kept before; moved in on the first start that finds no `host.sqlite` |
| `PORT` | `8080` | |
| `SOLANA_RPC_URL` | none: no lookup | The Solana RPC the registry lookup reads |
| `REGISTRY_PROGRAM_ID` | the devnet registry | The registry the lookup reads |
| `SENDER_CACHE_SECONDS` | `60` | How long a sender's records, once read, are kept; `0` reads them for every request |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none: blobs on disk | The bucket; all four, or none. Any `S3_` variable without all four stops the start |
| `S3_REGION` | `us-east-1` | The region the requests are signed for, as the bucket's service names it |
| `S3_STYLE` | `path` | `path` or `virtual`, as the bucket's service asks |

### Run it

```sh
./forest.sh keys records registry/client
cd host && npm ci
npm test
DATA_DIR=./data/host npm start
```

The test checks that `/` says what this is; that forest's host runs with this policy; the settings;
that records go in and come back through the front; that forest's single-file fixture moves in once,
under the same numbers, and never over a directory that holds folders; that with a bucket (a
stand-in on loopback that checks forest's signature, in region `auto`) its bytes go straight there,
and bytes an earlier start left on disk move there; that the lookup counts a row of the sender's
with the issuer's key on it, and no other; that a message to an inbox open to one issuer's rows is
taken with the lookup and refused without it; and that a message key's message is taken while the
sender's host lists it, still taken within the cache once past, refused (`permission`) after,
refused (`lookup`) when the named host does not answer, and that a past message key's pull is
refused at once.

### On devnet

The build context is the repo root; `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`forest.sh records registry/client`, `npm ci`). Railway, project `forest-devnet`, service `host`,
at https://host.devnet.forest.foundation:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=host/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080, health check `/`.
- **Variables:** `DATA_DIR=/data/host`, `IMPORT_FROM=/data/host.sqlite` (the file this host kept
  before), `PORT=8080`, `SENDER_CACHE_SECONDS=60`, `SOLANA_RPC_URL` (Helius's devnet RPC, whose URL
  holds the key), and Railway's bucket by reference: `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`
  (`auto`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_STYLE=virtual`. `DATABASE_PATH`,
  which this code no longer reads, is still set.

The devnet index reads it (`index/lists/hosts.json`), and forest's CLI starts there when it is
given no host (it reads that list).

## Policy

- **Keeps** a replaced record, a message, and bytes no current record names any more for **30
  days**, by its own clock. A current record stays.
- **Blobs:** png, jpeg and mp4, up to **50,000,000 bytes** each.
- **Sizes:** **100** records or messages a request; **1,000** a page, and at most **4,194,304
  bytes** a page, though always one line.
- **Inboxes:** it takes a message for any profile whose card here declares an inbox, under each of
  forest's rules: anyone, one issuer's rows (through the registry lookup, over `SOLANA_RPC_URL`;
  without it, refused as `rule_unsupported`), one message per sender, and a largest size.
- **Message keys:** it takes a message a message key signed. It reads the sender's records from the
  host the message names within **5 seconds**, and keeps what it read for **60 seconds** on devnet.
- **Who may write:** anyone. It refuses nothing by policy of its own, and has no rate limit.
- **Where it keeps things:** a SQLite file per folder and one log across them, on the volume; blob
  bytes in an S3-compatible bucket. When one machine is not enough, forest's records say the way
  ("When it grows").
- **No request logs.** Neither forest's host nor the front logs a request or keeps an address.
- **At home:** the same program on your own machine works the moment it is reachable with an
  address and HTTPS, which at home means a tunnel.
- **Who it links:** a host that holds one person's profiles links them; a shared host is the crowd.

## Promises

- **Forest's host, unchanged.** The front adds the line at `/` and nothing else.
- **No address logs.** Neither forest's host nor the front logs a request or keeps an address. On
  Railway, Railway's own request logs exist.

## Limits

- **Anyone can write here,** anything forest's host accepts.
- **On devnet it may be wiped at any time,** and with it every record the e2e runs left.
- **One machine, one replica.** The folders are files on one volume; more than one machine is a
  change to forest's storage first.
- **It trusts its RPC** for the registry lookup. A lookup that fails refuses the message
  (`lookup`), and the sender sends it again.
- **A past message key can still send here for up to 60 seconds:** until what this host read of
  the sender's records expires. Its pulls stop at once.
- **Taking a message key's message tells the sender's host something:** this host asks it for the
  sender's records, so it sees that this host asked, and when.

## Who decides what

- **The standard (forest):** the six requests, what makes a record, a message and a blob valid, and
  the inbox's rules.
- **This host, by its policy:** the numbers above, the RPC it asks, how long it keeps a sender's
  records, its logs and its storage.
- **The person, through their app:** which hosts their hosts record names, who may write to their
  inbox, and which message keys may send for them.

## FAQ

**Why run forest's host, and not one written here?**
Forest's host is the reference for what a host does. A host written here could drift from it, and
the e2e run would test the wrong thing.

**Why are the numbers written here, when they are forest's defaults?**
So moving the forest pin cannot change this host's policy without a pull request here that says so.

**Why keep a sender's records for a minute, and not read them for every message?**
Reading them is a request to another host, up to five seconds, for every message a message key
signs. A minute keeps that to one request a sender a minute, and a past key stops within it.

**Why move the bytes on disk to the bucket on start?**
`host.sqlite` lists which bytes the host holds, whatever holds them. Bytes left on disk after the
bucket is set would be listed as held and never found. Moving them under the same names keeps the
list true.

**Why do older e2e profiles name another address?**
Until 7 October 2026 the host answered only at a Railway address. The hosts records of the profiles
e2e made before then name that address, and no one can sign them again: each run forgot its
people's words. Readers that start from the index's hosts list, the index and forest's CLI among
them, still find those profiles here; a message to one goes to the old address, and fails once
that address is gone.
