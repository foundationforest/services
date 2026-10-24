# Reading the Forest index: a skill for AI agents

Forest is open software for people to offer, pay and review each other through profiles they own. A
profile is one person's identity in one market and role, its label, such as `tutoring/tutor`; its
address is its name. This index ranks what is public: it reads the hosts it lists, keeps the
profiles whose profile record carries a stamp proof that checks for a verifier key it lists (a
verifier checked that a real person holds the seed behind the profile), ranks them, and serves what
it finds. A profile that does not count here still has a page, saying why.

## How to read

- Everything is a plain GET. No key, no sign-up, no cookies.
- Every page has a JSON twin at the same address with `.json` on its path; the home page's is
  `/index.json`. The twin is the object the page is drawn from.
- Answers may be up to 30 seconds old.
- In records, money and decimals are text: a price `{ "amount": "30", "currency": "USD", "per": "hour" }`,
  a score `"8.5"`, a point's degrees `"40.42"`. A rating in the JSON is a plain number.

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
- `minRating`: a profile rated at least this, from 1 to 10; `minReviews`: at least this many reviews;
- `limit` (20 unless given, at most 100) and `offset`, for the next page.

A result is `{ "profile", "market", "role", "post": { "address", "body" }, "rating", "checks" }`. The
post's body holds its market's fields. Results are sorted by the profile's rating pulled toward its
market's mean (How it scores, in the README), then the newest post.

## A profile

    GET https://index.forest.foundation/profiles/<address>.json

- `profile`: its profile record, as the hosts serve it: `market`, `role`, `pay` (its pay addresses,
  `{ "solana", "evm" }`), `inboxKey` and `inbox` (how to message it), `proofs`.
- `checks`: each verifier key it counts for here, `{ "verifier", "key", "label" }`, such as a face
  check.
- `rating`: `{ "value", "reviews", "withPayment", "statement", "signature" }`, such as 9.2 from 14
  reviews, 11 with a payment. `value` is null with no counted review. `statement` is what this index
  signed, canonical JSON; `signature` is its EdDSA-Poseidon signature over the statement's UTF-8
  bytes, by the key whose address is `index`, which the standard's keys check (`checkBytes`).
- `posts`: each post, `{ "address", "body", "listed" }`, with `why` when it is not listed (it does
  not fit its market, its profile does not count, or it was deleted: a deleted post keeps its last
  body here, so a review that names it still finds it).
- `reviews`: `received` and `given`, each `{ "reviewer", "address", "body", "counted", "why",
  "evidence", "evidenceWhy", "weight" }`. A review's evidence is written `<chain>:<id>`, such as
  `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:<signature>`. `evidence` is `with` (a payment between the
  two backs it), `without`, `unchecked` (it names a chain this index does not read; `evidenceWhy`
  says which), or `invalid` (it names one that does not count, or no chain). `why` is there only
  when it does not count.
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
format: a person proves a rating from their own profiles on their device, naming none of them.

## To act

This index only reads. To post, review, message or pay, the person's signer, a device that holds
their seed, signs with the profile's main key and writes to the profile's hosts; an AI asks one of
the person's signers to act for them.
