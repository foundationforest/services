# verifier

The verifier checks that you are one real person, by your face or your ID, and signs a stamp to your
seed (the secret on your device that all your keys come from). Your profiles then prove they're
verified without saying who you are, or which of your other profiles they go with. The Forest
Foundation runs this copy, at https://verifier.forest.foundation. Anyone can sign stamps; the main
way is a verifier like this one, and each reader decides which verifiers count. It keeps your stamp
number, which check gave it and the stamp; for the ID check, a keyed hash of your name and birthday;
and of the ID check's payment, a hash, never beside your stamp. Your face, and from the ID check
your name, birthday and country, stay with Didit, its check provider, and how you paid with Stripe.
The face check is free; the ID check is paid. No key of yours, no account.

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

| Step | Face check, free | ID check, paid |
|---|---|---|
| Pay | | `POST /id/payment`, and the person pays on Stripe's page ([The ID check's payment](#the-id-checks-payment)) |
| Open | `POST /face/session` opens a session on the face workflow and answers the page the person uses | `POST /id/session` with the payment, on the ID workflow |
| The person | Didit checks for a live person and compares the face with every face it has seen | Didit also reads a government document and matches the live face to its photo |
| Ask | The app sends the session and its stamp number to `POST /face/stamp` | `POST /id/stamp`, with the payment |
| Approved | The verifier fetches the selfie, computes its embedding ([The face model](#the-face-model)), keeps the session next to the stamp number, and answers a stamp from the face key | Every document, liveness and face-match step passed too; then the fingerprint, and the stamp number's ID stamp |

- **In Review** means Didit has seen the face before: the verifier answers `202 {"waiting":"review"}`,
  keeps nothing, and the app asks again later. A person at the foundation decides in Didit's
  console, so a second stamp number for one face is a person's call, not this code's.
- **Declined** answers `403 declined`, and **Expired** or **Abandoned** (the person did not finish
  in time) `403 expired`: the session will never pass, so the app opens a new one.
- **Anything else unfinished** answers `403 not_approved`, and the app asks again once the person is
  done. A refused or failed request uses nothing up.
- **The fingerprint** is HMAC-SHA256 (a keyed hash), under the fingerprint key, of the standard's
  canonical JSON of `{birth, name}`: the name Didit reads, first and last, else the full name, in
  Unicode NFKC, lower case, one space between words; the birth date as `YYYY-MM-DD`. Kept next to
  another stamp number: refused, `duplicate_document`. Next to the same one: its first ID stamp,
  given back ([The stamp](#the-stamp)). The country is left out, since a renewed or another
  country's document is the same person. Without the key, a guessed name and birthday cannot be
  tested against the file.
- **`vendor_data`** on each session is a fresh random id after a prefix naming only the check, so it
  names nobody; Didit's face search compares a face with those under other `vendor_data`.

### The ID check's payment

The ID check is paid before its session opens, on a Stripe Checkout page the verifier makes. One
payment gives one ID stamp, and up to three sessions to get it.

1. The app sends `POST /id/payment` with a `returnUrl` on an origin in `APP_ORIGINS`, and gets the
   payment's id (its Checkout Session's, `cs_…`) and Stripe's page. It keeps the id: Stripe sends
   the person back to `returnUrl` as it is, paid or not, with no id in its address.
2. The person pays on Stripe's page.
3. The app sends `POST /id/session` with the payment. The first time, the verifier asks Stripe
   whether that Checkout Session was paid and is one it made (its mark, `metadata.check`); if not,
   `402 not_paid`, and the app asks again whenever it likes. Each session opened takes one of the
   payment's three tries, and one Didit does not open gives its try back; after three,
   `409 payment_used`.
4. The app sends the payment again with `POST /id/stamp`. The first stamp it gives, a new one or the
   first ID stamp given back, uses it up: no more sessions and no more stamps from it
   (`409 payment_used`). A refused stamp uses nothing, and a session sent again within its hour uses
   no payment.

No webhook: the verifier asks Stripe when the app comes back, so nothing waits on Stripe's redirect.
The payment sent with a stamp need not be the one that opened its session: each payment opens at
most three sessions and gives at most one stamp, which is all the rule needs, so the verifier keeps
nothing that ties a payment to a session or a stamp number (Stripe's and Railway's own records
could, as [Limits](#limits) says). Without `STRIPE_SECRET_KEY`, all three routes answer
`503 not_for_sale`.

### The stamp

The verifier signs `{stampNumber, facts, verifierName}` with the standard's `signStamp`, and answers
it in the standard's JSON form, with what its facts were made from beside it:

```
face:  {"stampNumber":"<decimal>","facts":"<decimal>","verifier":"<face key>","verifierName":"<its name>",
        "signature":{"r8":["<decimal>","<decimal>"],"s":"<decimal>"},"model":"opencv-sface-2021dec","embedding":"<base64url>"}
ID:    the same, from the ID key, and "fields":"{\"date_of_birth\":\"1815-12-10\",\"first_name\":\"Ada\",…}"
```

| Key | Its facts, fixed for good: a new recipe is a new key |
|---|---|
| face key | `Poseidon([h(model), h(embedding)])` |
| ID key | `Poseidon([h(model), h(embedding), fieldsRoot])` |

- **Poseidon:** a hash made for zero-knowledge proofs, circomlib's, through `poseidon-lite` 0.3.0, as
  the standard's keys use it. **`h(x)`:** SHA-256 of x's bytes, as a big-endian integer, mod BN254's
  scalar order (the size of the numbers the proofs work in).
- **`model`:** the face model's name, UTF-8. A face's numbers mean nothing without the program that
  made them; with the name, anyone can run the same model. **`embedding`:** the 512 bytes the model
  gives for the selfie.
- **`fields`:** every text field Didit read on the document, by Didit's names, as it read them, in
  one string of canonical JSON (RFC 8785): `document_type`, `document_subtype`, `document_number`,
  `personal_number`, `first_name`, `last_name`, `full_name`, `date_of_birth`, `date_of_issue`,
  `expiration_date`, `issuing_state`, `nationality`, `place_of_birth`, `address`, `gender`,
  `marital_status`, `region`, and each of `extra_fields`, a document's own (a profession, a driving
  licence's classes), as `extra_fields.<its key>`. A field Didit did not read is absent. Never an
  image or a video, the step's status, what Didit works out itself (`age`, `issuing_state_name`,
  `formatted_address`, `parsed_address`), or the same text again in machine form (`mrz`,
  `barcodes`).
- **`fieldsRoot`:** the root of a Poseidon Merkle tree of depth 8, 256 leaves: one leaf
  `Poseidon([h(name), h(value)])` for each field, in the order of their names, as `fields` lists
  them, then leaves of 0; each node `Poseidon([left, right])`. Every path has 8 steps, so one field
  can be proved against the root without the others; nothing here makes such a proof.

The fields beside a stamp are the person's: anyone they show them to can make the facts again.
Nothing in the standard reads them, and the verification keeps the facts private. Facts are exact;
a face comparison is fuzzy. Two photos of one face never give the same numbers, so a later check
would not work the facts out from a new photo: you would show the kept embedding, anyone could see it
gives the facts, and compare it with your live face using the same model. So a face that changes
with light and age leaves its stamp good. Nothing here runs such a check yet.

**Asked back:** `POST /stamp` with a stamp number answers, for each key, the first stamp it signed
for that number, its own fields only, or `null`. A later face check answers its own new stamp, but
the first stays the one handed back, so nobody else who knows the number can change it; either gives
the same verification. A later ID check answers the first ID stamp, its own fields only: one ID
stamp a person, ever. At each start the verifier forgets any kept ID stamp its ID key did not sign,
so that stamp number's next ID check keeps a new one. Handing a stamp back is safe: a verification
needs the seed behind the number. The fields beside a stamp come only in the answer that signed it,
and again from that session within its hour.

### Its keys

`GET /` gives its name, its two keys as addresses each with its facts recipe, `h`, `fieldsRoot`, and
`consent`, the text an app shows before the ID check ([The consent screen](#didit)), in canonical
JSON (one exact way of writing it); with gifts, also
`"gift":{"face":<n>,"host":"<origin>","id":<n>,"sponsor":"<address>"}`.

- **The name** never changes: everyone's stamp number here is derived from it
  ([keys](https://github.com/foundationforest/standard/blob/main/keys/README.md#the-recipe)).
- **Two keys, one per check,** so a reader can trust or weigh them apart.
- **One secret,** 32 random bytes made on its own machine at the first start that finds none (the
  standard's `newSeed`), kept in `verifier-seed.json` beside its database, readable by its own user
  only, so the two are kept or lost together. No person, phrase or variable holds it; nothing prints
  or logs it.
- **Derived from its own secret** with the standard's `hkdf` (a standard way to make many keys from
  one secret): under `face`, the face key; `id-fields`, the ID key, a text of its own for its recipe;
  `fingerprint`, the fingerprint key; `sponsor`, the sponsor key, an Ed25519 key that signs the
  gifts' tickets. The texts never change, since a new text would derive a new key. None of the keys
  holds money.

### Once a stamp is signed

- **Within the hour** since its first signing, the same session and stamp number give the same
  stamp, as Didit still has its decision and selfie. After it: `session_used`, with no question to
  Didit; a retry gives no more time.
- **Every minute,** the sweep deletes in Didit each session first signed an hour ago or more
  (`DELETE /v3/session/{id}/delete/`), and forgets its id and time once Didit has. One Didit does not
  answer is tried at the next sweep. Never a session In Review, declined or unfinished.
- **What goes:** the selfie, the liveness video, the document's images, the rest of what Didit read
  on it (document number, nationality, dates), and its decision.
- **What stays:** each deletion asks Didit to keep one template of the face
  (`retain_face_embeddings`), whatever the application's setting: numbers, no image, no name, used
  only for this application's face search, so a face that comes back still goes to review. Didit
  ends every kept template; the verifier asks for 3650 days, the longest it allows. Didit's list of
  users also still shows, for a deleted ID session, the full name, birth date and country, so it can
  tell when someone comes back; a template matches only while its user is there.

### What it keeps

One SQLite file (a database in a single file), seven tables:

| Table | What | Why |
|---|---|---|
| `sessions` | The SHA-256 of each session id that gave a stamp, with the stamp number and which check (`face` or `id`) | A session gives its stamp to one stamp number, and again only within its hour |
| `stamps` | The first stamp each key signed for each stamp number: the number, the key, the facts, the signature | A lost stamp comes back |
| `to_delete` | The id of each session not yet deleted in Didit, its check, and when it was first signed | The hour, and the sweep. It goes once Didit has deleted it |
| `fingerprints` | Each fingerprint the ID check signed for, with the stamp number | One name and birth date, one stamp number's ID stamp |
| `gifts`, `id_gifts` | Each stamp number given its face stamp's gift, or its ID stamp's, with a hash of the buy | One gift a person from each check; the same buy gets the same ticket |
| `payments` | The SHA-256 of each payment that opened an ID session, how many sessions it opened, and whether it gave a stamp | One payment, three sessions at most and one ID stamp |

Nothing else: no face, no embedding, no name, no birth date, no document, no address, none of the
fields beside a stamp, and of a payment nothing of who paid or with what, no amount, no time, and
nothing beside a session or a stamp number. Facts are a one-way hash: without the exact embedding,
which no new photo gives again, no guess can be tested against them. A session id is in clear, with
a time, only in `to_delete`, for the hour or so until Didit has deleted it. Deleted bytes are
overwritten (`secure_delete`). The stamp number links the tables, so whoever also holds what Didit
keeps of those sessions can tell which face went with which name.

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
  and the end-to-end test), gives every photo one fixed embedding, under the model `stand-in`.

### The gifts

With `HOST_URL`, a stamp asked with a gift comes with the host's credits (prepaid units of its
writes, [host](../host/README.md#credits)), once per stamp number from each check: `FACE_CREDITS`
with a face stamp, `ID_CREDITS` with an ID stamp. The host signs them blind, so the verifier never
sees them, and pays nothing: the host lists its sponsor key and counts what its tickets paid for.

1. The app reads the gift in `GET /`, makes one buy at the host for exactly the check's credits
   (`buy`, in `host/client/`), and keeps what finishes it.
2. It sends `"gift": "<the buy's reference>"` with `POST /face/stamp` or `POST /id/stamp`.
3. Once per stamp number, the verifier keeps a hash of the buy and signs a ticket with its sponsor
   key (`ticketMessage`, `src/ticket.ts`): that host, that buy, that many credits.
4. The answer adds `"gift": {"ticket": …}`, or `{"error": …}`: `bad_gift` for anything but a buy's
   reference, `given` for another buy than this number's. The same buy again gets the same ticket.
   The gift never holds back the stamp.
5. The app collects the buy with the ticket and finishes its credits: the main way, into its wallet,
   the Profiles folder's balance.

## Its API

| Route | Body | Answer |
|---|---|---|
| `GET /` | | `200`, [its keys](#its-keys) |
| `POST /face/session` | none, `{}`, or `{"returnUrl": "<url>"}`, a page on an origin in `APP_ORIGINS` where Didit sends the person after | `201 {"sessionId", "url"}` |
| `POST /face/stamp` | `{"sessionId": "<uuid>", "stampNumber": "<decimal>"}`, and may add `"gift"` | `200 {"stamp"}`, with `"gift"` if asked; `202 {"waiting": "review"}` |
| `POST /id/payment` | `{"returnUrl": "<url>"}`, a page on an origin in `APP_ORIGINS` where Stripe sends the person after, paid or not | `201 {"payment", "url"}` |
| `POST /id/session` | `{"payment": "<its id>"}`, and may add `"returnUrl"`, as for a face session | `201 {"sessionId", "url"}` |
| `POST /id/stamp` | `{"sessionId", "stampNumber", "payment"}`, and may add `"gift"` | `200 {"stamp"}`, with `"gift"` if asked; `202 {"waiting": "review"}` |
| `POST /stamp` | `{"stampNumber": "<decimal>"}` | `200 {"face", "id"}`, each a stamp or `null`; `404 not_found` if neither |

A stamp number is decimal text, as the standard's `stampNumberOf` gives it: no sign, no leading zero,
below BN254's scalar order. A payment's id is its Checkout Session's, `cs_test_…` or `cs_live_…`. A
body with any other field is refused. CORS is open to any origin. Every code below is in
`src/codes.ts`, which an app can import. Errors are `{"error": "<code>"}`:

- **`400`:** `not_json`, `not_an_object`, `expected_empty_body`, `expected_exactly_returnUrl`,
  `expected_exactly_payment`, `expected_exactly_payment_and_returnUrl`,
  `expected_exactly_sessionId_and_stampNumber`,
  `expected_exactly_sessionId_and_stampNumber_and_payment`, `expected_exactly_stampNumber`,
  `bad_session_id`, `bad_stamp_number`, `bad_return_url`, `bad_payment`.
- **`402`:** `not_paid` (not paid, or no payment Stripe has).
- **`403`, the check does not count:** `unknown_session`, `wrong_workflow`, `declined`, `expired`,
  `not_approved`, `no_liveness`, `liveness_not_passed`, `no_document`, `document_not_passed`,
  `no_face_match`, `face_match_not_passed`, `no_face`, `no_document_data` (no name, or no real birth
  date), `duplicate_document`.
- **`409`:** `session_used` (given to another stamp number, or its hour is over), `payment_used`
  (it gave its stamp, or opened its three sessions).
- **Others:** `404 not_found` (no route, or no stamp); `405 post_only`, `405 get_only`;
  `413 too_large` (over 4 KB); `502 face_check_unavailable`, `502 payment_unavailable` (Stripe);
  `503 not_for_sale` (no Stripe); `500 internal`.

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
| `APP_ORIGINS` | none: no `returnUrl` | Where Didit and Stripe may send a person back, by origin, comma-separated | the Forest app, https://app.forest.foundation |
| `STRIPE_SECRET_KEY` | none: the ID check is not for sale | Stripe's secret key, `sk_…`, or a restricted one, `rk_…`. A secret | a test-mode key, for "Forest" at Stripe, added by hand in Railway |
| `STRIPE_ID_PRICE` | required with the key | The Stripe Price the ID check sells, `price_…` | "Forest ID check", $5, `price_1UXRbDILoxkbMfX4cfwRfCOI` |
| `HOST_URL` | none: no gift | The host whose credits the gifts pay for, `https://<host>` | https://host.forest.foundation |
| `FACE_CREDITS`, `ID_CREDITS` | `10`, `100` | How many with a face stamp, and an ID stamp; 0 for none | the defaults, a cent of writes each |
| `DATABASE_PATH` | `./data/verifier.sqlite` | The one file; its secret's file, `verifier-seed.json`, is made beside it | on its volume, in a directory of its own |
| `PORT` | `8080` | | |

**Another app** uses both checks as the Forest app does. The ID check needs a page on an origin in
`APP_ORIGINS` to send the person back to, and so does a face check that sends them back: to add one,
ask at support@forest.foundation, or open a pull request adding it to `APP_ORIGINS`'s Ours, above;
the foundation sets it in Railway.

It refuses to start without a required variable, so never without Didit: every stamp it signs counts
with every reader that trusts its keys, and a stand-in that passed everyone would sign for anyone. It
also refuses a `verifier-seed.json` that does not hold a secret (quoting none of it),
`FACE_MODEL=stand-in` with a Didit off this machine, a host or app that is not an origin, and a
Stripe key or Price that is not one (quoting no key), or a key without a Price.

### Didit

- **The foundation pays per check:** about $0.15 a face check, up to $0.30 an ID check on Didit's
  list. The cost is capped at Didit by a prepaid balance with no auto-refill, so there is no session
  limit here. The ID check's price is in [Stripe](#stripe).
- **"Forest face":** one passive liveness step, face search on. A face seen before, even with another
  name or document, goes to review. A screen, a virtual camera, an injected frame, an outside camera
  or more than one face is declined.
- **"Forest ID":** a document by camera scan, then liveness, then the face matched to the document's
  photo. Didit takes no action on anything seen before, so the fingerprint alone decides.
- **Reviews:** a person at the foundation approves or declines each in Didit's console.
- **Retention:** the application's own window is unlimited, so a session that gave no stamp stays in
  Didit until someone deletes it in the console.

**The consent screen.** `GET /` serves it as `consent`, and an app shows what it gets, before the ID
check:

> The check costs $5, paid to the Open Forest Foundation through Stripe, and covers up to three
> tries. Stripe keeps your payment details and email; Forest keeps of the payment only a one-way
> hash and how it was used, never beside your stamp. Forest, run by the Open Forest Foundation,
> checks your face and a government ID with Didit, its provider, to make sure each person is checked
> once. Didit keeps photos of your ID and what it reads on it (your name, date of birth and document
> number), your selfie and a short video while it checks. An hour after your stamp is signed, Forest
> deletes them at Didit, which still keeps your full name, date of birth and country, and a template
> of your face for up to ten years, so it can tell if you come back. Forest keeps none of this: only
> a one-way fingerprint of your name and date of birth next to your stamp number, so the same person
> is not checked twice, and the stamp it signed you, a one-way hash of what the check saw, so it can
> hand it back if you lose it. It gives you a stamp, with every text field read from your ID beside
> it (your name, date of birth, document number and the rest), for you to keep; a profile that shows
> it says only that you were checked.

**Data law:** the Open Forest Foundation is the responsible party for both checks, so two things sit
outside this code: a processing agreement with Didit, and Didit's retention setting. Paperwork and a
setting; nothing here does them. The consent screen above is this code's, and an app shows it.

### Stripe

- **The price:** $5 an ID check, the Price in `STRIPE_ID_PRICE`, in US dollars, paid at Stripe to
  the business the key belongs to. Stripe takes its fee from it.
- **Three tries a payment:** a real person's ID check fails mostly to glare, blur or a moved face,
  which a second or third try fixes. Three keep Didit's share, up to $0.30 a session, under a fifth
  of the price after Stripe's fee; more would mostly help someone trying fake documents on Didit.
- **How a person pays:** as the key's payment settings at Stripe allow; the verifier names no method.
- **Its API version:** every request sends `Stripe-Version: 2026-10-28.endive`, the version its code
  and its stand-in follow, so a new default version at Stripe changes nothing here.
- **What Stripe sees:** what the person pays with, their email, the name, country and, for some
  countries, postal code it asks for, their device's network address, and the app's page they come
  back to. The verifier tells it only the Price and its mark, `check: id`: never a stamp number, a
  Didit session or anything from the ID. It reads back only whether the payment was paid, and the
  mark.
- **A test-mode key** takes only Stripe's test cards, which anyone can look up, so it charges
  nobody, and a payment made under it is unknown to a live key: `not_paid` there.
- **Paid and still waiting?** Write to support@forest.foundation.
- **A live key** is a restricted one with only Checkout Sessions: Write, all the verifier uses, for
  a business at Stripe that is the foundation's, with a live Price in `STRIPE_ID_PRICE`.

### Public, secret, kept

- **Public:** this code, these settings, its name and its two keys.
- **Secret:** the secret its keys are derived from, `DIDIT_API_KEY` and `STRIPE_SECRET_KEY`.
- **Kept, not published:** [What it keeps](#what-it-keeps), the stamp numbers given a gift among it.
- **Logged:** its port, that it made its secret, an error's kind, what Didit did with a face it kept
  no template of, and why Stripe or Didit failed: at each 502, and at a sweep beside how many
  deletions Didit did not answer, the error's kind and, when one answered, its HTTP status and codes
  (Stripe's error `type`, `code` and `param`; Didit's `code`), each only if it is lower case,
  digits, `_`, `.` and brackets, at most 64 characters, and not shaped like a Stripe key or a
  Checkout Session's id. Never what either said in words, a key, a session or a payment.

### The image and the commands

One replica, never more, since the sessions and fingerprints are one SQLite file; a volume for
`DATABASE_PATH` and its secret, or a deploy loses who was signed for which stamp number, and the
secret. Ours runs on Railway; any platform with Node 22.18 and a persistent disk will do.
`deploy/Dockerfile`, built from the repo root: Node 22.22.2 and git, `standard.sh`, `npm ci`,
`npm run fetch -- models`, then `npm start`.

```
./standard.sh                     # from the repo root: the standard, at its pin
(cd host && npm ci)               # the host's credits client and seller, for the gifts' tests
cd verifier && npm ci             # the standard's packages, linked by name from ../standard/
npm run fetch                     # the face models and the three test portraits, checked by SHA-256
npm run check && npm test
npm start                         # with the settings above
```

It uses `@foundationforest/keys`, `/proofs` and `/folders` through `file:` links; moving `STANDARD`
can change their dependencies, so `npm install` here writes the lockfile again. By hand, its secret
and file go in `data/`, which `.gitignore` covers. Against Didit's sandbox (an application that
mocks every provider and never bills), after `npm run fetch -- models`:

```
DIDIT_SANDBOX_API_KEY=<the sandbox application's key> npm run sandbox             # every session approved
DIDIT_SANDBOX_API_KEY=<the sandbox application's key> npm run sandbox -- review_x  # or Didit's review_…, decline_… scenarios
```

It runs both checks on the sandbox's two workflows, never reads `DIDIT_API_KEY`, refuses when the
two are the same, and keeps its own secret and file in `data/sandbox/`. With `STRIPE_SECRET_KEY`,
`STRIPE_ID_PRICE` and `APP_ORIGINS` set, the ID check is paid in Stripe's test mode, with a test
card; it refuses a live key.

`test/` covers, against a stand-in Didit and a stand-in Stripe, a real SQLite file and real HTTP:
both checks and review, the ID check's payment and its tries, verifications made from the stamps and
checked against the published keys, the facts vectors and the fields tree leaf by leaf, what is read
of Didit's ID report, stamps asked back and given back, the secret, the sweep, the raw file, the
face models on three portraits, both gifts' tickets taken by the host's own seller, the Stripe
client's requests, what a failure at Stripe or Didit logs, the fetch's retries, and this README's
consent screen and codes, as the code has them.

## Promises

- **It keeps which check session gave which stamp number, the stamp it signed, and for the ID check
  the fingerprint, kept with the stamp number, and nothing else of a check; of a payment, only a
  hash, how many sessions it opened and whether it gave a stamp, never beside a session or a stamp
  number.** No face, no embedding, no name, no birth date, no document, and no time or session id in
  clear once a session is deleted in Didit; deleted bytes are overwritten. A test reads the raw file
  for names, birth dates, embeddings, references, payment ids and session ids.
- **It never logs a request, an address, a session, a stamp number or a stamp, and never writes down
  an address.** It logs an error's kind, never its message.
- **It takes no key of the person's, has no sign-ups, and nothing it keeps ties a person to a
  profile.** An app sends a session and a stamp number, as a POST body, never in a URL, since hosting
  platforms log paths. No request names a profile: the verification is made on the person's device.
- **It signs a stamp only for a check Didit approved, on that check's workflow, and a key's recipe
  never changes.** It will not start without Didit; the face and ID keys sign stamps, the sponsor
  key tickets, nothing else; a new recipe is a new key.
- **It deletes every session in Didit an hour after its stamp is first signed, or at the first sweep
  after that which Didit answers, and no other.** Never one In Review. Each deletion asks Didit to
  keep only a template of the face.

## Limits

- **Two people with one name and birthday:** the second pays, and is refused the ID check, with no
  review.
- **One person whose documents spell the name differently** can hold two ID stamps.
- **One person per check: the face check rests on Didit's face search, the ID check on the
  document's fingerprint;** a face approved from review is signed for whatever stamp number the
  person brings.
- **A person can hold a face stamp on one seed and an ID stamp on another,** since the ID check finds
  repeats by the document alone. Time solves it: an index trusts a profile more the more verifiers
  stand behind its seed.
- **A face template ends** after 3650 days at most; then a returning face is new to Didit.
- **The checks share one face search,** so taking the ID check first sends the face check to review.
- **After the hour, a lost answer loses the fields beside the stamp for good:** the stamp comes back,
  from `POST /stamp` or a new ID check, without them.
- **A stamp describes the document as it was on the day of the check:** with one ID stamp a person,
  a renewed document never gives a new one.
- **Stamps signed before this code kept them do not come back:** `not_found`, and the person checks
  again.
- **For that hour, `to_delete` names the session:** whoever reads the file can ask Didit about it.
- **A deletion Didit does not answer** leaves the session there, images and all, till a later sweep.
- **It trusts Didit's decision,** and relies on the workflow settings above, which it cannot see.
- **The answer that signs a stamp says who the person is:** keep it as a key is kept.
- **A lost gift is lost:** another buy gets `given`.
- **Losing the volume** means a new secret and keys, with no signed handover, and lets a person get
  a second stamp number's ID stamp. The name, and so the stamp numbers, stay.
- **SFace's training data** (CASIA-WebFace, VGGFace2, MS-Celeb-1M) has research-only terms; no widely
  used face model's data is cleaner.
- **The face test is three NASA portraits,** two of one person: it shows the model tells them apart,
  not how often it errs.
- **Railway's own request logs** hold each request's client address and path.
- **What Stripe keeps and Railway's logs** both hold a person's network address and a time, so
  together they can tie a payment to the request that used it.
- **A refund in Stripe** leaves its payment open: the verifier asks only whether it was paid.

## FAQ

**Can you tell which profile is mine?**
No. We hold your stamp number, made from your seed and our name; your profiles' keys are made from
your seed and their labels. Only your seed connects the two, and it never leaves your device. A
verification shows that we signed a stamp to the seed behind it, never which stamp number.

**Why are an ID stamp's fields one string, not an object?**
A stamp's own keys are lower-case words, so it fits inside an entry, and Didit's names, such as
`date_of_birth`, are not. One string keeps Didit's names and the exact text each leaf was made from.

**Could someone rebuild this verifier from public data?**
Its name, keys and code are public. Which session and person went with which stamp number is not, so
a new verifier starts its own, and its people come through their own checks.
