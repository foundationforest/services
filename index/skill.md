# Reading Forest: a skill for AI agents

Forest is an open place where each person is checked once, by face, to be one real human, and then
owns their profile, their offers and their reviews. People deal with strangers directly; a payment
is held between the two until both agree. This index reads the public records of every profile
counted here as one real person, and serves them to people as pages and to you as JSON. A profile
not counted is not here.

## How to read

- Everything is a plain GET. No key, no account, no sign-in, no cookies.
- Every page has a JSON twin at the same address with `.json` added to the path. The home page's
  twin is `/index.json`. The twin is the exact data the page shows.
- Answers may be up to 30 seconds old.
- Amounts in receipts are base units, as text. A price in an offer is whole units, as text
  (`"25"`, `"12.50"`). A price is optional: an offer may name none.
- In records, decimals are text: a price, a rating (`"8.5"`), a point's degrees (`"38.72"`). In
  the JSON twins, ratings and scores are plain numbers.
- Start anywhere below; every answer links onward with full URLs (`url`, `profileUrl`,
  `marketUrl`, `dealUrl`).

## Search

    GET https://forest.foundation/search.json?q=portuguese

Returns `markets` (markets this index uses whose name, folder, roles or role names contain the
words) and `offers` (live offers whose text matches), ranked the same way as a market.

To browse instead: `https://forest.foundation/index.json` lists the folders and their markets;
`https://forest.foundation/folders/freelance-work.json` lists one folder's markets;
`https://forest.foundation/markets/online-tutors.json` lists a market's live offers.

In a market, offers are ranked: sellers counted as a real person in that market first, then by
standing, then newest. Page with `?offset=50`. A market has one name: another spelling is not
that market.

Near a place: add `near=lat,lon&km=N` to a market or a search, such as
`https://forest.foundation/markets/language-exchange.json?near=38.72,-9.14&km=10`. It keeps the
offers whose point is within N km, and leaves out offers that name no place.

The market file comes with its market (`market`): `description`, `sides` (`two`: a seller and a
buyer; `one`: peers), `roleNames` (the plain words for seller and buyer, such as tutor and student),
`ratings` (the rating names reviews there usually give),
`howDealsGo` (how deals there usually go, in plain text), and the extra fields offers and reviews
there carry.

Each offer carries `description`, `price` (`amount`, the currency as `mint`, and `per`: hour, day
or job; null when it names none), `terms` (optional: an `arbiter`, and a `timer` of `days`
to the `seller` or `buyer`; absent, neither), `availability`, `remote` and `location` (`lat`, `lon`,
`precisionKm`, `area`; either may be missing), `expires`, the seller's `profile`, `name` and
`profileUrl`, its `market` and `role` (its author profile's: an offer names neither), the seller's
`uniqueness`, `rating` and `standing`, and a `payLink` (none when it names no price).

## Read a profile

    GET https://forest.foundation/profiles/3ds35BYoks9R95FJ3XfwfvtuDGkaM3LeEiqUP2wWBfJm.json

A profile is one key: its address is its permanent name, and also where it is paid. One person may
hold several profiles; they are linked only if the person chose to link them. The answer carries:

- `address`, and `profile`: `name`, the one `market` it lives in and its `role` there (with `side`,
  the market's word for it), `about`, `contact`, and `read`, its reading key, for whoever makes a
  private record for it. A profile lives in one market, under one label (`market/role`); a person
  in two markets holds two profiles.
- `stamps`: every registry row of this profile's whose keeper this index trusts, counted or not.
- `scores`: `uniqueness` (one per counted label), `rating` and `standing`, each signed.
- `offers` and `requests`: its live offers, whether its own key or a writer key it allowed signed
  them.
- `reviews.received` and `reviews.given`: each with its `ratings` (by name, 1 to 10), its
  `evidence` (what payment backs it), the reviewer's weight, and what it added to standing. A
  review's market is the market of the profile it is about; `fields` are the ones that market's
  file adds to a review. `media` lists its photos and videos by the SHA-256 of their bytes; this
  index does not fetch them.

Private records are not here: only their readers can open them.

## Check a real person

A keeper keeps a list of stamps; the foundation's issuer keeps the human list, putting a person on
it once, after a face check. A profile shows it is on a list with a row in the registry, which names
the profile, the keeper, the label and the root of the list it proved against, without saying which
stamp is the person's. One person gets at most one row per keeper per label, so a second profile in
the same market needs a second person, or a second keeper. It means real and accountable, not good.

In `stamps[]`:

- `counted: true` means this index counts it. It counts only if all of these hold:
  - its `keeper` is one this index trusts (`keeper.name`, `keeper.weight`), and the keeper's
    signature on the row's `root` checks;
  - its `label` is a market this index uses and a role its sides allow, exactly
    (`online-tutors/seller`, `language-exchange/peer`); a plain market with no role counts for
    nothing;
  - it is the profile's own label: `profile.market` and `profile.role`.
- `why` says why not when it doesn't: `notAMarketHere`, `noRole` or `notTheProfilesLabel`
  (registered under another market or side than the one the profile lives in).
- `scores.uniqueness[]` combines the keepers of each counted label into one number from 0 to 1.

To check it yourself, without trusting this index: `row` is the address of the row's account in the
registry program on Solana. Read it: it names the profile's key, the keeper, the root, the keeper's
signature on the root (`keeperSignature`) and the label. Check that signature with the keeper's key:
it is ed25519 over the root's 32 bytes. Then decide whether you trust that keeper. This index's
keepers are listed at
https://github.com/foundationforest/services/blob/main/index/lists/keepers.json.

## Check a receipt

A review can name a deal. When a payment was held for it, the deal's ID is the payment's address,
and its record stays forever as a receipt.

    GET https://forest.foundation/deals/CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU.json

- `receipt`: `buyer` and `seller` (keys) with the profiles they name, if this index holds them
  (`buyerProfiles`, `sellerProfiles`, each with its `rating` and `standing`), `creator` (who
  started it; `seller` means the seller asked for the payment), `amount`, `mint`, `arbiter` and
  `timer` if set, `createdAt`, `fundedAt`, `endedAt`, `outcome`, `toSeller` and `toBuyer`, and
  `objection` (`by`, `side` and `at`) if one side objected, which moves no money.
- `outcome`: `releasedToSeller`, `releasedToBuyer`, `split`, `arbitrated`, `timerReleased`, or
  null while it is held.
- `receipt: null` means this index has no payment for the deal; the reviews that name it are still
  listed.
- `reviews`: every review that names the deal. Two reviews across one deal are the two sides.

How much a receipt backs a review (`evidence.kind` on the review):

| Kind | Meaning | Weight |
|---|---|---|
| `both` | paid, and the seller signed for it: asked for the payment, or signed a split or a refund | 1 |
| `oneSidedConfirmed` | paid by the buyer, and the seller reviewed the same deal | 1 |
| `oneSided` | paid by the buyer; the seller hasn't reviewed it | 0.5 |
| `none` | no receipt, someone else's, a currency not counted, or not paid; the reason is in `note` | 0.05 |

To check it yourself: the deal ID is the escrow account's address on Solana. Read that account, or
the escrow program's own events for it (`Created`, `Funded`, `Ended`, `Closed`, `Objected`).

## What the scores mean

Three scores. They are never added together.

- **Uniqueness**, per label, 0 to 1: how sure this index is that the profile is one real person
  there. `1 − (1 − w1) × (1 − w2) × …` over the weights of the keepers whose counted rows it holds.
- **Rating**, per profile, 1.0 to 10.0: the `overall` ratings of the reviews that count,
  averaged, each weighed by its reviewer and by the payment behind it. No review that counts gives
  one: no rating, not zero.
- **Standing**, per profile, any number, below zero too, starting at zero: the sum of the reviews
  received, each weighed by its reviewer (their uniqueness, then their own standing) and by the payment
  behind it. An overall of 10 adds, 5.5 is neutral, 1 takes away.

Pages show the rating and the standing side by side, as two numbers.

Both are this index's opinion, and the rules are open:
https://github.com/foundationforest/services/blob/main/index/README.md#how-it-scores. Another index
may weigh differently.

Every score is signed twice. Each score's `signed.statement` is the text signed with Ed25519, and
`signed.eddsaPoseidon` a second signature for later zero-knowledge proofs. The public keys and the
statement format are in `https://forest.foundation/index.json` under `index.keys` and
`index.statement`.

## Paying

An offer's `payLink` is one documented format:
https://github.com/foundationforest/services/blob/main/index/README.md#the-pay-link. It names the
offer (its profile's address, then `offer/<id>`) and the id of the record that holds it (`record`),
and repeats its price and terms. The seller is the profile the offer names, paid at its address:
the link carries no other key. This index never pays and never holds money.

An example, from this index's test data:

    https://forest.foundation/pay?v=2&offer=3ds35BYoks9R95FJ3XfwfvtuDGkaM3LeEiqUP2wWBfJm%2Foffer%2Fportuguese&record=3192bff03b2c8009281f892c58d389cbecc3ac99e2d93655e692e2e2ba4ff302&price.amount=25&price.mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&price.per=hour

Its twin, `https://forest.foundation/pay.json?…` with the same query, says whether the link still
matches the offer (`check`: `matches`, `changed`, `differs`, `notLive`, `noPrice`, `notFound`,
`invalid`). An offer with no price has no Pay link.

## Examples

The profile and deal examples above (Ana, and her deal with Ben) are this index's test data. On a
live index, start from `https://forest.foundation/index.json` or a search and follow the links.
Every page is also listed in `https://forest.foundation/sitemap.xml`.
