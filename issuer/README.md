# issuer

Devnet only: the foundation's issuer runs on devnet with a stand-in face check that passes
everyone. Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md).

## What it is

The keeper of the human list: a face check, once per person, and then their stamp on a list
everyone can read. A registry row proves a profile's holder is on this list without saying who
they are (forest's [registry](https://github.com/foundationforest/forest/blob/main/registry/README.md)).
The issuer keeps the list off chain, publishes it with every snapshot of it signed by its keeper
key, and does nothing else.

This is the foundation's first issuer. Anyone can run another, with this code or their own: a
keeper is anyone who keeps a list of stamps, and each reader decides which keepers it trusts.

## How it works

1. **The app opens a face check.** `POST /session` opens a Didit session on the foundation's
   workflow and returns the page the person does the check on (liveness, and a search for a
   duplicate face). Didit holds the face.
2. **The app sends the session and the person's stamp.** The stamp is made on the device, from the
   person's seed and this keeper's address (forest's `listSecret(seed, keeper)`). Nothing else is
   accepted.
3. **The issuer asks Didit for the session's decision** and accepts it only if: the session is on
   the foundation's workflow; Didit reports no duplicate face (`DUPLICATED_FACE` or
   `POSSIBLE_DUPLICATED_FACE`); every liveness step passed; the session is approved. A session
   counts once.
4. **Accepted stamps wait,** then go onto the list in a batch: everything waiting, every hour or as
   soon as 50 wait, shuffled, so a place on the list cannot be matched to a face check by when it
   arrived. Each batch gives the list one new snapshot.
5. **It publishes the list** with every snapshot it has had, each signed with its keeper key
   ([The list file](#the-list-file)).
6. **The app polls `POST /status`** until its stamp is `listed`, reads `/list.json`, and registers
   with forest's registry client (`buildRegistration`), proving against the newest snapshot and
   putting its signature in the row.

### The API

| Route | Body | Answer |
|---|---|---|
| `POST /session` | `{}` or none | `201 {"sessionId": "…", "url": "…"}` |
| `POST /submit` | `{"sessionId": "<uuid>", "stamp": "<decimal>"}` | `202 {"status": "queued"}` |
| `POST /status` | `{"stamp": "<decimal>"}` | `200 {"status": "queued" \| "listed" \| "unknown"}` |
| `GET /list.json` | | `200`, the list file |

A stamp is a decimal number, as Semaphore prints it: above zero, below BN254's field order, no
leading zero. A body with any other field is refused. CORS is open to any origin.

Errors are `{"error": "<code>"}`:

| Status | Codes |
|---|---|
| `400` | `bad_session_id`, `bad_stamp`, `not_json`, `not_an_object`, `expected_empty_body`, `expected_exactly_sessionId_and_stamp`, `expected_exactly_stamp` |
| `403` (the face check does not count) | `unknown_session`, `wrong_workflow`, `duplicate_face`, `no_liveness`, `liveness_not_passed`, `not_approved` |
| `409` | `session_used`, `stamp_queued`, `already_listed` |
| `429` | `try_later`: this address opened its share of sessions this hour |
| other | `404 not_found`, `405 post_only`, `405 get_only`, `413 too_large` (bodies over 1 KB), `502 face_check_unavailable`, `500 internal` |

A refused or failed submit uses nothing up: the same session can be sent again, for instance once a
review in Didit approves it.

### The list file

`GET /list.json`, RFC 8785 canonical JSON, `cache-control: no-cache`:

```
{"keeper":"<address>","snapshots":[{"root":"<64 hex>","signature":"<128 hex>","size":3,"time":1790000000000},…],"stamps":["<decimal>",…],"v":1}
```

- `keeper`: the keeper key's address, base58. This is the name a registry row records and a reader
  trusts.
- `stamps`: every stamp on the list, in list order: the order batches added them, shuffled within
  each batch. The list only grows.
- `snapshots`: one per batch, oldest first, never removed. `root` is the Semaphore Merkle root of
  the first `size` stamps, as forest's `listRoot` builds it, as 32 big-endian bytes in hex; `time`
  is when the batch ran, in milliseconds since 1970; `signature` is the keeper key's ed25519
  signature over those 32 bytes, in hex.

**How an app uses it:** take the newest snapshot, the first `size` stamps, and its signature, and
pass them to `buildRegistration`, which checks the signature before it proves anything.
**How a reader checks a row:** forest's `keeperSigned(row)`; it needs only the row, not this file.

### Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `DIDIT_API_KEY` | yes | | The foundation's Didit API key. A secret |
| `DIDIT_WORKFLOW_ID` | yes | | The workflow sessions are opened on; any other is refused |
| `ISSUER_KEYPAIR` | one of these two | | The keeper key: a JSON list of 64 numbers, as `solana-keygen` writes it. At start it is written to a private file in a new temporary directory, loaded, the file deleted, and the variable taken out of the environment |
| `ISSUER_KEYPAIR_PATH` | one of these two | | Or a path to that file, for local runs. `.gitignore` covers `*keypair*.json` |
| `DATABASE_PATH` | no | `./data/issuer.sqlite` | The one file: queue, used sessions, list, snapshots |
| `BATCH_MAX` | no | `50` | A batch runs as soon as this many wait |
| `BATCH_INTERVAL_SECONDS` | no | `3600` | And on this timer |
| `SESSION_LIMIT_PER_HOUR` | no | `5` | Sessions one address may open in an hour |
| `CLIENT_ADDRESS_HEADER` | no | none | The header a proxy puts the client's address in (`x-real-ip` on Railway) |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in |
| `PORT` | no | `8080` | |

It refuses to start if a required variable is missing, if both key variables are set, if the key is
not a keypair (the message quotes none of it), or if the file's list does not match its newest
snapshot. The key's address is the keeper's name: a new key is a new keeper that readers must be
told about.

### Run it

Node 22.18 or later. From the repo root:

```
./forest.sh registry/client records
cd issuer && npm ci
npm run check        # type-check, forest's files included
npm test             # a stand-in Didit, a real SQLite file, real HTTP
npm start            # the service, with the variables above
```

To run it by hand, make a key outside the repo (`solana-keygen new -o …/issuer-keypair.json`) and
point `ISSUER_KEYPAIR_PATH` at it.

### On devnet

Any platform that runs Node 22.18 with a persistent disk. **One replica, never more:** the queue and
the list are one SQLite file. **A volume** for `DATABASE_PATH`, or each deploy loses the list. The
build context is the repo root. `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`forest.sh registry/client records`, `npm ci`) and runs `deploy/start.sh`: with no
`DIDIT_API_KEY`, that first starts `deploy/fake-didit.ts`, a stand-in Didit on 127.0.0.1 that
approves every session it opens, points the issuer at it, and says so.

The foundation's devnet issuer runs that image on Railway, project `forest-devnet`, service
`issuer`, at https://issuer-production-4976.up.railway.app:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=issuer/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080. No health check: Railway
  refuses a path with a dot, and the other routes are POST.
- **The keeper key** is the devnet `issuer` key: address `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7`,
  the one keeper the devnet index trusts (`index/lists/keepers.json`).
- **No Didit key,** so the stand-in face check passes everyone.

| Variable | On devnet | Sealed |
|---|---|---|
| `ISSUER_KEYPAIR` | the devnet `issuer` key | yes |
| `DATABASE_PATH` | `/data/issuer.sqlite` | no |
| `BATCH_MAX` | `50` | no |
| `BATCH_INTERVAL_SECONDS` | `120` | no |
| `SESSION_LIMIT_PER_HOUR` | `20`, so a few e2e runs an hour fit | no |
| `CLIENT_ADDRESS_HEADER` | `x-real-ip` | no |
| `PORT` | `8080` | no |

Setting `DIDIT_API_KEY` and `DIDIT_WORKFLOW_ID` (sealed) and redeploying puts the real face check in
the stand-in's place. Its list holds the stamps of every e2e run since it started, and of the runs
before it was a keeper, kept under its new names.

## Promises

- **It never keeps a session next to a stamp.** Its one SQLite file has four tables. The two
  private ones share nothing and have no timestamps or row numbers: the SHA-256 of every session id
  used, and the stamps still waiting. The two public ones are the list and its snapshots. A stamp
  leaves the queue in the same transaction that lists it. Deleted bytes are overwritten
  (`secure_delete`), and after every batch the file is rewritten from what it holds (`VACUUM`). A
  test reads the raw file and checks this.
- **It never logs a request, an address, a session or a stamp.** It logs counts per batch, and an
  error's kind, never its message.
- **It never writes down an address.** It reads the client's address only to count `/session`
  against the limit, in memory, as a keyed hash under a key made at start.
- **It never puts what a person sends in a URL.** The three routes an app calls are POST with a JSON
  body, since hosting platforms log paths.
- **It never signs for anyone.** Its key signs the snapshots of its list, nothing else.
- **It never deletes a Didit session.** That would drop the face from Didit's duplicate search.
- **It never puts the list on chain.** A keeper's list lives off chain; a row carries only a root
  and the keeper's signature on it.

## Limits

- **On devnet, anyone passes.** The stand-in face check approves every session, so anyone who asks
  can put a stamp on the devnet list.
- **It trusts Didit's decision,** for a session on its own workflow: status, liveness steps and
  risk codes. It reads those and drops everything else Didit returns. It cannot see the workflow's
  setup: a liveness step with face search on (Didit's default), and an API key from the application
  that owns the workflow.
- **It trusts its own file:** at start, the file's list must match its newest snapshot, or it
  refuses to start.
- **A proxy's address header counts only when `CLIENT_ADDRESS_HEADER` names it;** otherwise the
  connection's own address, since a client can write any header.
- **The request limit is not a security boundary.** One address may open `SESSION_LIMIT_PER_HOUR`
  sessions in an hour, counted from its first; an IPv6 address counts with the rest of its /64. It
  stops one person running up the Didit bill from one place, and nothing more: someone with many
  addresses opens many sessions, and people behind one shared address share one count. The counts
  live in memory and reset on restart. `/submit` has no limit.
- **Start-up grows with the list.** It builds the Merkle tree from the file before it listens:
  about 0.4 seconds per 1,000 stamps. After that each batch hashes only what it adds.
- **`list.json` grows** by about 80 bytes a stamp, and holds every snapshot.
- **A new key is a new keeper.** Readers trust the address; there is no signed handover.
- **If the issuer's file is lost, so is its list.** It is published, but nothing here rebuilds the
  file from a copy.
- **Address logs.** The issuer keeps no network address (above). A hosting provider's own request
  logs are the operator's choice; on Railway they exist, with each request's client address and
  path.

## FAQ

**Why one file, list and signatures together?**
An app needs the stamps and the signature on their root from the same moment. Two files read one
after the other could straddle a batch; one file cannot.

**Why sign each snapshot's root, and not the whole file?**
A row carries one root and the keeper's signature on it, checked by anyone forever with
`keeperSigned`. Signing the root itself, as 32 big-endian bytes, is what the registry asks a keeper
to sign, so the signature in the file is the one that goes into the row.

**Why is the list not written on chain any more?**
Keepers' lists are never on chain. A row on chain needs only the root and the signature, and a
reader needs nothing else to count it.

**Why are a session and a stamp never stored side by side?**
So nothing ties a face check to a place on the list: two tables with no timestamps or row numbers,
deleted bytes overwritten, the file rewritten after every batch.

**Why batches, shuffled, hourly or at 50?**
So a place on the list cannot be matched to a face check by when it arrived.

**Why does `POSSIBLE_DUPLICATED_FACE` refuse like `DUPLICATED_FACE`, and why a fresh random
`vendor_data` on every Didit session?**
"Not a duplicate" is not what Didit said, and the random id names nobody.

**Why is everything an app sends a POST body?**
Hosting platforms log paths.

**Why does the session limit live in memory as keyed hashes, an IPv6 address counted by its /64?**
It stops one person running up the Didit bill without writing down an address.

**Why does a refused or failed submit use nothing up?**
A session in review may be approved later.

**Could someone rebuild this issuer from public data?**
Its list and every signed snapshot are public, so anyone can check it and keep a copy. A new keeper
starts its own list; its people come to it through their own face check.
