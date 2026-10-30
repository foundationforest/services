# verifier

The verifier checks that you are one real person, by your face or your ID, and signs a stamp to your
seed (the secret on your device that all your keys come from). Your profiles then prove they're
verified without saying who you are, or which of your other profiles they go with. The Forest
Foundation runs this copy, at https://verifier.forest.foundation. Anyone can sign stamps; the main
way is a verifier like this one, and each reader decides which verifiers count. It keeps your stamp
number, which check gave it, the stamp, and for the ID check a keyed hash of your name and birthday.
Your face stays with Didit, its check provider. No key of yours, no money, no account.

## How it works

| Word | What it is |
|---|---|
| stamp | One signature over the verifier's name, your stamp number and its facts ([the standard's](https://github.com/foundationforest/standard/blob/main/proofs/README.md#the-stamp-and-the-verification)) |
| stamp number | A number your device makes from your seed and the verifier's name, the same every time |
| facts | One number made from what the check saw of you, which any change to that changes |
| verification | What a profile shows: a proof, made on your device, that its seed holds a stamp from this verifier, without the stamp, the seed or who you are |

Signing the stamp number and the facts together says the check was for whoever holds the seed behind
that number. A stamp stays with the person: a profile entry carries only the verification, and
nothing here puts either on a chain.

### The two checks

Both are Didit sessions. The app drives them; the verifier only asks Didit what each came to.

| Step | Face check, free | ID check, free for now |
|---|---|---|
| Open | `POST /face/session` opens a session on the face workflow and answers the page the person uses | `POST /id/session`, on the ID workflow |
| The person | Didit checks for a live person and compares the face with every face it has seen | Didit also reads a government document and matches the live face to its photo |
| Ask | The app sends the session and its stamp number to `POST /face/stamp` | `POST /id/stamp` |
| Approved | The verifier fetches the selfie, computes its embedding ([The face model](#the-face-model)), keeps the session next to the stamp number, and answers a stamp from the face key | Every document, liveness and face-match step passed too; then the fingerprint, and a stamp from the ID key |

- **In Review** means Didit has seen the face before: the verifier answers `202 {"waiting":"review"}`,
  keeps nothing, and the app asks again later. A person at the foundation decides in Didit's
  console, so a second stamp number for one face is a person's call, not this code's.
- **Anything else** (declined, unfinished) is refused. A refused or failed request uses nothing up.
- **The fingerprint** is HMAC-SHA256 (a keyed hash), under the fingerprint key, of the standard's
  canonical JSON of `{birth, name}`: the name Didit reads, first and last, else the full name, in
  Unicode NFKC, lower case, one space between words; the birth date as `YYYY-MM-DD`. Kept next to
  another stamp number: refused, `duplicate_document`. Next to the same one: signed again, so a lost
  ID stamp comes back. The country is left out, since a renewed or another country's document is the
  same person. Without the key, a guessed name and birthday cannot be tested against the file.
- **`vendor_data`** on each session is a fresh random id after a prefix naming only the check, so it
  names nobody; Didit's face search compares a face with those under other `vendor_data`.

### The stamp

The verifier signs `{stampNumber, facts, verifierName}` with the standard's `signStamp`, and answers
it in the standard's JSON form, with what its facts were made from beside it:

```
face:  {"stampNumber":"<decimal>","facts":"<decimal>","verifier":"<face key>","verifierName":"<its name>",
        "signature":{"r8":["<decimal>","<decimal>"],"s":"<decimal>"},"model":"opencv-sface-2021dec","embedding":"<base64url>"}
ID:    the same, from the ID key, and "name":"ada lovelace","birth":"1815-12-10","country":826
```

| Key | Its facts, fixed for good: a new recipe is a new key |
|---|---|
| face key | `Poseidon([h(model), h(embedding)])` |
| ID key | `Poseidon([h(model), h(embedding), h(name), birthDays, countryNumeric])` |

- **Poseidon:** a hash made for zero-knowledge proofs, circomlib's, through `poseidon-lite` 0.3.0, as
  the standard's keys use it. **`h(x)`:** SHA-256 of x's bytes, as a big-endian integer, mod BN254's
  scalar order (the size of the numbers the proofs work in).
- **`model`:** the face model's name, UTF-8. A face's numbers mean nothing without the program that
  made them; with the name, anyone can run the same model. **`embedding`:** the 512 bytes the model
  gives for the selfie. **`name`:** as the fingerprint writes it.
- **`birthDays`:** days from 1970-01-01, negative before it, reduced as h is. **`countryNumeric`:**
  the document's country (Didit's `issuing_state`) as its ISO 3166-1 numeric code, or 0 when it has
  none, as for Kosovo, or when Didit read none.

The fields beside a stamp are the person's: anyone they show them to can make the facts again.
Nothing in the standard reads them, and the verification keeps the facts private. Facts are exact;
a face comparison is fuzzy. Two photos of one face never give the same numbers, so a later check
would not work the facts out from a new photo: you would show the kept embedding, anyone could see it
gives the facts, and compare it with your live face using the same model. So a face that changes
with light and age leaves its stamp good. Nothing here runs such a check yet.

**Asked back:** `POST /stamp` with a stamp number answers, for each key, the first stamp it signed
for that number, its own fields only, or `null`. A later check answers its own new stamp, but the
first stays the one handed back, so nobody else who knows the number can change it; either gives the
same verification. Handing it back is safe: a verification needs the seed behind the number. The
fields beside a stamp come only in the answer that signed it, and again from that session within its
hour.

### Its keys

`GET /` gives its name, its two keys as addresses each with its facts recipe, and `h`, in canonical
JSON (one exact way of writing it); with gifts, also
`"gift":{"face":<n>,"host":"<origin>","id":<n>,"sponsor":"<address>"}`.

- **The name** never changes: everyone's stamp number here is mixed from it
  ([keys](https://github.com/foundationforest/standard/blob/main/keys/README.md#the-recipe)).
- **Two keys, one per check,** so a reader can trust or weigh them apart.
- **One seed,** 32 random bytes made on its own machine at the first start that finds none (the
  standard's `newSeed`), kept in `verifier-seed.json` beside its database, readable by its own user
  only, so the two are kept or lost together. No person, phrase or variable holds it; nothing prints
  or logs it.
- **Mixed from the seed** with the standard's `hkdf` (a standard way to make many keys from one
  secret): under `face`, the face key; `id`, the ID key; `fingerprint`, the fingerprint key; `sponsor`,
  the sponsor key, an Ed25519 key that signs the gifts' tickets. The texts never change, since a new
  text would mix a new key. None of the keys holds money.

### Once a stamp is signed

- **Within the hour** since its first signing, the same session and stamp number give the same
  stamp, as Didit still has its decision and selfie. After it: `session_used`, with no question to
  Didit; a retry gives no more time.
- **Every minute,** the sweep deletes in Didit each session first signed an hour ago or more
  (`DELETE /v3/session/{id}/delete/`), and forgets its id and time once Didit has. One Didit does not
  answer is tried at the next sweep. Never a session In Review, declined or unfinished.
- **What goes:** the selfie, the liveness video, the document's images, what Didit read on it (name,
  date of birth, document number, nationality, dates), and its decision.
- **What stays:** each deletion asks Didit to keep one template of the face
  (`retain_face_embeddings`), whatever the application's setting: numbers, no image, no name, used
  only for this application's face search, so a face that comes back still goes to review. Didit
  ends every kept template; the verifier asks for 3650 days, the longest it allows.

### What it keeps

One SQLite file (a database in a single file), six tables:

| Table | What | Why |
|---|---|---|
| `sessions` | The SHA-256 of each session id that gave a stamp, with the stamp number and which check (`face` or `id`) | A session gives its stamp to one stamp number, and again only within its hour |
| `stamps` | The first stamp each key signed for each stamp number: the number, the key, the facts, the signature | A lost stamp comes back |
| `to_delete` | The id of each session not yet deleted in Didit, its check, and when it was first signed | The hour, and the sweep. It goes once Didit has deleted it |
| `fingerprints` | Each fingerprint the ID check signed for, with the stamp number | One name and birth date, one stamp number's ID stamp |
| `gifts`, `id_gifts` | Each stamp number given its face stamp's gift, or its ID stamp's, with a hash of the buy | One gift a person from each check; the same buy gets the same ticket |

Nothing else: no face, no embedding, no name, no birth date, no document, no address, none of the
fields beside a stamp. Facts are a one-way hash: without the exact embedding, which no new photo
gives again, no guess can be tested against them. A session id is in clear, with a time, only in
`to_delete`, for the hour or so until Didit has deleted it. Deleted bytes are overwritten
(`secure_delete`). The stamp number links the tables, so whoever also holds what Didit keeps of those
sessions can tell which face went with which name.

### The face model

`src/face.ts` turns a photo into its embedding: 128 numbers, as 512 bytes, close together for two
photos of one person and far apart for two people. Didit gives none, and an open model with published
weights is one any other verifier can run.

| Piece | What it does | Licence |
|---|---|---|
| YuNet (`face_detection_yunet_2023mar.onnx`), OpenCV's model zoo | Finds the face and five points: the eyes, the nose tip, the mouth's corners | MIT |
| SFace (`face_recognition_sface_2021dec.onnx`), OpenCV's model zoo | Gives the 128 numbers, the face turned and scaled so those points sit where SFace expects, at 112 by 112 | Apache 2.0; its training data, in [Limits](#limits) |
| `onnxruntime-web` | Runs both, in WASM | MIT |
| `jpeg-js`, `pngjs` | Read the photo | BSD-3-Clause, MIT |

- OpenCV's own steps (`FaceDetectorYN`, `FaceRecognizerSF`), written out unchanged, so no native
  library. Named `opencv-sface-2021dec` in a stamp. About a third of a second a photo on one core;
  nothing written or logged.
- `npm run fetch` puts the models in `models/` from OpenCV's Hugging Face pages, else from this
  repo's release `face-models` (the same files and licences): each source tried four times, 2, 4 and
  8 seconds apart, each file checked by SHA-256 (`scripts/fetch.ts`). Neither is in the repo.
  `.github/workflows/face-models.yml` adds each listed model the release lacks, never replacing one.
- `FACE_MODEL=stand-in`, only with a Didit on this machine (`test/fake-didit.ts`, run by the tests
  and the loop), gives every photo one fixed embedding, under the model `stand-in`.

### The gifts

With `HOST_URL`, a stamp asked with a gift comes with the host's credits (prepaid units of its
writes, [host](../host/README.md#credits)), once a stamp number from each check: `FACE_CREDITS` with
a face stamp, `ID_CREDITS` with an ID stamp. The host signs them blind, so the verifier never sees
them, and pays nothing: the host lists its sponsor key and counts what its tickets paid for.

1. The app reads the gift in `GET /`, makes one buy at the host for exactly the check's credits
   (`buy`, in `host/client/`), and keeps what finishes it.
2. It sends `"gift": "<the buy's reference>"` with `POST /face/stamp` or `POST /id/stamp`.
3. Once a stamp number, the verifier keeps a hash of the buy and signs a ticket with its sponsor key
   (`ticketMessage`, `src/ticket.ts`): that host, that buy, that many credits.
4. The answer adds `"gift": {"ticket": …}`, or `{"error": …}`: `bad_gift` for anything but a buy's
   reference, `given` for another buy than this number's. The same buy again gets the same ticket.
   The gift never holds back the stamp.
5. The app collects the buy with the ticket and finishes its credits: the main way, into its wallet,
   the Profiles folder's balance.

## Its API

| Route | Body | Answer |
|---|---|---|
| `GET /` | | `200`, [its keys](#its-keys) |
| `POST /face/session`, `POST /id/session` | none, `{}`, or `{"returnUrl": "<url>"}`, a page on an origin in `APP_ORIGINS` where Didit sends the person after | `201 {"sessionId", "url"}` |
| `POST /face/stamp` | `{"sessionId": "<uuid>", "stampNumber": "<decimal>"}`, and may add `"gift"` | `200 {"stamp"}`, with `"gift"` if asked; `202 {"waiting": "review"}` |
| `POST /id/stamp` | The same, and may add `"gift"` | `200 {"stamp"}`, with `"gift"` if asked; `202 {"waiting": "review"}` |
| `POST /stamp` | `{"stampNumber": "<decimal>"}` | `200 {"face", "id"}`, each a stamp or `null`; `404 not_found` if neither |

A stamp number is decimal text, as the standard's `stampNumberOf` gives it: no sign, no leading zero,
below BN254's scalar order. A body with any other field is refused. CORS is open to any origin.
Errors are `{"error": "<code>"}`:

- **`400`:** `not_json`, `not_an_object`, `expected_empty_body`, `expected_exactly_returnUrl`,
  `expected_exactly_sessionId_and_stampNumber`, `expected_exactly_stampNumber`, `bad_session_id`,
  `bad_stamp_number`, `bad_return_url`.
- **`403`, the check does not count:** `unknown_session`, `wrong_workflow`, `not_approved`,
  `no_liveness`, `liveness_not_passed`, `no_document`, `document_not_passed`, `no_face_match`,
  `face_match_not_passed`, `no_face`, `no_document_data` (no name, or no real birth date),
  `duplicate_document`.
- **Others:** `404 not_found` (no route, or no stamp); `409 session_used` (given to another stamp
  number, or its hour is over); `405 post_only`, `405 get_only`; `413 too_large` (over 4 KB);
  `502 face_check_unavailable`; `500 internal`.

## How we run it

### Settings

| Variable | Default | What | Ours |
|---|---|---|---|
| `VERIFIER_NAME` | `verifier.forest.foundation` | Its name, which never changes | the default |
| `DIDIT_API_KEY` | required | From the Didit application that owns both workflows. A secret | the foundation's |
| `DIDIT_FACE_WORKFLOW_ID` | required | The face check's workflow; a session on another is refused | "Forest face", `2faaca36-58b4-49d7-90d7-2b9cf002d173` |
| `DIDIT_ID_WORKFLOW_ID` | required | The ID check's workflow; the same | "Forest ID", `bfbdb912-d2f5-41d8-827c-4304e8209d24` |
| `DIDIT_BASE_URL` | `https://verification.didit.me` | For a stand-in Didit | the default |
| `FACE_MODEL` | `sface` | Or `stand-in`, with `DIDIT_BASE_URL` on loopback | `sface` |
| `APP_ORIGINS` | none: no `returnUrl` | Where Didit may send a person back, by origin, comma-separated | the Forest app, https://app.forest.foundation |
| `HOST_URL` | none: no gift | The host whose credits the gifts pay for, `https://<host>` | https://host.forest.foundation |
| `FACE_CREDITS`, `ID_CREDITS` | `10`, `100` | How many with a face stamp, and an ID stamp; 0 for none | the defaults, a cent of writes each |
| `DATABASE_PATH` | `./data/verifier.sqlite` | The one file; the seed file is made beside it | on its volume, in a directory of its own |
| `PORT` | `8080` | | |

It refuses to start without a required variable, so never without Didit: every stamp it signs counts
with every reader that trusts its keys, and a stand-in that passed everyone would sign for anyone. It
also refuses a seed file that is not a seed (quoting none of it), `FACE_MODEL=stand-in` with a Didit
off this machine, and a host or app that is not an origin.

### Didit

- **The foundation pays per check:** about $0.15 a face check, up to $0.30 an ID check on Didit's
  list. The cost is capped at Didit by a prepaid balance with no auto-refill, so there is no session
  limit here. A price for the ID check, and how it is paid, is this verifier's to set later.
- **"Forest face":** one passive liveness step, face search on. A face seen before, even with another
  name or document, goes to review. A screen, a virtual camera, an injected frame, an outside camera
  or more than one face is declined.
- **"Forest ID":** a document by camera scan, then liveness, then the face matched to the document's
  photo. Didit takes no action on anything seen before, so the fingerprint alone decides.
- **Reviews:** a person at the foundation approves or declines each in Didit's console.
- **Retention:** the application's own window is unlimited, so a session that gave no stamp stays in
  Didit until someone deletes it in the console.

**The consent screen.** Before the ID check the app shows this, word for word:

> Forest, run by the Open Forest Foundation, checks your face and a government ID with Didit, its
> provider, to make sure each person is checked once. Didit keeps photos of your ID and what it
> reads on it (your name, date of birth and document number), your selfie and a short video while
> it checks. An hour after your stamp is signed, Forest deletes them at Didit, which keeps only a
> template of your face, for up to ten years, so it can tell if the same face comes back. Forest
> keeps none of this: only a one-way fingerprint of your name and date of birth next to your stamp
> number, so the same person is not checked twice, and the stamp it signed you, a one-way hash of
> what the check saw, so it can hand it back if you lose it. It gives you a stamp, with your name,
> date of birth and country beside it for your own records; a profile that shows it says only that
> you were checked.

**Data law:** the Open Forest Foundation is the responsible party for both checks, so three things
sit outside this code: a processing agreement with Didit, the consent screen above, and Didit's
retention setting. Paperwork and settings; nothing here does them.

### Public, secret, kept

- **Public:** this code, these settings, its name and its two keys.
- **Secret:** its seed and `DIDIT_API_KEY`.
- **Kept, not published:** [What it keeps](#what-it-keeps), the stamp numbers given a gift among it.
- **Logged:** its port, that it made a seed, an error's kind, and at a sweep how many deletions Didit
  did not answer and what Didit did with a face it kept no template of. Never a session.

### The image and the commands

One replica, never more, since the sessions and fingerprints are one SQLite file; a volume for
`DATABASE_PATH` and the seed, or a deploy loses who was signed for which stamp number, and the seed.
Ours runs on Railway; any platform with Node 22.18 and a persistent disk will do. `deploy/Dockerfile`,
built from the repo root: Node 22.22.2 and git, `standard.sh`, `npm ci`, `npm run fetch -- models`,
then `npm start`.

```
./standard.sh                     # from the repo root: the standard, at its pin
(cd host && npm ci)               # the host's credits client and seller, for the gifts' tests
cd verifier && npm ci             # the standard's packages, linked by name from ../standard/
npm run fetch                     # the face models and the three test portraits, checked by SHA-256
npm run check && npm test
npm start                         # with the settings above
```

It uses `@foundationforest/keys`, `/proofs` and `/folders` through `file:` links; moving `STANDARD`
can change their dependencies, so `npm install` here writes the lockfile again. By hand, its seed and
file go in `data/`, which `.gitignore` covers. Against Didit's sandbox (an application that mocks
every provider and never bills), after `npm run fetch -- models`:

```
DIDIT_SANDBOX_API_KEY=<the sandbox application's key> npm run sandbox             # every session approved
DIDIT_SANDBOX_API_KEY=<the sandbox application's key> npm run sandbox -- review_x  # or Didit's review_…, decline_… scenarios
```

It runs both checks on the sandbox's two workflows, never reads `DIDIT_API_KEY`, refuses when the two
are the same, and keeps its own seed and file in `data/sandbox/`.

`test/` covers, against a stand-in Didit, a real SQLite file and real HTTP: both checks and review,
verifications made from the stamps and checked against the published keys, the facts vectors, stamps
asked back, the seed, the sweep, the raw file, the face models on three portraits, both gifts'
tickets taken by the host's own seller, and the fetch's retries.

## Promises

- **It keeps which check session gave which stamp number, and the stamp it signed, and nothing else
  of a check.** No face, no embedding, no name, no birth date, no document, and no time or session id
  in clear once a session is deleted in Didit; deleted bytes are overwritten. A test reads the raw
  file for names, birth dates, embeddings, references and session ids.
- **It never logs a request, an address, a session, a stamp number or a stamp, and never writes down
  an address.** It logs an error's kind, never its message.
- **It takes no key of the person's, has no sign-ups, and nothing it keeps ties a person to a
  profile.** An app sends a session and a stamp number, as a POST body, never in a URL, since hosting
  platforms log paths. No request names a profile: the verification is made on the person's device.
- **It never signs for anyone, and a key's recipe never changes.** The face and ID keys sign stamps,
  the sponsor key tickets, nothing else; a new recipe is a new key.
- **It deletes every session in Didit an hour after its stamp is first signed, or at the first sweep
  after that which Didit answers, and no other.** Never one In Review. Each deletion asks Didit to
  keep only a template of the face.

## Limits

- **Two people with one name and birthday:** the second is refused the ID check, with no review.
- **One person whose documents spell the name differently** can hold two ID stamps.
- **One person per verifier rests on Didit's face search;** a face approved from review is signed for
  whatever stamp number the person brings.
- **A face template ends** after 3650 days at most; then a returning face is new to Didit.
- **The checks share one face search,** so taking the ID check first sends the face check to review.
- **After the hour, a lost answer loses the fields beside the stamp;** the stamp comes back.
- **Stamps signed before this code kept them do not come back:** `not_found`, and the person checks
  again.
- **For that hour, `to_delete` names the session:** whoever reads the file can ask Didit about it.
- **A deletion Didit does not answer** leaves the session there, images and all, till a later sweep.
- **It trusts Didit's decision,** and relies on the workflow settings above, which it cannot see.
- **The answer that signs a stamp says who the person is:** keep it as a key is kept.
- **A country with no ISO numeric code enters as 0,** like one Didit did not read.
- **A lost gift is lost:** another buy gets `given`.
- **Losing the volume** means a new seed and keys, with no signed handover, and lets a person get a
  second stamp number's ID stamp. The name, and so the stamp numbers, stay.
- **SFace's training data** (CASIA-WebFace, VGGFace2, MS-Celeb-1M) has research-only terms; no widely
  used face model's data is cleaner.
- **The face test is three NASA portraits,** two of one person: it shows the model tells them apart,
  not how often it errs.
- **Railway's own request logs** hold each request's client address and path.

## FAQ

**Can you tell which profile is mine?**
No. We hold your stamp number, made from your seed and our name; your profiles' keys are made from
your seed and their labels. Only your seed connects the two, and it never leaves your device. A
verification shows that we signed a stamp to the seed behind it, never which stamp number.

**Could someone rebuild this verifier from public data?**
Its name, keys and code are public. Which session and person went with which stamp number is not, so
a new verifier starts its own, and its people come through their own checks.
