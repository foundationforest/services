# index

Part of Forest's services: [the top README](../README.md).

The foundation's index ranks what is public: it reads the hosts it lists, keeps the profiles whose
verification (a profile's proof that a verifier checked the person behind it) checks for a verifier
key it lists, ranks them, and serves what it finds as pages and as JSON.
Every index ranks what is public, each by its own opinions.

This is one copy, run by the Open Forest Foundation at https://index.forest.foundation. Anyone can
run another index; the main way is this code with lists of its own. It holds opinions and nothing of
the person's: which hosts to read, which verifier keys count and how much, and every number it ranks
by are files in this directory, and everything it ranks is public on a host. It holds no key of
anyone's but its own.

Of Forest's four jobs (who you are, that you are real, what you have done, your money), it does one:
what you have done. It reads the posts, reviews, vouches and reports profiles publish, and gives
each profile its ratings and a trust. Of the other three it only reads two, a profile entry on a host
and a verification a verifier's stamp made possible, and money not at all.

For AI agents: [`skill.md`](skill.md) and [`llms.txt`](llms.txt).

## How it works

```
the hosts in lists/hosts.json ── entries ──────┐
                                               ├──▶ filter ──▶ rank ──▶ pages, JSON, the tree
the markets, at MARKETS ── what a post holds ──┘
```

One process. Every `READ_SECONDS` it makes one pass: it reads what is new on each host, then
filters, ranks, signs what changed and builds its tree again, from everything it holds. Between
passes it serves the pages. Three verbs, each one place in the code:

- **filter** (`src/filter.ts`): which profiles count;
- **format** (`src/pages/`): one file per page, each building the page's JSON and drawing its HTML
  from that JSON;
- **rank** (`src/rank.ts`): pure functions, one for each part of the ranking, run once per market,
  from counted profiles, reviews, vouches and reports to each profile's trust (how much its own
  words and scores weigh), pickiness and ratings.

### What it reads

- **Entries, from each host in `lists/hosts.json`, in full** (`src/read.ts`): every entry on the host,
  for every folder, page by page from a cursor it keeps per host (`GET /v1/entries?after=`, the
  standard's `readPage`, which checks each entry's text and signature and refuses the rest). Each
  entry that checks is kept once. Each folder is then viewed with the standard's `viewFolder`, which
  decides which entry counts at each path, the main key's or that of an access key the profile entry
  lists with `write`, so this index sees what any other reader of the same entries sees. It reads
  these paths:
  - `profile`: the profile entry: its market and role, its hosts, its open key, its pay addresses,
    its access keys and its proofs;
  - `post/<id>`: a post. A delete keeps its last body here for good, marked deleted, so a review
    that names it still finds it. A post deleted before this index first read it keeps the last
    version a host still serves;
  - `review/<id>`: a review. A delete removes it;
  - `vouch/<id>` and `report/<id>`: a vouch and a report. A delete removes it.

  A locked entry, which only the keys it was locked to open, is left alone at any path. An entry
  dated ahead of the clock waits until it is due.
- **The markets,** through the markets package, `@foundationforest/markets`: `directory.json` and
  each market's file, from the checkout of [foundationforest/markets](https://github.com/foundationforest/markets) that
  `../standard.sh` makes at the commit in `../MARKETS`. Never over the network at run time.

It reads nothing else.

### Which profiles count

A profile counts when its profile entry names a market in the directory and one of that market's
roles, and carries a verification that:

1. is a verification's shape (the standard's `verificationCheck`, for this profile's address);
2. names a verifier key `lists/verifiers.json` lists;
3. carries the verifier name that list gives the key;
4. is for the label `<market>/<role>`, the profile entry's own;
5. checks (the proofs package's `checkVerification`), checked once and its answer kept;
6. was first seen by this index no later than the key's `until`, when the list gives one.

This index keeps, for each profile and each verifier key, when it first saw a verification of that
key on that profile that checks. A proof carries no date, and an entry's time is its writer's word,
so when this index first saw it is the only time it can trust for a key that leaked: proofs first seen after the leak do not count, and those seen before
still do.

A profile's page lists each proof with what this index made of it, and `checks` lists the keys it
counts for, each key once; its uniqueness comes from them (How it scores). A profile that does not
count has a page, but no rating and no trust, and its posts, reviews, vouches and reports count for
nothing.

### Posts

A post is listed when its profile counts and it fits its market, by the markets package's
`checkEntry`, the markets manual's own check. The mcp, the foundation's connector over MCP (the Model
Context Protocol, the way AI apps call outside tools), checks a post with the same code before it
signs one:

- each field is one its market names for the profile's role;
- each field is of its type in `types.json`;
- a choice takes only its values;
- a field marked `many` holds a list of its type, each value different;
- a field of type `file` names one of the files the body lists in `files`. `files` is the
  standard's own field, which the entry's check reads, and no market's.

A market's `required` is for apps to ask for, and nothing enforces it, so neither does this. A post
that is not listed is kept and shown on its profile's page with `why`: it does not fit (naming the
field), its profile does not count, or it was deleted.

### Reviews, vouches and reports

Each names the profile it is about as its `subject`, as the markets manual says: a review says how a
deal went and gives a score; a vouch says "I know this profile is real and honest"; a report says
"this profile is fake or a scam". Each may add text. One counts when, in this order:

1. its writer counts here;
2. it fits its writer's market for its kind, by the markets package's `checkEntry`: the fields
   every market's hold (`subject` an address, `score` "1" to "10" with at most one decimal, `text`,
   `post` a post's full address `<profile>/post/<id>`, its profile an address; a vouch and a report
   hold only `subject` and `text`) and the fields the market adds to its reviews, a `file` among
   them naming one of the body's `files`;
3. a review gives a score;
4. it is about another profile, not its writer;
5. its writer and the profile it is about have the same `market` in their profile entries, so each
   market is ranked on its own;
6. the profile it is about counts here;
7. it is the latest of its kind by its writer about that profile, by its entry's time: one review
   counts per writer, subject and post (or no post), and one vouch and one report per writer and
   subject.

One that does not count says why, on both profiles' pages, and changes nothing in the ranking.

### How it scores

Each counted profile gets a uniqueness, a trust, a pickiness and its ratings, one market at a time,
since a review, a vouch or a report counts only inside one. The code is `src/rank.ts`, one function
for each part below, each with its own numbers: each key's confidence in `lists/verifiers.json`, the
rest in `config/scoring.json` (How we run it).

**Uniqueness** is how sure this index is that the profile is one real person. Each verifier key it
lists has a confidence, from 0 to 1: today 0.75 for a face check and 0.95 for an ID check. A
profile's uniqueness is the chance that at least one of its checks holds, `1 − Π(1 − c)` over the
keys its verifications count for: 0.75 with a face check, 0.9875 with both.

**Words.** Each writer has one word about each profile it wrote about in its market: a report if its
latest counted entry about it is a report, otherwise a vouch, since it rated the profile or vouched
for it. A rating of 1 is a vouch too: its writer dealt with the profile. A word weighs its giver's
uniqueness times its trust, so at most 1.

**The vouch part** is `V = 1 − 0.5 × vouchStep^v`, where `v` is the sum of the weights of the vouches
a profile received. With none it is 0.5. At `vouchStep` 0.5, each full vouch, of weight 1, closes
half of what is left to 1; it never reaches 1.

**The report part** is `R = reportCut^r`, where `r` is the sum of the weights of the reports a profile
received. With none it is 1. At `reportCut` 0.25, each full report leaves a quarter.

**Trust** is `uniqueness × V × R`: how much the profile's own words and scores weigh. A newcomer's is
half its uniqueness, and it never passes its uniqueness, however many vouch for it. The vouch part
and the report part each move without touching the other.

**Pickiness.** Each score is put on 0 to 1, as `(s − 1) / 9`. A rater's pickiness is
`P = 0.5 + 0.5 × Σ(Rt − s) / (1 + n)`, over the `n` profiles it scored, `s` its score and `Rt` that
profile's current rating, on the same scale. A rater who scores below the ratings others give is
tough, and one who scores above them easy; with few scores it stays near 0.5, and one that scored no
one is 0.5. It only weighs the rater's scores: this index shows it nowhere.

**Ratings.** Each score weighs its rater's `uniqueness × trust × (s × P + (1 − s) × (1 − P))`. The
last part is what a score means from this rater: a tough rater's high scores count more and its low
ones less, an easy rater's the other way, and from an average rater every score weighs half. A
rater's reviews of one profile, one per post, are one score, their mean. A profile's rating is the
weighted average of its scores, from 1 to 10, shown as it is, to one decimal, with how many raters scored it. A profile no
counted review is about has no rating. Each review's `weight` is its score's weight, split equally
among its rater's reviews of that profile.

**Settling.** Trust, pickiness and ratings each depend on the others, so this index works them out in
rounds, from each trust at half its uniqueness and each pickiness at 0.5. Each round reads only the
round before, so the order of anything changes nothing. A round moves every trust and pickiness all
the way to its new value, until the biggest move stops shrinking; from then on, each time it stops
shrinking, rounds move half as far as before (FAQ). It stops when nothing moves by more than
`tolerance`, or after `maxRounds` rounds.

**Search's order.** Search and a market's page sort profiles by their ratings with `marketWeight` of
the market's average added, as if one more rater, of weight 1, gave the average; then by the newest
post. The market's average is the weighted average of every score in it. This is for order only: a
profile's page shows its ratings as they are. A profile no one rated sorts at its market's average
(FAQ); in a market with no scores, by the newest post.

At today's numbers, trust from 0 to 100, as the pages show it:
- a newcomer with a face check: 38, of its uniqueness 75;
- a profile of uniqueness 1: 50 with no word; 75 with one full vouch; 13 with one full report, a
  quarter of 50;
- a face vouched for by one face no one has said a word about: 44;
- two faces who rated each other: 45 each;
- five faces each vouching for a sixth: 61;
- ten faces all vouching for each other: 74 each, never 75;
- thirty faces all reporting each other: 6 each.

### The signed statement

What each counted profile shows is signed with the index's key, as a statement: canonical JSON (the
standard's folders' `canonical`) of

    {"index":"<this index>","profile":"<the profile>","ratings":{"value":"9.2" or null,"count":14},"trust":42,"uniqueness":75,"time":<ms>}

signed over its UTF-8 bytes with EdDSA-Poseidon (the standard's keys' `signBytes`), and served on the
profile's page as `statement` and `signature` (64 bytes, base64url). The rating's `value` is text, to
one decimal, since canonical JSON's numbers are whole; `count` is how many raters scored the profile;
and `trust` and `uniqueness` are whole numbers from 0 to 100. Anyone checks it with the standard's
keys' `checkBytes`, against the index's address. Its own fields, `index` and `ratings` among them,
say what it is, as every signed thing in the standard does, so the signature is never an entry's, a
message's or a root's. `time` is when those values were first what they are:
while none of them moves, the statement and signature stay.

### The tree

After each pass, the index builds its trusts into a tree in the standard's format
([proofs](https://github.com/foundationforest/standard/blob/main/proofs/README.md#the-tree-an-index-publishes)),
so a person proves a trust from their own profiles on their device, naming none of them
(`src/tree.ts`):

- **one leaf per counted profile:** its key, the point its address names, and its trust, from 0 to
  100, as its page shows it, as its score. A reputation proof shows the plain average of the scores
  of the profiles it counts, so a trust carried from several profiles is their average;
- **in order of address:** a leaf names its profile, as the profile's page does; what a proof hides
  is which of them it counts;
- **its root** is the proofs package's `buildTree`, signed with the index's key over its
  `signedBytes(root, time)`, the canonical text of `{ root, time }`, the time in ms. A new root only when the leaves change. Every root is
  kept.

`/v1/reputation` serves `{ index, root, time, signature, leaves }` (`leaves`: how many), and
`/v1/reputation/leaves` serves `{ root, leaves: [{ profile, score }] }`, each profile by its
address, both 404 while there is no tree.

A reputation proof on a profile entry carries the trust it proves, its `score`, and is shown, with
that `trust`, when:
- its index is one `lists/indexes.json` names;
- its root is that index's newest, or one the index signed within `maxAgeDays` days;
- it checks (the proofs package's `checkReputation`, its answer kept).

The newest root always counts: a tree that has not moved still says exactly what its proofs say. A
root's age runs from when this index last signed it, since a root that comes back is signed again.
This index knows only its own roots, so a proof against another index's tree shows nothing.

### What it serves

Every page is HTML for people, drawn by one template (`src/pages/template.ts`) from the page's JSON
object, which it also serves at the same path with `.json`: the page and its twin never disagree. The
HTML runs no script; each page carries schema.org JSON-LD. GET and HEAD only, open to any origin
(`access-control-allow-origin: *`), `cache-control: public, max-age=30, stale-while-revalidate=300`.

- **`/`**, twin `/index.json`: `{ "index", "markets": [{ "name", "description", "roles" }], "lists" }`:
  this index's address, every market in the directory with its role words, and its lists, each key
  with its confidence.
- **`/markets/<name>`**: `{ "index", "market", "posts": { "<role>": [<result>] } }`: the market's file
  verbatim as the directory holds it, its `preview` among the rest, and its listed posts by role,
  sorted as search sorts them.
- **`/search`**: `{ "index", "total", "results": [<result>] }`, with any of `q` (words in the post,
  each a word's start, all of them), `market`, `role`, `near=lat,lon` with `km` (a post with a place
  within `km` kilometres, 10 unless given), `minRating` (a rating of at least this), `minReviews`
  (scored by at least this many raters), `limit` (20 unless given, at most 100) and `offset`; sorted
  by search's order (How it scores), then the newest post.
- **`/profiles/<address>`**: `{ "index", "address", "profile", "checks", "ratings", "trust",
  "uniqueness", "statement", "signature", "posts", "reviews", "vouches", "reports", "words",
  "proofs" }`:
  - `profile`: the profile entry's body;
  - `checks`: `[{ "verifier", "key", "label" }]`;
  - `ratings`: `{ "value", "count" }`, the rating from 1 to 10 to one decimal, or null, and how many
    raters scored it;
  - `trust` and `uniqueness`: whole numbers from 0 to 100. A profile that does not count has no
    rating, 0, 0, and no `statement` or `signature`;
  - drawn as "Rated 9.2 by 14 · trust 42 · uniqueness 99", each check as a badge;
  - `posts`: `[{ "address", "body", "listed", "why" }]`, `why` only when not listed;
  - `reviews`: `{ "received", "given" }`, each `{ "reviewer", "address", "body", "counted", "why",
    "weight" }`, `why` only when it does not count, and `weight` its share of its score's weight (How
    it scores);
  - `vouches` and `reports`: `{ "received", "given" }`, each `{ "writer", "address", "body",
    "counted", "why" }`;
  - `words`: `{ "received", "given" }`, each `{ "writer", "subject", "word", "weight" }`: each
    writer's one word about the profile, `vouch` or `report`, and its weight;
  - `proofs`: each proof on the profile entry with its `result`.
- `/v1/reputation`, `/v1/reputation/leaves`, `/sitemap.xml` (the home page, each market, each counted
  profile), `/robots.txt`, and `/llms.txt` and `/skill.md`, files in this
  directory written for `https://index.forest.foundation`, served with `PUBLIC_URL` in its place.

A `<result>` is `{ "profile", "market", "role", "post": { "address", "body" }, "ratings", "trust",
"uniqueness", "checks" }`.

### Its key

The index's key is its seed (`src/seed.ts`): 32 random bytes the standard's `newSeed` makes at its
first start, kept in `DATA_DIR/index-seed.json`, readable by its own user only, never printed or
logged. The seed itself, with no text, is made into a service key, the standard's keys'
`serviceKey`. Its address is the index's name: every page shows it, and it signs the statements and
the roots.

### Where it keeps things

One SQLite file, `DATA_DIR/index.sqlite` (`node:sqlite`, with FTS5 for the text of posts; `src/store.ts`),
a fresh schema, beside the seed. Everything in it comes back from the hosts, but two tables: when
each verification was first seen, and every root it signed. `npm run rebuild` drops every other
table, makes each again with the schema of this code, reads the hosts again, ranks, and exits; the seed is never
touched. A file from before the standard's folders needs one `npm run rebuild` before this code
starts on it: the rebuild also drops its old tables, and the column `seen` kept for each proof's old
number, keeping each row's profile, key and time.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | required | The seed and the one file, on a volume |
| `PUBLIC_URL` | `https://index.forest.foundation` | Where the pages are published: an origin |
| `READ_SECONDS` | `30` | Seconds between the end of one pass and the start of the next |
| `PORT` | `8080` | |

A setting that cannot be read, a list or the config file that does not read, or a seed file that is
not a seed, stops the start, naming what is wrong.

### Run it

Node 22.18 or later. From the repo root:

```
./standard.sh                                              # the standard at STANDARD, built; the markets at MARKETS
(cd host && npm ci)                                        # this repo's host, which the tests run
cd index && npm ci                                         # the standard's packages, linked by name from ../standard/
npm run check                                              # type-check
npm test                                                   # everything below, on loopback
DATA_DIR=./data PUBLIC_URL=http://127.0.0.1:8080 npm start
```

The tests run this repo's host on loopback (its plug, `host/src/plug.ts`), and make real
verifications from the verification circuit's committed proving files for a stand-in verifier key
their lists name:

- **filter:** a verification that checks for a listed key counts; a changed byte, an unlisted key, a
  wrong name, a label other than the profile's market and role, a market not in the directory, a role
  not the market's, and a proof first seen after its key's `until` do not; uniqueness is a face
  key's confidence, the same with two proofs of one key, and 99 with a face check and an ID check;
- **rank,** on fixtures, with this index's numbers, the guarantees How it scores gives:
  - uniqueness: a face check's 0.75, with an ID check's 0.9875;
  - a newcomer's trust is half its uniqueness;
  - one full vouch closes half the gap to uniqueness, and each more half of what is left, never all;
    one full report cuts trust to a quarter; rank puts the parts together, each word weighing its
    giver's uniqueness times trust;
  - the vouch part and the report part each change without touching the other;
  - trust never passes uniqueness, a self-vouching ring of ten and forty random graphs of ratings,
    vouches and reports included, each settling;
  - thirty profiles all reporting each other settle where trust is what the reports leave of it;
  - a rater who gives 1s to well-rated places is tough, and counts less on low scores than a neutral
    rater;
  - each writer's word is its latest counted entry's, a rating of 1 a vouch;
  - a rating is its scores' weighted average, shown as it is, with how many raters; a writer's
    reviews of one profile are one score, each review weighing its share;
  - search's order adds the market's average, and a profile no one rated sorts at it;
- **reviews, vouches and reports:** one from a profile that does not count, with no score (a
  review), of itself, from another market, about a profile that does not count, or with a field its
  market does not name is skipped and says why; the latest per writer, subject and post counts for a
  review, and per writer and subject for a vouch and a report; each writer's word, and its weight; a
  report taken down turns its writer's word back to a vouch, and the trust rises; a review whose
  subject, or the profile its post names, is no address; a deleted post keeps its body;
- **markets:** a post that does not fit its market, by the markets package's check, kept, not listed,
  and saying why;
- **tree:** a leaf for each counted profile, in order of address, its score the profile's trust, one
  leaf for a profile two verifiers checked, and the served leaves rebuild the served root, whose signature checks; a reputation proof made
  from the leaves shows on its profile with the trust it carries, and not with a byte changed or on
  another profile; against a root that is not the newest it shows 29 days after this index signed it
  and not 31, and against the newest root it shows at any age;
- **pages:** the four answers' shapes; a market's file served verbatim, its `preview` with it; every
  page drawn from its twin's object; every JSON-LD block passes schema.org's vocabulary
  (`test/schemaorg/`); search's filters and its order, a profile no one rated at its market's
  average; every URL of this index that `llms.txt` and `skill.md` name answers;
- **seed:** made at the first start, readable by its user only, itself the key, the same after;
- **end to end,** over HTTP: two profiles with real verifications, an offer, a review, the index
  reading on its own schedule and serving the rating and the trust its vouch gives; then a rebuild
  gives the same;
  and a rebuild of a file from before the standard's folders keeps when each proof was first seen,
  without the old column, and makes the rest fresh; and a rebuild in a process of its own, as `npm
  run rebuild` runs it, ends that process once it is done, a verification checked; and `node
  src/main.ts rebuild`, on a file from before the standard's folders and with a timer that never
  ends in its process, says it rebuilt and exits, keeping when the proof was first seen and the old
  root.

## How we run it

Each of these is this index's opinion, in a file anyone can read or a setting this README lists.
Another index holds its own.

- **Its name:** the address of its key, made at its first start (Its key), on `/` and every page.
- **Which hosts it reads** (`lists/hosts.json`): https://host.forest.foundation, in full. It reads no
  other host, follows no hosts a profile entry names, and takes no list of hosts sent to it.
- **Which verifier keys count, and how much** (`lists/verifiers.json`): each key by its address, with
  the verifier name its verifications must carry, the name of its check, its confidence, and an
  optional `until`. Today it lists the two keys of the foundation's verifier, under its name
  `verifier.forest.foundation`, neither with an `until`: its face key `4H5vL1ym…`, the face check at
  0.75, and its ID key `H1SJ6Fxn…`, the ID check at 0.95.
- **Which markets:** every market in the directory at `MARKETS`, each role its file lists.
- **How it weighs** (`config/scoring.json`, How it scores):
  - `vouchStep` 0.5: each full vouch keeps half of what the vouch part has left to 1;
  - `reportCut` 0.25: each full report leaves a quarter of the report part;
  - `marketWeight` 1: how much of the market's average search's order adds, as one rater of weight 1;
  - `tolerance` 1e-9 and `maxRounds` 1000: the ranking has settled when nothing moves by more than a
    billionth, or after 1000 rounds.
- **Which reputation proofs it shows, and how old a signed root may be** (`lists/indexes.json`): its
  own (`self`), against its newest root, or one it signed in the last 30 days (`maxAgeDays`).
- **How often:** a pass every 30 seconds after the last ends (`READ_SECONDS`). A host that takes more
  than 60 seconds to serve a page fails that read, and the next pass tries again.
- **What it keeps:** every entry its hosts served that checks, each answer of a proof check, every
  root, and when each proof was first seen. Never a network address.
- **No request logs.** It logs its address at start, that it made a seed, a host failing, how many
  entries a host served that did not check, a pass that failed, and a failed request's path and
  error.
- **Where:** one replica built from `deploy/Dockerfile`, with this repo's root as the build context,
  and `DATA_DIR` on a volume.

## Promises

- **It holds no key of anyone's but its own,** and has no sign-up: everything it serves is open to
  anyone, with no login.
- **It keeps no network address** and logs no request but a failed one's path and error.
- **What it reads and how it weighs are files:** the hosts and the keys in `lists/`, its numbers in
  `config/`, its markets the directory at `MARKETS`. A change to one is a
  change anyone sees.
- **What it shows is signed.** Every counted profile's ratings, trust and uniqueness are signed with
  the key whose address is on every page, and so is every root.
- **Every page is drawn from its JSON twin,** so a person and a machine read the same facts.
- **Nothing here links two profiles of one person, but what a small tree can show.** It ranks each
  profile on its own, and nothing it serves ties a profile to a person; in a small tree, a trust a
  person carries to another of their profiles can point at the one leaf it came from
  ([the standard's proofs](https://github.com/foundationforest/standard/blob/main/proofs/README.md#limits)).

## Limits

- **It trusts the verifiers it lists** to sign stamps only for the people they say. It cannot tell.
- **Two of one person's profiles can rate or vouch for each other,** as a tutor and a student in one
  market. Nothing here links them, so nothing here can tell. What it buys is bounded: each word
  weighs its giver's uniqueness times trust, two faces lift each other from 38 to 45, and no ring of
  them passes its uniqueness, 75.
- **A rating of 1 is a vouch.** A writer who rated a profile dealt with it, however it went, so a
  profile that cheated someone gains trust from their rating, unless they report it instead.
- **Trust grows only from words received.** In a market where one side is never rated, that side
  keeps half its uniqueness, 38 for a face check, however many good deals it made; its scores still
  count, at that trust.
- **A rating is shown as it is.** One 10 from a newcomer shows 10, beside a count of 1. Only search's
  order pulls a profile with few scores toward its market's average.
- **Only its own roots.** A reputation proof against another index's tree shows nothing here.
- **It reads only the hosts it lists.** A profile whose folder lives elsewhere is not here.
- **Losing the volume loses the key,** and with it the address every statement and root was signed
  with, every root, and when each proof was first seen. A new start makes a new key, and every proof
  is first seen again.
- **Everything after the reading is computed again on every pass,** in one process; each proof is
  checked once. The ranking settles in rounds, up to `maxRounds`, each reading every rating and word in a market. One
  sitemap file; a profile's page lists every review, vouch, report and word; search reads every
  listed post that matches before it pages.
- **Pages in English only.**
- **Address logs.** A hosting provider's own request logs are the operator's choice, and may hold
  each request's address and path.

## Who decides what

- **The standard:** the entry and the profile entry, which keys count for a folder, the
  verification, the tree and the reputation proof.
- **The markets directory, at `MARKETS`:** the markets, their roles, and what a post, a review, a
  vouch and a report hold.
- **This index, by its own choice:** which hosts it reads; which verifier keys count, under which
  names, with what confidence, and until when; how a rating counts as a vouch; every number in
  `config/scoring.json`;
  which indexes' reputation proofs it shows, and how old a root may be; what its pages show.
- **A person, through their app:** where their folders live, which proofs their profile entry shows,
  and which index they read.

## FAQ

**Why does a second check raise uniqueness, and never past 1?**
Each check is one more chance to catch someone who is not one real person. Uniqueness is the chance
that at least one of them holds, `1 − Π(1 − c)`: a second check closes part of what the first left
open, 0.75 becoming 0.9875 with an ID check. A key counts once, however many of its proofs a profile
shows.

**Why does a rebuild keep when each proof was first seen, and the roots?**
Neither comes back from the hosts. Without the first, every proof would be first seen at the
rebuild, after any key's `until`. Without the roots, every reputation proof people show would stop
showing.

**Why does a profile no one rated sort at its market's average, and not last?**
Search's order adds the market's average to every profile's ratings, as one more rater; with no other
rater, the average is all there is. A profile rated below its market's average sorts below one no
one has rated yet: its ratings say it is worse than the market's usual. This is the order alone; its
page says it has no rating.

**Why do rounds move half as far once the biggest move stops shrinking?**
Reports can make whole moves flip for ever: thirty profiles that all report each other go from high
trust, so heavy reports, to low trust, so light reports, and back, every round. Moving half as far
settles them where trust is what the reports leave of it, 6 each for thirty faces. Where whole moves
settle on their own, the result is the same, within `tolerance`.

**Why serve every leaf, and no URL for one leaf and its path?**
A path asked for one leaf tells the index, and whoever logs its requests, which profile is the
caller's. With every leaf, an app finds its person's own on the device.

**Why is a deleted post still here?**
So a review that names it still finds what it was about. The post is not listed, and its page says it
was deleted.
