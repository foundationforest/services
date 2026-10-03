# host

A host keeps people's signed records, messages and photos, and serves them to anyone who asks.

Soil runs this one, on devnet: forest's reference host with the policy below. Anyone can run
another, with this code, forest's host alone, or their own. Nothing is on mainnet, and nothing is
shipped.

Up: [the repo](../README.md).

## How it works

Forest's host (`forest/records/src/host.ts`), unchanged, listens on loopback. In front of it, one
thing only: a front that answers `GET /` with one line saying what this is, and passes every other
request, untouched, to forest's host. So the routes are forest's six (forest's
[records](https://github.com/foundationforest/forest/blob/main/records/README.md), "Hosts"): records
in and out, messages in and pulled, blobs in and out. Forest's host checks every record's signature
and the access rule, every message's signature and its inbox's rule, and every blob's hash and the
record that names it, before it keeps anything.

`src/host.ts` hands forest's host the numbers in `POLICY` and, when `SOLANA_RPC_URL` is set, a
registry lookup: whether a key holds a row from an issuer, read with forest's registry client
(`fetchRows`, filtered on the key and the issuer). A row counts only if the issuer's signature on
its root checks (`issuerSigned`), since the registry stores that signature without checking it.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATABASE_PATH` | none: in memory | The SQLite file |
| `PORT` | `8080` | |
| `SOLANA_RPC_URL` | none: no lookup | The Solana RPC the registry lookup reads |
| `REGISTRY_PROGRAM_ID` | the devnet registry | The registry the lookup reads |

### Run it

```sh
./forest.sh keys records registry/client
cd host && npm ci
npm test
DATABASE_PATH=./data/host.sqlite npm start
```

The test checks that `/` says what this is, that forest's host runs with this policy, that records
go in and come back through the front, that the lookup counts a row only when the issuer signed it,
and that a message to an inbox open to one issuer's rows is taken with the lookup and refused
without it.

### On devnet

The build context is the repo root; `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`forest.sh records registry/client`, `npm ci`). Railway, project `forest-devnet`, service `host`,
at https://board-devnet-test-production.up.railway.app:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=host/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080, health check `/`.
- **Variables:** `DATABASE_PATH=/data/host.sqlite`, `PORT=8080`, and `SOLANA_RPC_URL` (sealed:
  Helius's devnet RPC, whose URL holds the key).

The devnet index reads it (`index/lists/hosts.json`), and connections looks there first (`HOSTS`).

## Policy

- **Keeps** a replaced record, a message, and bytes no current record names any more for **30
  days**, by its own clock. A current record stays.
- **Blobs:** png, jpeg and mp4, up to **50,000,000 bytes** each.
- **Sizes:** **100** records or messages a request; **1,000** a page, and at most **4,194,304
  bytes** a page, though always one line.
- **Inboxes:** it takes a message for any profile whose card here declares an inbox, under each of
  forest's rules: anyone, one issuer's rows (through the registry lookup, over `SOLANA_RPC_URL`;
  without it, refused as `rule_unsupported`), one message per sender, and a largest size.
- **Who may write:** anyone. It refuses nothing by policy of its own, and has no rate limit.
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
- **One file, one replica.**
- **It trusts its RPC** for the registry lookup. A lookup that fails refuses the message
  (`lookup`), and the sender sends it again.

## Who decides what

- **The standard (forest):** the six requests, what makes a record, a message and a blob valid, and
  the inbox's rules.
- **This host, by its policy:** the numbers above, the RPC it asks, its logs and its storage.
- **The person, through their app:** which hosts their hosts record names, and who may write to
  their inbox.

## FAQ

**Why run forest's host, and not one written here?**
Forest's host is the reference for what a host does. A host written here could drift from it, and
the e2e run would test the wrong thing.

**Why are the numbers written here, when they are forest's defaults?**
So moving the forest pin cannot change this host's policy without a pull request here that says so.

**Why is its address `board-devnet-test-production…`?**
It was the test board before forest's records replaced boards with hosts. Renaming the service
leaves the address as it is; changing the address would break the hosts record of every profile
the e2e runs made, and the index's hosts list.
