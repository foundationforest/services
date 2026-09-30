# issuer

The foundation's issuer: the step from "a face check passed" to "this person's secret is on the
foundation's list". The foundation runs the first issuer, on list 0, which it owns. Issuers are
open: anyone may open a list of their own in the registry and run this service, or another, on it.

**Nothing here is shipped.** It runs on devnet, on Railway, with Didit's real face check
(`docs/services.md`); its tests run against a stand-in Didit and a local validator.

## What it does

1. **The app asks for a face check.** `POST /session`: the service opens a Didit session on the
   foundation's workflow and returns the page the person does the check on, and the session's id.
   One network address may open a few sessions an hour ("The request limit", below).
2. **The person does the check** on Didit's page: liveness and a duplicate-face search. Didit holds
   the face.
3. **The app sends two things:** the session id and the person's identity commitment, computed on
   the device from the identity secret `keys/` derives (`humanIdentity(seed).commitment`). Nothing
   else is accepted: a body with any other field is refused.
4. **The service asks Didit for that session's decision** and accepts only this: the session is on
   the foundation's workflow; Didit reports no duplicate face (`DUPLICATED_FACE` or
   `POSSIBLE_DUPLICATED_FACE`); every liveness step passed; the session is approved. A session id
   counts once.
5. **Accepted commitments wait in a queue.** A batch takes all of them every hour, or as soon as 50
   are waiting, whichever comes first. It shuffles them and inserts them into the list one
   transaction each, so an entry on the chain can't be matched to a face check by when it arrived.
6. **The app polls `POST /status`** until its commitment is `listed`. It can then build proofs
   against the list with `registry/client`.

## What it never does

- **Never keeps a session next to a commitment.** The file holds two tables that share nothing, with
  no timestamps and no row numbers: the SHA-256 of every session id used, and the commitments still
  waiting. A commitment leaves the file once it is on the list. Deleted bytes are overwritten, and
  after every batch the whole file is rewritten from what it still holds. A test reads the raw file
  and checks this.
- **Never logs a request, an address, a session id or a commitment.** It logs one line per batch
  (how many were inserted) and the kind of an error, never an error's message.
- **Never writes down an address.** It reads the client's address for one thing only, counting
  `/session` requests against the limit, and holds even that in memory as a keyed hash, under a key
  that exists only in the running process.
- **Never puts anything a person sends in a URL.** All three routes are POST with a JSON body,
  because hosting platforms log every request's path.
- **Never stores anything at `/session`.** The session's `vendor_data` is a fresh random id that
  names nobody.
- **Never signs for anyone.** Its key signs only its own inserts, and it holds no one else's key.
  There are no accounts.
- **Never deletes a Didit session.** Deleting a session removes that face from Didit's duplicate
  search, and the person could then pass again under a new secret.

## The API

| Route | Body | Answer |
|---|---|---|
| `POST /session` | `{}` or none | `201 {"sessionId": "…", "url": "https://verify.didit.me/…"}` |
| `POST /submit` | `{"sessionId": "<uuid>", "commitment": "<decimal>"}` | `202 {"status": "queued"}` |
| `POST /status` | `{"commitment": "<decimal>"}` | `200 {"status": "queued" \| "listed" \| "unknown"}` |

The commitment is a decimal number, as Semaphore prints it: above zero, below BN254's field order,
no leading zero.

Errors are `{"error": "<code>"}`:

- **`400`: a malformed request.**
  - `bad_session_id`, `bad_commitment`, `not_json`, `not_an_object`, `expected_empty_body`
  - `expected_exactly_sessionId_and_commitment`, `expected_exactly_commitment`
- **`403`: a face check that does not count.**
  - `unknown_session`, `wrong_workflow`, `duplicate_face`
  - `no_liveness`, `liveness_not_passed`, `not_approved`
- **`409`: already used or waiting.**
  - `session_used`, `commitment_queued`, `already_listed`
- **`429 try_later`: this address has opened its share of sessions for the hour.** Nothing more is
  said.
- **Other codes.**
  - `404 not_found`, `405 post_only`, `413 too_large` (bodies are capped at 1 KB)
  - `502 face_check_unavailable`, `500 internal`

A refused or failed submit uses nothing up. The same session can be sent again, for instance once a
review in Didit's console approves it. CORS is open to any origin.

## The request limit

A session costs the foundation money once someone does the check on it, so one network address may
open `SESSION_LIMIT_PER_HOUR` sessions (5 unless set) in an hour, counted from its first. After that,
`POST /session` answers `429 {"error": "try_later"}` and Didit is not asked. Only `/session` is
counted; a malformed request is refused before it is counted.

- **An IPv6 address counts with the rest of its /64,** which one phone or household usually holds
  whole, so walking through one's own addresses gets no more. An IPv4 address counts alone.
- **Behind a proxy, the service needs the proxy's header.** Name it in `CLIENT_ADDRESS_HEADER`
  (`x-real-ip` on Railway); otherwise every request would come from the proxy and share one count.
  Unset, the service counts the connection's own address and ignores every such header, since a
  client can write any header it likes.
- **In memory only.** Nothing about it is written to the file or the log, and the counts hold no
  address: each is a keyed hash under a random key made at start.
- **It resets on restart.** A restart gives every address a fresh share.
- **It is not a security boundary.** Someone with many addresses, or many /64s, opens many sessions.
  People behind one shared address (a campus, a carrier's shared address) share one count. It stops
  one person running up the bill from one place, and nothing more.

## The Didit workflow it expects

The service reads a decision; it can't see how the workflow was set up. So these are rules for
whoever runs it:

- **A liveness step, with face search on.** Face search is on by default. A workflow can turn it off
  (`face_search_enabled: false`), and then no decision says "duplicate" at all.
- **The duplicate-face rule should decline.** The issuer refuses the risk codes whatever the
  workflow's rules decide, but the person should be told on Didit's page, not afterwards.
- **Never delete sessions, or turn on biometric-template retention first.** Deleting a session
  drops its face from the duplicate search.
- **`DIDIT_API_KEY` must belong to the application that owns the workflow.** Didit shows a key only
  its own application's sessions.

## Running it locally

Node 22.18 or later runs the TypeScript directly. The registry client is imported from
`../registry/client/src` by relative path, the way `registry/client/scripts/devnet.ts` imports
`keys/`, so both packages need their dependencies:

```
cd registry/client && npm ci
cd issuer          && npm ci
npm run check                # type-check, the registry client's files included
npm test                     # no chain: a stand-in Didit, an in-memory list, a real SQLite file
npm run test:validator       # end to end on solana-test-validator (see below)
npm start                    # the service, with the variables below
```

`npm run test:validator` needs the Solana CLI on the PATH (4.2.2, `docs/devnet.md`) and the registry
program built (`cargo build-sbf` in `registry/program`). It starts its own validator, loads the
program, sends `init`, and starts the service from its environment variables with the real chain
client and a stand-in Didit. The issuer key is the program's placeholder, which the tests can sign
for (`registry/README.md`, "What is sealed").

To run the service by hand against that validator, write a key file (`solana-keygen new -o
issuer-keypair.json`, or the placeholder as the test does), point `ISSUER_KEYPAIR_PATH` at it, and
set the other required variables.

## Environment variables

| Variable | Required | Default | What |
|---|---|---|---|
| `DIDIT_API_KEY` | yes | | The foundation's Didit API key. A secret. |
| `DIDIT_WORKFLOW_ID` | yes | | The workflow sessions are opened on; decisions on any other are refused |
| `ISSUER_KEYPAIR` | one of these two | | The issuer's key itself: the contents of a key file, 64 numbers as `solana-keygen` writes them. For Railway, as a sealed variable. At start the service writes it to a new directory under the system's temporary directory, readable by its own user only, loads it, deletes the file, and takes the variable out of its environment. |
| `ISSUER_KEYPAIR_PATH` | one of these two | | Or a path to the key file, for local runs. Never commit it (`.gitignore` covers `*keypair*.json`). Either way the key must be an insert key of the list, and it pays its own inserts, so it holds a little SOL. |
| `SOLANA_RPC_URL` | yes | | The RPC the service reads the list from and sends inserts to |
| `REGISTRY_PROGRAM_ID` | no | the client's `PROGRAM_ID` | The registry program; devnet's is in `devnet/devnet.json` |
| `LIST_INDEX` | no | `0` | The list this issuer inserts into |
| `DATABASE_PATH` | no | `./data/issuer.sqlite` | The one file |
| `BATCH_MAX` | no | `50` | A batch runs as soon as this many are waiting |
| `BATCH_INTERVAL_SECONDS` | no | `3600` | And on this timer, whatever is waiting |
| `SESSION_LIMIT_PER_HOUR` | no | `5` | Sessions one address may open in an hour |
| `CLIENT_ADDRESS_HEADER` | no | none | The header a proxy in front puts the client's address in: `x-real-ip` on Railway. Unset, the connection's own address. |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in |
| `PORT` | no | `8080` | |

The service refuses to start if a required variable is missing, if both key variables are set, if
the key is not a keypair (the message quotes none of it), if the key is not an insert key of the
list, or if the list is closed.

## What running it on Railway will need

Not tried. What the service needs from any host, as it reads on Railway's documents in September
2026:

- **One replica, never more.** The queue is a SQLite file and one process runs the batches.
- **A volume** for `DATABASE_PATH`, or every deploy empties the queue and forgets the used sessions.
  A volume backup is a copy of the file as it was: waiting commitments included, and the deleted
  bytes of files that are gone, which the service can't rewrite.
- **The repo root as the build's root,** since the service imports `registry/client`.
  - Build: `npm ci` in `registry/client`, then in `issuer`. Start: `npm start` in `issuer`.
  - Node 22.18 or later: Railpack reads `RAILPACK_NODE_VERSION`, or `engines` in `package.json`.
  - The repo root has no `package.json`, so Railpack may not recognize the service as Node without
    a Railpack config file or a Dockerfile. Not tried.
- **`DIDIT_API_KEY` as a sealed variable.** Railway gives a sealed variable to the service but
  never shows it again.
- **The issuer key as the sealed variable `ISSUER_KEYPAIR`.** Railway has no secret files. The
  service writes the key at start to a private file in the container's temporary directory, off the
  volume, loads it and deletes the file. The key is never in the repo. It is not in the image
  either, as long as no build step reads the variable: Railway does hand sealed variables to builds,
  and nothing in this service's build uses it.
- **`CLIENT_ADDRESS_HEADER=x-real-ip`,** so the request limit counts each client, not Railway's edge.
- **SOL on the issuer key** for its inserts, about 5,000 lamports each.
- **Railway's HTTP logs.** Railway keeps every request's client address and path for 3 to 90 days,
  depending on plan, and its documents describe no way to turn that off. The service puts nothing
  in a path, but the addresses are Railway's log, not the service's. This conflicts with "no address
  logs" and is open (`docs/changes.md`).
- **A public domain** for the app to call. `PORT` is set by Railway.

## Chosen, not decided

Where the handoff and the task were silent, the simplest option was taken. Each is reversible
until something ships, and each is in `docs/changes.md`.

1. **Each Didit session gets a random `vendor_data`.** Didit's duplicate check compares a face
   against faces verified under a different `vendor_data`, and its documents don't say what happens
   with none. A fresh random one per session makes every earlier face count, and names nobody.
2. **`POSSIBLE_DUPLICATED_FACE` refuses, like `DUPLICATED_FACE`.** "Not a duplicate" is not what
   Didit reported.
3. **The session must be approved as a whole,** not only its liveness steps.
4. **A refused or failed submit doesn't use the session up.** A session in review may be approved
   later.
5. **Status is a POST,** so a commitment is never in a URL.
6. **The commitment is sent as a decimal number,** the way Semaphore prints it.
7. **The file keeps session ids as SHA-256 hashes,** not in the clear. Refusing reuse needs no more,
   and a copy of the file then lists no Didit session.
8. **Two `WITHOUT ROWID` tables, no timestamps, `secure_delete` on, and `VACUUM` after every batch.**
   `VACUUM` rewrites the file from its live rows, which also drops the order rows arrived in. The
   rollback journal is deleted after each commit.
9. **One insert per transaction,** sent in the shuffled order, each confirmed (or its blockhash
   expired) before the next. The issuer key pays its own network fees; the fee payer is for
   people's transactions.
10. **A batch takes everything waiting,** skips any commitment already on the list, and stops at
    the first failure, leaving the rest queued. The program takes the same commitment twice, so not
    sending it twice is the issuer's job.
11. **The members are held in memory,** read from the chain at start and before every batch, plus
    each confirmed insert. `/status` never reads the chain itself.
12. **`node:sqlite` and `node:http`,** built into Node, so the service has one dependency:
    `@solana/web3.js`, pinned to the client's version.
13. **CORS is open to any origin.** The app may be served from anywhere.
14. **At start, the key must be an insert key of an open list.**
15. **Five sessions per address per hour by default,** in a window that starts at the address's
    first request.
16. **An IPv6 address counts by its /64.**
17. **The limit holds keyed hashes, not addresses,** under a key made at start and never written.
18. **The client's address comes from a proxy's header only when `CLIENT_ADDRESS_HEADER` names
    one,** so a client can't choose its own address where no proxy stands in front.
19. **The key file from `ISSUER_KEYPAIR` is deleted as soon as the key is loaded,** since nothing
    reads it again, and the variable is taken out of the process's environment.
