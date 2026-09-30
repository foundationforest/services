# How this index scores

Three scores. They are never added together or blended into one number. A badge means real and
accountable, not good.

- **Uniqueness**, per badge: how sure this index is that a badge belongs to one real human.
- **Rating**, per profile, from 1.0 to 10.0: the `overall` ratings the people this profile dealt
  with gave it, averaged, each weighed by who gave it and by what backs it up.
- **Standing**, per profile, starting at zero: what the people this profile dealt with said about
  it, summed, weighed the same way.

These are this index's opinion, not the foundation's rule. The weights live in two files anyone
can change on their own copy, `config/issuers.json` and `config/scoring.json`; the market names come
from the `markets` repo (`MARKETS_URL`). Another index may weigh everything differently. The code is
`src/scores/compute.ts`, and it must say the same as this page.

## Badges: which ones count

A badge is one `Registered` entry the registry program itself wrote. It counts for a profile only
if all four are true:

1. **It is `market/role`, and its market is in the directory, byte for byte.** Such as
   `tutoring/seller`. The name before the slash must be the name of a market the `markets` repo's
   directory lists, exactly: no other case, no other spelling. The role after it must be one the
   market's sides allow: `seller` or `buyer` in a two-sided market, `peer` in a one-sided one. A
   market file's labels (`tutor`, `student`) are words for pages, never roles. A plain `market`,
   with no role, counts for nothing, and so does any other separator. If other spellings counted,
   one person could register under two and hold two badges in one market.
2. **It is the profile's own scope.** A profile is one folder in one market, as one side of it: its
   record names `market` and `role`, and a badge counts for it only under exactly that
   `market/role`. A badge under any other scope counts for nothing here, whoever holds it; a person
   in a second market, or on the other side of the same one, holds a second profile.
3. **The profile declares its wallet.** The entry names the wallet that signed the registration.
   The profile's own record must name the same wallet. Change the record's wallet and the badge
   stops counting at once.
4. **The profile exists** in this index.

## Uniqueness

For each counted badge (one market and role), take the owners of the lists that
vouch for it: the list owner each entry names. Each owner has a weight from 0 to 1 in
`config/issuers.json`. The foundation's issuer starts at 1; every other key is 0 until someone
sets it.

    uniqueness = 1 − (1 − w1) × (1 − w2) × …

- One issuer at weight w gives w.
- Two independent issuers count for more than either alone, and never more than 1. Two issuers at
  0.5 give 0.75.
- An issuer at 0 adds nothing.

The weight follows the owner the entry named when the badge was registered, not whoever owns the
list today.

## Evidence: what backs a review

A review can point at a deal with its `dealId`. When that id is an escrow's address, the index
reads that escrow's permanent receipt, built only from events the escrow program itself wrote.
The receipt counts only if:

- the reviewer and the reviewed are the escrow's buyer and seller, in either order, going by the
  wallets their profiles declare; and
- its token is one this index counts (`countedMints` in `config/scoring.json`; for now, USDC on
  mainnet and on devnet).

If it counts, the index asks who said yes. The escrow has no accept step: the seller says yes by
signing for the deal. That is creating the escrow (an invoice), signing its ending (a split, which
both sign, or a release back to the buyer, a refund), or reviewing the deal.

| What the receipt shows | Evidence | Weight |
|---|---|---|
| Paid, and the seller created it (an invoice) | both | 1 |
| Paid, the buyer created it, and the seller signed its ending (a split, or a refund) | both | 1 |
| Paid, the buyer created it, and the seller reviewed the same deal id | one-sided, confirmed | 1 |
| Paid, the buyer created it, the seller signed nothing (released to the seller, decided by an arbiter or by the timer, or not ended), and has not reviewed it | one-sided | 0.5 |
| Not paid yet, or closed unfunded | none | 0.05 |
| No deal id, an id with no receipt, someone else's receipt, or a token not counted | none | 0.05 |

"Paid" means someone marked the escrow funded, or it ended. Every way out of the escrow pays out a
balance that held the amount (the program checks it), so an ending proves the payment; a one-tap
payment is never marked at all.

## Standing

Each review received adds:

    reviewer's weight × evidence weight × signal

- **Signal:** from the review's `overall` rating, `(overall − 5.5) / 4.5`: 10 is +1, 5.5 is 0, 1
  is −1, in a straight line between. A review with no `overall` says neither good nor bad, so it
  adds 0; it still shows in the list. Other rating names (`patience`, say) show on the review and
  weigh nothing here.
- **Reviewer's weight:** `max(u, 0.05) × (1 + t / (|t| + 1))`.
  - u is the reviewer's best uniqueness on any counted badge. A reviewer with no counted badge gets
    the floor, 0.05, so its review weighs near zero.
  - t is the reviewer's own standing. It moves the weight between nothing and twice the base, and
    a reviewer in low standing weighs less than a new one.

Because each reviewer's weight depends on its own standing, the index repeats the sum:

1. Start everyone at 0.
2. Compute every profile's standing from the others' current standing.
3. Repeat until no profile moves by more than 0.000000001, or 100 rounds.

Rules that stop cheap inflation:

- A review of yourself is ignored.
- Per reviewer and subject, one review counts per deal id that has evidence under it. All reviews
  with no evidence count once in total: the latest. Inventing deal ids adds nothing.
- Standing can go below zero. A person cannot shed it by starting over in the same market: one
  human, one badge per market.

What these rules do not stop: two real people who agree to run many small real deals and praise
each other. The handoff bounds that by identity (one badge per human per market) and by reviewer
standing. A minimum amount, or less weight for repeat deals between the same two, are open questions
in `docs/changes.md`.

A worked example (the end-to-end test):

- Ana and Ben are each badged at 1. Ana invoiced Ben and he paid, so both said yes; each gave the
  other an overall of 10 on that deal. Each converges to 1.618 (the golden ratio:
  x = 1 + x / (x + 1)).
- Cleo's badge does not count, because her profile declares another wallet. She gives Ana an
  overall of 1 with a made-up deal id, which takes off 0.05 × 0.05 × 1 = 0.0025.
- Cleo, with no reviews, stays at 0.

## Rating

The reviews that count for standing, and give an `overall`, averaged with the weights standing
gives them:

    rating = Σ (reviewer's weight × evidence weight × overall) / Σ (reviewer's weight × evidence weight)

- The same reviews count as for standing: not a review of yourself, and per reviewer and subject
  one per deal id with evidence under it, and one in all without. The reviewer's weight is the one
  standing ends with.
- It stays between 1.0 and 10.0, since it is an average of ratings in that range. It says how the
  people who dealt with this profile rated it; standing says how much weight their word carries in
  sum. A new profile with one good review has a high rating and a small standing.
- No review that counts gives an `overall`: no rating, rather than a zero.

In the example, Ana's rating is Ben's 10 at weight 1.618 and Cleo's 1 at weight 0.0025, so 9.986,
shown as 10.0. Ben's is Ana's 10 alone.

## How the pages show them

- **Side by side, never as one number.** A market lists badged sellers first, then by standing:
  two keys, one after the other.
- **Uniqueness** as a percentage on each badge ("how sure this index is that it is one real
  person"), with who vouched.
- **Two numbers wherever a profile appears** (an offer, a profile, the two sides of a receipt):
  the rating, with one decimal, out of 10 and with how many reviews give it, or "no rating yet";
  and standing, as its number, with the counts beside it on the profile page: how many reviews
  counted and how many a payment backs. A raw sum means little alone.
- **For machines,** the JSON twins carry `rating` (`value`, `reviews`) and `standing`. Each
  profile's JSON-LD carries an `AggregateRating` from the rating, with `bestRating` 10 and
  `worstRating` 1, and `reviewCount` the counted reviews that give an `overall`; no such review,
  no `AggregateRating`. Each offer carries its seller's `aggregateRating` too, and standing as a
  `PropertyValue` named `standing`, since schema.org has no place for it on a person.

## Signatures

Every score is served with a statement and two signatures. Both public keys are at `/`.

The statement, as text:

    forest.foundation/index/v1/score
    kind uniqueness            (or standing, or rating)
    did did:plc:…
    scope online-tutors/seller (empty for standing and rating)
    value 1000000              (millionths; may be negative for standing; a rating of 8.5 is 8500000)
    at 1790300000              (unix seconds, when this value was first computed)

- **Ed25519** signs the statement's UTF-8 bytes.
- **EdDSA-Poseidon** on BabyJubJub (zk-kit's, the scheme Semaphore itself uses) signs one field
  element:

      Poseidon(domain, kind, did, scope, value + 2^63, at)

  - `domain`: `fieldHash("forest.foundation/index/v1/score")`
  - `kind`: 1 for uniqueness, 2 for standing (trust's code, kept), 3 for rating
  - `did`: `fieldHash("forest.foundation/index/v1/did/", did)`
  - `scope`: the registry's own `scopeOf(scope)`, the exact number a registration proof carries,
    so a later proof can tie a uniqueness score to a badge; 0 for standing and rating
  - `value`: offset by 2^63, so a negative standing is still a small positive number a circuit can
    range-check

  `fieldHash` is the registry client's: keccak-256 of the namespace and the bytes, shifted right one
  byte.

A score whose value has not changed keeps its statement and signatures, so a signature someone
already holds stays good. Both keys come from one 32-byte seed (`INDEX_SIGNING_SEED`) by
HKDF-SHA256, under the labels `forest.foundation/index/ed25519/v1` and
`forest.foundation/index/eddsa-poseidon/v1`.

## When scores change

Every time a record or a chain event arrives, the index waits a quarter of a second, then
recomputes everything. At this size that is simplest; an incremental recompute is later work.
