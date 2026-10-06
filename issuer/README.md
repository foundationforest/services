# issuer

The issuer checks once that a person is one real human, by face, and puts their stamp on a list
anyone can read; for a person already on it, a second check, by face and a government ID, puts a
stamp on a second list.

The foundation runs this one, on devnet, with a stand-in that passes everyone, on both checks.
Anyone can run another, with this code or their own: an issuer is anyone who keeps a list of
stamps, and each reader decides which issuers it trusts. Nothing is on mainnet, and nothing is
shipped.

Up: [the repo](../README.md).

A registry row proves a profile's holder is on one of these lists without saying who they are
(forest's [registry](https://github.com/foundationforest/forest/blob/main/registry/README.md)). The
issuer keeps each list off chain and publishes it with every snapshot of it signed by that list's
key. When the ID check has a price, it also looks on chain for each payment. It does nothing else.

## How it works

Two checks, each with its own list and its own key, so a reader can weigh them apart:

| | The face list | The ID list |
|---|---|---|
| The check, by Didit | Liveness, with a search for a face seen before | A government document, liveness with the same search, and a match between the selfie and the document's photo |
| Who takes it | Anyone | A person already checked by face: face first |
| Its workflow | `DIDIT_WORKFLOW_ID` | `DIDIT_ID_WORKFLOW_ID` |
| Signed by | The issuer's key | The key mixed from the issuer's seed under `id` (forest's `mainKey`) |
| Its routes | `/session`, `/submit`, `/status`, `/list.json` | `/id/session`, `/id/submit`, `/id/status`, `/id/list.json` |
| Refused as a face seen before | Any face Didit has seen, in either check | A face seen in an earlier ID check |
| Its price | Free | `ID_TIER_PRICE`; 0 on devnet |

### The face list

1. **The app opens a face check.** `POST /session` opens a Didit session on the face workflow and
   returns the page the person does the check on (liveness, and a search for a duplicate face).
   Didit holds the face.
2. **The app sends the session and the person's stamp.** The stamp is made on the device, from the
   person's seed and this list's address (forest's `listSecret(seed, issuer)`). Nothing else is
   accepted.
3. **The issuer asks Didit for the session's decision** and accepts it only if: the session is on
   the face workflow; Didit reports no duplicate face (`DUPLICATED_FACE` or
   `POSSIBLE_DUPLICATED_FACE`); every liveness step passed; the session is approved. A session
   counts once.
4. **Accepted stamps wait,** then go onto the list in a batch: everything waiting, every hour or as
   soon as 50 wait, shuffled, so a place on the list cannot be matched to a check by when it
   arrived. Each batch gives the list one new snapshot.
5. **It publishes the list** with every snapshot it has had, each signed with the list's key
   ([The list file](#the-list-file)).
6. **The app polls `POST /status`** until its stamp is `listed`, reads `/list.json`, and registers
   with forest's registry client (`buildRegistration`), proving against the newest snapshot and
   putting its signature in the row.

### The ID list

The ID tier is an addition for a person already on the face list. It takes the same six steps under
`/id/`, on the ID list's own tables, batches and key, with these differences:

1. **`POST /id/session`** opens a Didit session on the ID workflow: a government document (Didit
   declines a document it has seen before), then liveness with face search, then a face match
   between the selfie and the document's photo. With a price, a payment comes first
   ([Payment](#payment)).
2. **The stamp** is made from the seed and the ID list's address, so it is unrelated to the same
   person's stamp on the face list.
3. **The issuer accepts the session only if:** it is on the ID workflow; Didit's face search found
   this face in an earlier face check, and in no earlier ID check; every liveness step, every
   document step and every face match passed; the session is approved.

**Which check saw a face.** Didit's face search covers every workflow in its application, and for
each earlier session with the same face it returns that session's `vendor_data`. The issuer sets
each session's `vendor_data` to its list's tag and a fresh random id, `face-<uuid>` or `id-<uuid>`.
An ID session is refused `face_stamp_first` when no match is a `face-` session: the person takes
the face check first. It is refused `duplicate_face` when any match is an `id-` session: one face
gets one ID stamp, whatever documents it brings.

### Payment

When `ID_TIER_PRICE` is above 0:

1. **The app asks:** `POST /id/session` with `{}` answers `402` with a payment to make:
   `{"error":"payment_required","payment":{"id","reference","to","mint","amount"}}`.
2. **The app pays:** `amount` of the dollar `mint` to `to`, with `reference` listed as one more
   account on the transfer, as Solana Pay does. It pays from an address that is not a profile's
   ([Policy](#policy)).
3. **The app comes back** with `POST /id/session` `{"payment": "<id>"}`. Until a finalized
   transaction naming `reference` has paid `to` at least `amount` in `mint`, the answer is
   `402 not_paid`, and the app asks again. Then the issuer opens the session: `201`. One payment
   opens one session; asked again, `409 payment_used`. If Didit cannot open the session, the
   payment stays unused.

The reference is the address of a key mixed from the issuer's seed under `reference/<id>`. Only
whoever holds the id can claim a payment that names it, and the id never goes on chain. To find a
payment, the issuer asks its RPC for the finalized transactions that name the reference
(`getSignaturesForAddress`), and reads each (`getTransaction`): what `to`'s token accounts in the
dollar gained in it must be at least the price. It reads nothing about who paid.

### The API

| Route | Body | Answer |
|---|---|---|
| `POST /session` | `{}` or none | `201 {"sessionId": "…", "url": "…"}` |
| `POST /submit` | `{"sessionId": "<uuid>", "stamp": "<decimal>"}` | `202 {"status": "queued"}` |
| `POST /status` | `{"stamp": "<decimal>"}` | `200 {"status": "queued" \| "listed" \| "unknown"}` |
| `GET /list.json` | | `200`, the face list's file |
| `POST /id/session` | `{}` or none; with a price, `{"payment": "<id>"}` once paid | `201 {"sessionId": "…", "url": "…"}`, or `402` with a payment to make |
| `POST /id/submit`, `POST /id/status`, `GET /id/list.json` | as above | as above, for the ID list |

A stamp is a decimal number, as Semaphore prints it: above zero, below BN254's field order, no
leading zero. A payment's id is 32 lowercase hex characters. A body with any other field is refused.
CORS is open to any origin.

Errors are `{"error": "<code>"}`:

| Status | Codes |
|---|---|
| `400` | `bad_session_id`, `bad_stamp`, `bad_payment`, `not_json`, `not_an_object`, `expected_empty_body`, `expected_exactly_sessionId_and_stamp`, `expected_exactly_stamp`, `expected_exactly_payment` |
| `402` | `payment_required` (with the `payment` to make), `not_paid` |
| `403` (the check does not count) | `unknown_session`, `wrong_workflow`, `duplicate_face`, `face_stamp_first`, `no_liveness`, `liveness_not_passed`, `no_document`, `document_not_passed`, `no_face_match`, `face_match_not_passed`, `not_approved` |
| `409` | `session_used`, `stamp_queued`, `already_listed`, `payment_used` |
| `429` | `try_later`: this address opened its share of sessions this hour |
| other | `404 not_found`, `405 post_only`, `405 get_only`, `413 too_large` (bodies over 1 KB), `502 face_check_unavailable`, `502 payment_check_unavailable`, `500 internal` |

A refused or failed submit uses nothing up: the same session can be sent again, for instance once a
review in Didit approves it.

### The list file

`GET /list.json` and `GET /id/list.json`, each RFC 8785 canonical JSON, `cache-control: no-cache`:

```
{"issuer":"<address>","snapshots":[{"root":"<64 hex>","signature":"<128 hex>","size":3,"time":1790000000000},…],"stamps":["<decimal>",…],"v":1}
```

- `issuer`: the list's key's address, base58. This is the name a registry row records and a reader
  trusts: the issuer's own key for the face list, the key mixed from its seed under `id` for the ID
  list.
- `stamps`: every stamp on the list, in list order: the order batches added them, shuffled within
  each batch. The list only grows.
- `snapshots`: one per batch, oldest first, never removed. `root` is the Semaphore Merkle root of
  the first `size` stamps, as forest's `listRoot` builds it, as 32 big-endian bytes in hex; `time`
  is when the batch ran, in milliseconds since 1970; `signature` is the list's key's ed25519
  signature over those 32 bytes, in hex.

**How an app uses it:** take the newest snapshot, the first `size` stamps, and its signature, and
pass them to `buildRegistration`, which checks the signature before it proves anything.
**How a reader checks a row:** forest's `issuerSigned(row)`; it needs only the row, not this file.

### Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `DIDIT_API_KEY` | yes | | The issuer's Didit API key, from the application that owns both workflows. A secret |
| `DIDIT_WORKFLOW_ID` | yes | | The face check's workflow; any other is refused on the face list |
| `DIDIT_ID_WORKFLOW_ID` | yes | | The ID check's workflow (document, liveness, face match); any other is refused on the ID list |
| `ISSUER_KEYPAIR` | one of these two | | The issuer's key: a JSON list of 64 numbers, as `solana-keygen` writes it. At start it is written to a private file in a new temporary directory, loaded, the file deleted, and the variable taken out of the environment. The ID list's key is mixed from it |
| `ISSUER_KEYPAIR_PATH` | one of these two | | Or a path to that file, for local runs. `.gitignore` covers `*keypair*.json` |
| `ID_TIER_PRICE` | no | `0` | The ID check's price, a whole number in the dollar's smallest unit: `2500000` is 2.50 of a six-decimal dollar. 0 is free |
| `ID_TIER_MINT` | when priced | | The dollar it is paid in, by its mint's address |
| `ID_TIER_PAY_TO` | when priced | | The address that receives it. It refuses to start if this is one of its two signing keys |
| `RPC_URL` | when priced | | The Solana RPC it looks for payments through, at `finalized` |
| `DATABASE_PATH` | no | `./data/issuer.sqlite` | The one file: for each list, its queue, used sessions, list and snapshots; the ID list's used payments |
| `BATCH_MAX` | no | `50` | A list's batch runs as soon as this many wait |
| `BATCH_INTERVAL_SECONDS` | no | `3600` | And on this timer |
| `SESSION_LIMIT_PER_HOUR` | no | `5` | Sessions one address may open in an hour, both checks together |
| `CLIENT_ADDRESS_HEADER` | no | none | The header a proxy puts the client's address in (`x-real-ip` on Railway) |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in |
| `PORT` | no | `8080` | |

It refuses to start if a required variable is missing, if both key variables are set, if the key is
not a keypair (the message quotes none of it), if a list in the file does not match its newest
snapshot, or if `ID_TIER_PAY_TO` is one of its signing keys. The key's address is the issuer's name:
a new key is a new issuer that readers must be told about, and, since the ID list's key is mixed
from it, a new ID list too.

### Run it

Node 22.18 or later. From the repo root:

```
./forest.sh registry/client records keys
cd issuer && npm ci
npm run check        # type-check, forest's files included
npm test             # a stand-in Didit and RPC, a real SQLite file, real HTTP
npm start            # the service, with the variables above
```

To run it by hand, make a key outside the repo (`solana-keygen new -o …/issuer-keypair.json`) and
point `ISSUER_KEYPAIR_PATH` at it.

### On devnet

Any platform that runs Node 22.18 with a persistent disk. **One replica, never more:** the queues
and the lists are one SQLite file. **A volume** for `DATABASE_PATH`, or each deploy loses the lists.
The build context is the repo root. `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`forest.sh registry/client records keys`, `npm ci`) and runs `deploy/start.sh`: with no
`DIDIT_API_KEY`, that first starts `deploy/fake-didit.ts`, a stand-in Didit on 127.0.0.1 that
approves every session it opens, on both workflows, points the issuer at it, and says so. It sees no
faces, so for face first it takes the newest face session it opened as the face each later ID
session's search finds: an ID session opened before any face session, or since a restart, finds
none and is refused.

The foundation's devnet issuer runs that image on Railway, project `forest-devnet`, service
`issuer`, at https://issuer-production-4976.up.railway.app:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=issuer/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080. No health check: Railway
  refuses a path with a dot, and the other routes are POST.
- **Its keys:** the devnet `issuer` key, `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7`, signs the
  face list; mixed from it under `id`, `BVT1PcgV7PAUVipZzm2xP9g6qQS97vdhofvZbkJy1JX4` signs the ID
  list. They are the two issuers the devnet index trusts (`index/lists/issuers.json`).
- **No Didit key,** so the stand-in passes everyone, on both checks.
- **The ID check is free:** `ID_TIER_PRICE` is unset, so 0.

| Variable | On devnet | Sealed |
|---|---|---|
| `ISSUER_KEYPAIR` | the devnet `issuer` key | yes |
| `DATABASE_PATH` | `/data/issuer.sqlite` | no |
| `BATCH_MAX` | `50` | no |
| `BATCH_INTERVAL_SECONDS` | `120` | no |
| `SESSION_LIMIT_PER_HOUR` | `20`, so a few e2e runs an hour fit | no |
| `CLIENT_ADDRESS_HEADER` | `x-real-ip` | no |
| `PORT` | `8080` | no |

Setting `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID` and `DIDIT_ID_WORKFLOW_ID` (sealed) and redeploying
puts the real checks in the stand-in's place. The face list holds the stamps of every e2e run since
it started, and of the runs before its list moved off chain, kept under its new names.

## Policy

- **The face check is free to the person.** The foundation pays its provider, Didit, per check:
  about $0.15 a check from 1 November 2026. On devnet the stand-in costs nothing.
- **The ID check costs `ID_TIER_PRICE`,** in the dollar `ID_TIER_MINT`, paid before the session
  opens. Didit lists the ID workflow at up to $0.30 a check (October 2026). On devnet the price is 0,
  and it stays 0 until an entity can receive the money.
- **Where it is paid:** `ID_TIER_PAY_TO`, an address of its own, never one of the issuer's signing
  keys. On devnet, once a price is set, it is `3Ht8GtvWYJi1bUFvWL53gPuV77VZmmpnSDzWPCf6xEiH`, the key
  mixed from the issuer's seed under `payments`, in the classic test dollar. On mainnet it is the
  address of the entity that receives the money, once one exists.
- **Never from a profile's address.** A payment is public on chain for good. Paid from a profile's
  address, it would tell everyone that this profile took the ID check, and tell the issuer, which
  sees when each payment lands and opens a session for it, which Didit session, and so which face
  and which document, goes with that profile. The lists exist so that a row says a profile's holder
  is on one and nothing more. The app pays from an address that holds no profile; the issuer cannot
  tell, and does not check.
- **The price pays for the check, whatever Didit decides.** Nothing is refunded. A refused submit
  uses nothing up, so the same session can still be sent again once a review in Didit approves it.
- **Session limits per address:** `SESSION_LIMIT_PER_HOUR` sessions an hour from one network
  address, both checks together, paid or not (5 by default, 20 on devnet), counted in memory as
  keyed hashes, an IPv6 address by its /64. `/submit`, `/status` and a payment's polling have no
  limit.
- **Shuffled publishing:** each list's stamps go onto it in batches, every `BATCH_INTERVAL_SECONDS`
  (an hour by default, 120 seconds on devnet) or as soon as `BATCH_MAX` wait (50), shuffled within
  each batch.
- **What Didit holds.** For the face check: the selfie, the liveness video, a template of the face
  for its face search, and its decision. For the ID check, also: the document's images, what Didit
  reads on it (name, date of birth, document number, nationality, dates), and the match between the
  selfie and the document's photo.
- **What the issuer reads.** From each decision: the workflow, whether each step passed (liveness;
  for the ID check also the document and the face match), the risk codes, and the tag of each earlier
  session with the same face. From a payment: what `ID_TIER_PAY_TO` gained, in which dollar. It
  keeps none of it.
- **The consent screen.** Before the ID check the app shows this, word for word; the last sentence
  only when there is a price:

  > Forest checks your face and a government ID with Didit, its provider, to make sure each person
  > is checked once. Didit keeps photos of your ID and what it reads on it (your name, date of birth
  > and document number), your selfie, a short video and a template of your face, so it can tell if
  > the same face or ID comes back. Forest keeps none of this: only that your check passed, and a
  > stamp that does not say who you are. The check costs {price}, paid before it starts, whatever
  > it decides.

- **Retention.** The issuer keeps, for as long as its lists live: the SHA-256 of each session id
  used, the stamps and snapshots, and the transaction signature of each payment used. Didit keeps
  what it holds for as long as its retention setting says; that setting is in Didit, not in this
  code. The issuer never asks Didit to delete a session: the duplicate search needs the face and the
  document. On devnet the stand-in keeps the ids of the sessions it opened and the newest face
  session's `vendor_data`, in memory, and nothing else.
- **Data law:** Forest is the responsible party for both checks, so three things sit outside this
  code: a processing agreement with Didit, the consent screen above, and Didit's retention setting.
  Paperwork and settings; nothing here does them.

## Promises

- **It never keeps a session next to a stamp.** Its one SQLite file has four tables for each list,
  and a fifth for the ID list. The private ones share nothing and have no timestamps or row numbers:
  for each list, the SHA-256 of every session id used, and the stamps still waiting; for the ID
  list, the transaction signature of each payment that opened a session. The public ones are the
  lists and their snapshots. A stamp leaves the queue in the same transaction that lists it. Deleted
  bytes are overwritten (`secure_delete`), and after every batch the file is rewritten from what it
  holds (`VACUUM`). A test reads the raw file and checks this.
- **It never logs a request, an address, a session or a stamp.** It logs counts per batch, and an
  error's kind, never its message.
- **It never writes down an address.** It reads the client's address only to count sessions
  against the limit, in memory, as a keyed hash under a key made at start.
- **It never puts what a person sends in a URL.** The routes an app calls are POST with a JSON
  body, since hosting platforms log paths.
- **It never signs for anyone.** Its two keys sign the snapshots of their lists, nothing else.
- **It never deletes a Didit session.** That would drop the face from Didit's duplicate search.
- **It never puts a list on chain.** An issuer's lists live off chain; a row carries only a root
  and the list's key's signature on it.

## Limits

- **On devnet, anyone passes.** The stand-in approves every session, on both checks, so anyone who
  asks can put a stamp on the devnet face list, and then on its ID list.
- **Payment is off until an entity exists.** The price is 0 on devnet, and nothing receives money
  until an entity can. The payment path runs in this code's tests only, against a stand-in RPC.
- **Face first is checked by face, not by stamp.** The issuer keeps no link from a session to a
  stamp, so it takes any earlier face check Didit's search finds, whether or not that check's stamp
  reached the face list.
- **It trusts Didit's decision,** for a session on the check's own workflow: status, each step's
  status, risk codes, and the `vendor_data` of each face-search match. It reads those and drops
  everything else Didit returns. It cannot see the workflows' setup: a liveness step with face search
  on (Didit's default); on the ID workflow, a duplicate face set to no action (else Didit declines a
  person moving up from the face list) and a document seen before declined; both workflows in one
  Didit application, so that face search covers both; and an API key from that application.
- **It trusts its RPC** to say which finalized transactions name a reference and what each moved.
  It reads the 20 newest that name it. Each `POST /id/session` with a payment asks the RPC, and has
  no limit of its own.
- **A payment through the foundation's fee payer is untested:** a transfer that lists one more
  account is not among what its tests sent through Kora.
- **It trusts its own file:** at start, each list in the file must match its newest snapshot, or it
  refuses to start.
- **A proxy's address header counts only when `CLIENT_ADDRESS_HEADER` names it;** otherwise the
  connection's own address, since a client can write any header.
- **The request limit is not a security boundary.** One address may open `SESSION_LIMIT_PER_HOUR`
  sessions in an hour, counted from its first; an IPv6 address counts with the rest of its /64. It
  stops one person running up the Didit bill from one place, and nothing more: someone with many
  addresses opens many sessions, and people behind one shared address share one count. The counts
  live in memory and reset on restart. `/submit` has no limit.
- **Start-up grows with the lists.** It builds each Merkle tree from the file before it listens:
  about 0.4 seconds per 1,000 stamps. After that each batch hashes only what it adds.
- **Each list file grows** by about 80 bytes a stamp, and holds every snapshot.
- **A new key is a new issuer,** and a new ID list. Readers trust the address; there is no signed
  handover.
- **If the issuer's file is lost, so are its lists.** They are published, but nothing here rebuilds
  the file from a copy.
- **Address logs.** The issuer keeps no network address (above). A hosting provider's own request
  logs are the operator's choice; on Railway they exist, with each request's client address and
  path.

## Who decides what

- **The standard (forest):** the list secret and the stamp, the recipe a key is mixed by, and the
  root and signature a row carries.
- **This issuer, by its policy:** who goes on each list (one face check per person, by Didit; one ID
  check per face, after a face check, by Didit), the ID check's price and where it is paid, when it publishes, and its
  limits.
- **Readers, by their own policy:** whether an index or a host trusts each list, and how much.
- **The person, through their app:** whether to be checked, by which check and which issuers, and
  which address to pay from.

## FAQ

**Why one file, list and signatures together?**
An app needs the stamps and the signature on their root from the same moment. Two files read one
after the other could straddle a batch; one file cannot.

**Why sign each snapshot's root, and not the whole file?**
A row carries one root and the issuer's signature on it, checked by anyone forever with
`issuerSigned`. Signing the root itself, as 32 big-endian bytes, is what the registry asks an issuer
to sign, so the signature in the file is the one that goes into the row.

**Why a second key for the ID list?**
A row names one issuer by its key, and nothing else about how its holder was checked. With one key
for both lists, a reader could not weigh an ID-checked row above a face-checked one. Mixed from the
issuer's seed by forest's own recipe, the second key needs no secret of its own.

**Why does the ID check need a face check first, and refuse a face seen in an earlier ID check?**
The ID tier is an addition for a person already on the face list: one person, one stamp on each
list, the ID stamp on top of the face stamp. A face seen in an earlier ID check is a second ID stamp
for the same person, whatever document it brings. The tag in `vendor_data` is how
the issuer tells the two apart: Didit's face search spans both checks and names only the earlier
sessions it matched.

**Why does `POSSIBLE_DUPLICATED_FACE` refuse like `DUPLICATED_FACE`, and why a fresh `vendor_data`
on every Didit session?**
"Not a duplicate" is not what Didit said. The random id names nobody, and the tag says only which
check the session was for.

**Why does the price go to one address, with a reference per session, and not to an address per
session?**
So the issuer never holds money, nor a key that moves it: money paid goes straight to the address
that receives it, and an address set in config can become the entity's without a change here. The
reference lets the issuer find each payment and count it once.

**Could someone rebuild this issuer from public data?**
Its lists and every signed snapshot are public, so anyone can check them and keep a copy. A new
issuer starts its own lists; its people come to it through their own checks.
