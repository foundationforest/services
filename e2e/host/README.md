# e2e/host

Devnet only: a host for devnet testing only. Nothing is on mainnet, and nothing is shipped.

Up: [e2e](../README.md).

## What it is

A host for records, run so the e2e run and the devnet index have somewhere to read and write: forest's
reference host (`forest/records/src/host.ts`), unchanged. It takes anyone's records, sets no policy
of its own, and may be wiped at any time.

The foundation runs no host; hosts are run by apps. This one exists for devnet testing only. Anyone
can run another, with this code or forest's host alone, or their own.

## How it works

Forest's host listens on loopback. In front of it, one thing only: a front that answers `GET /`
with one line saying what this is, and passes every other request, untouched, to forest's host.
So the routes are forest's (forest's [records](https://github.com/foundationforest/forest/blob/main/records/README.md),
"Hosts"): what's new for the whole host, a profile's records, and posting records. Forest's host
checks each record's signature and the writer rule before it keeps it.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATABASE_PATH` | none: records live in memory | The SQLite file |
| `PORT` | `8080` | |

### Run it

```sh
./forest.sh keys records
cd e2e/host && npm ci
npm test
DATABASE_PATH=./data/host.sqlite npm start
```

The test checks that `/` says what this is, and that records go in and come back through the
front, for the whole host and by profile.

### On devnet

Railway, project `forest-devnet`, service `board-devnet-test` (its old name; the address stays),
at https://board-devnet-test-production.up.railway.app:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=e2e/host/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080, health check `/`.
- **Variables:** `DATABASE_PATH=/data/host.sqlite`, `PORT=8080`.

The devnet index reads it (`index/lists/hosts.json`), and connections looks there first (`HOSTS`).

## Promises

- **Forest's host, unchanged.** The front adds the line at `/` and nothing else.
- **No address logs.** Neither forest's host nor the front logs a request or keeps an address. On
  Railway, Railway's own request logs exist.

## Limits

- **Anyone can write here,** anything forest's host accepts.
- **It may be wiped at any time,** and with it every record the e2e runs left.
- **One file, one replica.**

## FAQ

**Why is it called `board-devnet-test` on Railway?**
It was the test board before forest's records replaced boards with hosts. Renaming the service
would change its address, which the index's hosts list and the hosts record of every profile the
e2e runs made name.

**Why run forest's host, and not one written here?**
Forest's host is the reference for what a host does. A host written here could drift from it, and
the e2e run would test the wrong thing.
