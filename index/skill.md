# Reading the Forest index: a skill for AI agents

Forest is open software for people to offer, pay and review each other through profiles they own. A
profile is one person's identity in one market and role, its label, such as `tutoring/tutor`; its
address is its name. This index ranks what is public: it reads the hosts it lists, keeps the
profiles whose profile entry carries a verification that checks for a verifier key it lists (a
proof that the person behind the profile holds a stamp from a verifier this index counts as checking
one real person), ranks them, and serves what it finds. A profile that does not count here still has
a page, with what this index made of each of its proofs.

## How to read

- Everything is a plain GET, so any AI that can read the web can read and browse these pages by
  links, with nothing to install and no login: no key, no sign-up, no cookies. The home page links
  each market, a market each of its listings, and a listing its profile.
- Every page has a JSON twin at the same address with `.json` on its path; the home page's is
  `/index.json`. The twin is the object the page is drawn from.
- A page may be cached for 30 seconds, and served for up to 5 minutes more while a cache fetches a
  new one. The index reads its hosts again 30 seconds after each pass ends.
- In entries, money and decimals are text: a price `{ "amount": "30", "currency": "USD", "per": "hour" }`,
  a score `"8.5"`, a point's degrees `"40.42"`. In this index's JSON, a rating, a trust and a
  uniqueness are plain numbers; in its signed `statement`, a rating is text.

## What each profile shows

Every profile this index counts shows three things, each ranked inside its own market only:

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
  the checks its verifications count for: 75 with a face check, 99 with a face check and an ID check.

On the pages, a listing in a list shows its profile's badge, "Verified with a selfie" for a face
check and "Verified with ID" for an ID check, and its rating with how many raters scored it, "★ 9.2
(14)", or New when no one has rated it. Its trust and its uniqueness are in a fold on its profile's page, What
these mean, with what each means. A review's date there is its entry's `time`, in UTC. A
choice's value is in words there, `like-new` as "Like new", or by its label where its market gives
one, `xl` as "XL"; the JSON keeps it as written.

## The markets

    GET https://index.forest.foundation/index.json

`{ "index", "markets": [{ "name", "description", "roles", "listed", "words" }], "lists" }`: this
index's address, every market in the markets directory it reads, with its roles, how many listings
each role has `listed`, such as `{ "tutor": 3, "student": 1 }`, and each role's word for its
listings, `offers` or `requests`, such as `{ "tutor": "offers", "student": "requests" }`, and the
lists it reads by: `hosts`; `keys`,
each verifier key it counts with its `verifier`, its `label` (such as face check) and its
`confidence` from 0 to 1, that a profile it checked is one real person; `indexes`, whose reputation
proofs it shows; and `maxAgeDays`.

    GET https://index.forest.foundation/markets/tutoring.json

`{ "index", "market", "listings": { "<role>": [<result>] } }`: the market's file as the directory
holds it (its roles, its listing fields, the fields a listing's preview shows first, and the fields
its reviews add), and the listings this index lists, by role, in search's order.

## Search

    GET https://index.forest.foundation/search.json?q=maths&market=tutoring&role=tutor

`{ "index", "total", "results": [<result>], "query", "markets" }`: `query` is each filter below as
it was given, such as `{ "q": "maths", "market": "tutoring" }`, and `markets` every market's name.
Every filter may be left out:

- `q`: words in the listing, each a word's start, all of them;
- `market`, `role`: only that market, only listings by that role;
- `near=lat,lon` and `km`, how far the searcher would go (10 unless given): a listing whose place's
  circle touches that one, the distance between the two points at most `km` plus the place's
  `radiusKm`; each result then carries `km`, that distance between the two points, and a listing
  with no place, as one online only, is left out. `q` also finds a place by its area, such as a
  town;
- `minRating`: a profile rated at least this, from 1 to 10; one with no rating is left out;
- `minReviews`: a profile scored by at least this many raters;
- `limit` (20 unless given, at most 100) and `offset`, for the next page.

A result is `{ "profile", "market", "role", "listing": { "address", "body", "url", "photos" },
"ratings", "trust", "uniqueness", "checks" }`: the listing, with what its profile shows and its
checks. The listing's body holds its market's fields; `url` is its page; `photos` links to each file
its fields name, at the first host its profile entry names, `<host>/v1/files/<sha256>`. This index
keeps no bytes. With `near`, results come nearest first; otherwise, and among results as near, they
are sorted by each profile's rating with one rater's worth of its market's average added, so a
profile with few scores sits near the average; then by the newest listing. A profile no one has
rated sorts at its market's average. That is the order only: each result's `ratings` is as it is.

## A profile

    GET https://index.forest.foundation/profiles/<address>.json

- `profile`: its profile entry, as the hosts serve it: `market`, `role`, `hosts` (where its folder
  is), `openKey` (what an inbox entry to it is locked to; with none, it takes no inbox entries),
  `pay` (its pay addresses, any of `{ "solana", "evm" }`), `keys` (the access keys it hands out,
  each with what it `can` do), `proofs`.
- `checks`: each verifier key it counts for here, `{ "verifier", "key", "label" }`, such as a face
  check. Its uniqueness comes from these.
- `ratings`, `trust`, `uniqueness`: what it shows, as above. A profile that does not count has no
  rating, and a trust and uniqueness of 0.
- `statement` and `signature`, for a profile that counts: `statement` is what this index signed,
  canonical JSON of `{ index, profile, ratings: { value, count }, trust, uniqueness, time }`,
  the rating's value as text; `signature` is its EdDSA-Poseidon signature over the statement's UTF-8
  bytes, by the key whose address is `index`, which the standard's keys check (`checkBytes`).
- `listings`: each listing, `{ "address", "body", "time", "listed", "url", "photos" }`, with `why`
  when it is not listed (it does not fit its market, its profile does not count, or it was deleted:
  a deleted listing keeps its last body here, and that body's time, so a review that names it still
  finds it). `time` is its entry's own time, in ms since 1970, a plain number: its writer's word,
  not when this index read it.
- `reviews`: `received` and `given`, each `{ "reviewer", "address", "body", "time", "counted",
  "why", "weight", "market", "role", "checks" }`. A review's body holds its `subject`, its `score`,
  any `text`, the `listing` it is about, and the fields its market adds. `time` is as for a listing.
  `counted` says whether it counts here; `why`, only when it does not, says why (its writer does not
  count, it gives no score, it is about another market or its own writer, or a later one by the same
  writer about the same profile and listing counts instead). `weight` is how much its score weighs
  in the rating, split equally across that rater's reviews of the profile. `market`, `role` and
  `checks` are the other profile's: its writer's on one received, its subject's on one given, as
  this index holds them, `checks` as above; `null`, `null` and `[]` for one with no profile entry
  here.
- `vouches` and `reports`: `received` and `given`, each `{ "writer", "address", "body", "time",
  "counted", "why", "market", "role", "checks" }`. A vouch says "I know this profile is real and
  honest"; a report says "this profile is fake or a scam"; each body holds its `subject` and any
  `text`. `time`, `counted`, `why`, `market`, `role` and `checks` as for a review; one vouch and one
  report count per writer and profile, the latest.
- `words`: `received` and `given`, each `{ "writer", "subject", "word", "weight" }`: each writer's
  one word about a profile, `report` if its latest counted entry about it is a report, otherwise
  `vouch`, and its weight, the writer's uniqueness times trust, from 0 to 1. Trust comes from these.
- `proofs`: each proof on the profile entry, with what this index made of it: a verification's
  `result` is `counts` or why not; a reputation proof's shows the `trust` it carries.
- `message`: `[{ "name", "url" }]`, a link to message the profile from each app this index lists.

## A listing

    GET https://index.forest.foundation/profiles/<address>/listing/<id>.json

A listing's own page, at its address under `/profiles`: `{ "index", "profile", "market", "role",
"listing", "checks", "ratings", "trust", "uniqueness", "fields", "types", "labels", "message" }`.
`listing` is as its profile's page gives it; `checks`, `ratings`, `trust`, `uniqueness` and
`message` are its profile's; `fields` is its market's listing fields in the order the page shows
them, the market's preview first; `types` is each one's type, as its market names it, a `file` field
naming photos; `labels` is, for each choice field it holds, the labels its market gives the values
it holds, such as `{ "size": { "xl": "XL" } }`.
The page shows its photos, its fields, who posted it, and how to reach them: the `contact` its body
gives, in the writer's words, and `message`. A listing that is not listed has its page too, with
`why`.

## About

    GET https://index.forest.foundation/about.json

`{ "index", "lists" }`: this index's address and the lists it reads by, as `/index.json` gives them.
Its page says what this index is, links to the JSON, this file and the source, and lists what it
reads and its address.

## The tree

    GET https://index.forest.foundation/v1/reputation
    GET https://index.forest.foundation/v1/reputation/leaves

The root of this index's tree of trusts, its time and signature, and every leaf, in the standard's
format: a person proves a trust from their own profiles on their device, naming none of them, and
carries it to another of their profiles. A leaf is one counted profile's, `{ "profile", "score" }`:
its address, and its trust, from 0 to 100, as its score, so a proof carrying several profiles shows
their average.
A proof shows here against this index's newest root, or one it signed within `maxAgeDays`, in
`/index.json`'s `lists`. It is only shown: the profile's own trust, uniqueness and ratings, and
whether it counts, stay what its own verifications and words make them.

## To act

This index only reads. To message a profile, a person follows a `message` link to their app, or uses
the `contact` a listing gives. To post, review, vouch, report or message, the person's app signs
with the profile's main key, or whoever holds an access key the profile entry lists signs with that
key, within what the profile entry says it `can` do, and writes to the profile's hosts. An AI acts
for the person with an access key their app hands it.
