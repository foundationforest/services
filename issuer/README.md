# issuer

The issuer checks once that a person is one real human, by face, and signs them a note; for a
person who shows that note, a second check, by face and a government document, signs the same note
at a higher tier.

The foundation runs this one, on devnet, with a stand-in that passes everyone, on both checks.
Anyone can run another, with this code or their own: an issuer is anyone who signs notes for
people, and each reader decides which issuers it trusts. Nothing is on mainnet, and nothing is
shipped.

Up: [the repo](../README.md).

A note is forest's (forest's [registry](https://github.com/foundationforest/forest/blob/main/registry/README.md),
"The note and the person proof"): the person's note number, their face's embedding, the model that
made it, and a tier, signed by the issuer's key. The person keeps it, and with it proves on their
device, for a registry row, that this issuer signed them a note, without showing the note or who
they are. The issuer signs notes, looks on chain for payments when the document check has a price,
and does nothing else.

## How it works

Two stages, each a check by Didit, each signing a note for the same note number:

| | Stage 1: the face check | Stage 2: the document check |
|---|---|---|
| The check, by Didit | Liveness, with a search for a face seen before | A government document, liveness with the same search, and a match between the selfie and the document's photo |
| Who takes it | Anyone | A person who shows a note from stage 1 |
| Its workflow | `DIDIT_WORKFLOW_ID` | `DIDIT_ID_WORKFLOW_ID` |
| What the app sends | the session and its note number | the session and its note |
| Refused as seen before | A face Didit's search found in an earlier session that was signed for another note number | A name, birth date and country signed for another note number |
| The note | tier 1, with the face's embedding | the shown note at tier 2 |
| Its routes | `/session`, `/note` | `/id/session`, `/id/note` |
| Its price | Free | `ID_TIER_PRICE`; 0 on devnet |

**The issuer's name and key** are public at `GET /issuer.json`. The name is what a person's secret for
this issuer is mixed from (forest's `issuerSecret(seed, name)`), so it never changes. The key is the
Baby Jubjub key that signs every note, mixed from the issuer's seed (`ISSUER_KEYPAIR`) with forest's
`hkdf` under `issuer/notes`; a registry row names it, and readers trust it.

### Stage 1: the face check

1. **The app opens a face check.** `POST /session` opens a Didit session on the face workflow and
   returns the page the person does the check on. Didit holds the face.
2. **The app sends the session and its note number,** which its device mixes from the person's seed
   and this issuer's name (forest's `issuerSecret(seed, name).noteNumber`). The issuer never learns
   the secret behind it.
3. **The issuer asks Didit for the session's decision** and accepts it only if the session is on the
   face workflow, every liveness step passed, and the session is approved.
4. **A face seen before.** Didit's face search names each earlier session with the same face. If the
   issuer signed any of them for another note number, it refuses (`duplicate_face`); for the same
   note number, it signs again. So one face gets one note number, and a person who lost their note
   gets it again.
5. **The embedding.** The issuer fetches the session's selfie from Didit, computes its embedding
   with an open model ([The face model](#the-face-model)), and keeps neither.
6. **The note.** It keeps the session, and every earlier session of the same face, next to the note
   number, all in one transaction, then signs a tier 1 note and answers it.

### Stage 2: the document check

1. **`POST /id/session`** opens a Didit session on the document workflow. With a price, a payment
   comes first ([Payment](#payment)).
2. **The app sends the session and the person's note,** as it got it.
3. **The issuer checks the note:** signed by its own key, and made by its own model.
4. **It asks Didit for the decision:** the document workflow, and every liveness step, every document
   step and every face match passed, and the session approved. Each document once is Didit's own
   setting.
5. **The live face** from the session's selfie must match the note's embedding (`not_the_same_face`).
6. **The document's person:** a fingerprint of the name, the birth date and the document's country
   ([The fingerprint](#the-fingerprint)). Signed before for another note number, it is refused
   (`duplicate_document`); for the same one, signed again, so a lost tier 2 note comes back.
7. **The note.** It keeps the session and the fingerprint next to the note number, then signs the
   shown note at tier 2: the same note number, embedding and model.

### The fingerprint

HMAC-SHA256, under a key mixed from the issuer's seed with forest's `hkdf` under `issuer/fingerprint`,
of three things Didit reads on the document, each written one way: the name (first and last, else
the full name; Unicode NFKC, lower case, one space between words), the birth date (YYYY-MM-DD) and
the document's country (`issuing_state`, ISO 3166-1 alpha-3). Without the key, a guessed name cannot
be tested against the file.

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
| `GET /issuer.json` | | `200 {"key":"<128 hex>","name":"<name>","v":1}`, canonical JSON |
| `POST /session` | `{}` or none | `201 {"sessionId": "…", "url": "…"}` |
| `POST /note` | `{"sessionId": "<uuid>", "noteNumber": "<decimal>"}` | `200 {"note": <note>}`, tier 1 |
| `POST /id/session` | `{}` or none; with a price, `{"payment": "<id>"}` once paid | `201 {"sessionId": "…", "url": "…"}`, or `402` with a payment to make |
| `POST /id/note` | `{"sessionId": "<uuid>", "note": <note>}` | `200 {"note": <note>}`, tier 2 |

A note, as JSON: every number is decimal text, the embedding base64url, and the issuer's key 128 hex
characters, x then y, as a registry row holds it:

```
{"embedding":"<base64url>","issuer":"<128 hex>","model":"opencv-sface-2021dec","noteNumber":"<decimal>",
 "signature":{"R8":["<decimal>","<decimal>"],"S":"<decimal>"},"tier":"1"}
```

A note number is decimal text, as forest's `issuerSecret` gives it: no sign, no leading zero, below
BN254's field order. A payment's id is 32 lowercase hex characters. A body with any other field is
refused. CORS is open to any origin.

Errors are `{"error": "<code>"}`:

| Status | Codes |
|---|---|
| `400` | `bad_session_id`, `bad_note_number`, `bad_note`, `bad_payment`, `not_json`, `not_an_object`, `expected_empty_body`, `expected_exactly_sessionId_and_noteNumber`, `expected_exactly_sessionId_and_note`, `expected_exactly_payment` |
| `402` | `payment_required` (with the `payment` to make), `not_paid` |
| `403` (the check does not count) | `unknown_session`, `wrong_workflow`, `no_liveness`, `liveness_not_passed`, `no_document`, `document_not_passed`, `no_face_match`, `face_match_not_passed`, `not_approved`, `no_face`, `duplicate_face`, `not_our_note`, `other_model`, `not_the_same_face`, `no_document_data`, `duplicate_document` |
| `409` | `session_used` (this session's face was signed for another note number), `payment_used` |
| `429` | `try_later`: this address opened its share of sessions this hour |
| other | `404 not_found`, `405 post_only`, `405 get_only`, `413 too_large` (bodies over 4 KB), `502 face_check_unavailable`, `502 payment_check_unavailable`, `500 internal` |

A refused or failed request uses nothing up: the same session can be sent again, for instance once
a review in Didit approves it. A session that gave a note, sent again with the same note number,
gives the note again.

### The face model

`src/face.ts` turns a photo of a face into its embedding: 128 numbers, written as 512 bytes, that
two photos of one person give close together and two people far apart.

- **Two open models from OpenCV's model zoo, used unchanged:** YuNet
  (`face_detection_yunet_2023mar.onnx`, MIT) finds the face and five points on it (the eyes, the
  nose tip, the mouth's corners); SFace (`face_recognition_sface_2021dec.onnx`, Apache 2.0) gives
  the 128 numbers for the face turned and scaled so those points sit where SFace expects them, at
  112 by 112. They run on `onnxruntime-web` (MIT), in WASM; photos are read with `jpeg-js`
  (BSD-3-Clause) and `pngjs` (MIT). The steps are OpenCV's own (`FaceDetectorYN`,
  `FaceRecognizerSF`), written out in the file; on two of the test portraits its embeddings match
  OpenCV's at a cosine of 0.96 or more.
- **Its name in a note:** `opencv-sface-2021dec`.
- **The same person** is a cosine similarity of at least 0.5 (`FACE_MATCH`). OpenCV gives 0.363 for
  SFace, but across six official NASA portraits of five people, two of them scored 0.41 against each
  other, and one person eight years apart 0.80.
- **The files:** `npm run fetch` puts the models in `models/` from OpenCV's own Hugging Face pages,
  each checked against its SHA-256 (`scripts/fetch.ts`). None is in the repo.
- **About 0.3 seconds a photo** on one core, and nothing written or logged.

With `FACE_MODEL=stand-in`, allowed only with a stand-in Didit on this machine, every photo gives
one fixed embedding, forest's own devnet stand-in vector, under the model `stand-in`.

### Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `ISSUER_NAME` | yes | | The issuer's name, as `/issuer.json` gives it. Every person's secret for this issuer is mixed from it: it never changes |
| `DIDIT_API_KEY` | yes | | The issuer's Didit API key, from the application that owns both workflows. A secret |
| `DIDIT_WORKFLOW_ID` | yes | | The face check's workflow; any other is refused for stage 1 |
| `DIDIT_ID_WORKFLOW_ID` | yes | | The document check's workflow (document, liveness, face match); any other is refused for stage 2 |
| `ISSUER_KEYPAIR` | one of these two | | The issuer's seed: a JSON list of 64 numbers, as `solana-keygen` writes a key. At start it is written to a private file in a new temporary directory, loaded, the file deleted, and the variable taken out of the environment. The note key, the fingerprint key and the payment references are mixed from it |
| `ISSUER_KEYPAIR_PATH` | one of these two | | Or a path to that file, for local runs. `.gitignore` covers `*keypair*.json` |
| `FACE_MODEL` | no | `sface` | `sface`, or `stand-in` with a stand-in Didit on this machine (`DIDIT_BASE_URL` on loopback); `deploy/start.sh` sets it |
| `ID_TIER_PRICE` | no | `0` | The document check's price, a whole number in the dollar's smallest unit: `2500000` is 2.50 of a six-decimal dollar. 0 is free |
| `ID_TIER_MINT` | when priced | | The dollar it is paid in, by its mint's address |
| `ID_TIER_PAY_TO` | when priced | | The address that receives it. It refuses to start if this is the seed's own address |
| `RPC_URL` | when priced | | The Solana RPC it looks for payments through, at `finalized` |
| `DATABASE_PATH` | no | `./data/issuer.sqlite` | The one file: the sessions, the fingerprints and the payments used |
| `SESSION_LIMIT_PER_HOUR` | no | `5` | Sessions one address may open in an hour, both checks together |
| `CLIENT_ADDRESS_HEADER` | no | none | The header a proxy puts the client's address in (`x-real-ip` on Railway) |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in |
| `PORT` | no | `8080` | |

It refuses to start if a required variable is missing, if both seed variables are set, if the seed
is not a keypair (the message quotes none of it), if `FACE_MODEL=stand-in` is set with a Didit off
this machine, or if `ID_TIER_PAY_TO` is the seed's own address. A new seed is a new note key, which
readers must be told about; the name stays, so no one's stamps change.

### Run it

Node 22.18 or later. From the repo root:

```
./forest.sh registry/client records keys
cd issuer && npm ci
npm run fetch        # the face models, and the three test portraits, each checked by SHA-256
npm run check        # type-check, forest's files included
npm test             # a stand-in Didit and RPC, a real SQLite file, real HTTP, a person proof from a note;
                     # the face models on the portraits; the devnet stand-in Didit, both stages
npm start            # the service, with the variables above
```

To run it by hand, make a seed outside the repo (`solana-keygen new -o …/issuer-keypair.json`) and
point `ISSUER_KEYPAIR_PATH` at it.

### On devnet

Any platform that runs Node 22.18 with a persistent disk. **One replica, never more:** the sessions
and fingerprints are one SQLite file. **A volume** for `DATABASE_PATH`, or each deploy forgets which
face was signed for which note number. The build context is the repo root. `deploy/Dockerfile`
builds it (Node 22.22.2 and git, `forest.sh registry/client records keys`, `npm ci`, the face models
by `npm run fetch -- models`) and runs `deploy/start.sh`: with no `DIDIT_API_KEY`, that first starts
`deploy/fake-didit.ts`, a stand-in Didit on 127.0.0.1 that approves every session it opens, on both
workflows, with no face seen before and, for a document, a name it makes up for that session; points
the issuer at it with `FACE_MODEL=stand-in`; and says so.

The foundation's devnet issuer runs that image on Railway, project `forest-devnet`, service
`issuer`, at https://issuer-production-4976.up.railway.app:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=issuer/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080. No health check: Railway
  refuses a path with a dot, and the other routes are POST.
- **Its name:** `issuer.devnet.forest.foundation`.
- **Its note key:** `2185f564303f0c1cd8efdb1e35e59cc128f388f1da07511a412c186b6bb5b4bf186ac19097701f2619d447c5cd68484674e48194dd7ed4d025b20ea9d063a549`,
  mixed from the devnet `issuer` key (`7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7`), which signs
  nothing itself. It is the issuer the devnet index trusts (`index/lists/issuers.json`) and the fee
  payer takes vouchers from.
- **No Didit key,** so the stand-in passes everyone, on both checks.
- **The document check is free:** `ID_TIER_PRICE` is unset, so 0.

| Variable | On devnet | Sealed |
|---|---|---|
| `ISSUER_NAME` | `issuer.devnet.forest.foundation` | no |
| `ISSUER_KEYPAIR` | the devnet `issuer` key | yes |
| `DATABASE_PATH` | `/data/issuer.sqlite` | no |
| `SESSION_LIMIT_PER_HOUR` | `20`, so a few e2e runs an hour fit | no |
| `CLIENT_ADDRESS_HEADER` | `x-real-ip` | no |
| `PORT` | `8080` | no |

Setting `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID` and `DIDIT_ID_WORKFLOW_ID` (sealed) and redeploying
puts the real checks, and the face model, in the stand-in's place. The file the issuer kept when it
published lists held the lists, their snapshots and the sessions used; the first start on notes
drops those tables and rewrites the file.

## Policy

- **The face check is free to the person.** The foundation pays its provider, Didit, per check:
  about $0.15 a check from 1 November 2026. On devnet the stand-in costs nothing.
- **The document check costs `ID_TIER_PRICE`,** in the dollar `ID_TIER_MINT`, paid before the
  session opens. Didit lists the document workflow at up to $0.30 a check (October 2026). On devnet
  the price is 0, and it stays 0 until an entity can receive the money.
- **Where it is paid:** `ID_TIER_PAY_TO`, an address of its own, never the issuer's seed. On devnet,
  once a price is set, it is `3Ht8GtvWYJi1bUFvWL53gPuV77VZmmpnSDzWPCf6xEiH`, the key mixed from the
  issuer's seed under `payments`, in the classic test dollar. On mainnet it is the address of the
  entity that receives the money, once one exists.
- **Never from a profile's address.** A payment is public on chain for good. Paid from a profile's
  address, it would tell everyone that this profile took the document check, and tell the issuer,
  which sees when each payment lands and opens a session for it, which Didit session, and so which
  face and which document, goes with that profile. A note exists so that a row says a profile's
  holder was checked and nothing more. The app pays from an address that holds no profile; the
  issuer cannot tell, and does not check.
- **The price pays for the check, whatever Didit decides.** Nothing is refunded. A refused request
  uses nothing up, so the same session can still be sent again once a review in Didit approves it.
- **Session limits per address:** `SESSION_LIMIT_PER_HOUR` sessions an hour from one network
  address, both checks together, paid or not (5 by default, 20 on devnet), counted in memory as
  keyed hashes, an IPv6 address by its /64. `/note`, `/id/note` and a payment's polling have no
  limit.
- **Tiers:** 1 after the face check, 2 after the document check. What they mean is this issuer's
  word; a reader weighs them.
- **One face, one note number; one document's person, one note number.** Seen again with the same
  note number, the note is signed again; with another, refused.
- **The same face:** a cosine similarity of at least 0.5 between the live selfie's embedding and the
  note's.
- **What Didit holds.** For the face check: the selfie, the liveness video, a template of the face
  for its face search, and its decision. For the document check, also: the document's images, what
  Didit reads on it (name, date of birth, document number, nationality, dates), and the match
  between the selfie and the document's photo.
- **What the issuer reads.** From each decision: the workflow, whether each step passed (liveness;
  for the document check also the document and the face match), the selfie's address, the earlier
  sessions with the same face, and, for the document check, the name, the birth date and the
  document's country. From the selfie: its embedding. From a payment: what `ID_TIER_PAY_TO` gained,
  in which dollar. It keeps none of it but what Retention, below, says.
- **The consent screen.** Before the document check the app shows this, word for word; the last
  sentence only when there is a price:

  > Forest checks your face and a government ID with Didit, its provider, to make sure each person
  > is checked once. Didit keeps photos of your ID and what it reads on it (your name, date of birth
  > and document number), your selfie, a short video and a template of your face, so it can tell if
  > the same face or ID comes back. Forest keeps none of this: only a one-way fingerprint of your
  > name, date of birth and country next to your note number, so the same person is not checked
  > twice, and it gives you a note that does not say who you are. The check costs {price}, paid
  > before it starts, whatever it decides.

- **Retention.** The issuer keeps, for as long as it runs: the SHA-256 of each session id that gave
  a note, and of each earlier session of the same face, next to the note number; each document's
  fingerprint next to its note number; and the transaction signature of each payment used. Didit
  keeps what it holds for as long as its retention setting says; that setting is in Didit, not in
  this code. The issuer never asks Didit to delete a session: the duplicate search needs the face and
  the document. On devnet the stand-in keeps the ids of the sessions it opened, their workflows and
  the names it made up, in memory, and nothing else.
- **Data law:** Forest is the responsible party for both checks, so three things sit outside this
  code: a processing agreement with Didit, the consent screen above, and Didit's retention setting.
  Paperwork and settings; nothing here does them.

## Promises

- **It keeps which check session gave which note number, and nothing else of a check.** Its one
  SQLite file has three tables: the SHA-256 of each session id next to the note number its face was
  signed for; a keyed one-way fingerprint of each document's name, birth date and country next to
  the note number it was signed for; and the transaction signature of each payment used. No face, no
  embedding, no name, no document, no time, no row number. Deleted bytes are overwritten
  (`secure_delete`). A test reads the raw file and checks this.
- **It never logs a request, an address, a session, a note number or a note.** It logs an error's
  kind, never its message.
- **It never writes down an address.** It reads the client's address only to count sessions against
  the limit, in memory, as a keyed hash under a key made at start.
- **It never puts what a person sends in a URL.** The routes an app calls are POST with a JSON
  body, since hosting platforms log paths.
- **It never signs for anyone.** Its note key signs notes, nothing else.
- **It never deletes a Didit session.** That would drop the face from Didit's duplicate search.
- **It never puts a note on chain.** A note stays with the person; a row carries only the person
  proof's public values.

## Limits

- **On devnet, anyone passes.** The stand-in approves every session, on both checks, with no face
  seen before and a name made up for each document, so anyone who asks gets a note from the devnet
  issuer, at either tier.
- **Payment is off until an entity exists.** The price is 0 on devnet, and nothing receives money
  until an entity can. The payment path runs in this code's tests only, against a stand-in RPC.
- **A note carries a face's embedding.** The person keeps it, and an app should keep it as it keeps
  a key: whoever has it holds numbers made from that face. Only its hash enters the person proof,
  and the note goes back to the issuer only for the document check.
- **A face seen before is known only through Didit's search.** The issuer keeps no embedding, so a
  face Didit's search misses is a new face to it, and can be signed for a second note number.
- **It trusts Didit's decision,** for a session on the check's own workflow: status, each step's
  status, the selfie, each face-search match's session, and what the document step read. It reads
  those and drops everything else Didit returns. It cannot see the workflows' setup: a liveness step
  with face search on (Didit's default); on the document workflow, a duplicate face set to no action
  (else Didit declines a person moving up from the face check) and a document seen before declined;
  both workflows in one Didit application, so that face search covers both; and an API key from that
  application.
- **The fingerprint is as exact as Didit's reading.** A name read two ways (a middle name, another
  script) is two fingerprints, so one person with two documents may pass twice, for the note number
  their face allows.
- **It trusts its RPC** to say which finalized transactions name a reference and what each moved.
  It reads the 20 newest that name it. Each `POST /id/session` with a payment asks the RPC, and has
  no limit of its own.
- **A payment through the foundation's fee payer is untested:** a transfer that lists one more
  account is not among what its tests sent through Kora.
- **A proxy's address header counts only when `CLIENT_ADDRESS_HEADER` names it;** otherwise the
  connection's own address, since a client can write any header.
- **The request limit is not a security boundary.** One address may open `SESSION_LIMIT_PER_HOUR`
  sessions in an hour, counted from its first; an IPv6 address counts with the rest of its /64. It
  stops one person running up the Didit bill from one place, and nothing more: someone with many
  addresses opens many sessions, and people behind one shared address share one count. The counts
  live in memory and reset on restart. `/note` and `/id/note` have no limit.
- **A new seed is a new note key.** Readers trust the key; there is no signed handover. The name
  stays, so a person's stamps do not change and a row made under the old key cannot be made again.
- **If the issuer's file is lost,** so is which face and which document were signed for which note
  number: a person seen before could then be signed for a second one.
- **The face model's training data is not ours to vouch for.** SFace's weights are Apache 2.0, but
  its paper trains it on CASIA-WebFace, VGGFace2 and MS-Celeb-1M, whose own terms are for research.
  No widely used face model is trained on data with cleaner terms.
- **The face test is three portraits.** Two of one person and one of another, official NASA
  photos (public domain, `npm run fetch` takes them from NASA's image library): enough to show the
  model runs as OpenCV's does, not to measure how often it errs.
- **Address logs.** The issuer keeps no network address (above). A hosting provider's own request
  logs are the operator's choice; on Railway they exist, with each request's client address and
  path.

## Who decides what

- **The standard (forest):** the note, the issuer secret and the note number, the stamp, and the
  person proof a row carries.
- **This issuer, by its policy:** whom it signs notes for (one face check per face, by Didit; one
  document check per person, after a face check, by Didit), what its tiers mean, the face model and
  when two faces are the same, the document check's price and where it is paid, and its limits.
- **Readers, by their own policy:** whether an index, a fee payer or a host trusts this issuer's key,
  and how much each tier weighs.
- **The person, through their app:** whether to be checked, by which check and which issuers, and
  which address to pay from.

## FAQ

**Why does the issuer keep which session gave which note number?**
To sign a face once. Didit's face search names the earlier sessions with the same face; the issuer
needs to know which note number each of them was signed for, to sign the same one again and refuse
another. It keeps the session's hash and the note number, nothing about the face.

**Why sign a face seen before again, for the same note number?**
A person who lost their note, or whose app lost the answer, gets it back with a new face check. The
same note number gives the same stamps, so a second note gives no second row.

**Why keep the fingerprint next to the note number, and not alone?**
So a lost tier 2 note comes back: the same person, with the same note number, is signed again. A
fingerprint alone could only refuse.

**Why does the tier 2 note keep the tier 1 note's embedding?**
It is the same note at a higher tier: the person's face as the face check saw it. The live face of
the document check is compared with it, then dropped.

**Why does the issuer compute the embedding, and not Didit?**
Didit gives none, and the note must name the model that made it, so anyone can check what it means.
An open model, published with its weights, is one any other issuer can run too.

**Why a fresh `vendor_data` on every Didit session?**
Didit's duplicate check compares a face with faces verified under another `vendor_data`. The random
id names nobody, and the tag says only which check the session was for.

**Why does the price go to one address, with a reference per session, and not to an address per
session?**
So the issuer never holds money, nor a key that moves it: money paid goes straight to the address
that receives it, and an address set in config can become the entity's without a change here. The
reference lets the issuer find each payment and count it once.

**Could someone rebuild this issuer from public data?**
Its name and key are public, and its code is here. What it keeps, which face and which document were
signed for which note number, is not public, so a new issuer starts its own; its people come to it
through their own checks.
