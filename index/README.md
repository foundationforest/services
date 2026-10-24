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
- **rank** (`src/rank.ts`): one pure function from counted profiles and counted reviews to points and
  ratings.

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
5. the profile it is about counts here;
6. it is the latest of its writer's reviews of that profile and that post (or of no post), by its
   record's time. One review counts per writer, subject and offer.

A review that does not count says why, on both profiles' pages.

### Evidence

A counted review's `evidence` is `<chain>:<id>`, the chain in CAIP-2 form, as the markets manual
writes it; the chain holds a colon itself, so the text splits at its last colon. `config/chains.json`
names each chain this index reads, with its reader and the setting that holds its RPC's URL. A
reader reads one type of chain and matches the two profiles' pay addresses of that type, from each
profile record's `pay`, `{ solana, evm }`. This index has one reader, `solana`, which matches the
`solana` pay addresses and has two kinds of evidence, each one file in `src/evidence/`, with its
name, how it recognizes an id, and its check:

- **`escrow`**, an address of 32 bytes, on the chain the escrow runs on: the escrow's receipt, from
  what this index read on chain. It counts when the receipt's payer and recipient are the two
  profiles' pay addresses, in either order, its mint is one `config/currencies.json` lists, and it
  ended with money to the recipient.
- **`payment`**, a transaction's signature of 64 bytes: one `getTransaction` at `finalized`, through
  the chain's RPC, its answer kept once the chain has one. It counts when the transaction succeeded
  and, in a mint `config/currencies.json` lists, one of the two pay addresses lost and the other
  gained, in either direction: a buyer reviewing the seller they paid, or the seller reviewing them.
  An app writes the review seconds after paying, before the chain holds the payment as final, so a
  signature the RPC holds no transaction for is asked again on each pass until the review's record
  is a day old; only then is it kept as invalid.

A review is shown:

- `with` a payment: its evidence counts;
- `without`: it names none;
- `unchecked`: it names a chain `config/chains.json` does not list, so this index cannot tell
  whether it holds; `evidenceWhy` names the chain, and it weighs as a review without;
- `invalid`: it names no chain (the text before its last colon is no CAIP-2 chain), an id its
  chain's reader does not recognize, or one that does not count, or one of the two profiles has no
  pay address of the chain's type.

When the RPC does not answer, or does not hold the payment yet, the review counts as without for that
pass and is checked again on the next. A review that does not count is not checked, and shows
without.

### How it scores

One score, the rating. The code is `src/rank.ts`; every number is in `config/scoring.json` (How we run
it).

**Points.** Every counted profile starts with its points `s`. Points flow along counted reviews: each
round, a profile keeps `1 − d` of its starting points, and each review passes its subject `d` times
its writer's points, split equally across all the writer's counted reviews, times `score / 10`, times
its evidence weight `e`:

    x(p) = (1 − d) · s(p) + d · Σ over reviews of p of  x(writer) / n(writer) · score / 10 · e

starting from `x = s`, until no profile moves by more than `tolerance`, or for at most `maxRounds`
rounds. `n(writer)` is how many counted reviews the writer wrote, so a writer of a hundred reviews
passes a hundredth of its share with each. With every evidence weight at most 1, profiles that review
only each other never end with more points among them than they started with: a ring of ten profiles
of 1 point each ends with at most 10. A profile no counted review points to keeps `1 − d` of its
starting points: 0.15 of a point, for a face check, at today's numbers.

**A review's weight** is the share it passes in the flow: its writer's points over how many counted
reviews the writer wrote, times its evidence weight, `x(writer) / n(writer) · e`. So one writer weighs
at most their own points in anyone's rating, however many posts of that profile they review.

**The rating** is the mean of the scores a profile received, each weighted by its review's weight:
`Σ weight · score / Σ weight`. It is shown to one decimal, with how many counted reviews it comes
from and how many of those have a payment: "9.2 from 14 reviews, 11 with a payment". With no counted
review, there is no rating.

**The shrunk rating** is what search and a market's page sort by: the rating pulled toward its
market's mean rating, more so the less weight is behind it:

    (Σ weight · score + m · the market's mean rating) / (Σ weight + m)

with `m` = `shrink`, and the market's mean rating the mean of the ratings of its rated profiles. A
profile with no rating sorts at its market's mean. `m` is about the weight of three brand-new
reviewers: a face-checked profile nobody has reviewed has 0.15 of a point, and passes all of it with
its only review, so after three such reviews a rating sits about halfway between its own value and
its market's mean.

### The signed rating

Each counted profile's rating is signed with the index's key, as a statement: canonical JSON (the
standard's records' `canonical`) of

    {"index":"<this index>","profile":"<the profile>","rating":"9.2" or null,"reviews":14,"withPayment":11,"time":<ms>}

signed over its UTF-8 bytes with EdDSA-Poseidon (the standard's keys' `signBytes`), and served in the
profile's `rating` as `statement` and `signature` (64 bytes, base64url). Anyone checks it with the
standard's keys' `checkBytes`, against the index's address. The statement begins with `{`, never
with the `0xff` every record, message, pull, blob request and root begins with, so the signature is
never one of those. `time` is when the rating first had that value: a rating that does not move keeps
its statement and signature.

### The tree

After each pass, the index builds its ratings into a tree in the standard's format
([proofs/reputation](https://github.com/foundationforest/standard/blob/main/proofs/reputation/README.md)),
so a person proves a rating from their own profiles on their device, naming none of them
(`src/tree.ts`):

- **one leaf per tag** of a counted profile with a rating: the tag its counted stamp proof shows;
  the scope of its label; its rating times ten, rounded (9.2 is 92); and how many counted reviews it
  received. Two counted proofs with one tag, two keys of one verifier, give one leaf;
- **in order of tag,** which says nothing about whose leaf is whose;
- **its root** is the reputation client's `buildTree`, signed with the index's key over the client's
  `signedBytes(root, time)`, the time in ms. A new root only when the leaves change. Every root is
  kept.

`/v1/reputation` serves `{ index, root, time, signature, leaves }` (`leaves`: how many), and
`/v1/reputation/leaves` serves `{ root, leaves: [{ tag, scope, score, count }] }`, tag and scope in
hex, both 404 while there is no tree.

A reputation proof on a profile record is shown when its index is one `lists/indexes.json` names, its
root is one of that index's newest `roots`, and it checks (the client's `checkReputation`, its answer
kept). This index knows only its own roots, so a proof against another index's tree shows nothing.

### What it serves

Every page is HTML for people, drawn by one template (`src/pages/template.ts`) from the page's JSON
object, which it also serves at the same path with `.json`: the page and its twin never disagree. The
HTML runs no script; each page carries schema.org JSON-LD. GET and HEAD only, open to any origin
(`access-control-allow-origin: *`), `cache-control: public, max-age=30, stale-while-revalidate=300`.

- **`/`**, twin `/index.json`: `{ "index", "markets": [{ "name", "description", "roles" }], "lists" }`:
  this index's address, every market in the directory with its role words, and its lists.
- **`/markets/<name>`**: `{ "index", "market", "posts": { "<role>": [<result>] } }`: the market's file
  verbatim as the directory holds it, its `preview` among the rest, and its listed posts by role, by
  the shrunk rating, then the newest.
- **`/search`**: `{ "index", "total", "results": [<result>] }`, with any of `q` (words in the post,
  each a word's start, all of them), `market`, `role`, `near=lat,lon` with `km` (a post with a place
  within `km` kilometres, 10 unless given), `minRating`, `minReviews`, `limit` (20 unless given, at
  most 100) and `offset`; sorted as a market's page.
- **`/profiles/<address>`**: `{ "index", "address", "profile", "checks", "rating", "posts", "reviews":
  { "received", "given" }, "proofs" }`:
  - `profile`: the profile record's body;
  - `checks`: `[{ "verifier", "key", "label" }]`;
  - `rating`: `{ "value", "reviews", "withPayment", "statement", "signature" }`, with no statement or
    signature for a profile that does not count;
  - `posts`: `[{ "address", "body", "listed", "why" }]`, `why` only when not listed;
  - each review: `{ "reviewer", "address", "body", "counted", "why", "evidence", "evidenceWhy",
    "weight" }`, `why` only when it does not count, `evidenceWhy` only when its evidence is
    `unchecked`;
  - `proofs`: each proof on the profile record with its `result`.
- **`/deals/<escrow>`**: the receipt, every move, the profiles whose `solana` pay address is either
  side, and the reviews that name it as `<the escrow's chain>:<escrow>`.
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
a fresh schema, beside the seed. Everything in it comes back from the hosts and the chain, but two
tables: when each stamp proof was first seen, and every root it signed. `npm run rebuild` drops every
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
- **rank,** on fixtures: a ring of ten ends with at most ten points; a writer of a hundred reviews
  passes a hundredth with each; the rating is weighted by the share each review passes, so ten
  reviews by one writer weigh as one; the shrunk rating; the rounds stop;
- **reviews:** one from a profile that does not count, with no score, of itself, about a profile that
  does not count, or with a field its market does not name is skipped and says why; the latest per
  writer, subject and post counts; a deleted post keeps its body;
- **evidence:** escrows and payments in either direction count, and the wrong parties, a refund, an
  open escrow, another mint, a failed transaction do not; a payment the chain answers for is asked
  once, one not on chain yet is asked again on the next pass and counts once it is, and one still
  missing a day after its review is invalid for good; evidence on a chain the lists do not name is
  unchecked, says which chain, and is never asked for, and evidence with no chain is invalid; a
  deal's page finds the reviews that name it on its chain;
- **markets:** the checks of fields, choices, lists and roles; a post that does not fit is kept and
  not listed; the escrow program is the one the pinned standard records, on a chain
  `config/chains.json` lists;
- **tree:** the served leaves rebuild the served root, whose signature checks; a reputation proof made
  from the leaves shows on its profile, and not with a byte changed, on another profile, or against a
  root past the newest;
- **pages:** the four answers' shapes; a market's file served verbatim, its `preview` with it; every
  page drawn from its twin's object; every JSON-LD block passes schema.org's vocabulary
  (`test/schemaorg/`); search's filters and sort; every URL in `llms.txt` and `skill.md` answers;
- **seed:** made at the first start, readable by its user only, the same key after;
- **end to end,** over HTTP: two profiles with real stamp proofs, an offer, a review, the index
  reading on its own schedule and serving the rating; then a rebuild gives the same; and a rebuild of
  a file from before tags were called tags keeps when each proof was first seen.

## How we run it

Each of these is this index's opinion, in a file anyone can read or a setting this README lists.
Another index holds its own.

- **Its name:** the address of its key, made at its first start (Its key), on `/` and every page.
- **Which hosts it reads** (`lists/hosts.json`): https://host.forest.foundation, in full. It reads no
  other host, follows no profile's hosts record, and takes no hosts record sent to it.
- **Which verifier keys count, and how much** (`lists/verifiers.json`): each key by its address, with
  the verifier name its stamp proofs must carry, the name of its check, its points, and an optional
  `until`. Today it lists the two keys of the foundation's verifier, under its name
  `verifier.forest.foundation`, neither with an `until`: its face key `MC8L1NFD…`, the face check at
  1 point, and its ID key `HfYyeaez…`, the ID check at 2.
- **Which chains it reads** (`config/chains.json`): one, Solana's devnet
  (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`), the chain the escrow runs on today, with the reader
  `solana`, through `RPC_URL`.
- **Which markets:** every market in the directory at `MARKETS`, each role its file lists.
- **How it weighs** (`config/scoring.json`): `damping` 0.85, `tolerance` 10⁻⁹, `maxRounds` 100,
  `shrink` (m) 0.5, about the weight of three brand-new reviewers, and the evidence weights `escrow`
  1, `payment` 1 and `none` 1: today a payment changes nothing but what a review shows; the weights
  are there for when money moves.
- **How long a payment may take to be final:** a day from its review's record (`WAIT_MS` in
  `src/evidence/payment.ts`); until then a payment the RPC does not hold is asked for again on each
  pass.
- **Which money counts** (`config/currencies.json`): USDC, USDT, Open USD and EURC, the dollars the
  fee payer takes, and two test dollars, each with its code and six decimals: the classic one, which
  its maker, a key from the phrase that funds the loop, mints at will; and the one shaped like Open
  USD, which no one can mint any more, since its maker's key came from a phrase that is lost.
- **Which escrow:** the standard's, its program at `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`.
- **Which reputation proofs it shows, and how old a signed root may be** (`lists/indexes.json`): its
  own (`self`), against one of its newest 10 roots.
- **How often:** a pass every 30 seconds after the last ends (`READ_SECONDS`). A host that takes more
  than 60 seconds to serve a page fails that read, and the next pass tries again; an RPC request
  times out after 30 seconds.
- **What it keeps:** every record its hosts served that checks, the escrow's receipts and moves, each
  answer of a proof or payment check, every root, and when each proof was first seen. Never a network
  address.
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
- **A payment not final within a day of its review counts for nothing, for good.** The day runs from
  the review's record time, which its writer signs.
- **A writer's reviews each count in the review count.** One review counts per writer, subject and
  post, so a writer who names many posts of one profile adds to "from N reviews" with each, though
  together they weigh no more than the writer's points.
- **Two of one person's profiles can review each other,** and with small payments between them, each
  backed. Nothing here links them, so nothing here can tell.
- **Only its own roots.** A reputation proof against another index's tree shows nothing here.
- **It reads only the hosts it lists.** A profile whose records live elsewhere is not here.
- **In a small tree, a rating can point at one leaf** (the standard's
  [reputation](https://github.com/foundationforest/standard/blob/main/proofs/reputation/README.md#limits)).
- **Losing the volume loses the key,** and with it the address every rating and root was signed with,
  every root, and when each proof was first seen. A new start makes a new key, and every proof is
  first seen again.
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
  shows, and how many roots back; what its pages show.
- **A person, through their app:** where their records live, which proofs their profile record shows,
  and which index they read.

## FAQ

**Why does a profile with two counted keys start with the larger of their points, not their sum?**
Two keys of one verifier, a face check and an ID check, are one person checked twice. Their sum would
make the same person count for more by being checked again.

**Why does a rebuild keep when each proof was first seen, and the roots?**
Neither comes back from the hosts or the chain. Without the first, every proof would be first seen at
the rebuild, after any key's `until`; without the roots, every reputation proof people show would
stop showing.

**Why does evidence count only in a mint this index lists, for an escrow too?**
Anyone can make a mint. A receipt in a token its maker mints at will would show "with a payment" for
nothing.

**Why keep a root while the leaves do not change, and count roots, not their age?**
A proof against the newest root stays exact however old it is, until a rating in the tree moves; an
age would end it while it is still true. Keeping the root while nothing moves means a proof goes stale
only when something it could say changed.

**Why serve every leaf, and no URL for one leaf and its path?**
A path asked for by tag tells the index, and whoever logs its requests, which profile is the
caller's. With every leaf, an app finds its person's own on the device.

**Why is a deleted post still here?**
So a review that names it still finds what it was about. The post is not listed, and its page says it
was deleted.

**How would one market rank by other numbers?**
A `markets` section in `config/scoring.json`, by market name, with the same keys; nothing reads one
today.
