# issuer

The foundation's issuer: the step from "a face check passed" to "this person's secret is on the
foundation's list". The issuer keeps its list itself and publishes it; the registry never sees a
list. Issuers are open: anyone may keep a list and publish it the same way, with this service or
another.

**Nothing here is shipped.** Its tests run against a stand-in Didit and a stand-in Solana RPC. The
devnet issuer on Railway runs this version, with the stand-in face check (`deploy/README.md`).

## What it does

1. **The app asks for a face check.** `POST /session`: the service opens a Didit session on the
   foundation's workflow and returns the page the person does the check on, and the session's id.
   One network address may open a few sessions an hour ("The request limit", below).
2. **The person does the check** on Didit's page: liveness and a duplicate-face search. Didit holds
   the face.
3. **The app sends two things:** the session id and the person's identity commitment, computed on
   the device from the identity secret `forest/keys/` derives (`humanIdentity(seed)`'s
   `commitment`). Nothing else is accepted: a body with any other field is refused.
4. **The service asks Didit for that session's decision** and accepts only this: the session is on
   the foundation's workflow; Didit reports no duplicate face (`DUPLICATED_FACE` or
   `POSSIBLE_DUPLICATED_FACE`); every liveness step passed; the session is approved. A session id
   counts once.
5. **Accepted commitments wait in a queue.** A batch takes all of them every hour, or as soon as 50
   are waiting, whichever comes first. It shuffles them and appends them to the list, so a place
   on the list can't be matched to a face check by when it arrived. Each batch gives the list one
   new root.
6. **The service publishes two files:** the whole list, in order, and every root it has had, with
   dates, signed with the issuer's key ("The two files", below). They change after each batch. When
   it has a Solana RPC, it also writes each batch on chain, its new root and its new members, in
   notes its key signs, so the whole list can be rebuilt from the chain alone ("Each batch on
   chain", below).
7. **The app polls `POST /status`** until its commitment is `listed`. It then reads `/list.json`
   and proves against it with `forest/registry/client` (`buildRegistration`).

## What it never does

- **Never keeps a session next to a commitment.** The file holds four tables. The two private ones
  share nothing and hold no timestamps and no row numbers: the SHA-256 of every session id used,
  and the commitments still waiting. The two public ones are what the files publish: the list and
  its roots. A commitment leaves the queue in the same transaction that puts it on the list.
  Deleted bytes are overwritten, and after every batch the whole file is rewritten from what it
  still holds, so no deleted or moved row leaves a copy behind. A test reads the raw file and checks
  this.
- **Never logs a request, an address, a session id or a commitment.** It logs one line per batch
  (how many were added) and the kind of an error, never an error's message.
- **Never writes down an address.** It reads the client's address for one thing only, counting
  `/session` requests against the limit, and holds even that in memory as a keyed hash, under a key
  that exists only in the running process.
- **Never puts anything a person sends in a URL.** The three routes a person's app calls are POST
  with a JSON body, because hosting platforms log every request's path. The two files are GET, and
  their paths name nothing.
- **Never stores anything at `/session`.** The session's `vendor_data` is a fresh random id that
  names nobody.
- **Never signs for anyone.** Its key signs its roots file and the transactions that put its
  batches on chain, and nothing else, and it holds no one else's key. There are no accounts.
- **Never deletes a Didit session.** Deleting a session removes that face from Didit's duplicate
  search, and the person could then pass again under a new secret.

## The API

| Route | Body | Answer |
|---|---|---|
| `POST /session` | `{}` or none | `201 {"sessionId": "…", "url": "https://verify.didit.me/…"}` |
| `POST /submit` | `{"sessionId": "<uuid>", "commitment": "<decimal>"}` | `202 {"status": "queued"}` |
| `POST /status` | `{"commitment": "<decimal>"}` | `200 {"status": "queued" \| "listed" \| "unknown"}` |
| `GET /list.json` | | `200`, the list file |
| `GET /roots.json` | | `200`, the roots file |

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
  - `404 not_found`, `405 post_only`, `405 get_only` (the two files), `413 too_large` (bodies
    are capped at 1 KB)
  - `502 face_check_unavailable`, `500 internal`

A refused or failed submit uses nothing up. The same session can be sent again, for instance once a
review in Didit's console approves it. CORS is open to any origin.

## The two files

What indexes, boards and apps read. Each is served at a fixed path on the issuer's own address, as
RFC 8785 canonical JSON (`forest/records/SPEC.md`, section 2), with `cache-control: no-cache`.
Numbers too large for JSON are decimal text, as the API sends them.

**`GET /list.json`: the list.**

```
{"commitments":["<decimal>",…],"v":1}
```

- `commitments`: every identity commitment on the list, in list order: the order the batches added
  them, shuffled within each batch. The list only grows; nothing is ever removed or reordered.
- `v`: 1.
- The file is not signed. It is checked against the roots file.

**`GET /roots.json`: every root the list has had, signed.**

```
{"issuer":"did:key:z6Mk…","roots":[{"root":"<decimal>","size":3,"time":1790000000000},…],"sig":"<base64url>","v":1}
```

- `issuer`: the issuer's key, as its did:key (`forest/records/SPEC.md`, section 1). This is the
  name a reader trusts.
- `roots`: one entry per batch, oldest first, never removed.
  - `root`: the Semaphore Merkle root of the first `size` commitments, as the circuit computes it
    (`forest/registry/client`'s `listRoot`).
  - `size`: how many commitments the list held.
  - `time`: when the batch ran, in milliseconds since 1970.
  - Before the first batch, `roots` is empty.
- `sig`: Ed25519 (RFC 8032), base64url without padding, over `0xff` ‖
  UTF-8(`forest.foundation/issuer/roots/v1\n`) ‖ UTF-8(the canonical text of the file without
  `sig`). This is how a records entry is signed, under its own label, so neither signature can pass
  for the other.
- `v`: 1.

**How a reader checks them:**
1. Parse both as canonical text: re-serializing must give the same bytes.
2. Check `sig` against the key `issuer` names, and that `issuer` is the issuer it trusts.
3. Check that the newest root's `size` is the list's length, and that `listRoot` of the whole list
   is that root.
4. It may check every older root against its prefix of the list the same way.

A device proves against the whole list (the newest root). An index or a board counts a line when
the line's root is in the roots file of an issuer it trusts, or on chain from it (below). The
registry itself checks no root.

## Each batch on chain

When `SOLANA_RPC_URL` is set, each batch, once it is in the file, is also written to Solana: its
new root and its new members, in notes. A note is the root's line of the roots file with a run of
the batch's members, in list order, from list position `from` (0 for the list's first), under its
own label:

```
forest.foundation/issuer/root/v2
{"commitments":["<decimal>",…],"from":0,"root":"<decimal>","size":3,"time":1790000000000}
```

(one newline between the label and the canonical text, none after). A batch whose members do not fit
in one note is cut into as few as fit, about ten members a note; each note carries the root's line
again, so every note reads alone. So the chain holds every root the issuer has published and every
member of its list, dated by the chain, readable from the issuer's own address even if the issuer
stops answering or changes its files.

- **The transaction:** one per note, paid for and signed by the issuer's key. Two instructions: the
  compute budget program's `SetComputeUnitLimit` at 500,000 with no price, then Solana's memo
  program (v2, `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) naming the key as its signer, with the
  note as its text. The memo program spends about 350 compute units a byte (it logs the text): a
  full note, 1,021 bytes, took 373,272 units on devnet, above the default limit of 200,000. A note's
  size is bound by the transaction's 1,232 bytes.
- **How a reader checks one:** the transaction succeeded; the issuer's key signed it (its address
  is the did:key's public key, in base58); a top-level instruction calls the memo program v2 naming
  that key; its text is the label, then canonical text with exactly `commitments` (decimal text, at
  least one), `from`, `root`, `size` and `time`, the members ending at or before `size`.
- **How a reader rebuilds the list** (`listFromNotes` in `src/chain.ts`): read every note the key
  signed; place each member at its position; a note seen twice counts once. Refuse a gap, two notes
  that disagree on a member or on a root, or members past the newest root. Then check each root
  against its prefix of the list, as "The two files" says. The tests rebuild `list.json` and every
  root of `roots.json` from the notes alone; on devnet, the loop does it from the chain.
- **Order and retries:** batches are written oldest first, one note at a time. A note the RPC does
  not take, or that does not confirm before its blockhash runs out, is tried again a minute later,
  from that note on; the file records a batch's transactions once all its notes are confirmed. A
  restart in the middle of a batch writes that batch's notes again, and a note sent, lost and sent
  again could land twice; a reader keeps each once.
- **Version 1** of the label (`forest.foundation/issuer/root/v1`) held the root's line alone. A file
  from then is written again at start, every batch with its members, oldest first; the old notes
  stay on chain, and an index still reads a root from them.
- **Cost:** the network fee, 5,000 lamports a note; the compute limit costs nothing while no price
  is set. A batch of 50 is five notes: at one batch an hour, about 0.22 SOL a year. The key needs
  that SOL; nothing else of the service does.
- **The key signs two kinds of thing:** the roots file (its bytes begin `0xff`) and these Solana
  messages (which never begin `0xff`), as `forest/records/SPEC.md`, section 1, separates them.
- **Logs:** counts per run (notes written, roots complete), and a failure's kind (`RpcUnavailable`,
  `MemoFailed`, `MemoExpired`), never a root, a member, a signature or the RPC's words, since the
  RPC's address can carry a key.

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

Node 22.18 or later runs the TypeScript directly. Forest's registry client and records library are
imported from `forest/registry/client/src` and `forest/records/src` by relative path (forest at the
commit in `../FOREST`), so those packages need their dependencies too. From the repo root:

```
./forest.sh registry/client records
cd issuer && npm ci
npm run check                # type-check, forest's files included
npm test                     # a stand-in Didit, a real SQLite file, real HTTP; no chain anywhere
npm start                    # the service, with the variables below
```

To run it by hand, write a key file (`solana-keygen new -o issuer-keypair.json`, outside the
repo), point `ISSUER_KEYPAIR_PATH` at it, and set the other required variables.

## Environment variables

| Variable | Required | Default | What |
|---|---|---|---|
| `DIDIT_API_KEY` | yes | | The foundation's Didit API key. A secret. |
| `DIDIT_WORKFLOW_ID` | yes | | The workflow sessions are opened on; decisions on any other are refused |
| `ISSUER_KEYPAIR` | one of these two | | The issuer's key itself: the contents of a key file, 64 numbers as `solana-keygen` writes them. For Railway, as a sealed variable. At start the service writes it to a new directory under the system's temporary directory, readable by its own user only, loads it, deletes the file, and takes the variable out of its environment. |
| `ISSUER_KEYPAIR_PATH` | one of these two | | Or a path to the key file, for local runs. Never commit it (`.gitignore` covers `*keypair*.json`). Either way the key signs the roots file and its notes on chain, and nothing else; it needs SOL only for the notes. Its did:key is the issuer's name, so a new key is a new name readers must be told. |
| `DATABASE_PATH` | no | `./data/issuer.sqlite` | The one file: the queue, the used sessions, the list and its roots |
| `BATCH_MAX` | no | `50` | A batch runs as soon as this many are waiting |
| `BATCH_INTERVAL_SECONDS` | no | `3600` | And on this timer, whatever is waiting |
| `SESSION_LIMIT_PER_HOUR` | no | `5` | Sessions one address may open in an hour |
| `SOLANA_RPC_URL` | no | none | A Solana RPC: each batch, its root and its members, is also written on chain there, paid by the issuer's key. Unset, nothing goes on chain. A URL with a provider's key in it is a secret. |
| `CLIENT_ADDRESS_HEADER` | no | none | The header a proxy in front puts the client's address in: `x-real-ip` on Railway. Unset, the connection's own address. |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in |
| `PORT` | no | `8080` | |

The service refuses to start if a required variable is missing, if both key variables are set, if
the key is not a keypair (the message quotes none of it), or if the file's list does not match its
newest root.

At start it builds the list's Merkle tree from the file once: about 0.4 seconds per 1,000
members here, about 27 seconds per 100,000. After that each batch hashes only what it adds.

## What running it on Railway will need

`deploy/` does this on devnet (`deploy/README.md`). Written before it was tried, what the service
needs from any host, as it reads on Railway's documents in September 2026:

- **One replica, never more.** The queue and the list are one SQLite file, and one process runs
  the batches.
- **A volume** for `DATABASE_PATH`, or every deploy empties the queue, forgets the used sessions and
  loses the list. The list is public, so anyone holding its last published file holds a copy, but
  only the file on the volume goes on growing. A volume backup is a copy of the file as it was:
  waiting commitments included, and the deleted bytes of files that are gone, which the service
  can't rewrite.
- **The repo root as the build's root,** since the service imports `forest/registry/client` and
  `forest/records`.
  - Build: `./forest.sh registry/client records`, then `npm ci` in `issuer`. Start: `npm start` in
    `issuer`.
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
- **Railway's HTTP logs.** Railway keeps every request's client address and path for 3 to 90 days,
  depending on plan, and its documents describe no way to turn that off. The service puts nothing
  in a path, but the addresses are Railway's log, not the service's. This conflicts with "no address
  logs" and is open (`forest/docs/changes.md`).
- **A public domain** for the app to call, and the fixed address of the two files. `PORT` is set by
  Railway.

## Chosen, not decided

Where the handoff and the task were silent, the simplest option was taken. Each is reversible
until something ships, and each is in `forest/docs/changes.md` or, from 9 on where it says so,
this repo's `docs/changes.md`.

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
8. **The queue and the used sessions: two `WITHOUT ROWID` tables, no timestamps; `secure_delete`
   on, and `VACUUM` after every batch.**
   `VACUUM` rewrites the file from its live rows, which also drops the order rows arrived in. The
   rollback journal is deleted after each commit.
9. **One root per batch** (this repo). A batch appends everything it adds, then the list has one
   new root, so there are as few roots as batches.
10. **A batch takes everything waiting,** skips any commitment already on the list, and adds the
    rest together with their root and their removal from the queue, in one transaction: all or
    nothing (this repo).
11. **The list and its roots live in the same file as the queue** (this repo), so one transaction
    moves a batch. The members and the Merkle tree are held in memory, built from the file at start
    and grown by each batch. `/status` and the files read only memory.
12. **`node:sqlite`, `node:http` and `node:crypto`,** built into Node, so the service has one
    dependency: `@semaphore-protocol/group`, pinned to the registry client's version (this repo).
    Its tree is what `listRoot` builds; the tests check every root against `listRoot`.
13. **CORS is open to any origin.** The app may be served from anywhere.
14. **At start, the file's list must match its newest root** (this repo).
15. **Five sessions per address per hour by default,** in a window that starts at the address's
    first request.
16. **An IPv6 address counts by its /64.**
17. **The limit holds keyed hashes, not addresses,** under a key made at start and never written.
18. **The client's address comes from a proxy's header only when `CLIENT_ADDRESS_HEADER` names
    one,** so a client can't choose its own address where no proxy stands in front.
19. **The key file from `ISSUER_KEYPAIR` is deleted as soon as the key is loaded,** since nothing
    reads it again, and the variable is taken out of the process's environment.
20. **The two files are served by the issuer itself,** at `/list.json` and `/roots.json`, with no
    other host in between (this repo).
21. **The key stays a `solana-keygen` file,** now a signing key only, named by its did:key as
    Forest names Ed25519 keys (this repo).
22. **The roots file is signed as a records entry is,** under its own label,
    `forest.foundation/issuer/roots/v1` (this repo).
23. **A root's time is milliseconds since 1970,** as a records entry's is (this repo).
24. **The list file is not signed.** The signed roots file covers it (this repo).
25. **Each root on chain as a memo** (this repo): the memo program v2, the issuer's key paying and
    signing, the memo the root's line of the roots file under the label
    `forest.foundation/issuer/root/v1`. The roots file's format is unchanged. From 28 on, each
    batch's notes carry its members too, under `…/root/v2`.
26. **The transaction is built by hand** (this repo): one instruction in a legacy message, so the
    service keeps one dependency.
27. **A root is written after its batch is in the file,** not in the same step (this repo): the
    chain cannot join the file's transaction, so the file comes first and the chain follows, with
    retries, and the file records each root's transaction.
28. **The members in decimal text** (this repo), as `list.json` writes them, so a reader needs no
    second format.
29. **One note shape for every part of a batch** (this repo): each note repeats the root's line, so
    every note reads alone and the index takes a root from any of them, for about 160 bytes a note.
30. **A new label, `…/root/v2`** (this repo); the index reads v1 and v2.
31. **The compute limit raised, at no price** (this repo), rather than notes of four members within
    the default limit: a third as many notes for every reader to fetch.
32. **A file from v1 writes every batch again** (this repo), so a list begun then is whole on chain.
33. **Progress inside a batch is kept in memory** (this repo); the file records a batch once all its
    notes are on chain.
