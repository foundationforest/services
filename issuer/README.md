# issuer

Devnet only: the foundation's issuer runs on devnet with a stand-in face check that passes
everyone. Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md). Who reads what it publishes: [the index](../index/README.md), and
apps through `forest/registry/client`.

The issuer checks once, by face, that someone is one real human, and adds them to its list. A badge
is proven against that list. The issuer keeps the list itself and publishes it; the registry never
sees a list and checks no root. Issuers are open: anyone may keep a list and publish it the same way,
with this service or another, and each reader decides which issuers it trusts.

## What it does

1. **The app asks for a face check.** `POST /session` opens a Didit session on the foundation's
   workflow and returns the page the person does the check on (liveness, and a search for a
   duplicate face). Didit holds the face.
2. **The app sends the session and the person's identity commitment,** computed on the device from
   the identity secret forest's keys recipe derives. Nothing else is accepted.
3. **The issuer asks Didit for the session's decision** and accepts it only if: the session is on
   the foundation's workflow; Didit reports no duplicate face (`DUPLICATED_FACE` or
   `POSSIBLE_DUPLICATED_FACE`); every liveness step passed; the session is approved. A session
   counts once.
4. **Accepted commitments wait,** then go onto the list in a batch: everything waiting, every hour
   or as soon as 50 wait, shuffled, so a place on the list cannot be matched to a face check by when
   it arrived. Each batch gives the list one new root.
5. **It publishes the list and every root it has had** as two files, the roots signed with its key
   ([The two files](#the-two-files)). With an RPC, it also writes each batch on chain, so the whole
   list can be rebuilt from the chain alone ([Each batch on chain](#each-batch-on-chain)).
6. **The app polls `POST /status`** until its commitment is `listed`, reads `/list.json`, and proves
   against it with `forest/registry/client` (`buildRegistration`).

## The API

| Route | Body | Answer |
|---|---|---|
| `POST /session` | `{}` or none | `201 {"sessionId": "…", "url": "…"}` |
| `POST /submit` | `{"sessionId": "<uuid>", "commitment": "<decimal>"}` | `202 {"status": "queued"}` |
| `POST /status` | `{"commitment": "<decimal>"}` | `200 {"status": "queued" \| "listed" \| "unknown"}` |
| `GET /list.json` | | `200`, the list file |
| `GET /roots.json` | | `200`, the roots file |

A commitment is a decimal number, as Semaphore prints it: above zero, below BN254's field order, no
leading zero. A body with any other field is refused. CORS is open to any origin.

Errors are `{"error": "<code>"}`:

| Status | Codes |
|---|---|
| `400` | `bad_session_id`, `bad_commitment`, `not_json`, `not_an_object`, `expected_empty_body`, `expected_exactly_sessionId_and_commitment`, `expected_exactly_commitment` |
| `403` (the face check does not count) | `unknown_session`, `wrong_workflow`, `duplicate_face`, `no_liveness`, `liveness_not_passed`, `not_approved` |
| `409` | `session_used`, `commitment_queued`, `already_listed` |
| `429` | `try_later`: this address opened its share of sessions this hour |
| other | `404 not_found`, `405 post_only`, `405 get_only`, `413 too_large` (bodies over 1 KB), `502 face_check_unavailable`, `500 internal` |

A refused or failed submit uses nothing up: the same session can be sent again, for instance once a
review in Didit approves it.

## The two files

What indexes, boards and apps read. Each is served at a fixed path on the issuer's own address, as
RFC 8785 canonical JSON, with `cache-control: no-cache`. Large numbers are decimal text.

**`GET /list.json`: the list.**

```
{"commitments":["<decimal>",…],"v":1}
```

Every identity commitment on the list, in list order: the order batches added them, shuffled within
each batch. The list only grows. The file is not signed; the roots file covers it.

**`GET /roots.json`: every root the list has had, signed.**

```
{"issuer":"did:key:z6Mk…","roots":[{"root":"<decimal>","size":3,"time":1790000000000},…],"sig":"<base64url>","v":1}
```

- `issuer`: the issuer's key, as its did:key. This is the name a reader trusts.
- `roots`: one per batch, oldest first, never removed. `root` is the Semaphore Merkle root of the
  first `size` commitments, as `forest/registry/client`'s `listRoot` builds it; `time` is when the
  batch ran, in milliseconds since 1970. Before the first batch, `roots` is empty.
- `sig`: Ed25519, base64url without padding, over `0xff` ‖ UTF-8(`forest.foundation/issuer/roots/v1\n`)
  ‖ UTF-8(the canonical text of the file without `sig`). A record is signed the same way under its
  own label, so neither signature can pass for the other.

**How a reader checks them:** both parse as canonical text (re-serializing gives the same bytes);
`sig` verifies under the key `issuer` names, and that is an issuer it trusts; the newest root's
`size` is the list's length, and `listRoot` of the whole list is that root. Older roots check the
same way against their prefix of the list.

## Each batch on chain

With `SOLANA_RPC_URL` set, each batch, once it is in the issuer's file, is also written to Solana:
its new root and its new members, in notes the issuer's key signs. A note is the root's line of the
roots file with a run of the batch's members from list position `from`, under its own label (one
newline after the label, none at the end):

```
forest.foundation/issuer/root/v2
{"commitments":["<decimal>",…],"from":0,"root":"<decimal>","size":3,"time":1790000000000}
```

A batch whose members do not fit in one note is cut into as few as fit, about ten members a note,
and each note repeats the root's line, so every note reads alone. So the chain holds every root and
every member, dated by the chain, even if the issuer stops answering or changes its files.

- **The transaction:** one per note, paid and signed by the issuer's key: the compute budget
  program's `SetComputeUnitLimit` at 500,000 with no price, then Solana's memo program (v2,
  `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) naming the key as its signer, the note as its text.
  The memo program spends about 350 compute units a byte; a full note (1,021 bytes) took 373,272 on
  devnet. Built by hand, with no Solana library.
- **How a reader checks one:** the transaction succeeded; the issuer's key signed it; a top-level
  memo (v2) instruction names that key; its text is the label, then canonical text with exactly
  `commitments` (at least one), `from`, `root`, `size` and `time`, the members ending at or before
  `size`.
- **How a reader rebuilds the list** (`listFromNotes` in `src/list.ts`): place each member at its
  position; a note seen twice counts once; refuse a gap, two notes that disagree, or members past
  the newest root; then check each root against its prefix. The tests rebuild `list.json` and every
  root from the notes alone, and the loop does it from devnet.
- **Order and retries:** oldest batch first, one note at a time. A note that fails or expires is
  tried again a minute later, from that note on. The file records a batch's transactions once all
  its notes are confirmed.
- **Version 1** of the label (`…/issuer/root/v1`) held the root alone. A file from then writes every
  batch again at start, with its members; the old memos stay on chain, and the index still reads a
  root from them.
- **Cost:** 5,000 lamports a note. A batch of 50 is five notes; one such batch an hour is about
  0.22 SOL a year. That SOL is all the key needs.

## What it never does

- **Never keeps a session next to a commitment.** Its one SQLite file has four tables. The two
  private ones share nothing and have no timestamps or row numbers: the SHA-256 of every session id
  used, and the commitments still waiting. The two public ones are the list and its roots. A
  commitment leaves the queue in the same transaction that lists it. Deleted bytes are overwritten
  (`secure_delete`), and after every batch the file is rewritten from what it holds (`VACUUM`). A
  test reads the raw file and checks this.
- **Never logs a request, an address, a session or a commitment.** It logs counts per batch and per
  run of notes, and an error's kind, never its message.
- **Never writes down an address.** It reads the client's address only to count `/session` against
  the limit, in memory, as a keyed hash under a key made at start.
- **Never puts what a person sends in a URL.** The three routes an app calls are POST with a JSON
  body, since hosting platforms log paths.
- **Never signs for anyone.** Its key signs the roots file and its note transactions, nothing else.
- **Never deletes a Didit session.** That would drop the face from Didit's duplicate search.

## What it trusts

- **Didit's decision,** for a session on its own workflow: status, liveness steps and risk codes.
  It reads those and drops everything else Didit returns.
- **The Didit workflow's setup,** which it cannot see: a liveness step with face search on (Didit's
  default), and `DIDIT_API_KEY` from the application that owns the workflow.
- **Its own file:** at start, the file's list must match its newest root, or it refuses to start.
- **A proxy's address header only when `CLIENT_ADDRESS_HEADER` names it;** otherwise the
  connection's own address, since a client can write any header.

## The request limit

One network address may open `SESSION_LIMIT_PER_HOUR` sessions (5 unless set) in an hour, counted
from its first; then `POST /session` answers `429 try_later` and Didit is not asked. Only `/session`
counts. An IPv6 address counts with the rest of its /64; an IPv4 address alone. The counts live in
memory only and reset on restart. It stops one person running up the Didit bill from one place, and
nothing more: someone with many addresses opens many sessions, and people behind one shared address
share one count.

## Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `DIDIT_API_KEY` | yes | | The foundation's Didit API key. A secret |
| `DIDIT_WORKFLOW_ID` | yes | | The workflow sessions are opened on; any other is refused |
| `ISSUER_KEYPAIR` | one of these two | | The key itself: a JSON list of 64 numbers, as `solana-keygen` writes it. At start it is written to a private file in a new temporary directory, loaded, the file deleted, and the variable taken out of the environment |
| `ISSUER_KEYPAIR_PATH` | one of these two | | Or a path to that file, for local runs. `.gitignore` covers `*keypair*.json` |
| `DATABASE_PATH` | no | `./data/issuer.sqlite` | The one file: queue, used sessions, list, roots |
| `BATCH_MAX` | no | `50` | A batch runs as soon as this many wait |
| `BATCH_INTERVAL_SECONDS` | no | `3600` | And on this timer |
| `SESSION_LIMIT_PER_HOUR` | no | `5` | Sessions one address may open in an hour |
| `SOLANA_RPC_URL` | no | none | Where each batch is written on chain. Unset: nothing goes on chain. A URL holding a provider's key is a secret |
| `CLIENT_ADDRESS_HEADER` | no | none | The header a proxy puts the client's address in (`x-real-ip` on Railway) |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in |
| `PORT` | no | `8080` | |

It refuses to start if a required variable is missing, if both key variables are set, if the key is
not a keypair (the message quotes none of it), or if the file's list does not match its newest root.
The key's did:key is the issuer's name: a new key is a new issuer that readers must be told about.

## Run it

Node 22.18 or later. From the repo root:

```
./forest.sh registry/client records
cd issuer && npm ci
npm run check        # type-check, forest's files included
npm test             # a stand-in Didit, a real SQLite file, real HTTP, a stand-in Solana RPC
npm start            # the service, with the variables above
```

To run it by hand, make a key outside the repo (`solana-keygen new -o …/issuer-keypair.json`) and
point `ISSUER_KEYPAIR_PATH` at it.

## Deploy

Any platform that runs Node 22.18 with a persistent disk. **One replica, never more:** the queue and the
list are one SQLite file. **A volume** for `DATABASE_PATH`, or each deploy loses the list. The build
context is the repo root. `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`forest.sh registry/client records`, `npm ci`) and runs `deploy/start.sh`: with no `DIDIT_API_KEY`,
that first starts `deploy/fake-didit.ts`, a stand-in Didit on 127.0.0.1 that approves every session
it opens, points the issuer at it, and says so.

**The foundation's devnet issuer** runs that image on Railway, project `forest-devnet`, service
`issuer`:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=issuer/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080 (the fixed address of the two
  files). No health check: Railway refuses a path with a dot, and the other routes are POST.
- **No Didit key,** so the stand-in face check passes everyone.

| Variable | On devnet | Sealed |
|---|---|---|
| `ISSUER_KEYPAIR` | the devnet issuer key from forest's `devnet/keys.sh`; did:key `z6MkmSeFgQp3SxoPB3qmrNFmqPaZAmjMUzmv9KViBqWtPLFV`, address `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` | yes |
| `SOLANA_RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `DATABASE_PATH` | `/data/issuer.sqlite` | no |
| `BATCH_MAX` | `50` | no |
| `BATCH_INTERVAL_SECONDS` | `120` | no |
| `SESSION_LIMIT_PER_HOUR` | `20`, so a few loop runs an hour fit | no |
| `CLIENT_ADDRESS_HEADER` | `x-real-ip` | no |
| `PORT` | `8080` | no |

Setting `DIDIT_API_KEY` and `DIDIT_WORKFLOW_ID` (sealed) and redeploying puts the real face check in
the stand-in's place.

## Limits

- **On devnet, anyone passes.** The stand-in face check approves every session, so anyone who asks
  can put a commitment on the devnet list.
- **`/submit` has no limit.** Each one asks Didit for a decision.
- **Start-up grows with the list.** It builds the Merkle tree from the file before it listens:
  about 0.4 seconds per 1,000 members, about 27 per 100,000. After that each batch hashes only what
  it adds.
- **`list.json` grows** by about 80 bytes a member, and every reader that rebuilds from the chain
  reads about one transaction per ten members.
- **A new key is a new issuer.** Readers trust the did:key; there is no signed handover.
- **A restart mid-batch writes that batch's notes again,** so a note can land twice; readers keep
  each once.
- **The request limit is not a security boundary** (above).
- **Address logs at the hosting platform.** Railway keeps every request's client address and path in its own
  logs.
