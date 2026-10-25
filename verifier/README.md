# verifier

Part of Forest's services: [the top README](../README.md).

The verifier checks that you are one real person and signs you a stamp.

Forest is one seed and its profiles, verified once, with offers and reviews in public that indexes
rank. The verifier serves one of these: verified once. Once it signs you a stamp you are verified,
and any of your profiles can prove it without saying who you are or which of your other profiles it
goes with. This is one copy, run by the Open Forest Foundation. Anyone can run another: anyone can
sign stamps; the main way is a verifier like this one, and each reader decides which verifiers
count. It keeps your stamp number, which check gave it and the stamp it signed you, and for the ID
check a keyed hash of your name and birthday. Your face stays with the check provider, Didit, and it
holds none of your money.

## How it works

### What a stamp says

A stamp is one signature over two numbers at once:

- **your stamp number,** made on your device from your seed and our name, the same every time;
- **its facts,** one number made from what the check saw of you, which any change to that changes.

Signing the two together is what ties you to what the check saw: the signature says it was checked
for whoever holds the seed behind that stamp number.

What each key's facts are made from:

- **the face key:** the face model's name, and the numbers it gave for your face;
- **the ID key:** the same, and your name, your birth date and your document's country.

The model's name is in it because the face's numbers mean nothing without the program that made
them: with the name, anyone can run the same model and get numbers that compare with yours.

Facts are exact; a face comparison is fuzzy. The same list of numbers always gives the same
facts, but two photos of one face never give the same list. So a later check, by us or by
anyone, would not take a new photo and work the facts out again: you would show the list kept
beside your stamp, anyone could see that it gives the stamp's facts, and then compare it with your
live face, using the same model. Nothing here runs such a check yet.

We see your selfie, and what Didit reads on your document, only while a check runs. We hand what the
facts are made from back to you, beside the stamp, and keep none of it in clear. We keep the stamp,
and hand it back by its stamp number ([The stamp](#the-stamp)). An hour after the stamp is signed we
delete the check at Didit, which keeps only a template of your face
([Once a stamp is signed](#once-a-stamp-is-signed)).

The stamp is the standard's
([proofs/stamp](https://github.com/foundationforest/standard/blob/main/proofs/stamp/README.md#the-stamp-and-the-stamp-proof)).
From it, your device makes a stamp proof for any of your profiles, which shows that we signed you a
stamp without showing the stamp, your seed or who you are.

### Who it is

`GET /` gives its name and its two keys, as addresses, with the check each one signs for and its
facts recipe:

```
{"face":{"facts":"Poseidon([h(model), h(embedding)])","key":"<address>"},
 "h":"SHA-256 of the bytes, read as a big-endian integer, mod the BN254 scalar order",
 "id":{"facts":"Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric])","key":"<address>"},
 "name":"verifier.forest.foundation"}
```

With a welcome gift it adds `"gift":{"host":"<origin>","credits":<n>,"sponsor":"<address>"}`. It is
canonical JSON.

- **The name** is `VERIFIER_NAME`, `verifier.forest.foundation` unless set. Everyone's stamp number and
  tags at this verifier are mixed from it
  ([keys](https://github.com/foundationforest/standard/blob/main/keys/README.md#the-verifier-secret)),
  so it never changes.
- **Two keys, one for each check.** The face key signs face stamps and the ID key signs ID stamps, so
  a reader that trusts one and not the other, or weighs them differently, can tell them apart from
  the key alone.
- **Its seed.** Every key the verifier holds is mixed from one seed: 32 random bytes, made on its own
  machine the first time it starts and finds none (the standard's `newSeed`), and kept in one file,
  `verifier-seed.json`, beside its database, readable by its own user only. So the seed and the record
  of what it signed are kept, or lost, together. No variable holds it, and nothing prints or logs it.
- **What is mixed from the seed,** with the standard's `hkdf`:
  - under `issuer/face`, the face key;
  - under `issuer/id`, the ID key;
  - under `issuer/fingerprint`, the key of the ID check's fingerprints;
  - under `issuer/sponsor`, the sponsor key, an Ed25519 key that signs the gift's tickets;
  - under `issuer/reference/<id>`, the address a payment for one ID check names.

  None of them holds money. The texts never change, since a new text would mix a new key, so they
  keep the words they were first written with.

### The face check

Free, for anyone.

1. **The app opens a check.** `POST /face/session` opens a Didit session on the face workflow and
   answers the page the person does the check on.
2. **The person does it.** Didit checks that a live person is in front of the camera and compares
   the face with every face it has seen.
3. **The app sends the session and its stamp number** to `POST /face/stamp`.
4. **The verifier asks Didit what the session came to:**
   - **Approved:** the verifier fetches the selfie, computes its embedding
     ([The face model](#the-face-model)), keeps the session next to the stamp number, and answers a
     stamp from the face key. An hour later it deletes the session in Didit
     ([Once a stamp is signed](#once-a-stamp-is-signed)).
   - **In Review:** Didit has seen the face before ([How we run it](#how-we-run-it)). The verifier
     answers `202 {"waiting":"review"}`, keeps nothing, and the app asks again later. A person at
     the foundation decides in Didit's console.
   - **Anything else** (declined, not finished): refused.

A face Didit has already seen goes to review, so whether a face gets a second stamp number is
decided there, by a person, not by this code.

### The ID check

Offered only with a price (`ID_PRICE`, [Payment](#payment)). Otherwise its routes answer
`404 not_offered`.

1. **The app pays and opens a check:** `POST /id/session` ([Payment](#payment)).
2. **The person does it.** Didit reads a government document, checks that a live person is in front
   of the camera, and matches the live face to the document's photo.
3. **The app sends the session and its stamp number** to `POST /id/stamp`.
4. **The verifier asks Didit what the session came to.** In Review and refusals are as for the face
   check. Approved means every document step, liveness step and face match passed too.
5. **The person's fingerprint.** The verifier computes it from the name and birth date Didit read
   (HMAC-SHA256, under the fingerprint key, of the standard's canonical JSON of `{birth, name}`):
   - already kept next to another stamp number: refused (`duplicate_document`);
   - next to the same one: signed again, so a lost ID stamp comes back.
6. **The stamp.** It computes the selfie's embedding, keeps the session and the fingerprint next to
   the stamp number, and answers a stamp from the ID key. An hour later it deletes the session in
   Didit.

The name is the one Didit reads, first and last, else the full name: Unicode NFKC, lower case, one
space between words. The birth date is `YYYY-MM-DD`. The country is left out of the fingerprint on
purpose: a renewed document, or another country's, is the same person. Without the key, a guessed
name and birthday cannot be tested against the file.

A refused or failed request uses nothing up: the same session can be sent again.

### Once a stamp is signed

The verifier keeps the stamp and answers it at once, and keeps the session's id and when it was first
signed (`to_delete`, [What it keeps](#what-it-keeps)).

- **Within the hour,** the same session sent again with its stamp number gives the same stamp: Didit
  still has its decision and its selfie. Once the hour since its first signing is over, it is refused
  (`session_used`), with no question to Didit. A retry gives it no more time.
- **The sweep:** every minute, the verifier deletes in Didit each session first signed an hour ago or
  more (`DELETE /v3/session/{id}/delete/`), and forgets its id and time once Didit has deleted it. A
  deletion Didit does not answer is tried again at the next sweep.
- **What goes:** Didit deletes the session's selfie, its liveness video, the document's images, what
  it read and its decision.
- **What stays:** each deletion asks Didit to keep one template of the face
  (`retain_face_embeddings`), whatever the application's own setting says: numbers, no image, no
  name, used only for this application's face search. So a face that comes back still goes to
  review. Didit gives every kept template an end; the verifier asks for 3650 days, the longest it
  allows.
- **Only a session whose stamp is signed:** never one In Review, declined or unfinished. Those stay in
  Didit for as long as its retention lets them.
- **What it logs:** how many deletions Didit did not answer at a sweep, and what Didit says it did
  with a face when it kept no template; never the session.

### The stamp

The verifier signs `{stampNumber, facts}` with the standard's `signStamp`, and answers the stamp in
the standard's JSON form, with the fields its facts were made from beside it:

```
face:  {"stampNumber":"<decimal>","facts":"<decimal>","verifier":"<face key>","signature":{"r8":["<decimal>","<decimal>"],"s":"<decimal>"},
        "model":"opencv-sface-2021dec","embedding":"<base64url>"}
ID:    the same, from the ID key, and "name":"ada lovelace","birth":"1815-12-10","country":826
```

Each key's recipe is fixed for good; a new recipe would be a new key. Poseidon is the standard's
(circomlib's, through `poseidon-lite` 0.3.0, as the standard's keys use it), and h(x) is SHA-256 of
x's bytes, read as a big-endian integer, reduced mod BN254's scalar order:

| | |
|---|---|
| face key | `Poseidon([h(model), h(embedding)])` |
| ID key | `Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric])` |

- `model`: the face model's name, as UTF-8.
- `embedding`: the 512 bytes the model gives for the check's selfie, in the stamp as base64url.
- `name`: written as the fingerprint writes it, as UTF-8.
- `birthDays`: the days from 1970-01-01 to the birth date, negative before it, reduced into the
  field as h is.
- `countryNumeric`: the document's country (Didit's `issuing_state`, ISO 3166-1 alpha-3) as its
  ISO 3166-1 numeric code, or 0 when it has none, as for Kosovo, or when Didit read none.

The fields beside the stamp are for the person: anyone they show them to can make the facts again
and see they are the stamp's. Nothing in the standard reads them, and the stamp proof keeps the facts
private.

**Asked back.** The verifier keeps each stamp without the fields beside it. `POST /stamp` with a
stamp number answers the stamps kept for it, one for each key, `null` for a key that signed none:
the stamp's own fields only (`stampNumber`, `facts`, `verifier`, `signature`). Each is the first that
key signed for that number. A later check for the same number answers its own new stamp, and the
first stays the one handed back, so a check by anyone else who knows the number never changes it;
either gives the same tag. The fields beside a stamp come back only in the answer that signed it,
and from the same session within its hour.

### What it keeps

One SQLite file, six tables:

| Table | What | Why |
|---|---|---|
| `sessions` | The SHA-256 of each session id that gave a stamp, next to the stamp number and which check it was (`face` or `id`) | So a session gives its stamp to one stamp number, and again only within its hour |
| `stamps` | The first stamp each key signed for each stamp number: the stamp number, which key (`face` or `id`), the facts and the signature (r8, s) | So a lost stamp comes back ([The stamp](#the-stamp)) |
| `to_delete` | The id of each session that gave a stamp and is not yet deleted in Didit, which check it was, and when it was first signed | So it is signed again only within its hour, and the sweep can delete it in Didit then. It goes once Didit has deleted it |
| `fingerprints` | Each fingerprint the ID check signed for, next to the stamp number | So one name and birth date gives one stamp number its ID stamp, and gives it again |
| `id_payments` | The transaction signature of each payment used, with the reference it named (public in that transaction), and whether Didit answered that it opened its session | So one payment opens one session, for its own payment id only, and a session deleted after its stamp is not opened again |
| `gifts` | Each stamp number given its welcome gift, with a hash of the buy | So a person gets one, and the same buy asked for again gets the same ticket |

Nothing else: no face, no embedding, no name, no birth date, no document, no address, none of the
fields beside a stamp. A stamp's facts are a one-way hash of what the check saw: without the exact
embedding, which is not kept and which no new photo gives again, no guess of a face, a name or a
birth date can be tested against them. A session id
is kept as its hash; in clear, and with a time, only in `to_delete`, for the hour or so until Didit
has deleted the session. After that the file names no Didit session and holds no time. Deleted bytes
are overwritten (`secure_delete`). The stamp number links the tables: a fingerprint sits next to the same
stamp number as the sessions signed for it, so whoever also holds Didit's records of those sessions
can tell which face went with which name.

### The face model

`src/face.ts` turns a photo of a face into its embedding: 128 numbers, written as 512 bytes, that two
photos of one person give close together and two people far apart. Didit gives no embedding, and
the recipe names the model, so anyone can make the same numbers: an open model, published with its
weights, is one any other verifier can run too.

| Piece | What it does | Licence |
|---|---|---|
| YuNet (`face_detection_yunet_2023mar.onnx`), from OpenCV's model zoo | Finds the face and five points on it: the eyes, the nose tip, the mouth's corners | MIT |
| SFace (`face_recognition_sface_2021dec.onnx`), from OpenCV's model zoo | Gives the 128 numbers for the face, turned and scaled so those points sit where SFace expects them, at 112 by 112 | Apache 2.0; its training data's terms are in [Limits](#limits) |
| `onnxruntime-web` | Runs both models, in WASM | MIT |
| `jpeg-js`, `pngjs` | Read the photo | BSD-3-Clause, MIT |

- **Used unchanged.** The steps are OpenCV's own (`FaceDetectorYN`, `FaceRecognizerSF`), written out
  in the file, so no native library is needed.
- **Its name in a stamp:** `opencv-sface-2021dec`.
- **The files:** `npm run fetch` puts the models in `models/` from OpenCV's own Hugging Face pages,
  and when those fail, from this repo's release `face-models`, which holds the same two files, each
  with its licence. Each source is tried four times, 2, 4 and 8 seconds apart; the fetch fails only
  if both sources fail. Each file is checked against its SHA-256 (`scripts/fetch.ts`), whichever
  source gave it. Neither is in the repo. `.github/workflows/face-models.yml` adds to the release,
  from Hugging Face, each model the script lists that the release does not hold yet, and never
  replaces one.
- **About a third of a second a photo** on one core. Nothing is written or logged.
- **The stand-in, for tests.** With `FACE_MODEL=stand-in`, allowed only with a Didit on this machine
  (`test/fake-didit.ts`, which the tests and the e2e loop run), every photo gives one fixed
  embedding, under the model `stand-in`.

### Payment

The ID check is offered only with all four of `ID_PRICE`, `ID_PAY_TO`, `ID_MINT` and `RPC_URL`; one
without the others stops the verifier from starting.

1. **The app asks:** `POST /id/session` with `{}` answers `402` with a payment to make:
   `{"error":"payment_required","payment":{"id","reference","to","mint","amount"}}`.
2. **The app pays** `amount` of the dollar `mint` to `to`, with `reference` listed as one more
   account on the transfer, as Solana Pay does, from an address that holds no profile
   ([How we run it](#how-we-run-it)).
3. **The app comes back** with `POST /id/session` `{"payment": "<id>"}`. Until a finalized
   transaction naming `reference` has paid `to` at least `amount` in `mint`, the answer is
   `402 not_paid`, and the app asks again. Then the verifier marks the payment used, for good, and
   opens the session: `201`. One payment opens one session, for its own payment id: a transaction
   another payment id already used is `409 payment_used`.
4. **A lost answer, or Didit not answering.** Each session a payment id opens carries, as its
   `vendor_data` in Didit, the SHA-256 of the payment id, so Didit never holds the id. Asked again
   with a payment id whose payments are all used, the verifier looks the session up by it (Didit's
   list of sessions) and answers it again; if Didit never answered that it opened one, it opens one
   now. A payment whose session Didit answered it opened, and no longer lists, gave its stamp and was
   deleted since:
   `409 payment_used`. A payment is never given back. A second payment naming the same reference
   opens a second session.

The reference is the address of a key mixed from the verifier's seed, so only whoever holds the id can
claim a payment that names it, and the id never goes on chain. To find a payment, the verifier asks
its RPC for the 20 newest finalized transactions that name the reference
(`getSignaturesForAddress`), and reads each (`getTransaction`): what `to`'s token accounts in the
dollar gained in it must be at least the price. It reads nothing about who paid.

### The welcome gift

With `HOST_URL`, a stamp number's first face stamp comes with `HOST_CREDITS` of the host's credits
(prepaid units, [host](../host/README.md#credits)). The app buys them, the verifier signs a sponsor's
ticket for the buy, and the host signs them blind, so the verifier never sees them. It pays nothing:
the host lists the verifier's sponsor key and counts what its tickets paid for.

1. **The app reads the gift** in `GET /`: the host, how many credits, and the sponsor key.
2. **The app makes one buy at the host** for exactly those credits (as the buyer's credits client
   in `e2e/credits/` does, `buy`), and keeps what it needs to finish the buy later.
3. **It sends the buy's reference with the stamp request:** `POST /face/stamp` with
   `"gift": "<reference>"`.
4. **Once a stamp number,** the verifier keeps a hash of the buy next to it, and signs a ticket with its
   sponsor key (`ticketMessage` in `src/ticket.ts`): that host, that buy, that many credits.
5. **The answer** is the stamp, with `"gift": {"ticket": "<ticket>"}`, or `"gift": {"error": …}`:
   `bad_gift` for anything but a buy's reference, or `given` for another buy than the one the stamp
   number was given its gift for. The same buy asked for again, with a new check for the same stamp
   number, gets the same ticket. The stamp is never held back by the gift.
6. **The app collects** the buy at the host with its ticket, and finishes the credits.

### The API

| Route | Body | Answer |
|---|---|---|
| `GET /` | | `200`, who it is ([Who it is](#who-it-is)) |
| `POST /face/session` | `{}` or none; or `{"returnUrl": "<url>"}`, a page on one of the origins in `APP_ORIGINS`, where Didit sends the person when the check is done | `201 {"sessionId": "…", "url": "…"}` |
| `POST /face/stamp` | `{"sessionId": "<uuid>", "stampNumber": "<decimal>"}`; with a gift, may add `"gift": "<buy's reference>"` | `200 {"stamp": <stamp>}`; with `gift` asked, also `"gift"` |
| `POST /id/session` | `{}` or none; then `{"payment": "<id>"}` once paid | `201 {"sessionId": "…", "url": "…"}`, the same session for the same payment asked again, or `402` with a payment to make |
| `POST /id/stamp` | `{"sessionId": "<uuid>", "stampNumber": "<decimal>"}` | `200 {"stamp": <stamp>}` |
| `POST /stamp` | `{"stampNumber": "<decimal>"}` | `200 {"face": <stamp>, "id": <stamp>}`, each a stamp's own fields only, or `null` ([The stamp](#the-stamp)); `404 not_found` when none was signed for that number |

A session Didit holds In Review answers `202 {"waiting": "review"}`. A stamp number is decimal text,
as the standard's `verifierSecret` gives it: no sign, no leading zero, below BN254's scalar order. A
payment's id is 32 lowercase hex characters. A body with any other field is refused. CORS is open
to any origin.

Errors are `{"error": "<code>"}`:

| Status | Codes |
|---|---|
| `400` | `not_json`, `not_an_object`, `expected_empty_body`, `expected_exactly_returnUrl`, `expected_exactly_sessionId_and_stampNumber`, `expected_exactly_stampNumber`, `expected_exactly_payment`, `bad_session_id`, `bad_stamp_number`, `bad_payment`, `bad_return_url` (not a URL on an origin in `APP_ORIGINS`) |
| `402` | `payment_required` (with the `payment` to make), `not_paid` |
| `403` (the check does not count) | `unknown_session`, `wrong_workflow`, `not_approved`, `no_liveness`, `liveness_not_passed`, `no_document`, `document_not_passed`, `no_face_match`, `face_match_not_passed`, `no_face`, `no_document_data` (no name, or no real birth date), `duplicate_document` |
| `404` | `not_found` (no such route, or no stamp for that stamp number), `not_offered` (the ID check, with no price) |
| `409` | `session_used` (this session gave its stamp to another stamp number, or its hour is over), `payment_used` |
| `429` | `try_later`: this address opened its share of sessions this hour |
| other | `405 post_only`, `405 get_only`, `413 too_large` (bodies over 4 KB), `502 face_check_unavailable`, `502 payment_check_unavailable`, `500 internal` |

### Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `VERIFIER_NAME` | no | `verifier.forest.foundation` | The verifier's name, as `GET /` gives it. Everyone's stamp number and tags at this verifier are mixed from it: it never changes |
| `DIDIT_API_KEY` | yes | | The verifier's Didit API key, from the application that owns both workflows. A secret |
| `DIDIT_FACE_WORKFLOW_ID` | yes | | The face check's workflow; a session on any other is refused for a face stamp |
| `DIDIT_ID_WORKFLOW_ID` | yes | | The ID check's workflow (document, liveness, face match); a session on any other is refused for an ID stamp |
| `DIDIT_BASE_URL` | no | `https://verification.didit.me` | For a stand-in Didit |
| `FACE_MODEL` | no | `sface` | `sface`, or `stand-in`, for tests, with a Didit on this machine (`DIDIT_BASE_URL` on loopback) |
| `APP_ORIGINS` | no | none: no `returnUrl` taken | The apps a person may be sent back to after a face check, by origin, comma-separated |
| `ID_PRICE` | with the ID check | none: not offered | The ID check's price, a whole number above 0 in the dollar's smallest unit: `2500000` is 2.50 of a six-decimal dollar |
| `ID_PAY_TO` | with the ID check | | The address that receives it; never the sponsor key's |
| `ID_MINT` | with the ID check | | The dollar it is paid in, by its mint's address |
| `RPC_URL` | with the ID check | | The Solana RPC it looks for payments through, at `finalized` |
| `HOST_URL` | no | none: no gift | The host's origin, `https://<host>`, whose credits the gift's ticket pays for |
| `HOST_CREDITS` | no | `10` | How many of the host's credits; 0 for none |
| `DATABASE_PATH` | no | `./data/verifier.sqlite` | The one file. The seed file, `verifier-seed.json`, is in the same directory, made there at the first start |
| `SESSION_LIMIT_PER_HOUR` | no | `5` | Sessions one address may open in an hour, both checks together |
| `CLIENT_ADDRESS_HEADER` | no | none | The header a proxy puts the client's address in (`x-real-ip` on Railway) |
| `PORT` | no | `8080` | |

It refuses to start if a required variable is missing (so never without Didit), if the seed file is
not a seed (the message quotes none of it), if `FACE_MODEL=stand-in` is set with a Didit off this
machine, if `ID_PAY_TO` is the sponsor key's address, or if the host or an app is not an origin.

### Run it

Node 22.18 or later. From the repo root:

```
./standard.sh                     # the standard at the pinned commit, installed and built
(cd e2e && npm ci) && (cd host && npm ci)   # the buyer's credits client and the host's seller, for the gift's tests
cd verifier && npm ci             # the standard's packages, linked by name from ../standard/
npm run fetch                     # the face models, and the three test portraits, each checked by SHA-256
npm run check                     # type-check
npm test                          # a stand-in Didit and RPC, a real SQLite file, real HTTP; stamp proofs
                                  # made from both stamps and checked against the published keys; the
                                  # facts vectors (test/vectors.json); each stamp asked back by its
                                  # number; the seed made, kept and read again; each session deleted
                                  # in Didit an hour after its stamp is signed, never one in review;
                                  # the face models on the portraits; the stand-in Didit the e2e loop
                                  # runs, both checks and review; the gift's ticket, taken by the
                                  # host's own seller; the fetch's tries and its second source
npm start                         # the service, with the variables above
```

The verifier depends on the standard's packages by name (`@foundationforest/keys`, `/stamp`,
`/records`) through `file:` links into `standard/`; moving `STANDARD` can change what they depend on,
so `npm install` in `verifier/` writes the lockfile again. Run by hand, it makes its seed in `data/`,
beside its file; `.gitignore` covers both.

**By hand, against Didit's sandbox** (an application that mocks every provider and never bills):

```
npm run fetch -- models
DIDIT_SANDBOX_API_KEY=<the sandbox application's key> npm run sandbox             # every session approved
DIDIT_SANDBOX_API_KEY=<the sandbox application's key> npm run sandbox -- review_x  # or Didit's review_…, decline_… scenarios
```

A Didit key belongs to one application, so the sandbox takes its own variable; the script never
reads `DIDIT_API_KEY`, and refuses to start when the two are the same. It runs both checks on the
sandbox's two workflows, with its own seed and file in `data/sandbox/`, and the ID check at a price
of 1 with a stand-in payment check that counts every payment as landed. `POST /face/session`, open
the page it answers and walk through Didit's flow, then `POST /face/stamp`.

### The image

Any platform that runs Node 22.18 with a persistent disk. **One replica, never more:** the sessions
and fingerprints are one SQLite file. **A volume** for `DATABASE_PATH` and the seed beside it, or a
deploy loses which session and which person were signed for which stamp number, and the seed with
them. The build context is the repo root. `deploy/Dockerfile` builds it (Node 22.22.2 and git,
`standard.sh`, `npm ci`, the face models by `npm run fetch -- models`) and runs `npm start` in
`verifier/`.

## How we run it

- **Its name:** `verifier.forest.foundation`.
- **Its seed is made on its machine** at its first start, and kept on its volume beside its file. No
  person, phrase or variable holds it.
- **Its provider is Didit,** for both checks, in the foundation's Didit application. The foundation
  pays it per check: about $0.15 a face check from 1 November 2026, and up to $0.30 an ID check on
  Didit's list (October 2026).
- **The face check, "Forest face"** (`2faaca36-58b4-49d7-90d7-2b9cf002d173`), free to the person:
  - one passive liveness step, with Didit's face search on;
  - a face Didit has seen before, including one seen with another name or document, goes to review;
  - a screen, a virtual camera, an injected frame, an outside camera, or more than one face is
    declined.
- **The ID check, "Forest ID"** (`bfbdb912-d2f5-41d8-827c-4304e8209d24`):
  - a document, by camera scan, then liveness, then the live face matched to the document's photo;
  - Didit takes no action on a document, a person or a face it has seen before, so the fingerprint
    alone decides.
- **Reviews happen in Didit's console:** a person at the foundation approves or declines each
  session in review, and the app's next ask gets the answer.
- **The recipes:**
  - the face key's is `Poseidon([h(model), h(embedding)])`;
  - the ID key's is `Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric])`;
  - both are fixed for good ([The stamp](#the-stamp)).
- **The face model:** SFace, `opencv-sface-2021dec` ([The face model](#the-face-model)).
- **The ID check is not offered yet:** no price is set, so `/id/session` and `/id/stamp` answer
  `not_offered`. Once a price is set, it is paid before the session opens, and pays for the check
  whatever Didit decides. Nothing is refunded.
- **Where it would be paid:** `ID_PAY_TO`, an address of its own, never one the verifier's seed gives.
- **Never from a profile's address.** A payment is public on chain for good. Paid from a profile's
  address, it would tell everyone that this profile took the ID check, and tell the verifier, which
  sees when each payment lands and opens a session for it, which Didit session, and so which face
  and which document, goes with that profile. A stamp exists so that a profile shows its holder was
  checked and nothing more. The app pays from an address that holds no profile; the verifier cannot
  tell, and does not check.
- **The welcome gift:** at a stamp number's first face stamp, 10 of the host's credits
  (`HOST_CREDITS`, a cent of writes each) at the foundation's host (`HOST_URL`), as a sponsor's
  ticket. Once a stamp number.
- **No money:** the verifier holds no key that holds money. The ID check's price would go straight to
  `ID_PAY_TO`; the gift is a ticket, which the host counts.
- **Session limits per address:** `SESSION_LIMIT_PER_HOUR` sessions an hour from one network
  address, both checks together, paid or not: 5 unless set. A cost guard: each check is paid to
  Didit, and the limit keeps a flood of them from one place from running up the bill. Counted in
  memory as keyed hashes, an IPv6 address by its /64. The stamp requests and a payment's polling have
  no limit.
- **Where Didit sends the person back:** a page of an app in `APP_ORIGINS`, when the app asks: the
  Forest app, at https://app.forest.foundation.
- **One replica, a volume,** the seed and the file in a directory of their own on it.
- **What Didit holds,** until the session's stamp is signed. For the face check: the selfie, the
  liveness video, a template of the face for its face search, and its decision. For the ID check,
  also: the document's images, what Didit reads on it (name, date of birth, document number,
  nationality, dates), and the match between the selfie and the document's photo. Once the stamp is
  signed, only the face template, for 3650 days.
- **What the verifier reads.** From each decision:
  - the workflow, the status, and whether each step passed;
  - the selfie's address;
  - for the ID check, the name, the birth date and the document's country.

  From the selfie, its embedding. From a payment, what `ID_PAY_TO` gained, in which dollar. From a
  gift, the buy's reference. It keeps none of it but what [What it keeps](#what-it-keeps) lists, and
  answers the embedding, and for the ID check the name, birth date and country, to the person
  beside the stamp.
- **The consent screen.** Before the ID check the app shows this, word for word:

  > Forest, run by the Open Forest Foundation, checks your face and a government ID with Didit, its
  > provider, to make sure each person is checked once. Didit keeps photos of your ID and what it
  > reads on it (your name, date of birth and document number), your selfie and a short video while
  > it checks. An hour after your stamp is signed, Forest deletes them at Didit, which keeps only a
  > template of your face, for up to ten years, so it can tell if the same face comes back. Forest
  > keeps none of this: only a one-way fingerprint of your name and date of birth next to your stamp
  > number, so the same person is not checked twice, and the stamp it signed you, a one-way hash of
  > what the check saw, so it can hand it back if you lose it. It gives you a stamp, with your name,
  > date of birth and country beside it for your own records; a profile that shows it says only that
  > you were checked. The check costs {price}, paid before it starts, whatever it decides.

- **Retention.** The verifier keeps what [What it keeps](#what-it-keeps) lists for as long as it runs.
  It deletes every session in Didit an hour after its stamp is first signed, and asks Didit to keep
  the face template for 3650 days. Didit gives every kept template an end, and 3650 days is the longest it
  allows, so a template is never kept without a limit. The live application's own retention window,
  how long Didit keeps a session nobody deletes, is unlimited, so a session that gave no stamp (in
  review, declined, unfinished) stays until someone deletes it in Didit's console.
- **Data law:** the Open Forest Foundation is the responsible party for both checks, so three things
  sit outside this code: a processing agreement with Didit, the consent screen above, and Didit's
  retention setting. Paperwork and settings; nothing here does them.

## Promises

- **It keeps which check session gave which stamp number, and the stamp it signed, and nothing else
  of a check.** Its one SQLite file has six tables:
  - the SHA-256 of each session id, next to the stamp number it was signed for and which check it was;
  - the first stamp each key signed for each stamp number: which key, the facts and the signature;
  - the id of each session not yet deleted in Didit, which check it was, and when it was first
    signed, until Didit has deleted it;
  - a keyed one-way fingerprint of each name and birth date the ID check signed for, next to the stamp
    number;
  - the transaction signature of each payment used, with the reference it named and whether its
    session opened;
  - each stamp number given its welcome gift, with a hash of the buy.

  No face, no embedding, no name, no birth date, no document, and no time or session id in clear
  once a session is deleted in Didit. Deleted bytes are overwritten (`secure_delete`). A test reads
  the raw file and checks this.
- **It never logs a request, an address, a session, a stamp number or a stamp.** It logs an error's
  kind, never its message.
- **It never writes down an address.** It reads the client's address only to count sessions against
  the limit, in memory, as a keyed hash under a key made at start.
- **It never puts what a person sends in a URL.** The routes an app calls are POST with a JSON body,
  since hosting platforms log paths.
- **It takes no key of the person's.** An app sends it a session and a stamp number, never a key.
- **No sign-ups.**
- **Nothing it keeps ties a person to a profile.** No request names a profile: the stamp proof that
  ties a stamp to a profile is made on the person's device.
- **It never signs for anyone.** Its face key and its ID key sign stamps, and its sponsor key signs
  tickets, nothing else.
- **A key's recipe never changes.** What a key's stamps' `facts` are made from is fixed for good;
  a new recipe is a new key.
- **It deletes every session in Didit an hour after its stamp is first signed, and no other.** Never
  one In Review.
  Each deletion asks Didit to keep only a template of the face, so its search still sees a face that
  comes back.
- **It never puts a stamp on chain.** A stamp stays with the person; a profile record carries only the
  stamp proof.

## Limits

- **Two people with the same name and birthday:** the second is refused the ID check
  (`duplicate_document`). Didit takes no action on duplicates in the ID check and the fingerprint
  decides, so there is no review of it here.
- **One person with two countries' documents that spell the name differently can hold two ID
  stamps.** A name read two ways (a middle name, another script) is two fingerprints. The fingerprint
  is as exact as Didit's reading.
- **One person per verifier rests on Didit's face search.** The verifier keeps no face; a face Didit's
  search misses is a new person to it, and a face sent to review is signed for whatever stamp number
  the person brings once a person at the foundation approves it.
- **A kept face template ends.** Didit keeps it 3650 days at most; after that its search no longer
  sees the face, and a face that comes back is new to it.
- **Didit's face search covers both checks,** which share one application: a person who takes the ID
  check before the face check goes to review at the face check.
- **After the hour, a lost answer loses what was beside the stamp.** Within the hour since its stamp
  was first signed, a session gives the same answer again; after it, the stamp comes back by its
  stamp number, and the embedding, and the ID's name, birth date and country, do not.
- **Stamps signed before this code kept them do not come back.** The file holds only the stamps
  signed since; for an older one, `POST /stamp` answers `not_found`, and the person checks again,
  where a face Didit has seen goes to review.
- **For that hour, the file names the session.** Its id and when it was signed sit in `to_delete`, in
  clear, until Didit has deleted it: whoever reads the file then can ask Didit about that session.
- **A deletion Didit does not answer leaves the session in Didit,** selfie and document images
  included, and its id and time in the file, until a later sweep gets an answer. The verifier logs that
  it happened, without the session.
- **It trusts Didit's decision,** for a session on the check's own workflow: the status, each step's
  status, the selfie, and what the document step read. It reads those and drops everything else
  Didit returns. It cannot see how the workflows are set up in Didit, and relies on what How we run
  it lists: face search on, a face seen before sent to review, and an API key from the application
  that owns both workflows, allowed to delete its sessions.
- **The answer that signs a stamp carries what it was made from.** A face stamp carries the face's
  embedding; an ID stamp, also the name, birth date and country. The person keeps it, and an app
  should keep it as it keeps a key: whoever has it holds numbers made from that face, and who the
  person is.
- **A country with no ISO numeric code enters as 0,** so an ID stamp's facts do not tell such a
  country from a document whose country Didit did not read.
- **The ID check is not offered** until a price is set.
- **Payment is untried on chain.** The payment path runs in this code's tests only, against a
  stand-in RPC, and a transfer that lists one more account is not among what the fee payer's tests
  sent through Kora.
- **A payment's session is found again through Didit's list of sessions,** by its `vendor_data`; the API key
  must be allowed to read sessions. A session Didit opened whose answer was lost, if Didit's list
  misses it, is opened again on the next ask, and the foundation pays Didit for both.
- **It trusts its RPC** to say which finalized transactions name a reference and what each moved. It
  reads the 20 newest that name it. Each `POST /id/session` with a payment asks the RPC, and has no
  limit of its own.
- **A lost gift is lost.** The same buy asked for again, with a new check, gets the same ticket; a
  buy the app no longer holds cannot be finished, and another buy gets `given`.
- **A proxy's address header counts only when `CLIENT_ADDRESS_HEADER` names it;** otherwise the
  connection's own address, since a client can write any header.
- **The session limit is not a security boundary.** It counts an hour from an address's first
  session. It stops one person running up the Didit bill from one place, and nothing more: someone
  with many addresses opens many sessions, and people behind one shared address share one count. The
  counts live in memory and reset on restart.
- **Losing the volume means new keys and new checks.** The seed and the file live only there: a start
  without them makes a new seed, whose keys readers must trust anew, with no signed handover, and
  which session and which person were signed for which stamp number is gone too, so a person could
  get a second stamp number's ID stamp. The name stays, so a person's tags do not change.
- **The face model's training data is not ours to vouch for.** SFace's weights are Apache 2.0, but
  its paper trains it on CASIA-WebFace, VGGFace2 and MS-Celeb-1M, whose own terms are for research. No
  widely used face model is trained on data with cleaner terms.
- **The face test is three portraits.** Two of one person and one of another, official NASA photos
  (public domain, `npm run fetch` takes them from NASA's image library): enough to show the model
  tells those two people apart, not to measure how often it errs.
- **Address logs.** The verifier keeps no network address. A hosting provider's own request logs are
  the operator's choice; on Railway they exist, with each request's client address and path.

## Who decides what

- **The standard:** the stamp, the verifier secret and the stamp number, the tag, and the stamp proof.
- **This verifier, by its own choice:** whom it signs stamps for (a face Didit approves, by its search
  and its reviews; one stamp number for each name and birth date), its two keys and their recipes,
  the face model, the ID check's price and where it is paid, the welcome gift, its limits, and its
  name.
- **Readers, by their own choice:** whether to trust this verifier's face key, its ID key or both, and
  how much each weighs.
- **The person, through their app:** whether to be checked, by which check and which verifiers, which
  address to pay from, and where to keep the stamp.

## FAQ

**Can you tell which profile is mine?**
No. We hold your stamp number, made from your seed and our name. Your profiles' keys are made from
your seed and their labels. Nothing we hold connects the two: only your seed does, and it never
leaves your device. A stamp proof on a profile shows that we signed a stamp to the seed behind it,
never which stamp number.

**What if I lose my stamp?**
Ask for it by its stamp number, `POST /stamp` ([The stamp](#the-stamp)); your device makes the number
again from your seed and our name. The stamp is useless without the seed: a stamp proof needs the
seed behind its number, so handing it back is safe. The fields beside it, the embedding and the ID's
name, birth date and country, are not kept and do not come back.

**My face changes with light and age. Does the hash still work?**
Yes. The hash pins the one list of numbers we computed from your selfie at check time, and that list
never changes, so the stamp stays good. A new photo would give a slightly different list; telling
whether two lists are the same face is a comparison, made with the model, and that is where the
fuzziness lives, not in the stamp.

**Why a fresh `vendor_data` on every Didit session?**
Didit's face search compares a face with faces checked under another `vendor_data`. The random id
names nobody, and its prefix says only which check the session was for.

**Why does the price go to one address, with a reference per payment, and not to an address per
payment?**
So the verifier holds none of the money an ID check is paid with, nor a key that moves it: it goes
straight to the address that receives it, and that address is a setting, which can change without a
change here. The reference lets the verifier find each payment and count it once.

**Why does it refuse to start without Didit?**
Every stamp it signs counts with every reader that trusts its keys. Started with a stand-in that
passes everyone, those keys would sign stamps for anyone. The stand-in is for tests on this machine,
with keys made for them.

**Could someone rebuild this verifier from public data?**
Its name and keys are public, and its code is here. What it keeps, which session and which person
were signed for which stamp number, is not public, so a new verifier starts its own; its people come to
it through their own checks.
