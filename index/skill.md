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
- In records, money and decimals are text: a price is whole units (`"25"`, `"12.50"`), a rating
  `"8.5"`, a point's degrees `"38.72"`. Amounts in receipts are base units, as text. In the JSON
  twins, ratings and scores are plain numbers.
- Every answer links onward with full URLs (`url`, `profileUrl`, `marketUrl`, `dealUrl`).

## Search

    GET https://forest.foundation/search.json?q=portuguese

Returns `markets` (the markets this index uses whose name, folder, roles or role names contain the
text) and `offers` (live offers whose text matches), ranked as in a market.

To browse instead: `https://forest.foundation/index.json` lists the folders and their markets;
`https://forest.foundation/folders/freelance-work.json` lists one folder's markets;
`https://forest.foundation/markets/online-tutors.json` lists a market's live offers.

In a market, offers are ranked: sellers counted as a real person in that market first, then by
standing, then newest. Page with `?offset=50`. A market has one name: another spelling is not that
market.

Near a place: add `near=lat,lon&km=N` to a market or a search, such as
`https://forest.foundation/markets/language-exchange.json?near=38.72,-9.14&km=10`. It keeps the
offers whose point is within N km, and leaves out offers that name no place.

A market's answer carries its file (`market`): `description`, `sides` (`two`: a seller and a buyer;
`one`: peers), `roleNames` (the plain words for seller and buyer, such as tutor and student),
`ratings` (the rating names reviews there usually give), `howDealsGo` (how deals there usually go,
in plain text), and the extra fields its offers and reviews carry.

Each offer carries:

- `description`, `availability`, `remote`, `expires`;
- `price`: `amount`, the currency as `mint`, and `per` (hour, day or job); null when it names none;
- `terms`: an `arbiter`, and a `timer` of `days` to the `seller` or `buyer`; absent, neither;
- `location`: `lat`, `lon`, `precisionKm`, `area`; `remote` or `location` may be missing;
- `media`: its photos and videos (Pictures, below);
- the seller's `profile`, `name`, `profileUrl`, `uniqueness`, `rating` and `standing`;
- its `market` and `role`: its author profile's, since an offer names neither;
- a `payLink` (Paying, below); none when it names no price.

## Read a profile

    GET https://forest.foundation/profiles/3ds35BYoks9R95FJ3XfwfvtuDGkaM3LeEiqUP2wWBfJm.json

A profile is one key: its address is its permanent name, and also where it is paid. A profile lives
in one market, under one label (`market/role`); a person in two markets holds two profiles, linked
only if the person chose to link them. The answer carries:

- `address`, and `profile`: `name`, the `market` it lives in and its `role` there (with `side`, the
  market's word for it), `about`, `photo` (Pictures, below), `inboxKey` and `inbox` (Write to a
  profile, below).
- `stamps`: every registry row of this profile's whose issuer this index trusts, counted or not
  (Check a real person, below).
- `scores`: `uniqueness` (one per counted label), `rating` and `standing`, each signed.
- `proofs`: the reputation proofs its card carries that this index shows.
- `offers` and `requests`: its live offers, whether its main key or an access key it allowed
  signed them.
- `reviews.received` and `reviews.given`: each with its `ratings` (by name, 1 to 10), its
  `evidence` (what payment backs it), the reviewer's weight, and what it added to standing. A
  review's market is the market of the profile it is about; `fields` are the ones that market's
  file adds to a review. `media` lists its photos and videos.

Private records are not here: only their readers can open them.

## Pictures

A profile's `photo`, and each `media` of an offer or a review, is a photo or a short video:
`sha256`, the SHA-256 of its bytes; `mimeType`, `image/png`, `image/jpeg` or `video/mp4`; and
`url`, where a host that holds it serves it, or null when no host this index reads holds it. The
bytes are on the hosts, never here. Check the SHA-256 of what you fetch yourself.

## Write to a profile

A profile whose `profile.inbox` is set takes messages, on its own hosts. `inbox.senders` is
`anyone`, or `{ "issuer": <key> }`: the sender's key must hold a registry row from that issuer
(128 hex characters, as a row holds it), under any label. `once` means one message from each
sender, ever; `maxBytes` is the largest it takes; `readers` are keys every message is encrypted
to besides `inboxKey`. No message passes through this index.

How to send one is forest's: its records' Inbox section,
https://github.com/foundationforest/forest/blob/main/records/README.md, or the CLI, `send`
(https://github.com/foundationforest/services/blob/main/mcp/README.md). The hosts this index reads
are in https://github.com/foundationforest/services/blob/main/index/lists/hosts.json.

## Check a real person

An issuer signs a person a note after the checks it chooses; the foundation's issuer checks a face
once, and, for a person who asks, a government document too. A profile shows it holds a note with a
row in the registry, which names the profile, the issuer's key and the label, without saying who the
person is. One person gets at most one row per issuer per label. It means real and accountable, not
good.

In `stamps[]`:

- `counted: true` means this index counts it. It counts only if all of these hold:
  - its `issuer` is one this index trusts, by its key (`issuer.key`, `issuer.name`, and
    `issuer.weight`, its weight at the row's tier);
  - its `label` is a market this index uses and a role its sides allow, exactly
    (`online-tutors/seller`, `language-exchange/peer`); a plain market with no role counts for
    nothing;
  - it is the profile's own label: `profile.market` and `profile.role`.
- `why` says why not when it doesn't: `notAMarketHere`, `noRole` or `notTheProfilesLabel`
  (registered under another market or side than the one the profile lives in).
- `tier` is the tier the profile's card shows for the row, with a person proof this index checked
  against it, or null; `badge` says it in words: `ID-checked` for tier 2.
- `scores.uniqueness[]` combines the issuers of each counted label into one number from 0 to 1.

To check it yourself, without trusting this index: `row` is the address of the row's account in the
registry program on Solana
(https://github.com/foundationforest/forest/blob/main/registry/README.md). Read it: it names the
profile's key, the row's stamp, the issuer's key and the label, and the program wrote it only after
checking the person proof against that key. Then decide whether you trust that issuer. This
index's issuers are listed at
https://github.com/foundationforest/services/blob/main/index/lists/issuers.json.

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

What backs a review is its `evidence.kind`, weighed by `evidence.weight`:

- `both`: paid, and the seller signed for it (asked for the payment, or signed a split or a refund);
- `oneSidedConfirmed`: paid by the buyer, and the seller reviewed the same deal;
- `oneSided`: paid by the buyer; the seller hasn't reviewed it;
- `none`: no receipt, someone else's, a currency not counted, or not paid; the reason is in `note`.

To check it yourself: the deal ID is the escrow account's address on Solana. Read that account, or
the escrow program's own events for it (`Created`, `Funded`, `Ended`, `Closed`, `Objected`).

## What the scores mean

Three scores, never added together:

- **Uniqueness**, per label, 0 to 1: how sure this index is that the profile is one real person
  there.
- **Rating**, per profile, 1.0 to 10.0: the `overall` ratings of the reviews that count, averaged,
  each weighed by its reviewer and by the payment behind it. No review that counts gives one: no
  rating, not zero.
- **Standing**, per profile, any number, below zero too, starting at zero: the reviews received,
  summed, each weighed the same way. An overall of 10 adds, 5.5 is neutral, 1 takes away.

Pages show the rating and the standing side by side, as two numbers. Both are this index's opinion,
and the rules are open:
https://github.com/foundationforest/services/blob/main/index/README.md#how-it-scores. Another index
may weigh differently.

Every score is signed: `signed.statement` is the text, and `signed.ed25519` its Ed25519 signature,
in hex. The public key and the statement format are in `https://forest.foundation/index.json` under
`index.keys` and `index.statement`.

## Check a reputation proof

Nothing public links one person's profiles. A person may still show, on one profile, a rating
proven from their own profiles in an index's reputation tree, naming none of them. Each of
`proofs[]` gives `score`, out of 10; `label` and `market` when it shows one market, or null when it
counts profiles it does not name; `index`, whose tree it was made from, with its `name`; and `root`
and `time`, the root that index signed and when. The page says "Rated 9.5 of 10 in Online tutors
(per …, 5 Oct 2026)", or "across their profiles".

This index shows a proof only when it checks for this profile's own key, its index is in
https://github.com/foundationforest/services/blob/main/index/lists/indexes.json, and its root is one
of that index's newest roots. One that fails, or is too old, shows nothing: that is not an error.
To check one yourself, take the proof from the profile's card on its hosts and run forest's
`verifyReputation` (https://github.com/foundationforest/forest/blob/main/circuits/README.md) with
the profile's address.

This index's own tree, for an app that proves on the device:

    GET https://forest.foundation/v1/reputation

gives `index` (its signing key, as an address), `root` (64 hex), `time` (ms), `signature`
(base64url) and how many `leaves`.

    GET https://forest.foundation/v1/reputation/leaves

gives every leaf in the tree's order, with the `root` they make: `stamp` and `scope` (64 hex),
`score` (the rating times ten) and `count` (the reviews it comes from). An app finds its person's
own leaves here and proves on the device; it never asks for one leaf, so this index never learns
which are theirs.

## Paying

An offer's `payLink` is one documented format, forest's escrow's:
https://github.com/foundationforest/forest/blob/main/escrow/README.md#the-pay-link. The seller is
the profile the offer names, paid at its address: the link carries no other key. This index never
pays and never holds money.

An example, from this index's test data:

    https://forest.foundation/pay?v=2&offer=3ds35BYoks9R95FJ3XfwfvtuDGkaM3LeEiqUP2wWBfJm%2Foffer%2Fportuguese&record=3192bff03b2c8009281f892c58d389cbecc3ac99e2d93655e692e2e2ba4ff302&price.amount=25&price.mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&price.per=hour

Its twin, `https://forest.foundation/pay.json?…` with the same query, says whether the link still
matches the offer (`check`: `matches`, `changed`, `differs`, `notLive`, `noPrice`, `notFound`,
`invalid`).

## Examples

The profile and deal examples above (Ana, and her deal with Ben) are this index's test data. On a
live index, start from `https://forest.foundation/index.json` or a search and follow the links.
Every page is also listed in `https://forest.foundation/sitemap.xml`.
