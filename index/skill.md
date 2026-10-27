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
  a score `"8.5"`, a point's degrees `"40.42"`. In this index's JSON, a rating, a trust and a
  uniqueness are plain numbers; in its signed `statement`, a rating is text.

## What each profile shows

Every profile this index counts shows four things, each ranked inside its own market only:

- **Ratings,** `{ "value", "count" }`: `value` is the profile's rating from 1 to 10, to one decimal,
  and `count` is how many raters scored it. The rating is the plain weighted average of its scores,
  shown as it is: one 10 from one rater shows 10, with a count of 1, so read the count beside it. A
  score weighs more from a rater with more uniqueness and trust, and counts for what it means from
  that rater: a tough rater's high scores weigh more and its low ones less; an easy rater's the
  other way. `value` is null with no rating.
- **Trust,** from 0 to 100: how much this profile's own words and scores weigh. A newcomer's is half
  its uniqueness. It rises with each vouch, and with each rating it gets, since a rating is a vouch
  (the rater dealt with it), and falls with each report; each counts by its giver's uniqueness and
  trust. It never passes the profile's uniqueness.
- **Uniqueness,** from 0 to 100: how sure this index is that the profile is one real person, from
  the checks its stamp proofs count for: 75 with a face check, 99 with a face check and an ID check.
- **Pickiness,** a word: `tough` (it scores below the ratings others give), `average`, or `easy` (it
  scores above them). A profile that has scored no one is average.

Evidence weighs nothing today: a review backed by a payment counts as one without does, and says
what it rests on. A review backed by a deal may count more later.

## The markets

    GET https://index.forest.foundation/index.json

`{ "index", "markets": [{ "name", "description", "roles" }], "lists" }`: this index's address, every
market in the markets directory it reads, with its roles, and the lists it reads by: `hosts`; `keys`,
each verifier key it counts with its `verifier`, its `label` (such as face check) and its
`confidence` from 0 to 1, that a profile it checked is one real person; `indexes`, whose reputation
proofs it shows; and `maxAgeDays`.

    GET https://index.forest.foundation/markets/tutoring.json

`{ "index", "market", "posts": { "<role>": [<result>] } }`: the market's file as the directory holds
it (its fields, the fields a post's preview shows first, its review, vouch and report fields, its
payment schedules, how deals go), and its listed posts by role, in search's order.

## Search

    GET https://index.forest.foundation/search.json?q=maths&market=tutoring&role=tutor

`{ "index", "total", "results": [<result>] }`. Every filter may be left out:

- `q`: words in the post, each a word's start, all of them;
- `market`, `role`: only that market, only posts by that role;
- `near=lat,lon` and `km`: a post with a place within `km` kilometres (10 unless given); a post that
  names no place is left out;
- `minRating`: a profile rated at least this, from 1 to 10; one with no rating is left out;
- `minReviews`: a profile scored by at least this many raters;
- `limit` (20 unless given, at most 100) and `offset`, for the next page.

A result is `{ "profile", "market", "role", "post": { "address", "body" }, "ratings", "trust",
"uniqueness", "pickiness", "checks" }`: the post, with what its profile shows and its checks. The
post's body holds its market's fields. Results are sorted by each profile's rating with one rater's
worth of its market's average added, so a profile with few scores sits near the average; then by the
newest post. A profile no one has rated sorts at its market's average. That is the order only: each
result's `ratings` is as it is.

## A profile

    GET https://index.forest.foundation/profiles/<address>.json

- `profile`: its profile record, as the hosts serve it: `market`, `role`, `pay` (its pay addresses,
  `{ "solana", "evm" }`), `inboxKey` and `inbox` (how to message it), `proofs`.
- `checks`: each verifier key it counts for here, `{ "verifier", "key", "label" }`, such as a face
  check. Its uniqueness comes from these.
- `ratings`, `trust`, `uniqueness`, `pickiness`: what it shows, as above. A profile that does not
  count has no rating, a trust and uniqueness of 0, and a null pickiness.
- `statement` and `signature`, for a profile that counts: `statement` is what this index signed,
  canonical JSON of `{ index, profile, ratings: { value, count }, trust, uniqueness, pickiness, time }`,
  the rating's value as text; `signature` is its EdDSA-Poseidon signature over the statement's UTF-8
  bytes, by the key whose address is `index`, which the standard's keys check (`checkBytes`).
- `posts`: each post, `{ "address", "body", "listed" }`, with `why` when it is not listed (it does
  not fit its market, its profile does not count, or it was deleted: a deleted post keeps its last
  body here, so a review that names it still finds it).
- `reviews`: `received` and `given`, each `{ "reviewer", "address", "body", "counted", "why",
  "evidence", "evidenceWhy", "weight" }`. A review's body holds its `subject`, its `score`, any
  `text`, the `offer` it is about, its `evidence`, and its market's own fields. `counted` says
  whether it counts here; `why`, only when it does not, says why (its writer does not count, it gives
  no score, it is about another market or its own writer, or a later one by the same writer about the
  same profile and post counts instead). `evidence` is `with` (a payment between the two backs it),
  `without`, `unchecked` (it names a chain this index does not read; `evidenceWhy` says which), or
  `invalid` (it names one that does not count, or no chain, or one an earlier review used, when
  `evidenceWhy` says "already used": one payment backs one review). Evidence is written
  `<chain>:<id>`, such as `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:<signature>`. `weight` is how much
  its score weighs in the rating, split equally across that rater's reviews of the profile.
- `vouches` and `reports`: `received` and `given`, each `{ "writer", "address", "body", "counted",
  "why" }`. A vouch says "I know this profile is real and honest"; a report says "this profile is
  fake or a scam"; each body holds its `subject` and any `text`. `counted` and `why` as for a review;
  one vouch and one report count per writer and profile, the latest.
- `words`: `received` and `given`, each `{ "writer", "subject", "word", "weight" }`: each writer's
  one word about a profile, `report` if its latest counted record about it is a report, otherwise
  `vouch`, and its weight, the writer's uniqueness times trust, from 0 to 1. Trust comes from these.
- `proofs`: each proof on the profile record, with what this index made of it: a stamp proof's
  `result` is `counts` or why not; a reputation proof's shows the `trust` it carries.

## A deal

    GET https://index.forest.foundation/deals/<escrow address>.json

The escrow's receipt as the chain holds it (payer, recipient, mint, amount in base units, schedule,
how and when it ended, what each side got), every move with who made it and when, the profiles
whose `solana` pay address is either side, and the reviews that name it.

## The tree

    GET https://index.forest.foundation/v1/reputation
    GET https://index.forest.foundation/v1/reputation/leaves

The root of this index's tree of trusts, its time and signature, and every leaf, in the standard's
format: a person proves a trust from their own profiles on their device, naming none of them, and
carries it to another of their profiles. A leaf is one counted profile's: its score is the profile's
trust, from 0 to 100, and its count is 1, so a proof carrying several profiles shows their average.
A proof shows here against this index's newest root, or one it signed within `maxAgeDays`, in
`/index.json`'s `lists`.

## To act

This index only reads. To post, review, vouch, report or message, the person's signer, a device
that holds their seed, signs with the profile's main key and writes to the profile's hosts; a payment
is made with the profile's pay key, from its pay address. An AI asks one of the person's signers to
act for them.
