# issuer

The issuer checks once, by face, that a person is one real human, and signs them a note; a person
who then shows that note and a government document gets the same note signed at tier 2.

The foundation runs this one, on devnet, with a stand-in for both checks that passes everyone.
Anyone can run another, with this code or their own: an issuer is anyone who signs notes for
people, and each reader decides which issuers it trusts.

Up: [the repo](../README.md).

## How it works

A note is forest's
([registry](https://github.com/foundationforest/forest/blob/main/registry/README.md#the-note-and-the-person-proof)):
the person's note number, their face's embedding, the model that made it, and a tier, signed by
the issuer's note key. The person keeps it, and from it proves on their device, for a registry row,
that this issuer signed them a note, without showing the note or who they are.

The checks are Didit's: Didit runs each one on its own page, and holds the face and, for the
document check, the document. The issuer signs notes, looks on chain for a payment when the
document check has a price, and does nothing else.

**Who it is.** `GET /issuer.json` gives its name and its note key. The name is what each person's
secret for this issuer is mixed from
([keys](https://github.com/foundationforest/forest/blob/main/keys/README.md#the-issuer-secret)),
so it never changes. The note key is the Baby Jubjub key that signs every note, mixed from the
issuer's seed (`ISSUER_KEYPAIR`) with forest's `hkdf` under `issuer/notes`; a registry row names
it, and readers trust it.

### The flow

Tier 1, the face check, for anyone:

1. **The app opens a face check.** `POST /session` opens a Didit session on the face workflow and
   answers the page the person does the check on.
2. **The app sends the session and its note number,** which the device mixes from the person's
   seed and this issuer's name
   ([keys](https://github.com/foundationforest/forest/blob/main/keys/README.md#the-note-number)).
   The issuer never learns the secret behind it.
3. **The issuer asks Didit for the decision,** and takes it only if the session is on the face
   workflow, every liveness step passed, and the session is approved.
4. **A face seen before.** Didit's face search names each earlier session with the same face. If
   the issuer signed any of them for another note number, it refuses (`duplicate_face`). For the
   same note number it signs again: a person who lost their note gets it back, and the same note
   number gives the same stamps, so no second row.
5. **The embedding.** It fetches the session's selfie from Didit and computes its embedding with
   an open model ([The face model](#the-face-model)). It keeps neither.
6. **The note.** In one transaction it keeps the session, and every earlier session of the same
   face, next to the note number ([What it keeps](#what-it-keeps-and-why)). Then it signs a tier 1
   note and answers it.

Tier 2, the document check, for a person who shows a tier 1 note:

7. **The app opens a document check.** `POST /id/session` opens a Didit session on the document
   workflow. When the check has a price, a payment comes first ([Payment](#payment)).
8. **The app sends the session and the person's note,** as it got it. The issuer checks that its
   own key signed the note and its own model made it.
9. **It asks Didit for the decision:** the document workflow; every liveness step, every document
   step and every face match (the selfie against the document's photo) passed; the session
   approved. Each document once is Didit's own setting.
10. **A person seen before.** It makes the document's fingerprint
    ([What it keeps](#what-it-keeps-and-why)). Signed before for another note number, it refuses
    (`duplicate_document`); for the same one, it signs again, so a lost tier 2 note comes back.
11. **The same face.** The embedding of this session's selfie must match the note's
    ([Policy](#policy)), or it refuses (`not_the_same_face`). The live embedding is then dropped.
12. **The note.** It keeps the session and the fingerprint next to the note number, then signs the
    shown note at tier 2: the same note number, embedding and model, since it is the same note at a
    higher tier.

A refused or failed request uses nothing up: the same session can be sent again, for instance once
a review in Didit approves it.

### What it keeps, and why

One SQLite file, three tables:

| Table | What | Why |
|---|---|---|
| `sessions` | The SHA-256 of each session id that gave a note, and of each earlier session of the same face, next to the note number | To sign a face for one note number: Didit names a face's earlier sessions, and the issuer must know which note number each was signed for. The earlier ones are kept too, so one of them sent late, whose own search could not see the later one, is refused for another note number |
| `fingerprints` | Each document's fingerprint next to the note number it was signed for | To sign a document's person for one note number. Next to the note number, not alone, so a lost tier 2 note can be signed again: a fingerprint alone could only refuse |
| `id_payments` | The transaction signature of each payment used | So one payment opens one session |

Nothing else: no face, no embedding, no name, no document, no time, no row number. A session id is
kept only as its hash, so the file names no Didit session, and the two tables of notes share no
key, so nothing in the file says which document went with which face. Deleted bytes are
overwritten (`secure_delete`). How long it keeps them is [Policy](#policy).

**The fingerprint** is HMAC-SHA256, under a key mixed from the issuer's seed with forest's `hkdf`
under `issuer/fingerprint`, of three things Didit reads on the document, each written one way: the
name (first and last, else the full name; Unicode NFKC, lower case, one space between words), the
birth date (YYYY-MM-DD) and the document's country (`issuing_state`, ISO 3166-1 alpha-3). Without
the key, a guessed name cannot be tested against the file.

### The face model

`src/face.ts` turns a photo of a face into its embedding: 128 numbers, written as 512 bytes, that
two photos of one person give close together and two people far apart. Didit gives no embedding,
and a note must name the model that made it, so anyone can check what it means; an open model,
published with its weights, is one any other issuer can run too.

| Piece | What it does | Licence |
|---|---|---|
| YuNet (`face_detection_yunet_2023mar.onnx`), from OpenCV's model zoo | Finds the face and five points on it: the eyes, the nose tip, the mouth's corners | MIT |
| SFace (`face_recognition_sface_2021dec.onnx`), from OpenCV's model zoo | Gives the 128 numbers for the face, turned and scaled so those points sit where SFace expects them, at 112 by 112 | Apache 2.0; its training data's terms are in [Limits](#limits) |
| `onnxruntime-web` | Runs both models, in WASM | MIT |
| `jpeg-js`, `pngjs` | Read the photo | BSD-3-Clause, MIT |

- **Used unchanged.** The steps are OpenCV's own (`FaceDetectorYN`, `FaceRecognizerSF`), written
  out in the file, so no native library is needed.
- **Its name in a note:** `opencv-sface-2021dec`.
- **The files:** `npm run fetch` puts the models in `models/` from OpenCV's own Hugging Face pages,
  each checked against its SHA-256 (`scripts/fetch.ts`). Neither is in the repo.
- **About a third of a second a photo** on one core. Nothing is written or logged.
- **The stand-in.** With `FACE_MODEL=stand-in`, allowed only with a stand-in Didit on this
  machine, every photo gives one fixed embedding, forest's own devnet stand-in vector, under the
  model `stand-in`.

### Payment

When the document check has a price (`ID_TIER_PRICE` above 0):

1. **The app asks:** `POST /id/session` with `{}` answers `402` with a payment to make:
   `{"error":"payment_required","payment":{"id","reference","to","mint","amount"}}`.
2. **The app pays** `amount` of the dollar `mint` to `to`, with `reference` listed as one more
   account on the transfer, as Solana Pay does, from an address that holds no profile
   ([Policy](#policy)).
3. **The app comes back** with `POST /id/session` `{"payment": "<id>"}`. Until a finalized
   transaction naming `reference` has paid `to` at least `amount` in `mint`, the answer is
   `402 not_paid`, and the app asks again. Then the issuer opens the session: `201`. One payment
   opens one session; asked again, `409 payment_used`. If Didit cannot open the session, the
   payment stays unused.

The reference is the address of a key mixed from the issuer's seed under `reference/<id>`, by
forest's recipe for a main key. Only whoever holds the id can claim a payment that names it, and
the id never goes on chain. To find a payment, the issuer asks its RPC for the 20 newest finalized
transactions that name the reference (`getSignaturesForAddress`), and reads each
(`getTransaction`): what `to`'s token accounts in the dollar gained in it must be at least the
price. It reads nothing about who paid.

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
refused. CORS is open to any origin. A session that gave a note, sent again with the same note
number, gives the note again.

Errors are `{"error": "<code>"}`:

| Status | Codes |
|---|---|
| `400` | `bad_session_id`, `bad_note_number`, `bad_note`, `bad_payment`, `not_json`, `not_an_object`, `expected_empty_body`, `expected_exactly_sessionId_and_noteNumber`, `expected_exactly_sessionId_and_note`, `expected_exactly_payment` |
| `402` | `payment_required` (with the `payment` to make), `not_paid` |
| `403` (the check does not count) | `unknown_session`, `wrong_workflow`, `no_liveness`, `liveness_not_passed`, `no_document`, `document_not_passed`, `no_face_match`, `face_match_not_passed`, `not_approved`, `no_face`, `duplicate_face`, `not_our_note`, `other_model`, `not_the_same_face`, `no_document_data`, `duplicate_document` |
| `409` | `session_used` (this session's face was signed for another note number), `payment_used` |
| `429` | `try_later`: this address opened its share of sessions this hour |
| other | `404 not_found`, `405 post_only`, `405 get_only`, `413 too_large` (bodies over 4 KB), `502 face_check_unavailable`, `502 payment_check_unavailable`, `500 internal` |

### Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `ISSUER_NAME` | yes | | The issuer's name, as `/issuer.json` gives it. Every person's secret for this issuer is mixed from it: it never changes |
| `DIDIT_API_KEY` | yes | | The issuer's Didit API key, from the application that owns both workflows. A secret |
| `DIDIT_WORKFLOW_ID` | yes | | The face check's workflow; any other is refused for tier 1 |
| `DIDIT_ID_WORKFLOW_ID` | yes | | The document check's workflow (document, liveness, face match); any other is refused for tier 2 |
| `ISSUER_KEYPAIR` | one of these two | | The issuer's seed: a JSON list of 64 numbers, as `solana-keygen` writes a key. At start it is written to a private file in a new temporary directory, loaded, the file deleted, and the variable taken out of the environment. The note key, the fingerprint key and the payment references are mixed from it |
| `ISSUER_KEYPAIR_PATH` | one of these two | | Or a path to that file, for local runs. `.gitignore` covers `*keypair*.json` |
| `FACE_MODEL` | no | `sface` | `sface`, or `stand-in` with a stand-in Didit on this machine (`DIDIT_BASE_URL` on loopback); `deploy/start.sh` sets it |
| `ID_TIER_PRICE` | no | `0` | The document check's price, a whole number in the dollar's smallest unit: `2500000` is 2.50 of a six-decimal dollar. 0 is free |
| `ID_TIER_MINT` | when priced | | The dollar it is paid in, by its mint's address |
| `ID_TIER_PAY_TO` | when priced | | The address that receives it |
| `RPC_URL` | when priced | | The Solana RPC it looks for payments through, at `finalized` |
| `DATABASE_PATH` | no | `./data/issuer.sqlite` | The one file |
| `SESSION_LIMIT_PER_HOUR` | no | `5` | Sessions one address may open in an hour, both checks together |
| `CLIENT_ADDRESS_HEADER` | no | none | The header a proxy puts the client's address in (`x-real-ip` on Railway) |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in |
| `PORT` | no | `8080` | |

It refuses to start if a required variable is missing, if both seed variables are set, if the seed
is not a keypair (the message quotes none of it), if `FACE_MODEL=stand-in` is set with a Didit off
this machine, or if `ID_TIER_PAY_TO` is the seed's own address.

### Run it

Node 22.18 or later. From the repo root:

```
./forest.sh registry/client records keys
cd issuer && npm ci
npm run fetch        # the face models, and the three test portraits, each checked by SHA-256
npm run check        # type-check, forest's files included
npm test             # a stand-in Didit and RPC, a real SQLite file, real HTTP, a person proof from a note;
                     # the face models on the portraits; the devnet stand-in Didit, both tiers
npm start            # the service, with the variables above
```

To run it by hand, make a seed outside the repo (`solana-keygen new -o …/issuer-keypair.json`) and
point `ISSUER_KEYPAIR_PATH` at it.

### On devnet

Any platform that runs Node 22.18 with a persistent disk. **One replica, never more:** the sessions
and fingerprints are one SQLite file. **A volume** for `DATABASE_PATH`, or each deploy forgets which
face was signed for which note number. The build context is the repo root. `deploy/Dockerfile`
builds it (Node 22.22.2 and git, `forest.sh registry/client records keys`, `npm ci`, the face models
by `npm run fetch -- models`) and runs `deploy/start.sh`. With no `DIDIT_API_KEY`, that first starts
`deploy/fake-didit.ts`, a stand-in Didit on 127.0.0.1 that approves every session it opens, on both
workflows, with no face seen before and, for a document, a name it makes up for that session; then
points the issuer at it with `FACE_MODEL=stand-in`, and says so.

The foundation's devnet issuer runs that image on Railway, service `issuer`, at
https://issuer.devnet.forest.foundation:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=issuer/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080. No health check: Railway
  refuses a path with a dot, and the other routes are POST.
- **Who it is:** `issuer.devnet.forest.foundation`; its note key is in
  [the repo's devnet facts](../README.md#on-devnet) and at `/issuer.json`. It is the issuer the
  devnet index trusts (`index/lists/issuers.json`) and the fee payer takes vouchers from.
- **No Didit key,** so the stand-in passes everyone, at both tiers.
- **No price:** `ID_TIER_PRICE` is unset, so 0.

| Variable | On devnet | Sealed |
|---|---|---|
| `ISSUER_NAME` | `issuer.devnet.forest.foundation` | no |
| `ISSUER_KEYPAIR` | the devnet `issuer` key | yes |
| `DATABASE_PATH` | `/data/issuer.sqlite` | no |
| `SESSION_LIMIT_PER_HOUR` | `20` | no |
| `CLIENT_ADDRESS_HEADER` | `x-real-ip` | no |
| `PORT` | `8080` | no |

Setting `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID` and `DIDIT_ID_WORKFLOW_ID` (sealed) and redeploying
puts the real checks, and the face model, in the stand-in's place.

## Policy

- **Its provider is Didit,** for both checks. The foundation pays it per check: about $0.15 a face
  check from 1 November 2026, and up to $0.30 a document check on Didit's list (October 2026). On
  devnet the stand-in costs nothing.
- **The face check is free to the person.**
- **The document check costs `ID_TIER_PRICE`,** in the dollar `ID_TIER_MINT`, paid before the
  session opens. On devnet the price is 0, since nothing can receive the money yet.
- **Where it is paid:** `ID_TIER_PAY_TO`, an address of its own, never the issuer's seed. On devnet,
  once a price is set, it is the address mixed from the issuer's seed under `payments`
  ([the repo's devnet facts](../README.md#on-devnet)), in the classic test dollar.
- **Never from a profile's address.** A payment is public on chain for good. Paid from a profile's
  address, it would tell everyone that this profile took the document check, and tell the issuer,
  which sees when each payment lands and opens a session for it, which Didit session, and so which
  face and which document, goes with that profile. A note exists so that a row says a profile's
  holder was checked and nothing more. The app pays from an address that holds no profile; the
  issuer cannot tell, and does not check.
- **The price pays for the check, whatever Didit decides.** Nothing is refunded. A refused request
  uses nothing up, so the same session can still be sent again once a review in Didit approves it.
- **Session limits per address:** `SESSION_LIMIT_PER_HOUR` sessions an hour from one network
  address, both checks together, paid or not: 5 by default, 20 on devnet so a few e2e runs an hour
  fit. Counted in memory as keyed hashes, an IPv6 address by its /64. `/note`, `/id/note` and a
  payment's polling have no limit.
- **Tiers:** 1 after the face check, 2 after the document check. What they mean is this issuer's
  word; a reader weighs them.
- **One face, one note number; one document's person, one note number.** Seen again with the same
  note number, the note is signed again; with another, refused.
- **The face model:** SFace, named `opencv-sface-2021dec` in a note
  ([The face model](#the-face-model)).
- **The same face:** a cosine similarity of at least 0.5 (`FACE_MATCH`) between the live selfie's
  embedding and the note's. OpenCV gives 0.363 for SFace, but across six official NASA portraits of
  five people, two of them scored 0.41 against each other, and one person eight years apart 0.80.
- **What Didit holds.** For the face check: the selfie, the liveness video, a template of the face
  for its face search, and its decision. For the document check, also: the document's images, what
  Didit reads on it (name, date of birth, document number, nationality, dates), and the match
  between the selfie and the document's photo.
- **What the issuer reads.** From each decision: the workflow, whether each step passed (liveness;
  for the document check also the document and the face match), the selfie's address, the earlier
  sessions with the same face, and, for the document check, the name, the birth date and the
  document's country. From the selfie: its embedding. From a payment: what `ID_TIER_PAY_TO` gained,
  in which dollar. It keeps none of it but what [What it keeps](#what-it-keeps-and-why) lists.
- **The consent screen.** Before the document check the app shows this, word for word; the last
  sentence only when there is a price:

  > Forest checks your face and a government ID with Didit, its provider, to make sure each person
  > is checked once. Didit keeps photos of your ID and what it reads on it (your name, date of birth
  > and document number), your selfie, a short video and a template of your face, so it can tell if
  > the same face or ID comes back. Forest keeps none of this: only a one-way fingerprint of your
  > name, date of birth and country next to your note number, so the same person is not checked
  > twice, and it gives you a note that does not say who you are. The check costs {price}, paid
  > before it starts, whatever it decides.

- **Retention.** The issuer keeps what [What it keeps](#what-it-keeps-and-why) lists for as long as
  it runs. Didit keeps what it holds for as long as its retention setting says; that setting is in
  Didit, not in this code. The issuer never asks Didit to delete a session: the duplicate search
  needs the face and the document. On devnet the stand-in keeps, in memory, the ids of the sessions
  it opened, their workflows and the names it made up, and nothing else.
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
- **It takes no key of the person's.** An app sends it a session, a note number or a note, never a
  key.
- **No accounts.**
- **Nothing it keeps ties a person to a profile.** No request names a profile: the person proof
  that ties a note to a profile is made on the person's device.
- **It never signs for anyone.** Its note key signs notes, nothing else.
- **It never deletes a Didit session.** That would drop the face from Didit's duplicate search.
- **It never puts a note on chain.** A note stays with the person; a row carries only the person
  proof's public values.

## Limits

- **On devnet, anyone passes.** The stand-in approves every session, on both checks, with no face
  seen before and a name made up for each document, so anyone who asks gets a note from the devnet
  issuer, at either tier.
- **Payment is untried on chain.** The price is 0 on devnet. The payment path runs in this code's
  tests only, against a stand-in RPC, and a transfer that lists one more account is not among what
  the fee payer's tests sent through Kora.
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
- **A proxy's address header counts only when `CLIENT_ADDRESS_HEADER` names it;** otherwise the
  connection's own address, since a client can write any header.
- **The session limit is not a security boundary.** It counts an hour from an address's first
  session. It stops one person running up the Didit bill from one place, and nothing more: someone
  with many addresses opens many sessions, and people behind one shared address share one count.
  The counts live in memory and reset on restart.
- **A new seed is a new note key.** Readers trust the key; there is no signed handover. The name
  stays, so a person's stamps do not change and a row made under the old key cannot be made again.
- **If the issuer's file is lost,** so is which face and which document were signed for which note
  number: a person seen before could then be signed for a second one.
- **The face model's training data is not ours to vouch for.** SFace's weights are Apache 2.0, but
  its paper trains it on CASIA-WebFace, VGGFace2 and MS-Celeb-1M, whose own terms are for research.
  No widely used face model is trained on data with cleaner terms.
- **The face test is three portraits.** Two of one person and one of another, official NASA
  photos (public domain, `npm run fetch` takes them from NASA's image library): enough to show the
  model tells those two people apart, not to measure how often it errs.
- **Address logs.** The issuer keeps no network address. A hosting provider's own request logs are
  the operator's choice; on Railway they exist, with each request's client address and path.

## Who decides what

- **The standard (forest):** the note, the issuer secret and the note number, the stamp, and the
  person proof a row carries.
- **This issuer, by its policy:** whom it signs notes for (one face check per face, by Didit; one
  document check per person, after a face check, by Didit), what its tiers mean, the face model and
  when two faces are the same, the document check's price and where it is paid, and its limits.
- **Readers, by their own policy:** whether an index, a fee payer or a host trusts this issuer's
  key, and how much each tier weighs.
- **The person, through their app:** whether to be checked, by which check and which issuers, and
  which address to pay from.

## FAQ

**Why a fresh `vendor_data` on every Didit session?**
Didit's duplicate check compares a face with faces verified under another `vendor_data`. The random
id names nobody, and the tag says only which check the session was for.

**Why does the price go to one address, with a reference per session, and not to an address per
session?**
So the issuer never holds money, nor a key that moves it: money paid goes straight to the address
that receives it, and that address is a setting, which can change without a change here. The
reference lets the issuer find each payment and count it once.

**Could someone rebuild this issuer from public data?**
Its name and key are public, and its code is here. What it keeps, which face and which document were
signed for which note number, is not public, so a new issuer starts its own; its people come to it
through their own checks.
