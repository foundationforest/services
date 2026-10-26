# index

Part of Forest's services: [the top README](../README.md).

The foundation's index ranks what is public: it reads the hosts it lists and the chains it lists,
keeps the profiles whose stamp proof checks for a verifier key it lists, rates them, and serves what
it finds as pages and as JSON. Every index ranks what is public, each by its own opinions.

This is one copy, run by the Open Forest Foundation at https://index.forest.foundation. Anyone can
run another index; the main way is this code with lists of its own. It holds opinions and nothing of
the person's: which hosts and chains to read, which verifier keys count and how much, and every
number it ranks by are files in this directory, and everything it ranks is public on a host or on
chain. It holds no key of anyone's but its own.

Of Forest's four jobs (who you are, that you are real, what you have done, your money), it does one:
what you have done. It reads the offers and reviews profiles publish and the receipts the escrow
leaves on chain, and gives each profile one rating. The other three it only reads: a profile record
on a host, a stamp proof a verifier made possible, a payment.

For AI agents: [`skill.md`](skill.md) and [`llms.txt`](llms.txt).

## How it works

```
the hosts in lists/hosts.json ── records ──────┐
the escrow, on chain ── its events: receipts ──┼──▶ filter ──▶ rank ──▶ pages, JSON, the tree
the markets, at MARKETS ── what a post holds ──┘
```

One process. Every `READ_SECONDS` it makes one pass: it reads what is new on each host and on chain,
then filters, ranks, signs what changed and builds its tree again, from everything it holds. Between
passes it serves the pages. Three verbs, each one place in the code:

- **filter** (`src/filter.ts`): which profiles count;
- **format** (`src/pages/`): one file per page, each building the page's JSON and drawing its HTML
  from that JSON;
- **rank** (`src/rank.ts`): one pure function, run once per market, from counted profiles and counted
  reviews to trust, ratings and backing.

### What it reads

- **Records, from each host in `lists/hosts.json`, in full** (`src/read.ts`): every record on the host,
  for every profile, page by page from a cursor it keeps per host (the standard's `readPage`, which
  checks each record's text and signature and refuses the rest). Each record that checks is kept once.
  Each profile is then viewed with the standard's `viewProfile`, which decides which record counts at
  each path, so this index sees what any other reader of the same records sees. It reads three paths:
  - `profile`: the profile record;
  - `offer/<id>`: a post. A delete keeps its last body here for good, marked deleted, so a review
    that names it still finds it. A post deleted before this index first read it keeps the last
    version a host still serves;
  - `review/<id>`: a review. A delete removes it.

  A private record, encrypted to its readers, is left alone at any path. A record dated ahead of the
  clock waits until it is due.
- **The markets** (`src/markets.ts`): `directory.json`, each market's file and `build/types.json`,
  from the checkout of [foundationforest/markets](https://github.com/foundationforest/markets) that
  `../standard.sh` makes at the commit in `../MARKETS`. Never over the network at run time.
- **The escrow's receipts** (`src/chain.ts`): every transaction that named the standard's escrow
  program, oldest first, from a cursor (the newest signature read), at `finalized`, through the RPC
  `config/chains.json` names for the chain the escrow runs on. A failed transaction is skipped, and
  only events the program itself wrote are read (the escrow client's `decodeEvents`). From them it
  keeps each escrow's receipt (payer, recipient, mint, amount, arbiter, schedule, when it was funded
  and stopped, how and when it ended, what each side got) and every move, with who made it and when.
  An event the client cannot read was written by an earlier version of the program, whose escrows
  this version refuses: it is skipped.
- **The payments reviews name** (`src/evidence/payment.ts`): one `getTransaction` each (Evidence,
  below). Nothing else is read from any chain.

### Which profiles count

A profile counts when its profile record names a market in the directory and one of that market's
roles, and carries a stamp proof that:

1. is a stamp proof's shape (the standard's `stampCheck`, for this profile's address);
2. names a verifier key `lists/verifiers.json` lists;
3. carries the verifier name that list gives the key;
4. is for the label `<market>/<role>`, the profile record's own;
5. checks (the stamp client's `checkStamp`), checked once and its answer kept;
6. was first seen by this index no later than the key's `until`, when the list gives one.

This index keeps, for each proof that checks, its tag and when it first saw it. A proof carries no
date, and a record's time is its signer's word, so when this index first saw it is the only time it
can trust for a key that leaked: proofs first seen after the leak do not count, and those seen before
still do.

A profile's page lists each proof with what this index made of it, and `checks` lists the keys it
counts for. A counted profile starts the ranking with its counted keys' points, the largest of them.
A profile that does not count has a page, but no rating, and its posts and reviews count for nothing.

### Posts

A post is listed when its profile counts and it fits its market, read as the markets manual says and
as the mcp checks a post before it signs one:

- each field is one its market names for the profile's role;
- each field is of its type in `types.json`;
- a choice takes only its values;
- a field marked `many` holds a list of its type, each value different.

A market's `required` is for apps to ask for, and nothing enforces it, so neither does this. A post
that is not listed is kept and shown on its profile's page with `why`: it does not fit (naming the
field), its profile does not count, or it was deleted.

### Reviews

A review counts when, in this order:

1. its writer counts here;
2. it fits its writer's market's review fields: the shared ones it lists (`subject` an address,
   `score` "1" to "10" with at most one decimal, `text`, `offer` a post's full address
   `<profile>/offer/<id>`, `evidence`) and the fields the market adds;
3. it gives a score;
4. it is about another profile, not its writer;
5. its writer and the profile it is about have the same `market` in their profile records, so each
   market is ranked on its own;
6. the profile it is about counts here;
7. it is the latest of its writer's reviews of that profile and that post (or of no post), by its
   record's time. One review counts per writer, subject and offer.

A review that does not count says why, on both profiles' pages.

### Evidence

A counted review's `evidence` is `<chain>:<id>`, the chain in CAIP-2 form, as the markets manual
writes it; the chain holds a colon itself, so the text splits at its last colon. `config/chains.json`
names each chain this index reads, with its reader and the setting that holds its RPC's URL. A
reader reads one type of chain and matches the two profiles' pay addresses of that type, from each
profile record's `pay`, `{ solana, evm }`. A pay address counts only when its signature in the
profile record's `paySig` holds: its pay key signed that profile's address (the standard's
`checkPay`), so a profile cannot borrow someone else's payments. This index has one reader,
`solana`, which matches the `solana` pay addresses and has two kinds of evidence, each one file in
`src/evidence/`, with its name, how it recognizes an id, and its check:

- **`escrow`**, an address of 32 bytes, on the chain the escrow runs on: the escrow's receipt, from
  what this index read on chain. It counts when the receipt's payer and recipient are the two
  profiles' pay addresses, in either order, its mint is one `config/currencies.json` lists, and it
  ended with money to the recipient.
- **`payment`**, a transaction's signature of 64 bytes: one `getTransaction` at `finalized`, through
  the chain's RPC, its answer kept once the chain has one. It counts when the transaction succeeded
  and, in a mint `config/currencies.json` lists, one of the two pay addresses lost and the other
  gained, in either direction: a buyer reviewing the seller they paid, or the seller reviewing them.
  An app writes the review seconds after paying, before the chain holds the payment as final, so a
  signature the RPC holds no transaction for is asked again on each pass until a day after this
  index first saw the review name it, by its own clock; only then is it kept as invalid. A record's
  time is its writer's word, and a review read late, after a host or this index was down, would
  have no day left by it.

**One payment, one review.** An escrow or a payment backs one review: the earliest of the reviews it
backs, by record time, then by address. A later review that names it is `invalid`, with
`evidenceWhy` "already used". Only a review between its two pay addresses can be backed by it, so a
review by anyone else that names it takes nothing from them, however early its writer dates it.

A review is shown:

- `with` a payment: its evidence counts;
- `without`: it names none, or one of the two profiles' pay addresses of the chain's type is
  unsigned (`evidenceWhy` says "pay address unsigned");
- `unchecked`: it names a chain `config/chains.json` does not list, so this index cannot tell
  whether it holds; `evidenceWhy` names the chain, and it weighs as a review without;
- `invalid`: it names no chain (the text before its last colon is no CAIP-2 chain), an id its
  chain's reader does not recognize, or one that does not count, or one an earlier review used
  (`evidenceWhy` says "already used"), or one of the two profiles has no pay address of the chain's
  type.

When the RPC does not answer, or does not hold the payment yet, the review counts as without for that
pass and is checked again on the next. A review that does not count is not checked, and shows
without.

### How it scores

One rating per profile, and its backing: how much trust stands behind it. The code is `src/rank.ts`,
one pure function run once per market, since a review counts only inside one; every number is in
`config/scoring.json` (How we run it).

**Scores.** For each writer and each profile it reviewed, the scores of its counted reviews (one per
post) are averaged into one score `s`, from 1 to 10. `d` is how many profiles a writer reviewed. A
profile's review count is how many writers reviewed it.

**Trust.** Every counted profile starts with `(1 − alpha) · v`, where `v` is the points of its
largest counted key: 0.4 for a face check and 0.8 for an ID check, at today's numbers. Then, `rounds`
times, each step reading what the round before left:

1. **The baseline,** `mu`: the market's mean score, each score weighed by its writer's weight `w`,
   pulled toward `mu0` as if `marketPrior` of weight scored it:
   `mu = (marketPrior · mu0 + Σ w · s) / (marketPrior + Σ w)`. The first round weighs each score by
   its seed weight, its weight (step 5) from the starting trust: `(1 − alpha) · v / (d + sink)`,
   times its evidence factor. Many scores from a ring move the baseline only as far as the trust
   behind them.
2. **A writer's habit,** `sbar`: its mean score, pulled toward the baseline as if it had given
   `calibrationPrior` more scores at it: `sbar = (calibrationPrior · mu + Σ s) / (calibrationPrior + d)`.
3. **The calibrated score,** `shat = s − beta · (sbar − mu)`, kept within 1 to 10. A writer who scores
   above the baseline has each score lowered by `beta` of how far above it scores, and one who scores
   below has each raised. So a 9.5 from a writer who averages 6.5 counts for more than a 10 from one
   who gives everyone 10.
4. **Its quality,** `q = (shat − neutral) / neutral`: from −0.8 to 1, and 0 at `neutral`. A score
   above `neutral` passes trust to the profile it is about; one below takes some away.
5. **Its weight,** `w = min(1, T′ / (d + sink))` times its evidence factor. `T′` is the writer's
   trust less what that profile passed the writer, so two profiles that review each other pass
   nothing back and forth. A writer of many reviews splits its trust thinly. `sink` holds back part
   of every writer's trust: a writer of one review passes a third of it, at today's numbers.
6. **The flow** along it is `alpha · w · q`. Each profile's trust becomes `(1 − alpha) · v` plus
   every flow into it, never below 0.

**The backing,** `B`: the sum of the weights of a profile's writers, from the last round, shown to
one decimal. Each review's `weight` is its writer's weight split equally across that writer's counted
reviews of the profile, so a profile's backing is the sum of its counted reviews' weights.

**The rating,** `R = (ratingPrior · mu + Σ w · shat) / (ratingPrior + B)`, with the last round's
baseline: the calibrated scores, each weighed by its writer's weight, pulled toward the baseline as if
`ratingPrior` of backing scored it. It is shown to one decimal. A profile no counted review is about
has no rating.

**Evidence factors** (`evidence`): one for each kind of evidence, and `none` for a review with no
evidence or evidence that does not count. A writer takes, for one profile, the largest factor among
its reviews of it: evidence shows that money moved between the two profiles, whichever post a review
names.

At today's numbers:
- five face-checked profiles, each of which wrote one review of a sixth, back it with about 0.67;
- ten faces rating each other 10 end with a backing of about 0.54 each, and a rating within 1 of
  their market's baseline;
- two profiles of one person rating each other back each other with about 0.13.

Search and a market's page sort by rating, then the newest post. A profile with no rating comes
after every rated one, since the rating is the one score there is.

### The signed rating

Each counted profile's rating is signed with the index's key, as a statement: canonical JSON (the
standard's records' `canonical`) of

    {"index":"<this index>","profile":"<the profile>","rating":"9.2" or null,"backing":"1.4","reviews":14,"time":<ms>}

signed over its UTF-8 bytes with EdDSA-Poseidon (the standard's keys' `signBytes`), and served in the
profile's `rating` as `statement` and `signature` (64 bytes, base64url). `rating` and `backing` are
text, to one decimal, since canonical JSON's numbers are whole; `reviews` is how many writers
reviewed the profile. Anyone checks it with the
standard's keys' `checkBytes`, against the index's address. The statement begins with `{`, never
with the `0xff` every record, message, pull, blob request and root begins with, so the signature is
never one of those. `time` is when the rating, its backing and its review count first had those
values: while none of them moves, the statement and signature stay.

### The tree

After each pass, the index builds its ratings into a tree in the standard's format
([proofs/reputation](https://github.com/foundationforest/standard/blob/main/proofs/reputation/README.md)),
so a person proves a rating from their own profiles on their device, naming none of them
(`src/tree.ts`):

- **one leaf per tag** of a counted profile with a rating: the tag its counted stamp proof shows;
  the scope of its label; its rating times ten, rounded (9.2 is 92); and its backing times ten,
  rounded, at least 1 (1.4 is 14). A reputation proof averages the scores of the leaves it counts,
  each weighted by its count, so a rating carried from several profiles weighs each by the trust
  behind it, not by how many reviews it has (FAQ). Two counted proofs with one tag, two keys of one
  verifier, give one leaf;
- **in order of tag,** which says nothing about whose leaf is whose;
- **its root** is the reputation client's `buildTree`, signed with the index's key over the client's
  `signedBytes(root, time)`, the time in ms. A new root only when the leaves change. Every root is
  kept.

`/v1/reputation` serves `{ index, root, time, signature, leaves }` (`leaves`: how many), and
`/v1/reputation/leaves` serves `{ root, leaves: [{ tag, scope, score, count }] }`, tag and scope in
hex, both 404 while there is no tree.

A reputation proof on a profile record is shown when:
- its index is one `lists/indexes.json` names;
- its root is that index's newest, or one the index signed within `maxAgeDays` days;
- it checks (the client's `checkReputation`, its answer kept).

The newest root always counts: a tree that has not moved still says exactly what its proofs say. A
root's age runs from when this index last signed it, since a root that comes back is signed again.
This index knows only its own roots, so a proof against another index's tree shows nothing.

### What it serves

Every page is HTML for people, drawn by one template (`src/pages/template.ts`) from the page's JSON
object, which it also serves at the same path with `.json`: the page and its twin never disagree. The
HTML runs no script; each page carries schema.org JSON-LD. GET and HEAD only, open to any origin
(`access-control-allow-origin: *`), `cache-control: public, max-age=30, stale-while-revalidate=300`.

- **`/`**, twin `/index.json`: `{ "index", "markets": [{ "name", "description", "roles" }], "lists" }`:
  this index's address, every market in the directory with its role words, and its lists.
- **`/markets/<name>`**: `{ "index", "market", "posts": { "<role>": [<result>] } }`: the market's file
  verbatim as the directory holds it, its `preview` among the rest, and its listed posts by role, by
  rating, then the newest; a profile with no rating after every rated one.
- **`/search`**: `{ "index", "total", "results": [<result>] }`, with any of `q` (words in the post,
  each a word's start, all of them), `market`, `role`, `near=lat,lon` with `km` (a post with a place
  within `km` kilometres, 10 unless given), `minRating`, `minReviews` (at least this many writers),
  `limit` (20 unless given, at most 100) and `offset`; sorted as a market's page.
- **`/profiles/<address>`**: `{ "index", "address", "profile", "checks", "rating", "posts", "reviews":
  { "received", "given" }, "proofs" }`:
  - `profile`: the profile record's body;
  - `checks`: `[{ "verifier", "key", "label" }]`;
  - `rating`: `{ "value", "backing", "reviews", "statement", "signature" }`, with no statement or
    signature for a profile that does not count, drawn as "9.2 · backing 1.4 (14 reviews)";
  - `posts`: `[{ "address", "body", "listed", "why" }]`, `why` only when not listed;
  - each review: `{ "reviewer", "address", "body", "counted", "why", "evidence", "evidenceWhy",
    "weight" }`, `why` only when it does not count, `evidenceWhy` only when its evidence is
    `unchecked`, already used, or a pay address it is between is unsigned, and `weight` its share
    of its writer's weight (How it scores);
  - `proofs`: each proof on the profile record with its `result`.
- **`/deals/<escrow>`**: the receipt, every move, the profiles whose `solana` pay address is either
  side, signed for that profile (`checkPay`), and the reviews that name it as
  `<the escrow's chain>:<escrow>`.
- `/v1/reputation`, `/v1/reputation/leaves`, `/sitemap.xml` (the home page, each market, each counted
  profile, each deal with a receipt), `/robots.txt`, and `/llms.txt` and `/skill.md`, files in this
  directory written for `https://index.forest.foundation`, served with `PUBLIC_URL` in its place.

A `<result>` is `{ "profile", "market", "role", "post": { "address", "body" }, "rating", "checks" }`.

### Its key

The index's key is made from its seed (`src/seed.ts`): 32 random bytes the standard's `newSeed` makes
at its first start, kept in `DATA_DIR/index-seed.json`, readable by its own user only, never printed
or logged. The key is `hkdf(seed, "index/key")`, the standard's keys' `hkdf`, made into a service
key, the standard's keys' `serviceKey`. Its address is the index's name: every page shows it, and it
signs the ratings and the roots.

### Where it keeps things

One SQLite file, `DATA_DIR/index.sqlite` (`node:sqlite`, with FTS5 for the text of posts; `src/store.ts`),
a fresh schema, beside the seed. Everything in it comes back from the hosts and the chain, but three
tables: when each stamp proof was first seen, when each review was first seen naming its evidence,
and every root it signed. `npm run rebuild` drops every
other table, makes each again with the schema of this code, reads the hosts and the chain again,
ranks, and exits; the seed is never touched.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | required | The seed and the one file, on a volume |
| `PUBLIC_URL` | `https://index.forest.foundation` | Where the pages are published: an origin |
| `RPC_URL` | `https://api.devnet.solana.com` | The RPC of each chain `config/chains.json` reads through `RPC_URL`: Solana's public endpoint for the chain the escrow runs on today |
| `READ_SECONDS` | `30` | Seconds between the end of one pass and the start of the next |
| `PORT` | `8080` | |

A chain in `config/chains.json` names the setting that holds its RPC's URL; today each names
`RPC_URL`. A setting that cannot be read, a chain whose setting is not set, a list or a config file
that does not read, or a seed file that is not a seed, stops the start, naming what is wrong.

### Run it

Node 22.18 or later. From the repo root:

```
./standard.sh                                              # the standard at STANDARD, built; the markets at MARKETS
(cd standard/proofs/reputation/circuit && npm run fetch)   # the reputation circuit's proving files, for the tests
cd index && npm ci                                         # the standard's packages, linked by name from ../standard/
npm run check                                              # type-check
npm test                                                   # everything below, on loopback
DATA_DIR=./data PUBLIC_URL=http://127.0.0.1:8080 npm start
```

The tests run the standard's reference host on loopback, make real stamp proofs from the stamp
circuit's committed proving files for a stand-in verifier key their lists name, and answer the chain
from a stand-in RPC:

- **filter:** a stamp proof that checks for a listed key counts; a changed byte, an unlisted key, a
  wrong name, a label other than the profile's market and role, a market not in the directory, a role
  not the market's, and a proof first seen after its key's `until` do not;
- **rank,** on fixtures, with this index's numbers:
  - a ring of ten faces all rating each other 10 ends with each backing below 1 and each rating
    within 1 of the market's baseline;
  - a star of five one-review puppets backs its boss with about 0.67;
  - one face's two roles rating each other back each other with about 0.13;
  - an honest provider outranks the ring in its market. Its ten writers each rate it 9, rate four
    other providers 5 to 8, and are rated by them in turn;
  - a 9.5 from a writer averaging 6.5 weighs more in the rating than a 10 from one averaging 10;
  - mutual reviews pass no trust back and forth;
  - a writer's reviews of one profile are one score, and the review count is the writers';
  - evidence factors scale a writer's weight;
- **reviews:** one from a profile that does not count, with no score, of itself, from another
  market, about a profile that does not count, or with a field its market does not name is skipped
  and says why; the latest per writer, subject and post counts; a deleted post keeps its body;
- **evidence:**
  - escrows and payments in either direction count, and the wrong parties, a refund, an open escrow,
    another mint, a failed transaction do not;
  - one used by an earlier review is invalid, "already used", and a stranger's earlier review naming
    it takes nothing;
  - a payment the chain answers for is asked once, and one not on chain yet is asked again on the
    next pass and counts once it is;
  - one seen late, in a review written two days before, is still asked for 23 hours after this
    index first saw it, and is invalid for good 25 hours after;
  - evidence on a chain the lists do not name is unchecked, says which chain, and is never asked
    for, and evidence with no chain is invalid;
  - a profile that lists another's pay addresses, with that profile's signatures, gives no evidence,
    "pay address unsigned", takes nothing from the real one's review, and is no side of the deal;
  - a deal's page finds the reviews that name it on its chain;
- **markets:** the checks of fields, choices, lists and roles; a post that does not fit is kept and
  not listed; the escrow program is the one the pinned standard records, of the version its client
  reads, on a chain `config/chains.json` lists;
- **tree:** the served leaves carry each rating and its backing times ten and rebuild the served root,
  whose signature checks; a reputation proof made from the leaves shows on its profile, and not with
  a byte changed or on another profile; against a root that is not the newest it shows 29 days after
  this index signed it and not 31, and against the newest root it shows at any age;
- **pages:** the four answers' shapes; a market's file served verbatim, its `preview` with it; every
  page drawn from its twin's object; every JSON-LD block passes schema.org's vocabulary
  (`test/schemaorg/`); search's filters and sort; every URL in `llms.txt` and `skill.md` answers;
- **seed:** made at the first start, readable by its user only, the same key after;
- **end to end,** over HTTP: two profiles with real stamp proofs, an offer, a review, the index
  reading on its own schedule and serving the rating and its backing; then a rebuild gives the same;
  and a rebuild of a file from before tags were called tags keeps when each proof was first seen.

## How we run it

Each of these is this index's opinion, in a file anyone can read or a setting this README lists.
Another index holds its own.

- **Its name:** the address of its key, made at its first start (Its key), on `/` and every page.
- **Which hosts it reads** (`lists/hosts.json`): https://host.forest.foundation, in full. It reads no
  other host, follows no profile's hosts record, and takes no hosts record sent to it.
- **Which verifier keys count, and how much** (`lists/verifiers.json`): each key by its address, with
  the verifier name its stamp proofs must carry, the name of its check, its points, and an optional
  `until`. Today it lists the two keys of the foundation's verifier, under its name
  `verifier.forest.foundation`, neither with an `until`: its face key `9Kvr71eh…`, the face check at
  1 point, and its ID key `G6hYSXZU…`, the ID check at 2.
- **Which chains it reads** (`config/chains.json`): one, Solana's devnet
  (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`), the chain the escrow runs on today, with the reader
  `solana`, through `RPC_URL`.
- **Which markets:** every market in the directory at `MARKETS`, each role its file lists.
- **How it weighs** (`config/scoring.json`, How it scores):
  - `mu0` 7.5, the score a market's baseline starts from;
  - `marketPrior` 5, how much weight `mu0` holds in it;
  - `calibrationPrior` 3, how many scores at the baseline each writer's habit starts with;
  - `beta` 0.5, how much of a writer's habit comes off its scores;
  - `neutral` 5, the score that passes no trust;
  - `alpha` 0.6, how much of a profile's trust it takes from reviews, the rest from its key;
  - `sink` 2, the trust each writer holds back, counted as reviews;
  - `rounds` 10;
  - `ratingPrior` 0.5, the backing the baseline holds in each rating;
  - the evidence factors `escrow` 1, `payment` 1 and `none` 1. Today a payment changes nothing but
    what a review shows; the factors are there for when money moves.
- **How long a payment may take to be final:** a day from when this index first saw its review name
  it, by its own clock (`WAIT_MS` in `src/evidence/payment.ts`). Until then, a payment the RPC does
  not hold is asked for again on each pass.
- **Which money counts** (`config/currencies.json`): USDC, USDT, Open USD and EURC, the dollars the
  fee payer takes, kept for when money is real, and Circle's test USDC on the chain it reads,
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, each with its code and six decimals.
- **Which escrow:** the standard's, version 4, its program at
  `38vLV7TMvJ9bvXT3cbRLEfHUy8WbvHWfjmiUALUyCm5J`.
- **Which reputation proofs it shows, and how old a signed root may be** (`lists/indexes.json`): its
  own (`self`), against its newest root, or one it signed in the last 30 days (`maxAgeDays`).
- **How often:** a pass every 30 seconds after the last ends (`READ_SECONDS`). A host that takes more
  than 60 seconds to serve a page fails that read, and the next pass tries again; an RPC request
  times out after 30 seconds.
- **What it keeps:** every record its hosts served that checks, the escrow's receipts and moves, each
  answer of a proof or payment check, every root, when each proof was first seen, and when each
  review was first seen naming its evidence. Never a network address.
- **No request logs.** It logs its address at start, that it made a seed, a host or the RPC failing,
  how many records a host served that did not check, a pass that failed, and a failed request's path
  and error.
- **Where:** one replica built from `deploy/Dockerfile`, with this repo's root as the build context,
  and `DATA_DIR` on a volume.

## Promises

- **It holds no key of anyone's but its own,** and has no sign-up: everything it serves is open to
  anyone, with no login.
- **It keeps no network address** and logs no request but a failed one's path and error.
- **What it reads and how it weighs are files:** the hosts and the keys in `lists/`, its chains, its
  numbers and its money in `config/`, its markets the directory at `MARKETS`. A change to one is a
  change anyone sees.
- **One rating, and no other score.** Every counted profile's rating is signed with the key whose
  address is on every page, and so is every root.
- **Every page is drawn from its JSON twin,** so a person and a machine read the same facts.
- **Nothing here links two profiles of one person.** It ranks each profile on its own, and nothing it
  serves ties a profile to a person.

## Limits

- **It trusts the verifiers it lists** to sign stamps only for the people they say. It cannot tell.
- **It trusts its RPC** for receipts and payments; no second source checks it.
- **The public RPC answers a few requests at a time.** The first read of the escrow's history takes
  many passes there; a keyed RPC in `RPC_URL` reads it at once.
- **It reads evidence only on the chains it lists.** A review backed on another chain is shown
  unchecked, and weighs as a review without.
- **A payment not final within a day counts for nothing, for good.** The day runs from when this
  index first saw the review name it.
- **Two of one person's profiles can review each other,** and with small payments between them, each
  backed. Nothing here links them, so nothing here can tell. What it buys is small: each passes the
  other only its own starting trust, and nothing back, about 0.13 of backing for two face checks.
- **In a market where one side is never reviewed, that side's writers keep their starting trust and
  spread it thin.** Trust grows only from reviews received, so a buyer no one reviews passes its key's
  start, 0.4 for a face check, split across every profile it reviewed and `sink`, however many good
  deals it made.
- **Only its own roots.** A reputation proof against another index's tree shows nothing here.
- **It reads only the hosts it lists.** A profile whose records live elsewhere is not here.
- **In a small tree, a rating can point at one leaf** (the standard's
  [reputation](https://github.com/foundationforest/standard/blob/main/proofs/reputation/README.md#limits)).
- **Losing the volume loses the key,** and with it the address every rating and root was signed with,
  every root, and when each proof and each review was first seen. A new start makes a new key, and
  every proof and review is first seen again.
- **Escrows of earlier versions of the program are not read.**
- **Everything after the reading is computed again on every pass,** in one process; each proof and
  payment is checked once. One sitemap file; a profile's page lists every review; search reads every
  listed post that matches before it pages.
- **Pages in English only.**
- **Address logs.** A hosting provider's own request logs are the operator's choice, and may hold
  each request's address and path.

## Who decides what

- **The standard:** the record, the stamp proof, the tree and the reputation proof, the escrow and
  its receipt.
- **The markets directory, at `MARKETS`:** the markets, their roles, what a post and a review hold,
  and how evidence is written.
- **This index, by its own choice:** which hosts it reads; which verifier keys count, under which
  names, with how many points, and until when; which chains it reads evidence on, and through which
  RPC; which money counts; every number in `config/scoring.json`; which indexes' reputation proofs it
  shows, and how old a root may be; what its pages show.
- **A person, through their app:** where their records live, which proofs their profile record shows,
  and which index they read.

## FAQ

**Why does a profile with two counted keys start with the larger of their points, not their sum?**
Two keys of one verifier, a face check and an ID check, are one person checked twice. Their sum would
make the same person count for more by being checked again.

**Why does a rebuild keep when each proof and each review was first seen, and the roots?**
None of them comes back from the hosts or the chain. Without the first, every proof would be first
seen at the rebuild, after any key's `until`. Without the second, every payment still missing would be
asked for another day. Without the roots, every reputation proof people show would stop showing.

**Why does evidence count only in a mint this index lists, for an escrow too?**
Anyone can make a mint. A receipt in a token its maker mints at will would show "with a payment" for
nothing.

**Why is a leaf's count its backing, not its number of reviews?**
A reputation proof weighs each profile it carries by its leaf's count. Anyone can add reviews, and
puppets can write them; backing grows only with the trust behind them. By backing, a profile with
many thin reviews does not outweigh one with fewer, better-backed ones. The count is at least 1,
since the proof divides by the sum of its counts.

**Why serve every leaf, and no URL for one leaf and its path?**
A path asked for by tag tells the index, and whoever logs its requests, which profile is the
caller's. With every leaf, an app finds its person's own on the device.

**Why is a deleted post still here?**
So a review that names it still finds what it was about. The post is not listed, and its page says it
was deleted.
