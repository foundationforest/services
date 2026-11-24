# verifier

The verifier checks that you are one real person, by your face or your ID, and signs a stamp to your
seed (the secret on your device that all your keys come from). Your profiles then prove they're
verified without saying who you are, or which of your other profiles they go with. The Forest
Foundation runs this copy, at https://verifier.forest.foundation. Anyone can sign stamps; the main
way is a verifier like this one, and each reader decides which verifiers count. It keeps your stamp
number, which check gave it, the stamps and how many free face tries it used, and nothing about who
you are; of the ID check's payment, a hash, never beside your stamp. Your face, and from the ID
check your name, birthday and country, stay with Didit, its check provider, which remembers them so
it can tell if you come back; how you paid stays with Stripe. The face check is free, for two failed
tries; the ID check, which gives a face stamp too, holds $5 for your first ID and $2 for each you
add, taken only if it gives you a new stamp. No key of yours, no account.

## How it works

| Word | What it is |
|---|---|
| stamp | One signature over the verifier's name, your stamp number and its facts ([the standard's](https://github.com/foundationforest/standard/blob/main/proofs/README.md#the-stamp-and-the-verification)) |
| stamp number | A number your device makes from your seed and the verifier's name, the same every time |
| facts | One number made from the list of what the check saw of you, by the standard's recipe: any change to the list changes it |
| verification | What a profile shows: a proof, made on your device, that its seed holds a stamp from this verifier, without the stamp, the seed or who you are |

Signing the stamp number and the facts together says the check was for whoever holds the seed behind
that number. A stamp stays with the person: a profile entry carries only the verification, and
nothing here puts either on a chain.

### The two checks

Both are Didit sessions, on two workflows in one Didit application, with one key: a face search sees
only its own application's faces, so each check's face is compared with every face kept there, of
either check. The app drives them; the verifier asks Didit what each came to, and judges the faces it
saw ([One person, one stamp number](#one-person-one-stamp-number)).

| Step | Face check, free | ID check, paid |
|---|---|---|
| Pay | | `POST /id/payment` with the stamp number, and the person pays on Stripe's page, which holds the price ([The ID check's payment](#the-id-checks-payment)) |
| Open | `POST /face/session` with the stamp number, while it has a free try left, opens a session on the face workflow, for that number, and answers the page the person uses | `POST /id/session` with the payment alone, for its stamp number, on the ID workflow |
| The person | Didit checks for a live person, and reports each face it has seen like it | Didit also reads a government document and matches the live face to its photo |
| Ask | The app sends the session and its stamp number to `POST /face/stamp` | `POST /id/stamp`, with the payment |
| Approved | [One person, one stamp number](#one-person-one-stamp-number); then the verifier fetches the selfie, computes its embedding ([The face model](#the-face-model)), keeps the session next to the stamp number, and answers a stamp from the face key | Every document, liveness and face-match step passed too; then [one person, one stamp number](#one-person-one-stamp-number), a new ID stamp, and a face stamp from the same selfie when the stamp number holds none |

- **Declined** answers `403 declined`, and **Expired** or **Abandoned** (the person did not finish
  in time) `403 expired`: the session will never pass, so the app opens a new one.
- **Anything else unfinished** answers `403 not_approved`, and the app asks again once the person is
  done. A refused or failed request uses nothing up, but for the ID check's refusals that end its
  payment, and the face check's that are a try.
- **Two free face tries a stamp number:** a try is a face session opened for S that Didit finished,
  approved or declined, that an app asked a stamp of, and that gave S no stamp, counted once. A
  session never finished, expired, abandoned or still going, is no try. After two,
  `POST /face/session` for S answers `409 face_tries_used`, and the person takes the ID check.
  `POST /stamp` says how many are left, so an app knows before it opens one.
- **An ID check is a face check and a document:** it takes a live selfie and matches it to the
  document, so when it gives S an ID stamp and S holds no face stamp, it signs S one from the same
  selfie too, with no rule of its own and no gift of its own: the ID stamp's gift stands for both.
- **`vendor_data`** on each session is `<check>-<hash>-<random>`: the check's name, `face` or `id`;
  HMAC-SHA256 of the stamp number's 32 bytes, under a key derived from the verifier's secret ([Its
  keys](#its-keys)), the same for both checks; and a fresh random id. Without the verifier's secret,
  no stamp number gives its hash.
- **Each check is its own Didit user,** never one `vendor_data` for all of a person's checks: Didit
  leaves a user's own faces out of its whole face search, and comparing a person's checks with each
  other is what One person, one stamp number rests on.
- **A session gives a stamp only to the stamp number it was opened for:** asked for another, or
  under a `vendor_data` the verifier cannot read, `409 session_used`, which ends no payment.

### One person, one stamp number

Didit remembers; the verifier judges, and keeps each person under one stamp number. Neither
workflow takes any action on a face seen before. After Didit approves a check opened for stamp number
S, the verifier reads each face its liveness step matched, up to five, strongest first, and each
session a seen-face risk (`DUPLICATED_FACE`, `POSSIBLE_DUPLICATED_FACE`) names that the matches leave
out: Didit's pages say the matches are the faces above its similarity threshold, not whether its
lower, possible band is among them. Each face is one of three:

| A face | When |
|---|---|
| S's own | Under S's hash, from a check that gave S a stamp: a session the verifier holds for S, or a kept template, which only such a check leaves |
| An earlier try | Under S's hash, from a check that gave no stamp |
| Another's | Under any other `vendor_data`; a risk's that names no session, unless a face listed without one can be it; or one Didit no longer has that gave S no stamp |

Then, in order:

| | Face check | ID check |
|---|---|---|
| Another's face | `face_seen` | Its Didit user (`GET /v3/users/{vendor_data}/`) fits this check's document: `duplicate_document`. Anything else passes, a face check's among them, whose user is not asked about |
| S holds a stamp of either key, and no face is S's own | `other_person` | The same |
| S's own ID check, whose Didit user has a birth date | | It must fit this check's document, or `other_person` |
| Five faces, Didit's whole list, and none of these | `too_many_matches` | The same |
| None of these | A new face stamp; the first stays the one handed back | A new ID stamp, and a face stamp when S holds none |

- **Fits:** the birth dates are equal and the names fit, every word of this check's first name in
  the user's full name, or every word of the user's full name in this check's. Words are Unicode
  NFKD, marks removed, lower case, letters only. A user with no name: the birth date alone decides.
  An ID check that read no name, first or full, or no real birth date is refused first,
  `no_document_data`.
- **A face check reads no name,** so the ID check cannot tell its person from a twin, and passes:
  a person can hold a face stamp on one seed and an ID stamp on another, and no more.
- **An earlier try counts for nothing** but its place in Didit's list: a person's own lost try never
  blocks their next check, and someone else's try at S never makes their next one S's own.
- **Five matches at most:** a refused check stays approved at Didit for its day ([The
  sweep](#the-sweep)), so five of a person's tries under one stamp number could push an earlier
  stamp number's face off the list. A full list that refuses nothing may have left one out.
- **A session asked again within its hour** is judged no more: its decision is the same, and its own
  stamp is now S's.
- **A name alone never decides,** so strangers with one name and birth date both pass; **a face alone
  never decides,** so twins with their own first names pass.
- **The country is left out,** since a renewed or another country's document is the same person.
- **The verifier keeps none of it:** what it reads of a user is gone when the answer is.

### The ID check's payment

The ID check's price is held on a Stripe Checkout page the verifier makes, and taken only when it
gives a new ID stamp: one price for a stamp number's first ID stamp, another for each one after
([Stripe](#stripe)). One payment gives one ID stamp, and up to three sessions in its first day to
get it.

1. The app sends `POST /id/payment` with the stamp number and a `returnUrl` on an origin in
   `APP_ORIGINS`, and gets the payment and Stripe's page. The verifier picks the Price: the added-ID
   one when the stamp number holds an ID stamp. Until Stripe has said what its Prices are, it makes
   none, `502 payment_unavailable`.
2. **The payment carries the stamp number:** it is its Checkout Session's id (`cs_…`), a dot, and
   the stamp number locked with AES-256-GCM under the payment key ([Its keys](#its-keys)), the id
   bound in. It opens sessions for that stamp number alone and moves to no other; Stripe never sees
   the stamp number, and nothing else holds the two side by side. The app keeps it: Stripe sends the
   person back to `returnUrl` as it is, paid or not, with no id in its address.
3. The person pays on Stripe's page, which only holds the price until the verifier takes it
   (`payment_intent_data[capture_method]=manual`).
4. The app sends `POST /id/session` with the payment alone. Each time, the verifier asks Stripe
   whether that Checkout Session is one it made (its mark, `metadata.check`), whether it holds the
   money, and since when; if not, or if it was held a day ago or more, `402 not_paid`. Each session
   opened takes one of the payment's three tries, and one Didit does not open gives its try back;
   after three, `409 payment_used`.
5. The app sends the payment again with `POST /id/stamp`, with a session that payment opened and the
   stamp number; with another payment's, `402 not_paid`. A new ID stamp takes the hold and uses the
   payment up: no more sessions and no more stamps from it (`409 payment_used`). A session sent
   again within its hour uses no payment.

The hold is cancelled, and the payment used up:

- when its check is refused as a person seen before, `duplicate_document`;
- when its newest session, its last try, is refused as a session that will never pass: any `403` but
  `not_approved`, `unknown_session` and `wrong_workflow`. An older session refused later ends
  nothing, since the newest may still pass;
- by the hourly search: every hour, the sweep asks Stripe for the holds it made two days ago or more
  that still hold the money (`status:'requires_capture' AND metadata['check']:'id' AND created<…`),
  checks each one's own status, since a search can lag a minute behind, and cancels it.

One clock: a payment opens sessions only in its first day, so each session gets its full day before
its hold can go, and no price stays held more than two days. A cancel Stripe does not answer is
logged, and the hourly search finds it. No webhook, and nothing of a payment kept but its hash, its
tries and whether it is used up: the app sends the payment each time, and Stripe keeps every hold,
by its mark. A payment sits beside the sessions it opened only while it is not used up and they are
not yet deleted (Stripe's and Railway's own records could tie more, as [Limits](#limits) says).
Without `STRIPE_SECRET_KEY`, all three routes answer `503 not_for_sale`.

### The stamp

The verifier signs `{stampNumber, facts, verifierName}` with the standard's `signStamp`, and answers
it in the standard's JSON form, with the list its facts were made from beside it, under `factList`
([the standard's facts as a list](https://github.com/foundationforest/standard/blob/main/proofs/README.md#the-stamp-and-the-verification)):

```
{"stampNumber":"<decimal>","facts":"<decimal>","verifier":"<its key>","verifierName":"<its name>",
 "signature":{"r8":["<decimal>","<decimal>"],"s":"<decimal>"},
 "factList":[{"name":"model","value":"opencv-sface-2021dec","salt":"<decimal>"},
             {"name":"embedding","value":"<base64url>","salt":"<decimal>"}, …]}
```

| Key | Its facts, by name, in the list's order: a new recipe is a new key |
|---|---|
| face key | `model`, `embedding` |
| ID key | `model`, `embedding`, then each text field Didit read on the document, under Didit's own name, in the order of the names |

- **A fact** is a name, a value and a salt; the facts are the standard's `factsNumber` of the list,
  the root of a Poseidon tree with one leaf for each fact. Every value is text.
- **`model`:** the face model's name. A face's numbers mean nothing without the program that made
  them; with the name, anyone can run the same model. **`embedding`:** the 512 bytes the model gives
  for the selfie, as base64url text.
- **The document's fields:** every text field Didit read, as it read it, under Didit's names:
  `document_type`, `document_subtype`, `document_number`, `personal_number`, `first_name`,
  `last_name`, `full_name`, `date_of_birth`, `date_of_issue`, `expiration_date`, `issuing_state`,
  `nationality`, `place_of_birth`, `address`, `gender`, `marital_status`, `region`, and each of
  `extra_fields`, a document's own (a profession, a driving licence's classes), as
  `extra_fields.<its key>`. A field Didit did not read is absent. Never an image or a video, the
  step's status, what Didit works out itself (`age`, `issuing_state_name`, `formatted_address`,
  `parsed_address`), or the same text again in machine form (`mrz`, `barcodes`).
- **Each salt** is derived from the verifier's secret, not drawn: the first 31 bytes, read
  big-endian, of HMAC-SHA256 of the session's id, a 0 byte and the fact's name ([Its
  keys](#its-keys)). So the same session, signed again within its hour, gives the same list and the
  same stamp.
- **The face stamp an ID check gives** is the face key's: `model` and `embedding` from the same
  selfie, with its session's salts, the same as its ID stamp's first two facts.

The list beside a stamp is the person's: with the standard's facts proof, they show any of its facts,
up to eight in one proof, to one reader, and nothing else of the stamp. Nothing here makes such a
proof. Facts are exact; a face comparison is fuzzy. Two photos of one face never give the same
numbers, so a reader would not work the facts out from a new photo: the person shows the `embedding`
fact, and the reader compares it with their live face using the same model. So a face that changes
with light and age leaves its stamp good. Nothing here runs such a check yet.

**Asked back:** `POST /stamp` with a stamp number answers what is kept for it: `face`, the first
stamp the face key signed for that number, or `null`; `id`, every stamp the ID key signed for it, in
no set order; each without its list; and `faceTriesLeft`, its free face tries left. A later face
check that passes [One person, one stamp number](#one-person-one-stamp-number) answers its own new
stamp, but the first stays the one handed back; either gives the same verification. Each ID check
that passes gives a new ID stamp, one for each document checked, and none replaces another. At each
start the verifier forgets any kept stamp its key did not sign, so that stamp number's next check
keeps a new one. Handing a stamp back is safe: a verification needs the seed behind the number. The
list beside a stamp comes only in the answer that signed it, and again from that session within its
hour.

### Its keys

`GET /` gives, in canonical JSON (one exact way of writing it): its name; its two keys as addresses,
each with the names of its facts, `facts`, in their list's order (`extra_fields.<its key>` for each
of a document's own), and the ID key with `forSale`, `testPayments`, `price` and `addedPrice`;
`recipe`, the standard's facts as a list; `consent`, the text an app shows before the ID check ([The
consent screen](#didit)); and with gifts,
`"gift":{"face":<n>,"host":"<origin>","id":<n>,"sponsor":"<address>"}`.

- **The name** never changes: everyone's stamp number here is derived from it
  ([keys](https://github.com/foundationforest/standard/blob/main/keys/README.md#the-recipe)).
- **`forSale` and `testPayments`,** each `true` or `false`, say whether the ID check is for sale,
  which it is with `STRIPE_SECRET_KEY`, and whether its payments run on a test key, `sk_test_…` or
  `rk_test_…`, which charges nobody ([Stripe](#stripe)), so an app shows both before anyone taps.
  Without a key both are `false`; they change only when the verifier starts with another key.
- **`price` and `addedPrice`,** each `{"amount": <n>, "currency": "<code>"}` as Stripe's Price says
  it (its `unit_amount`, in the currency's smallest unit, so `500` is $5, and its `currency`, lower
  case): what a stamp number that holds no ID stamp pays, and what one that holds one pays. An app
  tells which by `POST /stamp`'s `id`, empty or not, and shows it beside the consent screen, so no
  app writes a price. Both `null` without a key, and until Stripe has said them: the verifier starts
  without them and asks Stripe at once and at every sweep, so the face check never waits for Stripe.
- **Two keys, one per check,** so a reader can trust or weigh them apart.
- **One secret,** 32 random bytes made on its own machine at the first start that finds none (the
  standard's `newSeed`), kept in `verifier-seed.json` beside its database, readable by its own user
  only, so the two are kept or lost together. No person, phrase or variable holds it; nothing prints
  or logs it.
- **Derived from its own secret** with the standard's `hkdf` (a standard way to make many keys from
  one secret): under `face-facts`, the face key; `id-facts`, the ID key; `sponsor`, the sponsor key,
  an Ed25519 key that signs the gifts' tickets; `vendor-data`, the key of a stamp number's hash in
  `vendor_data`; `fact-salt`, the key of the facts' salts; `payment`, the key a payment's stamp
  number is locked under. The texts never change, since a new text would derive a new key; a new
  recipe takes new ones, and `face`, `id` and `id-fields`, the texts of the keys of the recipes
  before, are never used again. None of the keys holds money.

### The sweep

- **Within the hour** since its first signing, the same session and stamp number give the same
  stamp, as Didit still has its decision and selfie. After it: `session_used`, with no question to
  Didit; a retry gives no more time.
- **Every minute,** the sweep deletes in Didit every session the verifier opened
  (`DELETE /v3/session/{id}/delete/`): one that gave a stamp an hour after it was first signed,
  keeping its face template if it gave its stamp number its first stamp of a kind, its first face
  stamp, its first ID stamp or both at once; any other, refused, unfinished or never asked about, a
  day after it opened, face and all. So a person's own kept faces stay at two at most: an added ID,
  or a later face stamp, keeps none. It forgets the session's id and time once Didit has. One Didit
  does not answer is tried at the next sweep.
- **What goes:** the selfie, the liveness video, the document's images, the rest of what Didit read
  on it (document number, nationality, dates), and its decision.
- **What stays,** for a session that gave its stamp number its first stamp of a kind: one template
  of the face (`retain_face_embeddings`), whatever the application's setting: numbers, no image, no
  name, used only for its application's face search, so a face that comes back is known. Didit ends
  every kept template; the verifier asks for 3650 days, the longest it allows. Didit's list of users
  also still shows, for any deleted ID session, the full name, birth date and country, which is what
  the ID check reads of a face it matched; a template matches only while its user is there.
- **A session that gave no stamp** keeps nothing of its face, so after its day it matches no one.

### What it keeps

One SQLite file (a database in a single file), eight tables:

| Table | What | Why |
|---|---|---|
| `sessions` | The SHA-256 of each session id that gave a stamp, with the stamp number and which check (`face` or `id`) | A session gives its stamp to one stamp number, and again only within its hour; a face Didit matches from it is that stamp number's own |
| `stamps` | The first face stamp and every ID stamp signed for each stamp number: the number, the key, the facts, the signature | A lost stamp comes back |
| `to_delete` | The id of each session that gave a stamp and is not yet deleted in Didit, its check, when it was first signed, and whether Didit keeps its face | The hour, and the sweep. It goes once Didit has deleted it |
| `opened` | The id of each session opened that gave no stamp and is not yet deleted in Didit, its check, when it opened; for an ID session which of its payment's tries it is and the SHA-256 of that payment while it is not used up; for a face session whether it counted as a free try | The day, the sweep, a payment's stamp from its own sessions only, its last try, and a face try counted once. It goes once Didit has deleted it, or moves to `to_delete` |
| `face_tries` | Each stamp number one of whose face sessions Didit finished without giving it a stamp, and how many | Two free face tries a stamp number |
| `gifts`, `id_gifts` | Each stamp number given its face stamp's gift, or its ID stamp's, with a hash of the buy | One gift a person from each check; the same buy gets the same ticket |
| `payments` | The SHA-256 of each payment that opened an ID session, how many sessions it opened, and whether it is used up | One payment, three sessions at most and one ID stamp |

Nothing else: no face, no embedding, no name, no birth date, no document, no address, none of the
list beside a stamp, no `vendor_data`, and of a payment nothing of who paid or with what, no amount,
no time, and nothing beside a stamp number. Facts are a one-way hash of the list: without the exact
embedding, which no new photo gives again, and the salts, which take the verifier's secret, no guess
can be tested against them. A session id is in clear, with a time, only in `to_delete` and `opened`,
for a day at most, until Didit has deleted it. Deleted bytes are overwritten (`secure_delete`); at
each start the verifier drops a `fingerprints` table, the keyed hashes of a name and birth date an
earlier version kept. The stamp number links the tables, so whoever also holds what Didit keeps of
those sessions can tell which face went with which name. Didit can tell which face check and which
ID check are one person's, since their `vendor_data` carry one hash, and whoever holds both the
verifier's secret and what Didit keeps can go from a stamp number to a person.

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
| `POST /face/session` | `{"stampNumber": "<decimal>"}`, and may add `"returnUrl": "<url>"`, a page on an origin in `APP_ORIGINS` where Didit sends the person after | `201 {"sessionId", "url"}`, while it has a free try left |
| `POST /face/stamp` | `{"sessionId": "<uuid>", "stampNumber": "<decimal>"}`, the stamp number it was opened for, and may add `"gift"` | `200 {"stamp"}`, with `"gift"` if asked |
| `POST /id/payment` | `{"stampNumber": "<decimal>", "returnUrl": "<url>"}`, a page on an origin in `APP_ORIGINS` where Stripe sends the person after, paid or not | `201 {"payment", "url"}` |
| `POST /id/session` | `{"payment": "<as POST /id/payment answered it>"}`, and may add `"returnUrl"`, as for a face session | `201 {"sessionId", "url"}` |
| `POST /id/stamp` | `{"sessionId", "stampNumber", "payment"}`, and may add `"gift"` | `200 {"stamp", "face"}`, `face` the face stamp signed from the same selfie, or `null`; with `"gift"` if asked |
| `POST /stamp` | `{"stampNumber": "<decimal>"}` | `200 {"face", "id", "faceTriesLeft"}`: a stamp or `null`, a list of stamps, a number |

A stamp number is decimal text, as the standard's `stampNumberOf` gives it: no sign, no leading
zero, below BN254's scalar order. A payment is what `POST /id/payment` answers: its Checkout
Session's id, `cs_test_…` or `cs_live_…`, a dot, and 80 characters of base64url, its stamp number
locked. A body with any other field is refused. CORS is open to any origin. Every code below is in
`src/codes.ts`, which an app can import. Errors are `{"error": "<code>"}`:

- **`400`:** `not_json`, `not_an_object`, `expected_exactly_stampNumber`,
  `expected_exactly_stampNumber_and_returnUrl`, `expected_exactly_payment`,
  `expected_exactly_payment_and_returnUrl`, `expected_exactly_sessionId_and_stampNumber`,
  `expected_exactly_sessionId_and_stampNumber_and_payment`, `bad_session_id`, `bad_stamp_number`,
  `bad_return_url`, `bad_payment` (not a payment this verifier made).
- **`402`:** `not_paid` (no money held, held a day ago or more, no payment Stripe has, or not the
  payment that opened the session).
- **`403`, the check does not count:** `unknown_session`, `wrong_workflow`, `declined`, `face_seen`
  (another stamp number's face), `expired`, `not_approved`, `no_liveness`, `liveness_not_passed`,
  `no_document`, `document_not_passed`, `no_face_match`, `face_match_not_passed`, `no_face`,
  `no_document_data` (no name, or no real birth date), `duplicate_document` (a person Didit has seen
  under another stamp number), `other_person` (not the person this stamp number's stamp went to),
  `too_many_matches` (Didit's whole list, which may have left one out).
- **`409`:** `session_used` (opened for or given to another stamp number, or its hour is over),
  `payment_used` (it gave its stamp, opened its three sessions, or its hold was cancelled),
  `face_tries_used` (the stamp number's two free face tries are used).
- **Others:** `404 not_found` (no route); `405 post_only`, `405 get_only`; `413 too_large` (over
  4 KB); `502 face_check_unavailable`, `502 payment_unavailable` (Stripe, or its prices not yet said);
  `503 not_for_sale` (no Stripe); `500 internal`.

## How we run it

### Settings

| Variable | Default | What | Ours |
|---|---|---|---|
| `VERIFIER_NAME` | `verifier.forest.foundation` | Its name, which never changes | the default |
| `DIDIT_API_KEY` | required | From the one Didit application both checks run in. A secret | the foundation's, for "forest id" |
| `DIDIT_FACE_WORKFLOW_ID` | required | The face check's workflow; a session on another is refused | "Forest face", `e2622cbf-0b3a-484e-bb94-3bad22d20833` |
| `DIDIT_ID_WORKFLOW_ID` | required | The ID check's workflow; the same | "Forest ID", `4ddd9ce6-5d8c-4984-9833-5e2b612f30b2` |
| `DIDIT_BASE_URL` | `https://verification.didit.me` | For a stand-in Didit | the default |
| `FACE_MODEL` | `sface` | Or `stand-in`, with `DIDIT_BASE_URL` on loopback | `sface` |
| `APP_ORIGINS` | none: no `returnUrl` | Where Didit and Stripe may send a person back, by origin, comma-separated | the Forest app, https://app.forest.foundation |
| `STRIPE_SECRET_KEY` | none: the ID check is not for sale | Stripe's secret key, `sk_…`, or a restricted one, `rk_…`. A secret | a test-mode key, for "Forest" at Stripe, added by hand in Railway |
| `STRIPE_ID_PRICE` | required with the key | The Stripe Price of a stamp number's first ID stamp, `price_…` | "Forest ID check", $5, `price_1UXRbDILoxkbMfX4cfwRfCOI` |
| `STRIPE_ADDED_ID_PRICE` | required with the key | The Stripe Price of each ID stamp after it, `price_…` | $2, the foundation's Price for an added ID, added by hand in Railway |
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
Stripe key or Price that is not one (quoting no key), or a key without both Prices. It never waits
for Stripe to start: it asks for the prices once it runs ([Its keys](#its-keys)).

### Didit

- **The foundation pays per check:** $0.10 a face check and $0.30 an ID check, on Didit's list. The
  cost is capped at Didit by a prepaid balance with no auto-refill. The ID check's price is in
  [Stripe](#stripe).
- **Two free face tries a stamp number:** each try costs the foundation at Didit, so a person whose
  face check fails twice takes the ID check, which they pay for.
- **One application,** "forest id", with both workflows.
- **"Forest face":** one passive liveness step, face search on, and every duplicate-face action No
  action. A screen, a virtual camera, an injected frame, an outside camera or more than one face is
  declined.
- **"Forest ID":** a document by camera scan, then liveness with face search on, then the face
  matched to the document's photo, every duplicate-face action No action too.
- **Both only report a face seen before,** and the verifier judges ([One person, one stamp
  number](#one-person-one-stamp-number)).
- **Retention:** the application's own window is unlimited; the verifier deletes every session it
  opens ([The sweep](#the-sweep)).

**The consent screen.** `GET /` serves it as `consent`, and an app shows what it gets, before the ID
check:

> The check's price is held through Stripe for the Open Forest Foundation and covers up to three
> tries in a day: it is taken only if the check gives you a new stamp, and is otherwise released
> within two days. Stripe keeps your payment details and email; Forest keeps of the payment only a
> one-way hash and how it was used, never beside your stamp. Forest, run by the Open Forest
> Foundation, checks your face and a government ID with Didit, its provider, to make sure each
> person is counted once. Didit keeps photos of your ID and what it reads on it (your name, date of
> birth and document number), your selfie and a short video while it checks. An hour after your
> stamp is signed, Forest deletes the check at Didit, which still keeps a template of your face
> (numbers, no photo) for up to ten years, so it can tell if you come back; a try that gives no
> stamp is deleted a day after it began, its face with it. Didit also keeps its record of the full
> name, date of birth and country it read. Forest keeps nothing about who you are: only the stamps
> it signed you, a one-way hash of what each check saw, so it can hand them back if you lose them.
> It gives you an ID stamp, with every text field read from your ID beside it (your name, date of
> birth, document number and the rest), for you to keep, and a face stamp from the same selfie if
> you have none yet; a profile that shows either says only that you were checked.

**Data law:** the Open Forest Foundation is the responsible party for both checks, so two things sit
outside this code: a processing agreement with Didit, and Didit's retention setting. Paperwork and a
setting; nothing here does them. The consent screen above is this code's, and an app shows it.

### Stripe

- **The prices:** $5 for a stamp number's first ID stamp, the Price in `STRIPE_ID_PRICE`, and $2 for
  each one after, a passport beside an ID card or a renewed document, the Price in
  `STRIPE_ADDED_ID_PRICE`; both in US dollars, held at Stripe for the business the key belongs to
  and taken only for a new ID stamp. Stripe takes its fee from what it takes.
- **Three tries a payment, in its first day:** a real person's ID check fails mostly to glare, blur or
  a moved face, which a second or third try fixes. Three keep Didit's share, up to $0.30 a session,
  under a fifth of the first ID's price after Stripe's fee, and under three fifths of an added ID's;
  more would mostly help someone trying fake documents on Didit.
- **By the Pay button.** Stripe's page says "You are charged only if the check passes.", its
  `custom_text[submit][message]`.
- **How a person pays:** as the key's payment settings at Stripe allow, among the methods that can
  hold money; the verifier names no method.
- **The hold:** a card's usually lasts 7 days at Stripe; the verifier cancels each within two.
- **Its API version:** every request sends `Stripe-Version: 2026-10-28.endive`, the version its code
  and its stand-in follow, so a new default version at Stripe changes nothing here.
- **What Stripe sees:** what the person pays with, their email, the name, country and, for some
  countries, postal code it asks for, their device's network address, and the app's page they come
  back to. The verifier tells it only the Price, its mark, `check: id`, on the session and its
  PaymentIntent, and the text by its Pay button: never a stamp number, a Didit session or anything
  from the ID. It reads back only each Price's amount and currency, and whether the payment holds
  the money or took it, since when, and the mark.
- **A test-mode key** takes only Stripe's test cards, which anyone can look up, so it charges
  nobody, and a payment made under it is unknown to a live key: `not_paid` there.
- **Paid and still waiting?** Write to support@forest.foundation.
- **A live key** is a restricted one with only Prices: Read, Checkout Sessions: Write and
  PaymentIntents: Write, all the verifier uses, for a business at Stripe that is the foundation's,
  with live Prices in `STRIPE_ID_PRICE` and `STRIPE_ADDED_ID_PRICE`.

### Public, secret, kept

- **Public:** this code, these settings, its name and its two keys.
- **Secret:** the secret its keys are derived from, `DIDIT_API_KEY` and `STRIPE_SECRET_KEY`.
- **Kept, not published:** [What it keeps](#what-it-keeps), the stamp numbers given a gift among it.
- **Logged:** its port, that it made its secret, an error's kind, what Didit did with a face it was
  asked to keep and did not, and why Stripe or Didit failed: at each 502, at a cancel Stripe did not
  answer, at a search for old holds Stripe did not answer, at an ask for the prices Stripe did not
  answer, beside how many of their cancels it refused, and at a sweep beside how many deletions
  Didit did not answer, the error's kind and, when one answered, its HTTP status and codes (Stripe's
  error `type`, `code` and `param`; Didit's `code`), each only if it is lower case, digits, `_`, `.`
  and brackets, at most 64 characters, and not shaped like a Stripe key or a Checkout Session's id.
  Never what either said in words, a key, a session or a payment.

### The image and the commands

One replica, never more, since the sessions and payments are one SQLite file, and an ID stamp's last
steps, its hold taken among them, one at a time in its one process; a volume for `DATABASE_PATH` and
its secret, or a deploy loses who was signed for which stamp number, and the secret. Ours runs on
Railway; any platform with Node 22.18 and a persistent disk will do. `deploy/Dockerfile`, built from
the repo root: Node 22.22.2 and git, `standard.sh`, `npm ci`, `npm run fetch -- models`, then `npm
start`.

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
DIDIT_SANDBOX_API_KEY=<the sandbox application's key> npm run sandbox              # every session approved
DIDIT_SANDBOX_API_KEY=<the sandbox application's key> npm run sandbox -- decline_x  # or another of Didit's scenarios
```

It runs both checks on the sandbox application's two workflows, with its key for both, refuses a key
that is `DIDIT_API_KEY`, and keeps its own secret and file in
`data/sandbox/`. With `STRIPE_SECRET_KEY`, `STRIPE_ID_PRICE` and `APP_ORIGINS` set, the ID check is
paid in Stripe's test mode, with a test card; it refuses a live key.

`test/` covers, against a stand-in Didit and a stand-in Stripe, a real SQLite file and real HTTP:
both checks, each rule of One person, one stamp number (twins, namesakes, one face with two birth
dates, someone else at a stamp number and an earlier try among them), the `vendor_data`, the ID
check's hold, its tries, its cancels and its clock, its two prices and the payment's lock, an ID
stamp for each document and the face stamp an ID check gives, the free face tries, which sessions
keep their faces, the Stripe and Didit clients' requests, verifications and a facts proof made from
the stamps and checked against the published keys, the lists, their salts and the `vendor_data` hash
against pinned vectors, what is read of Didit's ID report, stamps asked back, the secret, the sweep,
the raw file and one an earlier version wrote, the face models on three portraits, both gifts'
tickets taken by the host's own seller, what `GET /` says of the ID check's sale, what a failure at
Stripe or Didit logs, the fetch's retries, and this README's consent screen, codes and Stripe's page
text, as the code has them.

## Promises

- **It keeps which check session gave which stamp number, the stamps it signed and how many free
  face tries each stamp number used, and nothing else of a check; of a payment, only a hash, how
  many sessions it opened and whether it is used up, beside the sessions it opened only while it is
  open, a day at most, and never beside a stamp number.** No face, no embedding, no name, no birth
  date, no document, and no time or session id in clear once a session is deleted in Didit; deleted
  bytes are overwritten. A test reads the raw file for names, birth dates, embeddings, references,
  payment ids and session ids.
- **It never logs a request, an address, a session, a stamp number or a stamp, and never writes down
  an address.** It logs an error's kind, never its message.
- **It takes no key of the person's, has no sign-ups, and nothing it keeps ties a person to a
  profile.** An app sends a session and a stamp number, as a POST body, never in a URL, since hosting
  platforms log paths. No request names a profile: the verification is made on the person's device.
- **It signs a stamp only for a check Didit approved, on that check's workflow, and a key's recipe
  never changes.** It will not start without Didit; the face and ID keys sign stamps, the sponsor
  key tickets, nothing else; a new recipe is a new key.
- **It deletes in Didit every session it opens: one that gave a stamp an hour after it was first
  signed, keeping only a template of the face; any other a day after it opened, keeping nothing;
  each at the first sweep after that which Didit answers.**

## Limits

- **A new first name on a new ID,** by a legal change, gives a second ID stamp on another seed: it
  looks exactly like an identical twin. On the person's own seed it is refused, `other_person`.
- **Someone who has Didit erase their data** can verify again.
- **A twin or a look-alike is refused the face check,** `face_seen`, when Didit matches the face to
  one under another stamp number, and nobody reviews it; the ID check is still open to them, and
  gives them a face stamp too.
- **One person, one stamp number rests on Didit's face search,** the ID check's with the name and
  birth date: a face it matches to no other stamp number's is signed for the stamp number the person
  brings.
- **A person can hold a face stamp on one seed, and an ID stamp and a face stamp on another:** a
  face check reads no name, so the ID check cannot tell its person from a twin, and an ID check
  gives a face stamp to a stamp number that holds none. Time solves it: an index trusts a profile
  more the more verifiers stand behind its seed.
- **Two checks finished at the same moment do not see each other:** Didit compares a face only with
  checks it already approved.
- **Five of a stamp number's own faces at Didit fill its list,** its two kept faces and the day's
  tries: its next check is refused, `too_many_matches`, till the day's go. Once Didit holds many
  faces, five look-alikes can fill it too.
- **A lost volume re-stamps no one Didit knows:** a new secret reads no earlier `vendor_data`, so
  every face Didit kept is another stamp number's, until the checks move to an application that has
  none.
- **A kept face template ends** after 3650 days at most: then a returning face is new to Didit, and a
  person Didit no longer matches to their own stamped check, as then, is refused `other_person`.
- **After the hour, a lost answer loses the list beside the stamp for good:** the stamp comes back
  from `POST /stamp` without it, and a new check gives a new stamp, with its own.
- **A stamp describes the document as it was on the day of the check:** a renewed document takes a
  new, paid ID check, and the old stamp stays good.
- **The same document checked twice gives a second stamp for it:** the person paid, and an index
  counts the ID key once.
- **Each seed is its own stamp number,** so a new one, as a new passkey in an app gives, starts the
  free face tries over.
- **A face session no app asks a stamp of is no try,** however Didit finished it.
- **Stamps signed before this code kept them do not come back:** `POST /stamp` holds none, and the
  person checks again.
- **For a day at most, `to_delete` and `opened` name the sessions:** whoever reads the file can ask
  Didit about them.
- **A deletion Didit does not answer** leaves the session there, images and all, till a later sweep.
- **It trusts Didit's decisions and users,** and relies on the workflow settings above, which it
  cannot see.
- **The answer that signs a stamp says who the person is:** keep it as a key is kept.
- **A lost gift is lost:** another buy gets `given`.
- **Losing the volume** means a new secret and keys, with no signed handover. The name, and so the
  stamp numbers, stay.
- **SFace's training data** (CASIA-WebFace, VGGFace2, MS-Celeb-1M) has research-only terms; no widely
  used face model's data is cleaner.
- **The face test is three NASA portraits,** two of one person: it shows the model tells them apart,
  not how often it errs.
- **Railway's own request logs** hold each request's client address and path.
- **What Stripe keeps and Railway's logs** both hold a person's network address and a time, so
  together they can tie a payment to the request that used it.

## FAQ

**Can you tell which profile is mine?**
No. We hold your stamp number, made from your seed and our name; your profiles' keys are made from
your seed and their labels. Only your seed connects the two, and it never leaves your device. A
verification shows that we signed a stamp to the seed behind it, never which stamp number.

**Why does each check get its own `vendor_data`, not one for the person?**
Didit leaves a user's own faces, those under one `vendor_data`, out of its whole face search. With
one for all of a person's checks, their checks would never be compared with each other, and someone
else's check at their stamp number could not be told from theirs. The hash in each says which faces
are one stamp number's.

**Why are the salts derived, not drawn at random?**
So a session signed again within its hour gives the same stamp, list and all, after an app lost the
first answer, and an ID check tells whether the face stamp its stamp number holds is the one its
session signed by their facts. To anyone without the verifier's secret the salts are as good as
random; whoever holds it already holds every facts number the verifier signed.

**Why is the stamp number locked inside the payment, not kept beside it?**
So a payment opens ID sessions for its own stamp number alone, an added ID's price goes only to a
stamp number that holds an ID stamp, and an app back from Stripe opens the check with the payment
alone. Kept in the file, it would sit beside a payment, which the file never holds; told to Stripe,
whoever held the verifier's secret could tie a payer to a stamp number. Locked, it stays with the
app, as the stamp number already does.

**Could someone rebuild this verifier from public data?**
Its name, keys and code are public. Which session and person went with which stamp number is not, so
a new verifier starts its own, and its people come through their own checks.
