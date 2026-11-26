# verifier

The verifier checks that you are one real person, by your face or your ID, and signs a stamp to your
seed (the secret on your device that all your keys come from). Your profiles then prove they're
verified without saying who you are, or which of your other profiles they go with. The Forest
Foundation runs this copy, at https://verifier.forest.foundation. Anyone can sign stamps; the main
way is a verifier like this one, and each reader decides which verifiers count. It keeps your stamp
number, which check gave it, the stamps and how many free face tries it used, and, from the ID
check, a scrambled copy of your first name, first last name and birth date, and, when your ID shows
a personal number meant to last a lifetime, a second of that number and your ID's country, so no
other seed of yours gets an ID stamp until five years after Didit first kept your face; of the ID
check's payment, a hash for 30 days, never beside your stamp. Your
face, and from the ID check your ID's photos and what is read on it, go to Didit, its check
provider, which decides who is the same person; an hour after your stamp Didit keeps only a template
of your face, with your name, birth date and ID's country after an ID check, until you delete your
face or five years pass. How you paid stays with Stripe. Both checks are for people 18 and older.
The face check is free, once; the ID check, which gives a face stamp too, holds $5 for your first ID
and $2 for each you add, taken only if it gives you a new stamp. No key of yours, no account.

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

Both are Didit sessions, on two workflows in one Didit application, with one key, so each check is
compared with every other person's checks there, of either check. The app drives them; Didit decides
who is the same person, and the verifier signs only what Didit approved ([Didit
decides](#didit-decides)).

| Step | Face check, free | ID check, paid |
|---|---|---|
| Pay | | `POST /id/payment` with the stamp number, and the person pays on the verifier's payment page inside the app, or on Stripe's own page, which holds the price ([The ID check's payment](#the-id-checks-payment)) |
| Open | `POST /face/session` with the stamp number, while it has a free try left, opens a session on the face workflow, for that number, and answers the page the person uses | `POST /id/session` with the payment alone, for its stamp number, on the ID workflow |
| The person | Didit checks for a live person, and looks for their face under another person's checks | Didit also reads a government document, matches the live face to its photo, and looks for the document's person under another person's checks |
| Ask | The app sends the session and its stamp number to `POST /face/stamp` | `POST /id/stamp`, with the payment |
| Approved | The verifier fetches the selfie, computes its embedding ([The face model](#the-face-model)), keeps the session next to the stamp number, and answers a stamp from the face key | Every document, liveness and face-match step passed too, and no other stamp number holds the person ([The scrambled copy](#the-scrambled-copy)); then a new ID stamp, and a face stamp from the same selfie when the stamp number holds none |

- **Declined** or **In Review** answers Didit's refusal, as one code ([Didit
  decides](#didit-decides)), and **Expired** or **Abandoned** (the person did not finish in time)
  `403 expired`: the session will never pass, so the app opens a new one.
- **Anything else unfinished** answers `403 not_approved`, and the app asks again once the person is
  done. A refused or failed request uses nothing up, but for the ID check's refusals that end its
  payment, and the face check's that are a try.
- **One free face check a stamp number:** its try is a face session opened for S that Didit
  finished, approved, declined or in review, that an app asked a stamp of, and that gave S no stamp,
  counted once. A session never finished, expired, abandoned or still going, is no try. After it,
  `POST /face/session` for S answers `409 face_tries_used`, and the person takes the ID check. `POST
  /stamp` says whether it is left, so an app knows before it opens one. Within a check, Didit lets
  the person take it up to three times.
- **18 and older:** the face check refuses a face Didit estimates under 21, `too_young`, so the
  person takes the ID check, which refuses a document whose birth date shows under 18.
- **An ID check is a face check and a document:** it takes a live selfie and matches it to the
  document, so when it gives S an ID stamp and S holds no face stamp, it signs S one from the same
  selfie too, with no rule of its own and no gift of its own: the ID stamp's gift stands for both.
- **`vendor_data`** on every session for stamp number S, face or ID, is S's hash and nothing else:
  HMAC-SHA256 of the stamp number's 32 bytes, under a key derived from the verifier's secret ([Its
  keys](#its-keys)), in hex. Without the verifier's secret, no stamp number gives its hash.
- **One Didit user a stamp number:** Didit leaves a user's own checks out of its search for a person
  seen before, so a person's earlier checks never refuse their next one, and every other user's
  count.
- **A session gives a stamp, or its refusal, only to the stamp number it was opened for:** asked for
  another, or under any other `vendor_data`, as each session carried before, `409 session_used`,
  which ends no payment.

### Didit decides

Didit decides each check, as its workflows are set ([Didit](#didit)), and compares faces; the
verifier keeps no rule of its own on a face. It signs only for a session whose status is Approved.
Declined and In Review are a refusal, answered as one code, from the risks of the warnings Didit
says set that status (`decision_trace.status_warnings`): the first code in this order that one of
them says. A person seen before on another stamp number's ID is the verifier's to count, by its
scrambled copies and Didit's face matches ([The scrambled copy](#the-scrambled-copy)).

| Code | When | Didit's risks |
|---|---|---|
| `known_person` | Another stamp number holds a scrambled copy that matches this ID's, and is the same person ([The scrambled copy](#the-scrambled-copy)) | None: only the verifier says it, never Didit |
| `known_face` | Another person's face | `DUPLICATED_FACE`, `POSSIBLE_DUPLICATED_FACE`, `DUPLICATED_FACE_NAME_MISMATCH`, `DUPLICATED_FACE_DOCUMENT_MISMATCH`, `FRONT_CAMERA_DUPLICATED_FACE`, `POSSIBLE_FRONT_CAMERA_DUPLICATED_FACE`, `FRONT_CAMERA_DUPLICATED_FACE_NAME_MISMATCH`, `FRONT_CAMERA_DUPLICATED_FACE_DOCUMENT_MISMATCH` |
| `too_young` | A face Didit estimates under the face check's minimum; on the ID check, a birth date Didit read that shows under 18, while one it could not read is `id_unclear` | `AGE_BELOW_MINIMUM`, `MINIMUM_AGE_NOT_MET` |
| `face_mismatch` | The selfie does not match the ID's photo | `LOW_FACE_MATCH_SIMILARITY`, `FACE_MATCH_MAX_ATTEMPTS_EXCEEDED`, `LOW_FRONT_CAMERA_FACE_MATCH_SIMILARITY` |
| `id_unclear` | The ID can't be read | `COULD_NOT_RECOGNIZE_DOCUMENT`, `COULD_NOT_DETECT_DOCUMENT_TYPE`, `IMAGE_TOO_BLURRY`, `IMAGE_TOO_DARK`, `IMAGE_TOO_BRIGHT`, `NAME_NOT_DETECTED`, `DATE_OF_BIRTH_NOT_DETECTED`, `DOCUMENT_NUMBER_NOT_DETECTED`, `EXPIRATION_DATE_NOT_DETECTED`, `INVALID_DATE`, `MRZ_NOT_DETECTED`, `QR_NOT_DETECTED`, `BARCODE_NOT_DETECTED`, `PORTRAIT_IMAGE_NOT_DETECTED`, `DOCUMENT_HAS_NO_PORTRAIT`, `CRITICAL_FIELD_OCCLUSION_DETECTED`, `FACE_MATCH_NOT_COMPUTED`, `NO_REFERENCE_IMAGE` |
| | It is expired, or not accepted | `DOCUMENT_EXPIRED`, `DOCUMENT_NOT_SUPPORTED_FOR_APPLICATION` |
| | It looks altered | `SCREEN_CAPTURE_DETECTED`, `PRINTED_COPY_DETECTED`, `PORTRAIT_MANIPULATION_DETECTED`, `SPECIMEN_DOCUMENT_DETECTED`, `PUBLIC_DOCUMENT_IMAGE_DETECTED`, `MRZ_VALIDATION_FAILED`, `MRZ_AND_DATA_EXTRACTED_FROM_OCR_NOT_SAME`, `DATA_INCONSISTENT`, `DOCUMENT_SIDES_MISMATCH`, `QR_VALIDATION_FAILED`, `BARCODE_VALIDATION_FAILED`, `BARCODE_SIGNATURE_INVALID`, `DOCUMENT_NUMBER_FORMAT_MISMATCH`, `PERSONAL_NUMBER_FORMAT_MISMATCH` |
| `face_unclear` | Not a live face | `LIVENESS_FACE_ATTACK`, `LOW_LIVENESS_SCORE`, `VIRTUAL_CAMERA_DETECTED`, `INJECTION_ATTACK_DETECTED`, `FRAME_INJECTION_SUSPECTED`, `SCREEN_CAPTURE_DURING_CAPTURE`, `EXTERNAL_CAPTURE_DEVICE_DETECTED`, `LIVENESS_VIDEO_ANOMALY` |
| | The face can't be seen well | `NO_FACE_DETECTED`, `AGE_NOT_DETECTED`, `NO_FACE_IN_SELFIE`, `MULTIPLE_FACES_DETECTED`, `LOW_FACE_QUALITY`, `LOW_FACE_LUMINANCE`, `HIGH_FACE_LUMINANCE`; and an approved selfie in which [the face model](#the-face-model) finds no face |
| `other` | Anything else: a blocklist, an age limit, a decline by hand, no risk at all | Any other |

- **A refusal is kept, and the session deleted at once:** the file keeps its code (`refused`), so
  the app gets it each time it asks, for that stamp number alone, with no question to Didit; and the
  next sweep, within a minute, deletes the session in Didit, face and all, and, when its stamp
  number holds no stamp, its Didit user. The sweep asks Didit about every session opened that gave
  no stamp, so a refused one goes whether the app asked or not ([The sweep](#the-sweep)).
- **Approved without a step its check needs** (liveness; for the ID check also the document and the
  face match): no workflow that makes that check ran it, `403 wrong_workflow`, which uses no try.
- **An ID check approved without a birth date or any name read:** `403 id_unclear`, as the name copy
  needs both.
- **Didit's own name check is off,** and its risk, `POSSIBLE_DUPLICATED_USER`, is no reason in the
  table: it compares a document only with ID checks Didit still holds, and the verifier deletes each
  an hour after its stamp ([The sweep](#the-sweep)), so it would catch almost nothing, and it
  refuses without comparing faces. The ID workflow takes no action on it ([Didit](#didit)); were
  Didit to send it, the refusal is `other`, and nothing matches on it.
- **A face is Didit's to compare:** the verifier signs what Didit approves for the stamp number the
  person brings, but for the refusal of a person already counted.

### The scrambled copy

Didit keeps no ID check ([The sweep](#the-sweep)), so the verifier counts each person once itself,
and Didit compares their faces. Every ID stamp keeps, beside its stamp number's keyed hash, up to
two scrambled copies, each one value, and nothing else of the ID:

| Copy | Of | When |
|---|---|---|
| Name copy | The first given name, the first family name and the birth date | Every ID |
| Number copy | The ID's personal number and its country | Only an ID that shows a number meant to last a lifetime, of a country on the list below |

- **Cleaned:** capitals, no accents, an apostrophe dropped and anything else that is not a letter a
  space, single spaces; then each name is its first word. The names come from the document's
  machine-readable zone when it has one, as passports and most ID cards do, else from what Didit
  read on its face; the birth date is Didit's `date_of_birth`, never the zone's, which writes the
  year in two digits.
- **Scrambled** by scrypt, a scramble made slow on purpose (N = 2^16, r = 8, p = 1: 64 MB and about
  a fifth of a second a copy), with a key derived from the verifier's secret as its salt ([Its
  keys](#its-keys)), of the copy's label, `name` or `number`, and its details, joined by 0 bytes:
  keyed, one-way, and the same details always the same value, so a check finds a match by its own
  value alone. Each copy has its own label, so a name copy and a number copy never match each other.
- **What each can tell:** only whether a given name and birth date, or number, match. Without the
  secret no guess can be tested at all; with it, one guess at a time: every birth date in a hundred
  years for one known name is about two hours of one machine's time, the whole table thousands of
  years.
- **The country is not in the name copy,** so the same person's ID from a second country matches
  too.

**The number copy** is of Didit's `personal_number`, never its `document_number`, which changes with
each renewal, and only for a country on a list in `src/fingerprint.ts`:

| Country | The number | Its shape |
|---|---|---|
| Mexico (`MEX`) | The CURP | 18 characters: four letters, six digits, the sex, the state, three consonants, a character that tells the century, a check digit |

Didit's read of a Mexican INE gave the CURP as `personal_number`, in that shape. A value of any
other shape is no number, so a misread gives no copy and not a wrong one, and the ID keeps only its
name copy. A country is added only after the legal chat has checked its rules; to switch the number
copy off, the list is emptied.

**The rule.** On every ID check Didit approves, before signing, for each other stamp number that
holds a copy equal to one of this check's, whichever copy matched:

| That stamp number's face | Then |
|---|---|
| Held at Didit | Didit compares faces: its match list (`matches[]`) names that stamp number's `vendor_data`: refused, `known_person`; it does not: it passes, and both are kept. A number match alone never refuses while the face is held |
| Deleted by its person ([Deleting a face](#deleting-a-face)) | Refused, `known_person`, unless both IDs show a lifelong number and the numbers differ: a stranger who shares a name and a birth date |
| Its five years over | Its copies are gone, so nothing matches |

- **Five years:** both copies of a stamp number, and the mark that its person deleted their face,
  are deleted five years after Didit first kept that face, on the day the verifier deletes the Didit
  user ([The sweep](#the-sweep)). Nothing about a person is kept for good. A lost passkey stays
  locked out until then, whether or not the face was deleted.
- **A stamp number that holds an ID stamp** is never refused by it: another ID of the same person is
  always fine, as its face matched its document.
- **One at a time:** the copies are looked up in the same queue as an ID stamp's last steps, so two
  checks of one person at once never both pass; each is made before it, on its own thread.
- **Its face** is the file's `faces` ([What it keeps](#what-it-keeps)): Didit keeps one template a
  stamp number, so the verifier knows whose face is there to compare, and whose its person deleted.
- **A refused check shows its reason in the app;** nobody reviews it by hand.

### The ID check's payment

The ID check's price is held on a Stripe Checkout page the verifier makes, and taken only when it
gives a new ID stamp: one price for a stamp number's first ID stamp, another for each one after
([Stripe](#stripe)). One payment gives one ID stamp, and up to three sessions in its first day to
get it.

1. The app sends `POST /id/payment` with the stamp number, and gets the payment and where the
   person pays: with no `returnUrl`, the client secret of the [payment page](#the-payment-page); with
   a `returnUrl` on an origin in `APP_ORIGINS`, Stripe's own page, which sends them back there. The
   verifier picks the Price: the added-ID one when the stamp number holds an ID stamp. Until Stripe
   has said what its Prices are, it makes none, `502 payment_unavailable`.
2. **The payment carries the stamp number:** it is its Checkout Session's id (`cs_…`), a dot, and
   the stamp number locked with AES-256-GCM under the payment key ([Its keys](#its-keys)), the id
   bound in. It opens sessions for that stamp number alone and moves to no other; Stripe never sees
   the stamp number, and nothing else holds the two side by side. The app keeps it: Stripe sends the
   person back to `returnUrl` as it is, paid or not, with no id in its address, and the payment page
   tells the app only that the person is done.
3. The person pays, which only holds the price until the verifier takes it
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

- when its check is refused as a person already counted or a face Didit has seen, `known_person` or
  `known_face`,
  or as a birth date read under 18, `too_young`, since no other try can pass;
- when the person cancels the check, `POST /id/cancel` with the payment, while it gave no stamp: at
  once, and the payment opens no more sessions; one that gave a stamp answers `409 payment_used`,
  and one that holds nothing, not yet paid, `402 not_paid`;
- when its newest session, its last try, is refused as a session that will never pass: any `403` but
  `not_approved`, `unknown_session` and `wrong_workflow`. An older session refused later ends
  nothing, since the newest may still pass;
- by the hourly search: every hour, the sweep asks Stripe for the holds it made two days ago or more
  that still hold the money (`status:'requires_capture' AND metadata['check']:'id' AND created<…`),
  checks each one's own status, since a search can lag a minute behind, and cancels it.

One clock: a payment opens sessions only in its first day, so each session gets its full day before
its hold can go, and no price stays held more than two days. A cancel Stripe does not answer is
logged, and the hourly search finds it. No webhook, and nothing of a payment kept but its hash, its
tries, whether it is used up and when it opened its first session, for 30 days, after which it opens
nothing as Stripe says when it was made: the app sends the payment each time, and Stripe keeps every
hold, by its mark. A payment sits beside the sessions it opened only while it is not used up and
they are not yet deleted (Stripe's and Railway's own records could tie more, as [Limits](#limits)
says). Without `STRIPE_SECRET_KEY`, all three routes and the payment page answer `503 not_for_sale`.

### The payment page

Any app can send the person to Stripe's own page; the main way is the verifier's payment page,
framed inside the app, so the person never leaves it. It is Stripe's embedded Checkout for a payment
`POST /id/payment` made with no `returnUrl`: the same Price, hold, text by the Pay button and stamp
number locked in the payment, on a Checkout Session made with `ui_mode=embedded_page` and
`redirect_on_completion=never`, so Stripe sends the person nowhere.

| | |
|---|---|
| Its address | `https://verifier.forest.foundation/id/pay#<clientSecret>`, the `clientSecret` `POST /id/payment` answered after the `#`, which a browser never sends: it is in no request and no log |
| Who may frame it | The apps in `APP_ORIGINS` alone: `Content-Security-Policy: frame-ancestors <each origin>`, or `'none'` with none |
| Apple Pay and Google Pay | `Permissions-Policy: payment=(self "https://js.stripe.com" "https://checkout.stripe.com")`, and the app's frame carries `allow="payment"` |
| Stripe's script | `https://js.stripe.com/endive/stripe.js`, the release of the API version the verifier sends, on this page and no other: it mounts the Checkout with the client secret and the key's publishable key |
| Once the person has paid | One message to the app around it, `"payment_done"` (`PAYMENT_DONE` in `src/codes.ts`), posted to each origin in `APP_ORIGINS`, so the browser hands it to the one framing the page and to no other; never to `"*"` |

- **The message carries what Stripe's own page tells the app by sending the person back:** that they
  are done, nothing more. The app then sends `POST /id/session` with the payment it holds, and the
  verifier asks Stripe whether the money is held, as it does after Stripe's page: a message gives
  nothing by itself.
- **Only payment methods that need no other page:** with nowhere to send the person, Stripe leaves
  out those that take them to their bank's page, or any other.
- **Opened outside a frame,** the page takes the same payment, and posts its message to no one.

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
no set order; each without its list; `faceTriesLeft`, its free face tries left; and `deletion`, what
became of its ask to delete its face, or `null` ([Deleting a face](#deleting-a-face)). A later face
check Didit approves answers its own new stamp, but the first stays the one handed back; either
gives the same verification. Each ID check that passes gives a new ID stamp, one for each document
checked, and none replaces another. At each start the verifier forgets any kept stamp its key did
not sign, so that stamp number's next check keeps a new one. Handing a stamp back is safe: a
verification needs the seed behind the number. The list beside a stamp comes only in the answer that
signed it, and again from that session within its hour.

### Its keys

`GET /` gives, in canonical JSON (one exact way of writing it): its name; its two keys as addresses,
each with the names of its facts, `facts`, in their list's order (`extra_fields.<its key>` for each
of a document's own), the face key with `consent`, the text an app shows before the face check, and
`deletion`, the text an app shows before the person deletes their face, and the ID key with
`forSale`, `testPayments`, `price`, `addedPrice` and `cancelRight`, the line the person agrees to
that starts the ID check at once; `recipe`, the standard's facts as a list; `consent`, the text an
app shows before the ID check; `agree`, the one line an app has the person tick before either check
([The consent screens](#didit)); and with gifts,
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
tells which by `POST /stamp`'s `id`, empty or not, and shows it beside the ID check's consent
  screen, so no app writes a price. Both `null` without a key, and until Stripe has said them: the
  verifier starts without them and asks Stripe at once and at every sweep, so the face check never
  waits for Stripe.
- **Two keys, one per check,** so a reader can trust or weigh them apart.
- **One secret,** 32 random bytes made on its own machine at the first start that finds none (the
  standard's `newSeed`), kept in `verifier-seed.json` beside its database, on the same volume,
  readable by its own user only. A copy locked with a passphrase is kept off the volume ([The image
  and the commands](#the-image-and-the-commands)); no variable holds it, and nothing prints or logs
  it.
- **Derived from its own secret** with the standard's `hkdf` (a standard way to make many keys from
  one secret): under `face-facts`, the face key; `id-facts`, the ID key; `sponsor`, the sponsor key,
  an Ed25519 key that signs the gifts' tickets; `vendor-data`, the key of a stamp number's hash in
  `vendor_data`; `fact-salt`, the key of the facts' salts; `payment`, the key a payment's stamp
  number is locked under; `fingerprint`, the key of both scrambled copies, the text an earlier
  version used for its own, all dropped. The texts never change, since a new text would derive a
  new key; a new recipe takes new ones, and `face`, `id` and `id-fields`, the texts of the keys of
  the recipes before, are never used again. None of the keys holds money.

### The sweep

Every minute (`DELETE /v3/session/{id}/delete/` to delete one):

| What | What the sweep does |
|---|---|
| A check that gave a stamp, face or ID | An hour after it was first signed, deletes it in Didit, keeping one template of its face only when Didit holds none of its stamp number's |
| Refused, Declined or In Review | Deletes it in Didit at once, face and all: the sweep asks Didit what every session opened that gave no stamp came to, so it goes whether the app asked or not |
| Any other, unfinished or never asked about | Deletes it in Didit a day after it opened, face and all |
| A face its person asked to delete | 28 days after the ask, erases every session Didit holds of its stamp number and deletes its Didit user ([Deleting a face](#deleting-a-face)) |
| A face's five years | Five years after Didit first kept it, deletes its Didit user, so the name, birth date and country Didit keeps with it never outlive the face, and with it its stamp number's scrambled copies and the mark that its person deleted the face; for a face already deleted, only the file's rows |

- **Within the hour** since its first signing, the same session and stamp number give the same
  stamp, as Didit still has its decision and selfie. After it: `session_used`, with no question to
  Didit; a retry gives no more time.
- **A refused session's code** stays in the file till a day after the session opened, so the app
  still gets it; then the file forgets the session, and asking for it answers `unknown_session`.
- **Releasing a session that gave no stamp,** refused or at its day, when its stamp number holds no
  stamp and has no other session open, deletes its Didit user first (`POST /v3/users/delete/`): the
  full name, birth date and country Didit read, and any face template kept for it, but not its
  sessions, which the sweep deletes itself. So Didit keeps a name and a birth date
  only for a person with a stamp, and only as long as their face. Which sessions are open the sweep
  learns from Didit's answers: one it did not get releases nothing that sweep.
- **What goes:** the selfie, the liveness video, the document's images, the rest of what Didit read
  on it (document number, nationality, dates), and its decision. A deletion, or a question, Didit
  does not answer is tried at the next sweep.
- **A kept face template** (`retain_face_embeddings`, whatever the application's setting) is
  numbers, no image, no name, used only for its application's face search, so a face that comes back
  is known. Didit ends every kept template; the verifier asks for 1825 days, five years, as long as
  the foundation's Didit plan keeps anything. So Didit keeps one template a stamp number, from its
  first check that gave a stamp, face or ID, and another only once that one is deleted or its years
  are over.

### Deleting a face

The person asks with `POST /delete` and their stamp number, for a stamp number that holds a stamp;
else `409 nothing_to_delete`. It answers
`{"deletion":{"state":"requested","runsOn":"<YYYY-MM-DD>"}}`, 28 days on, the UTC date; asked again
while it waits, the same date. Till then `POST /delete/undo` undoes it,
`{"deletion":{"state":"undone"}}`, or `409 nothing_to_undo` when none waits.

1. **On its day,** the sweep asks Didit for every session of its stamp number (`GET /v3/sessions/`,
   by its `vendor_data`) and erases each, a privacy erasure (`deletion_instruction:
   "privacy_erasure"`), which takes every face template of its user with it; a check taken while it
   waited is one of them.
2. **Once Didit lists none,** it deletes the Didit user (`POST /v3/users/delete/`): the full name,
   birth date and countries Didit keeps on it go too. A step Didit does not answer is tried at the
   next sweep.
3. **Kept:** the stamps, and, until five years after Didit first kept the face, the scrambled copies
   and that its person deleted the face, so a match of a copy then refuses, unless the numbers
   differ ([The scrambled copy](#the-scrambled-copy)); then they are deleted. `POST /stamp` answers
   `{"state":"done","doneOn":"<YYYY-MM-DD>"}` for 90 days, then the file forgets the deletion's days.

Its next check that gives a stamp keeps a new template, as Didit holds none of that stamp number's,
and its face is held again.

### What it keeps

One SQLite file (a database in a single file), twelve tables:

| Table | What | Why |
|---|---|---|
| `sessions` | The SHA-256 of each session id that gave a stamp, with the stamp number and which check (`face` or `id`) | A session gives its stamp to one stamp number, and again only within its hour |
| `stamps` | The first face stamp and every ID stamp signed for each stamp number: the number, the key, the facts, the signature | A lost stamp comes back |
| `to_delete` | The id of each session that gave a stamp, until its hour is over and Didit has deleted it: its check, when it was first signed, and whether Didit keeps its face | The hour, and the sweep |
| `opened` | The id of each session opened that gave no stamp, till its day: its check, when it opened; for an ID session which of its payment's tries it is and the SHA-256 of that payment while it is not used up; for a face session whether it counted as a free try | The day, the sweep, a payment's stamp from its own sessions only, its last try, and a face try counted once. It goes with its day, or moves to `to_delete` |
| `refused` | The id of each opened session refused, its code, whether Didit has deleted it, and the SHA-256 of its `vendor_data` with its id, which tells its stamp number from any other and ties no two rows together | The app gets the code when it asks, for that stamp number alone, and the sweep deletes the session in Didit at once. It goes with its `opened` row |
| `face_tries` | Each stamp number one of whose face sessions Didit finished without giving it a stamp, and how many | One free face check a stamp number |
| `gifts`, `id_gifts` | Each stamp number given its face stamp's gift, or its ID stamp's, with a hash of the buy | One gift a person from each check; the same buy gets the same ticket |
| `payments` | The SHA-256 of each payment that opened an ID session, how many sessions it opened, whether it is used up, and when it opened its first, for 30 days | One payment, three sessions at most and one ID stamp |
| `fingerprints` | Each ID stamp's scrambled copies, each one value and its kind, `name` or `number`, beside its stamp number's keyed hash; one row for the same value twice. They go with the stamp number's `faces` row | No other stamp number gets an ID stamp for the same person ([The scrambled copy](#the-scrambled-copy)) |
| `faces` | Each stamp number's keyed hash whose face template Didit holds, and the day its five years end, when the sweep deletes its Didit user, its copies and the row; and whether its person deleted the face, which keeps the same day | One template a stamp number; whose face the copies can compare, and whose was deleted; nothing kept for good |
| `deletions` | Each stamp number's keyed hash whose person asked to delete their face, when it runs and, once it has, when it ran, for 90 days | Its day, its undo, and `POST /stamp` saying so |

Nothing else: no face, no embedding, no name, no birth date, no document, no address, none of the
list beside a stamp, no `vendor_data` but a stamp number's keyed hash in the last three, and of a
payment nothing of who paid or with what, no amount, and nothing beside a stamp number. Facts are a
one-way hash of the list: without the exact embedding, which no new photo gives again, and the
salts, which take the verifier's secret, no guess can be tested against them; the scrambled copies
take the secret too. A session id is in clear only in `to_delete`, `opened` and `refused`, with a
time in the first two, for a day at most. Deleted bytes are overwritten (`secure_delete`). The stamp
number links the first tables, and its keyed hash, which takes the secret to make, the last three,
so whoever also holds what Didit keeps of those sessions can tell which face went with which name.
Didit can tell which face check and which ID check are one person's, since they are one Didit user,
and whoever holds both the verifier's secret and what Didit keeps can go from a stamp number to a
person.

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
| `POST /id/payment` | `{"stampNumber": "<decimal>"}`, and may add `"returnUrl": "<url>"`, a page on an origin in `APP_ORIGINS` where Stripe sends the person after, paid or not | `201 {"payment", "clientSecret"}`, for the payment page; with `returnUrl`, `201 {"payment", "url"}`, Stripe's page |
| `GET /id/pay` | none: `#<clientSecret>` after its address | `200`, [the payment page](#the-payment-page) |
| `POST /id/session` | `{"payment": "<as POST /id/payment answered it>"}`, and may add `"returnUrl"`, as for a face session | `201 {"sessionId", "url"}` |
| `POST /id/stamp` | `{"sessionId", "stampNumber", "payment"}`, and may add `"gift"` | `200 {"stamp", "face"}`, `face` the face stamp signed from the same selfie, or `null`; with `"gift"` if asked |
| `POST /id/cancel` | `{"payment": "<as POST /id/payment answered it>"}` | `200 {"cancelled": true}`: its hold cancelled, now or before, while it gave no stamp ([The ID check's payment](#the-id-checks-payment)) |
| `POST /stamp` | `{"stampNumber": "<decimal>"}` | `200 {"face", "id", "faceTriesLeft", "deletion"}`: a stamp or `null`, a list of stamps, a number, and `{"state": "requested", "runsOn"}`, `{"state": "done", "doneOn"}` or `null` |
| `POST /delete` | `{"stampNumber": "<decimal>"}` | `200 {"deletion": {"state": "requested", "runsOn": "<YYYY-MM-DD>"}}`: its face deleted on that day ([Deleting a face](#deleting-a-face)) |
| `POST /delete/undo` | `{"stampNumber": "<decimal>"}` | `200 {"deletion": {"state": "undone"}}`, while it waits |

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
- **`403`, the check does not count:** Didit's refusal, the first that applies ([Didit
  decides](#didit-decides)): `known_person`, `known_face`, `too_young`, `face_mismatch`,
  `id_unclear`, `face_unclear`, `other`; and `unknown_session`, `wrong_workflow` (another workflow's
  session, or an approved one without a step its check needs), `expired`, `not_approved`.
- **`409`:** `session_used` (opened for or given to another stamp number, or its hour is over),
  `payment_used` (it gave its stamp, opened its three sessions, or its hold was cancelled),
  `face_tries_used` (the stamp number's free face check is used), `nothing_to_delete` (the stamp
  number holds no stamp), `nothing_to_undo` (no face deletion waits).
- **Others:** `404 not_found` (no route); `405 post_only`, `405 get_only`; `413 too_large` (over
  4 KB); `502 face_check_unavailable`, `502 payment_unavailable` (Stripe, or its prices not yet said);
  `503 not_for_sale` (no Stripe); `500 internal`.

## How we run it

### Settings

| Variable | Default | What | Ours |
|---|---|---|---|
| `VERIFIER_NAME` | `verifier.forest.foundation` | Its name, which never changes | the default |
| `DIDIT_API_KEY` | required | From the one Didit application both checks run in. A secret | the foundation's, for "forest id" |
| `DIDIT_FACE_WORKFLOW_ID` | required | The face check's workflow; a session on another is refused | "Forest face (Didit decides)", `04e9abf2-32f9-458d-8512-ba161d13fdc0` |
| `DIDIT_ID_WORKFLOW_ID` | required | The ID check's workflow; the same | "Forest ID (Didit decides)", `f3522a67-2676-4d32-a8ca-b1d25d50d73e` |
| `DIDIT_BASE_URL` | `https://verification.didit.me` | For a stand-in Didit | the default |
| `FACE_MODEL` | `sface` | Or `stand-in`, with `DIDIT_BASE_URL` on loopback | `sface` |
| `APP_ORIGINS` | none: no `returnUrl`, and no app frames the payment page | Where Didit and Stripe may send a person back, and the apps that may frame the payment page, by origin, comma-separated | the Forest app, https://app.forest.foundation |
| `STRIPE_SECRET_KEY` | none: the ID check is not for sale | Stripe's secret key, `sk_…`, or a restricted one, `rk_…`. A secret | a test-mode key, for "Forest" at Stripe, added by hand in Railway |
| `STRIPE_PUBLISHABLE_KEY` | required with the key | Its publishable key, `pk_…`, of the same mode, test or live, for the payment page. Public | the test-mode key's, added by hand in Railway |
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
Stripe key or Price that is not one (quoting no key), or a key without both Prices and a publishable
key of its own mode. It never waits
for Stripe to start: it asks for the prices once it runs ([Its keys](#its-keys)).

### Didit

- **The foundation pays per check:** $0.10 a face check and $0.30 an ID check, on Didit's list. The
  cost is capped at Didit by a prepaid balance with no auto-refill. The ID check's price is in
  [Stripe](#stripe).
- **One free face check a stamp number:** each costs the foundation at Didit, so a person whose face
  check fails takes the ID check, which they pay for.
- **One application,** "forest id", with both workflows.
- **"Forest face (Didit decides)":** liveness with face search and an age estimate; a duplicated
  face is declined, and so is a face estimated under 21.
- **"Forest ID (Didit decides)":** a document, liveness and a face match; a possible duplicated user
  takes no action, as Didit's name check compares a document only with ID checks Didit still holds,
  ours are gone an hour after their stamp, and it refuses without comparing faces ([Didit
  decides](#didit-decides)); a duplicated face takes no action, so twins and look-alikes pass; a
  face match under 40 is declined; a document showing under 18 is declined; no setting sends a check
  to review.
- **Up to three takes in a check,** on either workflow.
- **Retention:** Didit's Growth plan, which keeps a check up to five years, its face images and face
  template too, as `biometric_retention.deletes_at` on the check says. The verifier deletes every
  session it opens ([The sweep](#the-sweep)).

**The consent screens.** `GET /` serves each, and an app shows what it gets, before its check.

**The face check's consent screen.** `face.consent`:

> Forest, run by the Open Forest Foundation, checks your face with Didit, its provider, to make sure
> each person is counted once. The check is free, once, and within it you can take your selfie up to
> three times. Didit also uses your selfie to estimate your age: Forest is for people 18 and older,
> and a face it estimates to be under 21 is refused, so you take the ID check, which reads your
> birth date. Didit keeps your selfie and a short video while it checks. An hour after your stamp is
> signed, Forest deletes the check at Didit, which still keeps a template of your face (numbers, no
> photo), and after an ID check your name, birth date and your ID's country with it, until you
> delete your face or five years pass, so it can tell if you come back; it keeps no second template
> when it already holds one of yours. A check that does not pass is deleted at Didit once Forest has
> its answer, a day after it began at the latest, and one left unfinished a day after it began.
> Forest keeps nothing about who you are: only the stamp it signed you, a one-way hash of what the
> check saw, so it can hand it back if you lose it. It gives you a face stamp, with the face model's
> name and the 128 numbers it makes from your selfie beside it, for you to keep; a profile that
> shows it says only that you were checked.

**The ID check's consent screen.** `consent`, where apps read it before the face check had its own:

> The check's price is held through Stripe for the Open Forest Foundation and covers up to three
> tries in a day: it is taken only if the check gives you a new stamp, and is otherwise released
> within two days. Stripe keeps your payment details and email; Forest keeps of the payment only a
> one-way hash and how it was used, for 30 days, never beside your stamp. Forest, run by the Open
> Forest Foundation, checks your face and a government ID with Didit, its provider, to make sure
> each person is counted once. Didit checks the birth date on your ID: Forest is for people 18 and
> older. Didit keeps photos of your ID, what it reads on it, your selfie and a short video while it
> checks. An hour after your stamp is signed, Forest deletes the check at Didit, which still keeps a
> template of your face (numbers, no photo), with your name, birth date and your ID's country, until
> you delete your face or five years pass; it keeps no second template when it already holds one of
> yours. A check that does not pass is deleted at Didit once Forest has its answer, a day after it
> began at the latest, and one left unfinished a day after it began. To count each person once,
> Forest's verifier keeps beside your stamp a scrambled copy of your first name, first last name and
> birth date. If your ID shows a personal number meant to last a lifetime (such as Mexico's CURP),
> it also keeps a second one of that number and your ID's country. Neither can be read back: each
> can only tell whether something given to it matches. Until five years after Didit first kept your
> face, an ID check on another passkey that shows your name and birth date, or your number, is
> checked against your face: the same face is refused, a different face passes. If you have deleted
> your face, such a match is refused unless the two IDs show different numbers. Five years after
> Didit first kept your face, both copies are deleted. So if you lose this passkey, no new one can
> get an ID stamp for you until then, whether or not you delete your face. Your own check is refused
> the same way if it matches someone already counted. Beside them, Forest keeps only the stamps it
> signed you, a one-way hash of what each check saw, so it can hand them back if you lose them. It
> gives you an ID stamp, with every text field read from your ID beside it (your name, date of
> birth, document number and the rest), for you to keep, and a face stamp from the same selfie if
> you have none yet; a profile that shows either says only that you were checked.

**The line the person ticks.** `agree`, one tick before either check:

> I am 18 or older and I agree

**The right to cancel.** `id.cancelRight`, which the person agrees to before the ID check, so it
starts at once; until it gives a stamp, the app cancels it with `POST /id/cancel`:

> I ask for the ID check to start now, and I understand that I lose my right to cancel it once it is
> done.

**Deleting a face.** `face.deletion`, which the app shows before `POST /delete`:

> Deleting your face waits 28 days, and you can undo it until then. Then Didit erases your checks,
> the template of your face and what it keeps with it (after an ID check, your name, birth date and
> your ID's country). Your stamps stay, and the scrambled copies stay until five years after Didit
> first kept your face, then are deleted. Until then a new passkey still can't get an ID stamp for
> you, the same as if you had kept it.

**Data law:** the Open Forest Foundation is the responsible party for both checks, so two things sit
outside this code: a processing agreement with Didit, and Didit's retention setting. Paperwork and a
setting; nothing here does them. The consent screens above are this code's, and an app shows them.

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
  hold money; the verifier names no method. On the payment page, only those that need no other page:
  ours are cards, Apple Pay, Google Pay and Link.
- **Apple Pay and Google Pay on the payment page** need both the app's domain and the verifier's
  registered with Stripe as payment method domains, under the key's business: ours,
  app.forest.foundation and verifier.forest.foundation, are, by hand.
- **The hold:** a card's usually lasts 7 days at Stripe; the verifier cancels each within two.
- **Its API version:** every request sends `Stripe-Version: 2026-10-28.endive`, the version its code
  and its stand-in follow, so a new default version at Stripe changes nothing here.
- **What Stripe sees:** what the person pays with, their email, the name, country and, for some
  countries, postal code it asks for, their device's network address, and the app's page they come
  back to, or, on the payment page, that page and the app framing it. The verifier tells it only the
  Price, its mark, `check: id`, on the session and its PaymentIntent, the text by its Pay button
  and, for the payment page, that the session is embedded and sends the person nowhere: never a
  stamp number, a Didit session or anything from the ID. It reads back only each Price's amount and
  currency, and whether the payment holds the money or took it, since when, and the mark.
- **A test-mode key** takes only Stripe's test cards, which anyone can look up, so it charges
  nobody, and a payment made under it is unknown to a live key: `not_paid` there.
- **Paid and still waiting?** Write to support@forest.foundation.
- **A live key** is a restricted one with only Prices: Read, Checkout Sessions: Write and
  PaymentIntents: Write, all the verifier uses, for a business at Stripe that is the foundation's,
  with live Prices in `STRIPE_ID_PRICE` and `STRIPE_ADDED_ID_PRICE`, and its live publishable key in
  `STRIPE_PUBLISHABLE_KEY`.

### Public, secret, kept

- **Public:** this code, these settings, its name and its two keys.
- **Secret:** the secret its keys are derived from, the passphrase of its locked copy,
  `DIDIT_API_KEY` and `STRIPE_SECRET_KEY`.
- **Kept, not published:** [What it keeps](#what-it-keeps), the stamp numbers given a gift among it.
- **Logged:** its port, that it made its secret, an error's kind, what Didit did with a face it was
  asked to keep and did not, and why Stripe or Didit failed: at each 502, at a cancel Stripe did not
  answer, at a search for old holds Stripe did not answer, at an ask for the prices Stripe did not
  answer, beside how many of their cancels it refused, and at a sweep beside how many deletions of a
  session or a user, questions about a session, and face deletions Didit did not answer, the error's
  kind and, when
  one answered, its HTTP status and codes (Stripe's error `type`, `code` and `param`; Didit's
  `code`), each only if it is lower case, digits, `_`, `.` and brackets, at most 64 characters, and
  not shaped like a Stripe key or a Checkout Session's id or client secret. Never what either said
  in words, a key, a session, a payment or its client secret.

### The image and the commands

One replica, never more, since the sessions and payments are one SQLite file, and an ID stamp's last
steps, its hold taken among them, one at a time in its one process; a volume for `DATABASE_PATH` and
its secret, or a deploy loses who was signed for which stamp number, the scrambled copies, and the
secret. Ours runs on Railway; any platform with Node 22.18 and a persistent disk will do.
`deploy/Dockerfile`, built from the repo root: Node 22.22.2 and git, `standard.sh`, `npm ci`, `npm
run fetch -- models`, then `npm start`.

```
./standard.sh                     # from the repo root: the standard, at its pin
(cd host && npm ci)               # the host's credits client and seller, for the gifts' tests
cd verifier && npm ci             # the standard's packages, linked by name from ../standard/
npm run fetch                     # the face models and the three test portraits, checked by SHA-256
npm run check && npm test
npm start                         # with the settings above
```

**The secret's locked copy,** made once, by hand, by the foundation, on a computer with
[age](https://age-encryption.org) and Railway's command line: the secret goes from the volume
through a pipe into `age`, which locks it with a passphrase it asks for without showing it, one the
foundation's password manager made and keeps; the locked file is kept beside it there. The secret
never shows on a screen, in a log or in a chat. `DATABASE_PATH` is the service's own setting, read
on its machine:

```
railway ssh -- sh -c 'cat "$(dirname "$DATABASE_PATH")/verifier-seed.json"' | age -p -a > verifier-secret.age
```

On a new volume, to bring it back: the verifier has made a new secret there at its first start, so
the copy is written over it, and the service restarted; a stamp signed between the two is lost.

```
age -d verifier-secret.age | railway ssh -- sh -c 'umask 077 && cat > "$(dirname "$DATABASE_PATH")/verifier-seed.json"'
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
`data/sandbox/`. With `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, both Prices and `APP_ORIGINS`
set, the ID check is paid in Stripe's test mode, with a test card; it refuses a live key.

`test/` covers, against a stand-in Didit and a stand-in Stripe, a real SQLite file and real HTTP:
both checks, one Didit user a stamp number, each of Didit's refusals as its code and their order, a
refusal kept and deleted at once, whether the app asked or not, a Didit user deleted only when its
stamp number holds no stamp and has no session open, the `vendor_data`, the ID check's hold, its
tries, its cancels and its clock, its two prices and the payment's lock, the payment page's headers
and its script, run with a stand-in for Stripe's, and its one message, an ID stamp for each document
and the face stamp an ID check gives, the free face check, the age refusals, cancelling an ID check,
which sessions keep their faces, the scrambled copies, the number copy's list and each row of the
rule that refuses or passes a check, Didit's own name check left out, a face deleted, undone and its
day, a face's five years over and the copies going with them, a payment forgotten after its 30 days,
the Stripe and Didit clients' requests, verifications and a facts proof made from the stamps and
checked against the published keys, the lists, their salts and the `vendor_data` hash against pinned
vectors, what is read of Didit's decision and ID report, stamps asked back, the secret, the sweep,
the raw file and one an earlier version wrote, the face models on three portraits, both gifts'
tickets taken by the host's own seller, what `GET /` says of the ID check's sale, what a failure at
Stripe or Didit logs, the fetch's retries, and this README's consent screens and lines, codes and
Stripe's page text, as the code has them.

## Promises

- **It keeps which check session gave which stamp number, the stamps it signed and how many free
  face tries each stamp number used, and for each ID stamp one scrambled value of its first name,
  first last name and birth date and, when its ID shows a personal number meant to last a lifetime
  from a country on its list, a second of that number and the country, each made by scrypt under a
  key from its secret, slow on purpose, and deleted five years after Didit first kept the face, and
  nothing else of a check; of a payment, only a hash, how many sessions it opened and whether it is
  used up, for 30 days, beside the sessions it opened only while it is open, a day at most, and
  never beside a stamp number.** No face, no embedding, no name, no birth date, no document, and no
  session id in clear once a session is deleted in Didit, but a refused one's id and code, kept till
  a day after it opened so the app still gets its code. Beside a stamp number's keyed hash it keeps
  only its scrambled values, whether Didit holds its face, till when, whether its person deleted it,
  and its face deletion's days. Deleted bytes are overwritten. A test reads the raw file for names,
  birth dates, embeddings, references, payment ids and session ids.
- **It never logs a request, an address, a session, a stamp number or a stamp, and never writes down
  an address.** It logs an error's kind, never its message.
- **It takes no key of the person's, has no sign-ups, and nothing it keeps ties a person to a
  profile.** An app sends a session and a stamp number, as a POST body, never in a URL, since hosting
  platforms log paths. No request names a profile: the verification is made on the person's device.
- **It signs a stamp only for a check Didit approved, on that check's workflow, and a key's recipe
  never changes.** It will not start without Didit; the face and ID keys sign stamps, the sponsor
  key tickets, nothing else; a new recipe is a new key.
- **It deletes in Didit every session it opens: one that gave a stamp an hour after it was first
  signed, keeping only a template of the face; a refused or unfinished one within a day. The
  template, and the name, birth date and country Didit keeps with it, go 28 days after a face delete
  is asked, or after five years.**

## Limits

- **A changed name can give a second ID stamp:** someone whose name changed and whose CURP was
  reissued matches neither copy, so their face is never checked, and they can get a second ID stamp
  on another seed; so can anyone whose name changed and whose ID shows no lifelong number.
- **Someone who has Didit erase their data,** not by `POST /delete`, can get an ID stamp again on
  another seed: the verifier still counts their face as there, and a face Didit no longer holds
  matches nobody.
- **A deleted face lets a person get a new face stamp:** on another seed, the face check finds no
  face of theirs.
- **A lost seed means no new ID stamp for five years after Didit first kept the face,** whether or
  not its person deleted it: a new seed's ID check matches the old one's copies, and is refused if
  Didit names the face, or always once it is deleted. After that the copies are gone, and it counts
  as new.
- **A second ID with a differently written name can get through:** a licence without a
  machine-readable zone beside a passport, a letter the zone spells its own way (`Ø` for `OE`), or
  another name first, gives another first name or first last name, so the name copy does not match,
  and with no number copy to match, no face is compared.
- **Didit lists only its closest face matches,** five at most: a check whose face is like more than
  five others' can miss the one whose copy it matches.
- **A stranger who shares a person's first name, first last name and birth date is refused** once
  that person deleted their face, `known_person`, unless both IDs show a lifelong number and the
  numbers differ, and nobody reviews it; for five years after Didit first kept that face.
- **A twin or a look-alike is refused the face check,** `known_face`, and nobody reviews it; the ID
  check takes no action on a face seen before, so it is open to them, and gives them a face stamp
  too; a twin who shares the name and a birth date is refused it, `known_person`, if Didit names
  their twin's face, as it can when the faces are alike.
- **A face is Didit's to compare,** by settings the verifier cannot see: a check Didit approves is
  signed for the stamp number the person brings, unless another stamp number's copies match and the
  rule above refuses it.
- **A person can hold a face stamp on one seed, and an ID stamp and a face stamp on another:** a
  face check reads no document, and the ID check takes no action on a face seen before, so it does
  not see the face check, and it gives a face stamp to a stamp number that holds none. Time solves
  it: an index trusts a profile more the more verifiers stand behind its seed.
- **Two people can hold stamps on one seed:** Didit leaves a user's own checks out, and the verifier
  never refuses a stamp number that holds an ID stamp.
- **Two face checks finished at the same moment do not see each other:** Didit compares a face only
  with checks it already approved.
- **A lost volume loses the scrambled copies,** the stamps kept to hand back and which faces Didit
  holds: the secret comes back from its locked copy, and with it the keys and each stamp number's
  hash, but a person whose copies were lost can get an ID stamp on another seed.
- **A lost volume and a lost locked copy** mean a new secret and keys, with no signed handover, and
  a new hash for every stamp number, so Didit refuses each person it knows as another user's, until
  the checks move to an application that has none. The name, and so the stamp numbers, stay.
- **Didit keeps a face template up to five years:** then a returning face is new to Didit, and the
  scrambled copies are deleted with it, so its person's next ID check on another seed counts as new.
- **Didit's age estimate can be off by years:** a person 18 to 20 whose face looks under 21 uses
  their free face check, and takes the paid ID check.
- **Till a person's face is deleted or its five years end, Didit's list of users shows** the full
  name, birth date and country each of their ID checks read, deleted ones too.
- **A refusal the app never asks about ends no payment:** its hold waits for the hourly search, two
  days after it was held.
- **After the hour, a lost answer loses the list beside the stamp for good:** the stamp comes back
  from `POST /stamp` without it, and a new check gives a new stamp, with its own.
- **The payment page offers only payment methods that need no other page:** a bank's own page is on
  Stripe's page only.
- **A stamp describes the document as it was on the day of the check:** a renewed document takes a
  new, paid ID check, and the old stamp stays good.
- **The same document checked twice gives a second stamp for it:** the person paid, and an index
  counts the ID key once.
- **Each seed is its own stamp number,** so a new one, as a new passkey in an app gives, starts the
  free face check over.
- **A face session no app asks a stamp of is no try,** however Didit finished it.
- **Stamps signed before this code kept them do not come back:** `POST /stamp` holds none, and the
  person checks again.
- **For a day at most, `to_delete`, `opened` and `refused` name the sessions:** whoever reads the
  file can ask Didit about those it still has.
- **A deletion Didit does not answer** leaves the session there, images and all, till a later sweep.
- **It trusts Didit's decisions,** and relies on the workflow settings above, which it cannot see.
- **The answer that signs a stamp says who the person is:** keep it as a key is kept.
- **A lost gift is lost:** another buy gets `given`.
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

**Can someone read my name or my number from the scrambled copies?**
No. Each copy is one value, made by a scramble slow on purpose, under a key derived from the
verifier's secret: the name copy of your first name, first last name and birth date together, the
number copy of a lifelong number and its country. Without the secret nobody can test a guess against
one. With it, the secret's holder can only test a name and birth date, or a number, they already
guess, a fifth of a second each: trying every birth date for a name they know takes hours, and
reading back the whole table thousands of years. That holder can already go from a stamp number to a
person with what Didit keeps.

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
