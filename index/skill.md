# Reading the Forest index: a skill for AI agents

Forest is open software for people to offer, pay and review each other through profiles they own. A
profile is one person's identity in one market and role, its label, such as `tutoring/tutor`; its
address is its name. This index ranks what is public: it reads the hosts it lists, keeps the
profiles whose profile record carries a stamp proof that checks for a verifier key it lists (a
verifier checked that a real person holds the seed behind the profile), ranks them, and serves what
it finds. A profile that does not count here still has a page, with what this index made of each of
its proofs.

## How to read

- Everything is a plain GET. No key, no sign-up, no cookies.
- Every page has a JSON twin at the same address with `.json` on its path; the home page's is
  `/index.json`. The twin is the object the page is drawn from.
- A page may be cached for 30 seconds, and served for up to 5 minutes more while a cache fetches a
  new one. The index reads its hosts and the chain again 30 seconds after each pass ends.
- In records, money and decimals are text: a price `{ "amount": "30", "currency": "USD", "per": "hour" }`,
  a score `"8.5"`, a point's degrees `"40.42"`. A rating's `value` and `backing` in the JSON are
  plain numbers; in its signed `statement` they are text.

## The markets

    GET https://index.forest.foundation/index.json

`{ "index", "markets": [{ "name", "description", "roles" }], "lists" }`: this index's address, every
market in the markets directory it reads, with its roles, and the lists it reads by (hosts, verifier
keys, indexes).

    GET https://index.forest.foundation/markets/tutoring.json

`{ "index", "market", "posts": { "<role>": [<result>] } }`: the market's file as the directory holds
it (its fields, the fields a post's preview shows first, its review fields, its payment schedules,
how deals go), and its listed posts by role, best rated first.

## Search

    GET https://index.forest.foundation/search.json?q=maths&market=tutoring&role=tutor

`{ "index", "total", "results": [<result>] }`. Every filter may be left out:

- `q`: words in the post, each a word's start, all of them;
- `market`, `role`: only that market, only posts by that role;
- `near=lat,lon` and `km`: a post with a place within `km` kilometres (10 unless given);
- `minRating`: a profile rated at least this, from 1 to 10; `minReviews`: reviewed by at least this
  many writers;
- `limit` (20 unless given, at most 100) and `offset`, for the next page.

A result is `{ "profile", "market", "role", "post": { "address", "body" }, "rating", "checks" }`. The
post's body holds its market's fields. Results are sorted by the profile's rating, then the newest
post; a profile with no rating comes after every rated one.

## A profile

    GET https://index.forest.foundation/profiles/<address>.json

- `profile`: its profile record, as the hosts serve it: `market`, `role`, `pay` (its pay addresses,
  `{ "solana", "evm" }`), `inboxKey` and `inbox` (how to message it), `proofs`.
- `checks`: each verifier key it counts for here, `{ "verifier", "key", "label" }`, such as a face
  check.
- `rating`: `{ "value", "backing", "reviews", "statement", "signature" }`, such as 9.2 · backing 1.4
  (14 reviews). `value` is the rating, from 1 to 10: the scores of the profile's reviews, each
  calibrated against its writer's habit and weighed by its writer's weight, pulled toward its
  market's baseline while the backing is small. A writer's weight is a share of its trust (how much
  a profile's own reviews weigh: it starts from its verifier key, and moves with the reviews it
  gets), split across the profiles it reviewed. `backing` is how much trust stands behind the
  rating: the sum of its writers' weights. A face-checked writer of one review, itself unreviewed,
  adds about 0.13, so a backing below 1 means few trusted writers.
  `reviews` is how many writers reviewed it. Reviews count only between two profiles of one market.
  `value` is null with no counted review. `statement` is what this index signed, canonical JSON of
  `{ index, profile, rating, backing, reviews, time }`; `signature` is its EdDSA-Poseidon signature
  over the statement's UTF-8 bytes, by the key whose address is `index`, which the standard's keys
  check (`checkBytes`). The README's How it scores gives every step and number.
- `posts`: each post, `{ "address", "body", "listed" }`, with `why` when it is not listed (it does
  not fit its market, its profile does not count, or it was deleted: a deleted post keeps its last
  body here, so a review that names it still finds it).
- `reviews`: `received` and `given`, each `{ "reviewer", "address", "body", "counted", "why",
  "evidence", "evidenceWhy", "weight" }`. A review's evidence is written `<chain>:<id>`, such as
  `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:<signature>`. `evidence` is `with` (a payment between the
  two backs it), `without`, `unchecked` (it names a chain this index does not read; `evidenceWhy`
  says which), or `invalid` (it names one that does not count, or no chain, or one an earlier
  review used, when `evidenceWhy` says "already used": one payment backs one review). `why` is there
  only when it does not count. `weight` is the review's share of its writer's weight, split equally
  across that writer's counted reviews of the profile.
- `proofs`: each proof on the profile record, with what this index made of it.

## A deal

    GET https://index.forest.foundation/deals/<escrow address>.json

The escrow's receipt as the chain holds it (payer, recipient, mint, amount in base units, schedule,
how and when it ended, what each side got), every move with who made it and when, the profiles
whose `solana` pay address is either side, and the reviews that name it.

## The tree

    GET https://index.forest.foundation/v1/reputation
    GET https://index.forest.foundation/v1/reputation/leaves

The root of this index's tree of ratings, its time and signature, and every leaf, in the standard's
format: a person proves a rating from their own profiles on their device, naming none of them. A
leaf's score is its rating times ten, and its count its backing times ten, at least 1. A proof shows
here against this index's newest root, or one it signed within `maxAgeDays`, in `/index.json`'s
`lists`.

## To act

This index only reads. To post, review or message, the person's signer, a device that holds their
seed, signs with the profile's main key and writes to the profile's hosts; a payment is made with
the profile's pay key, from its pay address. An AI asks one of the person's signers to act for them.
