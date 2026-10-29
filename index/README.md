# index

The index reads the hosts, counts verified profiles only, and ranks them by reputation in each
market: pages for people, JSON for programs, free. A profile counts when it carries a verification (a
proof, made on the person's device, that a verifier checked the one real person behind its seed) for
a verifier key this index lists. Every index ranks what is public, each by its own opinions. The
Forest Foundation runs this copy, at https://index.forest.foundation. Anyone can run another; the
main way is this code with lists of its own. It holds opinions and nothing of the person's: which
hosts it reads, which verifier keys count and how much, and every number it ranks by are files here,
and everything it ranks is public on a host. It holds no key but its own, and there is no account.
For AI agents: [`skill.md`](skill.md) and [`llms.txt`](llms.txt).

## How it works

```
the hosts in lists/hosts.json ── entries ──────┐
                                               ├──▶ filter ──▶ rank ──▶ pages, JSON, the tree
the markets, at MARKETS ── what a post holds ──┘
```

One process. Every `READ_SECONDS` it makes a pass: it reads what is new on each host, then filters,
ranks, signs what changed and builds its tree again, from everything it holds; between passes it
serves. Each verb is one place in the code: **filter** (`src/filter.ts`), which profiles count;
**rank** (`src/rank.ts`), pure functions, one per part of the ranking, run once per market;
**format** (`src/pages/`), one file per page, building its JSON and drawing its HTML from it.

### What it reads

**Every entry on each host in `lists/hosts.json`** (`src/read.ts`), page by page from a cursor it
keeps per host (`GET /v1/entries?after=`, the standard's `readPage`, which checks each entry's text
and signature and refuses the rest). Each entry that checks is kept once. Each folder is viewed with
the standard's `viewFolder`, which picks the entry that counts at each path, by the main key or an
access key the profile entry lists with `write`, so this index sees what any reader sees.

| Path | What | A delete |
|---|---|---|
| `profile` | The profile entry: market and role, hosts, open key, pay addresses, access keys, proofs | |
| `post/<id>` | A post | Keeps its last body for good, marked deleted, so a review naming it still finds it; one deleted before this index read it keeps the last version a host still serves |
| `review/<id>` | A review | Removes it |
| `vouch/<id>`, `report/<id>` | A vouch, a report | Removes it |

A locked entry, which only the keys it was locked to open, is left alone; one dated ahead of the
clock waits until it is due. **The markets** come through the markets package,
`@foundationforest/markets`: `directory.json` and each market's file, from the checkout of
[foundationforest/markets](https://github.com/foundationforest/markets) at the commit in
`../MARKETS`, never over the network. It reads nothing else.

### Which profiles count

A profile counts when its profile entry names a market in the directory and one of its roles, and
carries a verification that:

1. has a verification's shape (the standard's `verificationCheck`, for this profile's address);
2. names a verifier key `lists/verifiers.json` lists,
3. with the verifier name the list gives it;
4. is for the label `<market>/<role>`, the profile entry's own;
5. checks (the proofs package's `checkVerification`), checked once and its answer kept;
6. was first seen here no later than the key's `until`, when the list gives one.

A proof carries no date, and an entry's time is its writer's word, so when this index first saw a
verification is the only time it can trust for a key that leaked: proofs seen after the leak do not
count, those before still do. A profile's page lists each proof with what this index made of it, and
`checks` lists the keys it counts for, once each. A profile that does not count has a page, but no
rating and no trust, and its entries count for nothing.

### Posts, reviews, vouches and reports

A post is listed when its profile counts and it fits its market by the markets package's
`checkEntry`, the markets manual's own check, which the mcp, the foundation's connector, over MCP
(the way AI apps call outside tools), runs too before it signs one: each field one its market names
for the role, of its type in `types.json`, a choice among its values, a `many` field a list of
different values, a `file` field one of the files the body lists in `files` (the standard's own
field). A market's `required` is for apps to ask, and nothing enforces it. A post not listed is kept
and shown on its profile's page with `why`: it does not fit (naming the field), its profile does not
count, or it was deleted.

A review says how a deal went and gives a score; a vouch says "I know this profile is real and
honest"; a report says "this profile is fake or a scam". Each names the profile it is about as its
`subject`, and may add text. One counts when, in order:

1. its writer counts here;
2. it fits its writer's market by `checkEntry`: `subject` an address, `score` "1" to "10" with at
   most one decimal, `text`, `post` a post's full address `<profile>/post/<id>` whose profile is an
   address (a vouch and a report hold only `subject` and `text`), and the fields the market adds to
   its reviews, a `file` among them naming one of the body's `files`;
3. a review gives a score;
4. it is about another profile, not its writer;
5. writer and subject have the same `market`, so each market is ranked on its own;
6. its subject counts here;
7. it is the writer's latest of its kind about that profile, by its entry's time: one review per
   writer, subject and post (or no post); one vouch and one report per writer and subject.

One that does not count says why, on both profiles' pages, and changes nothing.

### How it scores

Each counted profile gets a uniqueness, a trust, a pickiness and ratings, one market at a time. The
code is `src/rank.ts`; each key's confidence is in `lists/verifiers.json`, every other number in
`config/scoring.json`.

| Part | How |
|---|---|
| **Uniqueness**, how sure it is the profile is one real person | `1 − Π(1 − c)` over the keys its verifications count for, each key once, `c` its confidence: 0.75 with a face check, 0.9875 with an ID check too. Each check is one more chance to catch someone who is not one person, so a second raises it, never past 1 |
| **Words** | Each writer's one word about each profile it wrote about in its market: a report if its latest counted entry about it is a report, else a vouch, since it rated or vouched for it. A rating of 1 is a vouch: its writer dealt with the profile. A word weighs its giver's uniqueness times trust, at most 1 |
| **The vouch part** | `V = 1 − 0.5 × vouchStep^v`, `v` the sum of the vouches' weights: 0.5 with none; at `vouchStep` 0.5 each full vouch closes half of what is left to 1, never reaching it |
| **The report part** | `R = reportCut^r`, `r` the sum of the reports' weights: 1 with none; at `reportCut` 0.25 each full report leaves a quarter |
| **Trust**, how much its own words and scores weigh | `uniqueness × V × R`: a newcomer's is half its uniqueness, and it never passes it. Each part moves without touching the other |
| **Pickiness** | Each score on 0 to 1 as `(s − 1) / 9`; `P = 0.5 + 0.5 × Σ(Rt − s) / (1 + n)` over the `n` profiles it scored, `Rt` each one's current rating. Below others' ratings is tough, above is easy; few scores stay near 0.5. Shown nowhere |
| **Ratings** | Each score weighs `uniqueness × trust × (s × P + (1 − s) × (1 − P))`, so a tough rater's high scores count more and its low ones less, and an average rater's weigh half. A rater's reviews of one profile, one per post, are one score, their mean. A rating is the weighted average of its scores, 1 to 10, to one decimal, shown as it is with how many raters; none with no counted review. A review's `weight` is its score's weight, split among its rater's reviews of that profile |
| **Settling** | Trust, pickiness and ratings depend on each other, so it works in rounds from each trust at half its uniqueness and each pickiness at 0.5, each round reading only the one before, so no order of anything changes the result. A round moves every value all the way until the biggest move stops shrinking; from then on, each time it stops shrinking, half as far as before. It stops when nothing moves by more than `tolerance`, or after `maxRounds` |
| **Search's order** | Ratings with `marketWeight` of the market's average added, as one more rater of weight 1, then the newest post. The average is the weighted average of every score in the market. A profile no one rated sorts at it; in a market with no scores, by the newest post. Order only: a profile's page shows its ratings as they are |

At today's numbers, with trust from 0 to 100 as the pages show it:

| Who | Trust |
|---|---|
| A newcomer with a face check (uniqueness 75) | 38 |
| A profile of uniqueness 1, with no word / one full vouch / one full report | 50 / 75 / 13 |
| A face vouched for by one face no one has said a word about | 44 |
| Two faces who rated each other | 45 each |
| Five faces each vouching for a sixth | 61 |
| Ten faces all vouching for each other | 74 each, never 75 |
| Thirty faces all reporting each other | 6 each |

### The signed statement

What each counted profile shows is signed with the index's key, as canonical JSON (the standard's
folders' `canonical`) of

    {"index":"<this index>","profile":"<the profile>","ratings":{"value":"9.2" or null,"count":14},"trust":42,"uniqueness":75,"time":<ms>}

signed over its UTF-8 bytes with EdDSA-Poseidon (the standard's keys' `signBytes`), and served on
the profile's page as `statement` and `signature` (64 bytes, base64url). `value` is text, to one
decimal, since canonical JSON's numbers are whole; `count` is how many raters scored it; `trust` and
`uniqueness` are whole, 0 to 100. Anyone checks it with the keys' `checkBytes`, against the index's
address. Its own fields say what it is, so the signature is never an entry's, a message's or a
root's. `time` is when those values were first what they are: while none moves, the statement and
signature stay.

### The tree

After each pass, the index builds its trusts into a tree in the standard's format
([proofs](https://github.com/foundationforest/standard/blob/main/proofs/README.md#the-tree-an-index-publishes),
`src/tree.ts`), so a person proves a trust from their own profiles on their device, naming none:

- **one leaf per counted profile,** its key the point its address names, its score its trust, 0 to
  100. A reputation proof (a proof that carries a trust to another of one's profiles without linking
  them) shows the plain average of the scores it counts, so a trust carried from several profiles is
  their average;
- **in order of address:** a leaf names its profile, as its page does; what a proof hides is which
  it counts;
- **its root** is the proofs package's `buildTree`, signed over `signedBytes(root, time)`, the
  canonical text of `{ root, time }`, time in ms. A new root only when the leaves change; every root
  is kept.

A reputation proof on a profile entry carries the trust it proves, its `score`, and shows with that
`trust` when its index is one `lists/indexes.json` names, its root is that index's newest or one
signed within `maxAgeDays`, and it checks (the proofs package's `checkReputation`, answer kept). The
newest root always counts, since a tree that has not moved still says what its proofs say; a root's
age runs from when this index last signed it, as a root that comes back is signed again. This index
knows only its own roots.

### Its key, and where it keeps things

The index's key is its seed (`src/seed.ts`): 32 random bytes the standard's `newSeed` makes at its
first start, in `DATA_DIR/index-seed.json`, readable by its own user only, never printed or logged,
made into a service key with no text (the standard's keys' `serviceKey`). Its address is the index's
name: every page shows it, and it signs the statements and the roots.

One SQLite file, `DATA_DIR/index.sqlite` (`node:sqlite`, with FTS5 for the text of posts;
`src/store.ts`), beside the seed. Everything in it comes back from the hosts but two tables: when
each verification was first seen, and every root it signed. Without the first, every proof would be
first seen anew, after any key's `until`; without the roots, the reputation proofs people show would
stop showing. `npm run rebuild` drops every other table, makes each again with this code's schema,
reads the hosts again, ranks, and exits; the seed is never touched. A file from before the
standard's folders needs one `npm run rebuild` first, which also drops its old tables and the
column `seen`, keeping each first sighting's profile, key and time.

## Its API

Every page is HTML for people, drawn by one template (`src/pages/template.ts`) from the page's JSON
object, which is also served at the same path with `.json`: the two never disagree. The HTML runs no
script, and each page carries schema.org JSON-LD. GET and HEAD only, open to any origin
(`access-control-allow-origin: *`), `cache-control: public, max-age=30, stale-while-revalidate=300`.
Every field, for programs: [`skill.md`](skill.md).

| Path | JSON |
|---|---|
| `/`, twin `/index.json` | `{ index, markets: [{ name, description, roles }], lists }`: its address, every market in the directory with its role words, and its lists, each key with its confidence |
| `/markets/<name>` | `{ index, market, posts: { <role>: [<result>] } }`: the market's file verbatim, its `preview` among it, and its listed posts by role, in search's order |
| `/search` | `{ index, total, results: [<result>] }`, with any of `q` (each word a word's start in the post, all of them), `market`, `role`, `near=lat,lon` and `km` (10 unless given), `minRating`, `minReviews` (raters), `limit` (20, at most 100) and `offset` |
| `/profiles/<address>` | `{ index, address, profile, checks, ratings, trust, uniqueness, statement, signature, posts, reviews, vouches, reports, words, proofs }`: drawn as "Rated 9.2 by 14 · trust 42 · uniqueness 99", each check a badge. One that does not count has no rating, 0, 0, and no `statement` or `signature`. Each post, review, vouch and report says whether it counts and, when not, `why`; each review its `weight`; `words`, each writer's one word and its weight |
| `/v1/reputation` | `{ index, root, time, signature, leaves }`, `leaves` how many; 404 with no tree |
| `/v1/reputation/leaves` | `{ root, leaves: [{ profile, score }] }`, every leaf by address; 404 with no tree. No URL serves one leaf and its path: asking for one would tell the index, and whoever logs its requests, which profile is the caller's |
| `/sitemap.xml`, `/robots.txt` | The home page, each market, each counted profile |
| `/llms.txt`, `/skill.md` | Files here written for `https://index.forest.foundation`, served with `PUBLIC_URL` in its place |

A `<result>` is `{ profile, market, role, post: { address, body }, ratings, trust, uniqueness, checks }`.

## How we run it

Each of these is this index's opinion, in a file anyone can read or a setting below. Another index
holds its own.

- **Its name:** the address of its key, on `/` and every page.
- **Hosts** (`lists/hosts.json`): https://host.forest.foundation, in full. It reads no other host,
  follows no hosts a profile entry names, and takes no list of hosts sent to it.
- **Verifier keys** (`lists/verifiers.json`): each by address, with the verifier name its
  verifications carry, its check's name, its confidence and an optional `until`. Today the
  foundation's verifier's two keys, under `verifier.forest.foundation`, neither with an `until`: its
  face key `4H5vL1ym…`, face check at 0.75, and its ID key `H1SJ6Fxn…`, ID check at 0.95.
- **Markets:** every market in the directory at `MARKETS`, each role its file lists.
- **Weights** (`config/scoring.json`): `vouchStep` 0.5, `reportCut` 0.25, `marketWeight` 1,
  `tolerance` 1e-9 and `maxRounds` 1000.
- **Reputation proofs** (`lists/indexes.json`): its own (`self`), against its newest root or one it
  signed in the last 30 days (`maxAgeDays`).
- **How often:** a pass 30 seconds after the last ends. A host that takes more than 60 seconds to
  serve a page fails that read; the next pass tries again.
- **What it keeps:** every entry its hosts served that checks, each proof check's answer, every root,
  and when each proof was first seen.
- **Logs:** its address at start, that it made a seed, a host failing, how many entries a host served
  that did not check, a pass that failed, and a failed request's path and error.
- **Public:** its pages, JSON, signed statements and tree. **Secret:** its seed.
- **Where:** one replica of `deploy/Dockerfile`, built from the repo root, `DATA_DIR` on a volume.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | required | The seed and the one file, on a volume |
| `PUBLIC_URL` | `https://index.forest.foundation` | Where the pages are published: an origin |
| `READ_SECONDS` | `30` | Seconds between the end of one pass and the start of the next |
| `PORT` | `8080` | |

A setting, a list or the config file that does not read, or a seed file that is not a seed, stops
the start, naming what is wrong.

```
./standard.sh                                              # from the repo root: the standard and the markets, at their pins
(cd host && npm ci)                                        # this repo's host, which the tests run
cd index && npm ci                                         # the standard's packages, linked by name from ../standard/
npm run check && npm test
DATA_DIR=./data PUBLIC_URL=http://127.0.0.1:8080 npm start
```

`test/` covers, on loopback, with this repo's host and real verifications and reputation proofs
from the circuits' committed proving files: the filter, every guarantee How it scores gives (forty
random graphs among them), which reviews, vouches and reports count, the markets' check, the tree
and the proofs' ages, every page's shape and JSON-LD, the seed, and the index end to end over HTTP,
rebuilds included.

## Promises

- **It holds no key of anyone's but its own, and keeps no network address.** It has no sign-up:
  everything it serves is open to anyone, with no login. It logs no request but a failed one's path
  and error.
- **What it reads and how it weighs are files:** the hosts and the keys in `lists/`, its numbers in
  `config/`, its markets the directory at `MARKETS`. A change to one is a change anyone sees.
- **What it shows is signed.** Every counted profile's ratings, trust and uniqueness are signed with
  the key whose address is on every page, and so is every root.
- **Every page is drawn from its JSON twin,** so a person and a machine read the same facts.
- **Nothing here links two profiles of one person, but what a small tree can show.** It ranks each
  profile on its own, and nothing it serves ties a profile to a person; in a small tree, a trust a
  person carries to another of their profiles can point at the one leaf it came from
  ([the standard's proofs](https://github.com/foundationforest/standard/blob/main/proofs/README.md#limits)).

## Limits

- **It trusts the verifiers it lists** to sign stamps only for the people they say.
- **Two of one person's profiles can rate or vouch for each other:** nothing here links them. Two
  faces lift each other from 38 to 45, and no ring passes its uniqueness, 75.
- **A rating of 1 is a vouch:** a profile that cheated someone gains trust from their rating, unless
  they report it instead.
- **Trust grows only from words received:** a side of a market that is never rated keeps 38, however
  many deals it makes; its scores still count, at that trust.
- **A rating is shown as it is:** one 10 from a newcomer shows 10, with a count of 1.
- **Only its own roots:** a proof against another index's tree shows nothing here.
- **Only the hosts it lists:** a profile whose folder lives elsewhere is not here.
- **Losing the volume loses the key,** the address every statement and root was signed with, every
  root, and when each proof was first seen.
- **Everything after reading is computed again each pass,** in one process, each proof checked once;
  one sitemap file; a profile's page lists every entry about it; search reads every match before it
  pages.
- **Pages in English only.**
- **A hosting provider's own request logs** may hold each request's address and path.

## FAQ

**Why does a profile no one rated sort at its market's average, and not last?**
Search adds the market's average to every profile's ratings, as one more rater; with no other rater,
the average is all there is. A profile rated below the average sorts below one no one has rated yet:
its ratings say it is worse than the market's usual. Its page still says it has no rating.

**Why do rounds move half as far once the biggest move stops shrinking?**
Reports can make whole moves flip for ever: thirty profiles that all report each other go from high
trust, so heavy reports, to low trust, so light reports, and back, every round. Moving half as far
settles them where trust is what the reports leave of it, 6 each. Where whole moves settle on their
own, the result is the same, within `tolerance`.
