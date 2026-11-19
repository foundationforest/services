# index

The index reads the hosts, counts verified profiles only, and ranks them by reputation in each
market: pages for people, JSON for programs, free. A profile counts when it carries a verification (a
proof, made on the person's device, that its seed holds a stamp) from a verifier this index counts
as checking one real person: one whose key `lists/verifiers.json` lists. Every index ranks what is
public, each by its own opinions. The Forest Foundation runs this copy, at
https://index.forest.foundation. Anyone can run another; the main way is this code with lists of its
own. It holds opinions and nothing of the person's: which hosts it reads, which verifier keys count
and how much, and every number it ranks by are files here, and everything it ranks is public on a
host. It holds no key but its own, and there is no account. Any AI that can read the web can read
and browse these pages by links, with nothing to install and no login. For AI agents:
[`skill.md`](skill.md) and [`llms.txt`](llms.txt).

## How it works

```
the hosts in lists/hosts.json ── entries ─────────┐
                                                  ├──▶ filter ──▶ rank ──▶ pages, JSON, the tree
the markets, at MARKETS ── what a listing holds ──┘                            ▲
                                       places, at PLACES_URL ── names of places ┘
```

One process. Every `READ_SECONDS` it makes a pass: it reads what is new on each host, then filters,
ranks, signs what changed and builds its tree again, from everything it holds; between passes it
serves. Each verb is one place in the code: **filter** (`src/filter.ts`), which profiles count;
**rank** (`src/rank.ts`), pure functions, one per part of the ranking, run once per market;
**format** (`src/pages/`), one file per page, building its JSON and drawing its HTML from it,
asking the places service for the names of places as it builds (What it asks places).

### What it reads

**Every entry on each host in `lists/hosts.json`** (`src/read.ts`), page by page from a cursor it
keeps per host (`GET /v1/entries?after=`, the standard's `readPage`, which checks each entry's text
and signature and refuses the rest). Each entry that checks is kept once. Each folder is viewed with
the standard's `viewFolder`, which picks the entry that counts at each path, by the main key or an
access key the profile entry lists with `write`, so this index sees what any reader sees.

| Path | What | A delete |
|---|---|---|
| `profile` | The profile entry: market and role, hosts, public encryption key, pay addresses, access keys, proofs | |
| `listing/<id>` | A listing | Keeps its last body, and that body's time, for good, marked deleted, so a review naming it still finds it; one deleted before this index read it keeps the last version a host still serves |
| `review/<id>` | A review | Removes it |
| `vouch/<id>`, `report/<id>` | A vouch, a report | Removes it |

A locked entry, which only the keys it was locked to open, is left alone; one dated more than ten
minutes ahead of the index's clock is held back until it is not, as every reader's view holds it
(the standard's `viewFolder`, `MAX_FUTURE_MS`). **The markets** come through the markets package,
`@foundationforest/markets`: `directory.json`, the shared lists in `build/lists.json` and each
market's file, with the package's four answers, `checkEntry`, `match`, `read` and `ask`, from the
checkout of [foundationforest/markets](https://github.com/foundationforest/markets) at the commit
in `../MARKETS`, never over the network. It reads nothing else.

### What it asks places

A place on a host is a circle, three numbers and no name, and a page with no script can ask
nothing itself, so while it builds a page, never in a pass, the index asks the places service
([`../places`](../places/README.md), at `PLACES_URL`, `src/places.ts`) two things:

| It asks | For | Path |
|---|---|---|
| The first place found for the words a person types in Where | its point, as `near` writes one, and its caption, the name to show | `/v1/find?q=<words>` |
| The places nearest a circle's centre, the point rounded to two decimals | the name to show for a listing's place, and for a search's place a link gives with no name | `/v1/name?near=<lat>,<lon>` |

Of the places nearest a centre, the name is the caption of the first whose `radiusKm` times 5 is at
least the circle's, so a town names a wide circle and a colonia a small one; else the nearest's.
Places' answers change only with a new file, so each is kept in memory for a day, by its question,
up to 10,000 of each kind. One that fails or takes more than 5 seconds is not kept: the place
shows by its size alone, and Where finds no place. What leaves the index is the words typed in
Where and points rounded to two decimals, and nothing is logged; places stores nothing and logs no
question. Each answer carries places' credit, which the About page shows.

### Which profiles count

A profile counts when its profile entry names a market in the directory and one of its roles, and
carries a verification that:

1. has a verification's shape (the standard's `verificationCheck`, for this profile's address);
2. names a verifier key `lists/verifiers.json` lists,
3. with the verifier name the list gives it;
4. is for the label `<market>/<role>`, the profile entry's own;
5. checks (the proofs package's `checkVerification`), checked once and its answer kept;
6. was first seen here no later than the key's `until`, when the list gives one.

A profile whose market has left the directory never counts, so it and its listings drop out of
search; its page, and each of its listings' pages, still opens, with a line saying its market is
no longer in the markets directory.

A proof carries no date, and an entry's time is its writer's word, so when this index first saw a
verification is the only time it can trust for a key that leaked: proofs seen after the leak do not
count, those before still do. A profile's page lists each proof with what this index made of it, and
`checks` lists the keys it counts for, once each. A profile that does not count has a page, but no
rating and no trust, and its entries count for nothing.

### Listings and feedback

A listing is listed when its profile counts and it fits its market by the markets package's
`checkEntry`, the markets manual's own check, which the foundation's MCP server runs too before it
signs one: each field one its market names for the role, or `contact`, which every listing may
hold, held only where its `when` matches, each answer written as its piece writes one (text, a
choice among its values, a number or a range, a price list, a place's circle, a date's days with
their hours and zone, a photo one of the files the body lists in `files`, the standard's own field,
or a link), a list of different answers where its field takes several. A market's `preview` and
its words under `ask` are for apps to ask first, and nothing enforces them. A listing not listed is
kept, and its own page and its profile's say `why`: it does not fit (naming the field, in
`checkEntry`'s words), its profile does not count, or it was deleted.

A listing's words for search (`src/read.ts`) are its text answers as written and its choice
answers as the markets read them, such as Spanish for `es`; never its places, dates, numbers,
prices, photos or links, whose text is coordinates, a time zone's name, codes and amounts.

Feedback is what people say about a profile, in three kinds: a review says how a deal went and
gives a score; a vouch says "I know this profile is real and honest"; a report says "this profile is
fake or a scam". Each names the profile it is about as its
`subject`, and may add text. One counts when, in order:

1. its writer counts here;
2. it fits its writer's market by `checkEntry`: `subject` an address, `score` "1" to "10" with at
   most one decimal, `text`, `listing` a listing's full address `<profile>/listing/<id>` whose
   profile is an address (a vouch and a report hold only `subject` and `text`), and the fields the
   market adds to its reviews, a photo among them naming one of the body's `files`;
3. a review gives a score;
4. it is about another profile, not its writer;
5. writer and subject have the same `market`, so each market is ranked on its own;
6. its subject counts here;
7. it is the writer's latest of its kind about that profile, by its entry's time: one review per
   writer, subject and listing (or no listing); one vouch and one report per writer and subject.

One that does not count says why, on both profiles' pages, and changes nothing.

### How it scores

In a small town, you'd trust a plumber more if people you trust speak well of them, and less if
someone reports they cheated. Praise from the neighbour who complains about everything counts for
more than praise from the one who loves everyone. This index works the same way, with numbers, one
market at a time. The one thing a town gets for free, knowing each neighbour is one real person,
comes here from verifications.

Each counted profile gets a uniqueness, a trust, a pickiness and ratings, one market at a time. The
code is `src/rank.ts`; each key's confidence is in `lists/verifiers.json`, every other number in
`config/scoring.json`.

| Part | How |
|---|---|
| **Uniqueness**, how sure it is the profile is one real person | `1 − Π(1 − c)` over the keys its verifications count for, each key once, `c` its confidence; on the pages, 0 to 100: 75 with a face check, 99 with an ID check too. Each check is one more chance to catch someone who is not one person, so a second raises it, never past 1 |
| **Words** | Each writer's one word about each profile it wrote about in its market: a report if its latest counted entry about it is a report, else a vouch, since it rated or vouched for it. A rating of 1 is a vouch: its writer dealt with the profile. A word weighs its giver's uniqueness times trust, at most 1 |
| **The vouch part** | `V = 1 − 0.5 × vouchStep^v`, `v` the sum of the vouches' weights: 0.5 with none; at `vouchStep` 0.5 each full vouch closes half of what is left to 1, never reaching it |
| **The report part** | `R = reportCut^r`, `r` the sum of the reports' weights: 1 with none; at `reportCut` 0.25 each full report leaves a quarter |
| **Trust**, how much its own words and scores weigh | `uniqueness × V × R`: a newcomer's is half its uniqueness, and it never passes it. Each part moves without touching the other |
| **Pickiness** | Each score on 0 to 1 as `(s − 1) / 9`; `P = 0.5 + 0.5 × Σ(Rt − s) / (1 + n)` over the `n` profiles it scored, `Rt` each one's current rating. Below others' ratings is tough, above is easy; few scores stay near 0.5. Shown nowhere |
| **Ratings** | Each score weighs `uniqueness × trust × (s × P + (1 − s) × (1 − P))`, so a tough rater's high scores count more and its low ones less, and an average rater's weigh half. A rater's reviews of one profile, one per listing, are one score, their mean. A rating is the weighted average of its scores, 1 to 10, to one decimal, shown as it is with how many raters; none with no counted review. A review's `weight` is its score's weight, split among its rater's reviews of that profile |
| **Settling** | Trust, pickiness and ratings depend on each other, so it works in rounds from each trust at half its uniqueness and each pickiness at 0.5, each round reading only the one before, so no order of anything changes the result. A round moves every value all the way until the biggest move stops shrinking; from then on, each time it stops shrinking, half as far as before. It stops when nothing moves by more than `tolerance`, or after `maxRounds` |
| **Search's order** | Top rated, the default: ratings with `marketWeight` of the market's average added, as one more rater of weight 1, then the newest listing. The average is the weighted average of every score in the market. A profile no one rated sorts at it; in a market with no scores, by the newest listing. Nearest, `sort=near`, with a place: nearest first; Cheapest, `sort=price`, with a price filter: cheapest first; ties in Top rated's order. A place alone narrows the results and never reorders them. Order only: a profile's page shows its ratings as they are |

At today's numbers, with trust and uniqueness from 0 to 100 as the pages show them:

| Who | Trust |
|---|---|
| A newcomer with a face check (uniqueness 75) | 38 |
| A profile of uniqueness 100, with no word / one full vouch / one full report | 50 / 75 / 13 |
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
signed within `maxAgeDays`, and it checks (the proofs package's `checkReputation`, answer kept). It
is only shown: the profile's page lists it with the trust it proves, and whether the profile counts,
its trust, uniqueness, ratings and leaf stay what its own verifications and words make them
(`src/rank.ts` reads no proof). The newest root always counts, since a tree that has not moved still
says what its proofs say; a root's age runs from when this index last signed it, as a root that
comes back is signed again. This index knows only its own roots.

### Its key, and where it keeps things

The index's key is its own secret (`src/seed.ts`): 32 random bytes the standard's `newSeed` makes at
its first start, in `DATA_DIR/index-seed.json`, readable by its own user only, never printed or
logged, made into a service key with no text (the standard's keys' `serviceKey`). Its address is the
index's name: the About page shows it, every page's JSON gives it as `index`, and it signs the
statements and the roots.

One SQLite file, `DATA_DIR/index.sqlite` (`node:sqlite`, with FTS5 for the text of listings;
`src/store.ts`), beside the secret. Everything in it comes back from the hosts but two tables: when
each verification was first seen, and every root it signed. Without the first, every proof would be
first seen anew, after any key's `until`; without the roots, the reputation proofs people show would
stop showing. `npm run rebuild` drops every other table, makes each again with this code's schema,
reads the hosts again, ranks, and exits; the secret is never touched.

## Its API

Every page is HTML for people, drawn by one template (`src/pages/template.ts`) from the page's JSON
object, which is also served at the same path with `.json`: the two never disagree, and anything a
page shows is in its object, the names places gave among it. Beside the object, a page is drawn only
with what stays fixed while the index runs: the markets at `MARKETS`, for each market's number,
icon, summary and fields and whether the directory still lists it, and `lists/apps.json`, for the
app it opens.

The pages look like the Forest app: its colors, light and dark by the device's setting, and Figtree
for every word, titles and prices at its heaviest, served from here, with Phosphor's icons drawn into
each page, so a page asks no other site but the hosts for their photos. One rule for the greens:
strong green does something (Search, Message, Show offers); soft green is what is picked (a side, a
filter that is on, a place once set); black is for words and the check badges; every other action is
outlined in black. The HTML runs no script: filters are links and one GET form, a fold is HTML's
own, and a phone's filters are a market page's same form, shown over the page at `#filters`. Each
page carries schema.org JSON-LD.

- **A market** shows as its icon on its color. The icon is the one its market file names, else the
  market's first letter, as it is for an icon this copy of Phosphor lacks. The color is the market's
  number cycled through this index's ten colors (`src/avatar.ts`), so markets numbered next to each
  other differ; a market gone from the directory has no number, and takes the pages' quiet ink. On
  the front page each market is a tile filled with its color, its name and its counts white over a
  fade of black behind them (`TILE` in `src/pages/template.ts`), so both pass WCAG's contrast on
  every color (`test/contrast.test.ts`).
- **A profile's picture** is the Forest app's animal for its address, on its market's color: solid
  when its role's listings are offers, light when they are requests. The forty animals and the rule
  are the app's, copied into `src/animals.ts`: 32-bit FNV-1a over the address's UTF-8 bytes, modulo
  the list's length, so a profile is the same animal in the app and here, for everyone, with no
  login. The drawings are Microsoft's Fluent Emoji, High Contrast, under the MIT license. A page's
  JSON gives the address; the animal is drawn from it, as a market's color from its number.
- **A badge** says a check this index counts for a profile, each a black square: a face, "Verified
  with a selfie", for a face check; an ID card, "Verified with ID", for an ID check.
- **A result** shows its title, the description's first line, its first price and, quiet, its
  profile's rating with how many raters scored it, "★ 9.2 (14)", and its distance once there is a
  place. A market shows its results in this index's opinion, which any index may choose otherwise:
  a grid of pictures when the first field its `preview` shows is a photo field, its listings being
  things to look at, else a list. In a grid, a result is its listing's first photo, square, or, with
  none, its market's icon on a tint of its color, then three lines: its title on one line, its price
  bold under it, then the quiet line. In a list, two lines: its title with its price at the right,
  then the quiet line. Search shows a grid, each photo marked with its market's icon.
- **A beta market** carries Beta beside its name on its page, and its page says what beta means:
  "Beta: it works, at your own risk, and may change." A live one carries none.
- **A field** shows its market's label for the listing's role above each answer as stored, in the
  words the markets package's `read` gives it in English: a choice as its value reads, such as
  Spanish for `es`; a number in its field's unit, "45 minutes", and a range so, "9 to 11 years",
  "18 years or more"; a date's days and hours, with its zone beside them, which `read` leaves out,
  "Tuesdays and Thursdays, 18:00 to 20:00 (Europe/Madrid)". A listing that does not fit its market
  shows each answer by its shape.
- **A place** reads as the Forest app says it, by its size and the name places gives its centre
  (What it asks places): "Within 10 km of Camden, London", a circle of 0 km "Exact spot near Sol,
  Madrid"; with no name, "Within 10 km", "An exact spot"; on a listing's page with a link to its point
  at openstreetmap.org.
- **A price** reads as the Forest app says it: its amount in its currency, in English's number
  format with no decimals on a whole amount, "€15", "$12.50", "MX$1,300" ("30 coins" for a currency
  that is no code), then what it is for: for one of its per, "a" or "an" and the per, "€15 an hour",
  "€900 a month"; per hour another count as a length, "for 3 hours", or under 2 hours and not whole
  "for 45 minutes"; any other per counted, "for 5 lessons", "for 2 people"; with no per, the amount
  alone. A request's says "Up to" first: "Up to €60 for 3 hours". A listing's page shows every
  price, each with its note under it; a result its first.
- **A profile's rating, trust and uniqueness** are in its page's fold What these mean, open on a
  laptop.

GET and HEAD only, open to any origin (`access-control-allow-origin: *`), `cache-control: public,
max-age=30, stale-while-revalidate=300`. Every field, for programs: [`skill.md`](skill.md).

| Path | JSON |
|---|---|
| `/`, twin `/index.json` | `{ index, markets: [{ name, summary, description, status, roles, listed, words }], lists }`: its address, every market in the directory with its summary, its description if it has one, and its status (`live` or `beta`), its role words, how many listings each role has `listed` and each role's word for its listings (`offers` or `requests`), and its lists, each key with its confidence; drawn as one search box and a tile per market, filled with its color, its icon big at its top right, its name, and every role's count in its word, 0 included, "48 offers · 12 requests" |
| `/about`, twin `/about.json` | `{ index, lists, credit }`: its address and its lists, as `/` gives them, and the credit places' answers carry, for the names of places (null before places has answered); drawn as what this index is, links to its JSON, `skill.md` and source, then what it reads, its address and the credit |
| `/markets/<name>` | `{ index, market, listings: { <role>: [<result>] }, role, query, total, results, place, currencies }`: the market's file verbatim, its `preview` and `status` among it, and every listing this index lists, by role, in Top rated's order; and the page's view of one side, `role`, the query's or else the market's first: search's filters below, but `market`, as `query` gives them, `total` how many of that side's listings they find, `results` a page of them in their order, `place` as search gives it, and `currencies`, those that side's listings price in, most used first. Drawn as its icon on its color, its name, Beta beside it when beta, its summary and what beta means, its description in a fold behind a quiet link, More about this market; its sides as tabs, each with how many listings it lists, each keeping the words and the place; Where and its filters, one GET form to this page, a fold for Where, for each choice and number field that side is asked (a choice as chips, Any first, or as a picker past 12 values; a number as a range in its unit), for the price, "Up to" an amount, per one of the market's own pers or in all, in a currency, that side's most used first, and for the rating, Any, 8 or 9 or more; how many and the order; its results; Show more |
| `/search` | `{ index, total, results: [<result>], query, markets, place, found }`, with any of `q` (each word a word's start in the listing, all of them), `market`, `role`; a place: `where`, words for it, places' first place found (What it asks places), or `near=lat,lon` with `near.name`, the name to show for it, which places gives when it is left out; `km`, how far the searcher would go (10 unless given: a listing whose place's circle touches that one, the distance between the two points at most `km` plus its `radiusKm`); `minRating`, `minReviews` (raters), with `market` a filter per choice and number field of that market's listings, each matched by the markets package's `match`, all of them together (a choice as `<field>=<value>`, a listing whose field holds that value, among its answers for one with several; a number as `<field>.min` and `<field>.max`, in its unit, a listing whose number or range overlaps them, a missing end limiting nothing; a listing that leaves the field out left out); a price filter, on once it gives an amount or with `sort=price`: `price.currency` with `price.per`, `price.min` and `price.max` (a listing with a price in that currency for that per, the whole deal's when `price.per` is left out, whose amount divided by its count is in bounds, per hour a length, so 25 for 0.75 hours is 33.33 an hour: prices compare only within one currency and one per); `sort`, `rating` (Top rated, the default), `near` (Nearest, with a place) or `price` (Cheapest, with a price filter); `limit` (20, at most 100) and `offset`. `query` is each of these as given, `markets` every market's name, `place` the place results are near, `{ near, name, km }`, `name` null when places names none, or null with no place, and `found` how many results each market holds. A page's form sends back the name it showed: `where` with the same words as `near.name` is no new place, and an emptied box clears it. Drawn as Where, a fold with its box and how far, 2, 5, 10, 25 or 50 km, reading "Anywhere" or "Camden, London · 10 km"; a chip per market with results, to its page with the words and the place kept; how many and the order, only those that apply; the results; Show more, each link carrying the place as `near`, `near.name` and `km` and never `where` |
| `/profiles/<address>` | `{ index, address, profile, checks, ratings, trust, uniqueness, statement, signature, listings, reviews, vouches, reports, words, proofs, message }`: drawn for a buyer: its animal, its market and role, its badges, its rating and how many reviews count, the first `message` link as Message and the rest as links, its listings as its market shows them, and the reviews it received, each with its score, its entry's month in UTC, its text, and its writer's animal and short name; its rating, trust and uniqueness in the fold What these mean, the rest, its vouches among it, in a second fold. One that does not count has no rating, 0, 0, and no `statement` or `signature`. Each listing, review, vouch and report gives its entry's `time` (ms since 1970) and says whether it counts and, when not, `why`, and gives the other profile's `market`, `role` and `checks`, its writer's on one received and its subject's on one given, as this index holds them (`null`, `null` and none for one with no profile entry here); each review its `weight`; `words`, each writer's one word and its weight; `message`, a link to message it from each app in `lists/apps.json` |
| `/profiles/<address>/listing/<id>` | `{ index, profile, market, role, listing, checks, ratings, trust, uniqueness, fields, pieces, units, labels, captions, reviews, message }`: one listing, at its address under `/profiles`; `listing` as its profile's page gives it, `fields` the fields its market asks its role's listings, in the order the markets package's `ask` gives them, the `preview`'s first and `contact` last, `pieces` each one's piece, `units` each number field's unit, `labels` how each choice value it holds reads, `captions` the name places gives each of its places' centres, by field, null where it gives none, `reviews` the reviews its profile received that count, `{ count, latest }`, the two newest as its profile's page gives them, and `message` each app's link to message the profile about this listing (its `about`). Drawn the same with photos or without, photos adding the top: on a phone full width, swiped, each with "1 / 3"; on a laptop one at a time, with round arrows to each photo's anchor. Then its market and role, its description's first line as its title, each price with its note under it, who posted it (their animal, short name, rating with how many reviews, badges, linking to their page), its fields but photo ones, each label above its value, each place with a link to its point at openstreetmap.org, its `contact` as written, the rest of its description, its two latest reviews and a link to all, and a line linking its JSON. On a phone a bar at the foot holds its price and Message; on a laptop the right column stays in view. Its title is its first price and first line; a listing not listed has its page too, saying why |
| `/v1/reputation` | `{ index, root, time, signature, leaves }`, `leaves` how many; 404 with no tree |
| `/v1/reputation/leaves` | `{ root, leaves: [{ profile, score }] }`, every leaf by address; 404 with no tree. No URL serves one leaf and its path: asking for one would tell the index, and whoever logs its requests, which profile is the caller's |
| `/sitemap.xml`, `/robots.txt` | The home page, the About page, each market, each counted profile, each listing it lists |
| `/llms.txt`, `/skill.md` | Files here written for `https://index.forest.foundation`, served with `PUBLIC_URL` in its place |
| `/fonts/<file>` | The pages' font, the files of `@fontsource-variable/figtree` as the package gives them, cached for a day |

A `<result>` is `{ profile, market, role, listing: { address, body, url, photos }, ratings, trust, uniqueness, checks }`, and with `near`,
`km`: the distance between the two points, to one decimal.
A listing, on every page, gives `url`, its own page, and `photos`: each file its fields name (a photo
field, read by its shape) at the first host its profile entry names, `<host>/v1/files/<sha256>`
([the host's read](../host/README.md#its-api)), since the person's app writes every entry and file
to each host its profile entry names. The index keeps no bytes.

## How we run it

Each of these is this index's opinion, in a file anyone can read or a setting below. Another index
holds its own.

- **Hosts** (`lists/hosts.json`): https://host.forest.foundation, in full. It reads no other host,
  follows no hosts a profile entry names, and takes no list of hosts sent to it.
- **Verifier keys** (`lists/verifiers.json`): each by address, with the verifier name its
  verifications carry, its check's name, its confidence and an optional `until`. Today the
  foundation's verifier's two keys, under `verifier.forest.foundation`, neither with an `until`: its
  face key `4H5vL1ym…`, face check at 0.75, and its ID key `AbmjkNZy…`, ID check at 0.95.
- **Markets:** every market in the directory at `MARKETS`, each role its file lists.
- **Weights** (`config/scoring.json`): `vouchStep` 0.5, `reportCut` 0.25, `marketWeight` 1,
  `tolerance` 1e-9 and `maxRounds` 1000.
- **Reputation proofs** (`lists/indexes.json`): its own (`self`), against its newest root or one it
  signed in the last 30 days (`maxAgeDays`).
- **Apps** (`lists/apps.json`): each by name, with its `message` link to message a profile, `{address}`
  the profile's address, and its `about` link to message it about one listing, `{listing}` the
  listing's full address, `<profile address>/listing/<id>`, the shape a review's `listing` has. A
  profile's page links `message`, a listing's `about`. Today the Forest app,
  `https://app.forest.foundation/message?to={address}` and
  `https://app.forest.foundation/message?to={address}&listing={listing}`; `listing` is for the app,
  and one that does not read it ignores it. Without the file, the pages link to no app.
- **Places** (`PLACES_URL`): the foundation's, https://places.forest.foundation; each answer kept a
  day, up to 10,000 of each kind, each question given 5 seconds.
- **How often:** a pass 30 seconds after the last ends. A host that takes more than 60 seconds to
  serve a page fails that read; the next pass tries again.
- **What it keeps:** every entry its hosts served that checks, each proof check's answer, every root,
  and when each proof was first seen.
- **Logs:** its address at start, that it made its secret, a host failing, how many entries a host
  served that did not check, a pass that failed, and a failed request's path and error.
- **Public:** its pages, JSON, signed statements and tree. **Secret:** its key.
- **Where:** one replica of `deploy/Dockerfile`, built from the repo root, `DATA_DIR` on a volume.

### Settings

| Variable | Default | What |
|---|---|---|
| `DATA_DIR` | required | Its secret and the one file, on a volume |
| `PUBLIC_URL` | `https://index.forest.foundation` | Where the pages are published: an origin |
| `READ_SECONDS` | `30` | Seconds between the end of one pass and the start of the next |
| `PLACES_URL` | `https://places.forest.foundation` | The places service the pages ask for the names of places: an origin |
| `PORT` | `8080` | |

A setting, a list or the config file that does not read, or an `index-seed.json` that does not hold
a secret, stops the start, naming what is wrong.

```
./standard.sh                                              # from the repo root: the standard and the markets, at their pins
(cd host && npm ci)                                        # this repo's host, which the tests run
(cd places && npm ci)                                      # this repo's places, which the tests run
cd index && npm ci                                         # the standard's packages, linked by name from ../standard/
npm run check && npm test
DATA_DIR=./data PUBLIC_URL=http://127.0.0.1:8080 npm start
```

`test/` covers, on loopback, with this repo's host and this repo's places on its own tests' small
world, real verifications and reputation proofs from the circuits' committed proving files, and
markets of its own (`test/markets/`): the filter, the ranking and its guarantees, which feedback
counts, the markets' check and words, search's filters and its three orders, Where and places'
answers kept, the tree, every page drawn from its twin with its JSON-LD, the greens and the font,
each page's parts, the price and place words, the animals pinned to the app's, the tiles' contrast,
the apps' links, and the index end to end over HTTP, rebuilds included.

## Promises

- **It holds no key of anyone's but its own, and keeps no network address.** It has no sign-up:
  everything it serves is open to anyone, with no login. It logs no request but a failed one's path
  and error.
- **What it reads and how it weighs are files:** the hosts and the keys in `lists/`, its numbers in
  `config/`, its markets the directory at `MARKETS`. A change to one is a change anyone sees.
- **What it shows is signed.** Every counted profile's ratings, trust and uniqueness are signed with
  the key whose address is on the About page and in every page's JSON, and so is every root.
- **Every page is drawn from its JSON twin,** so a person and a machine read the same facts.
- **Nothing here links two profiles of one person, but what a small tree can show.** It ranks each
  profile on its own, and nothing it serves ties a profile to a person; in a small tree, a trust a
  person carries to another of their profiles can point at the one leaf it came from
  ([the standard's proofs](https://github.com/foundationforest/standard/blob/main/proofs/README.md#limits)).

## Limits

- **It trusts the verifiers it lists** to sign stamps only for the people they say.
- **Two of one person's profiles can rate or vouch for each other:** nothing here links them (FAQ).
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
- **Where takes the first place places finds:** a name many towns share finds the one places puts
  first.
- **A place's name is the nearest places holds,** however far, and only while places answers: with
  none, a place shows by its size alone.
- **Browsing by links goes market by market,** and filters live in the query, which some AI
  readers drop.
- **Pages in English only.**
- **Values as stored:** a number in its own unit and money in its own currency, never converted,
  so a price filter names one currency.
- **A market's fields filter by a choice or a number only,** one value or one range each: no
  filter on a date.
- **A hosting provider's own request logs** may hold each request's address and path.

## FAQ

**Why does search filter by a market's fields only once a market is chosen?**
A field means what its market's file says: two markets may give one name another piece or other
values. Within one market each name has one meaning, so a filter on it finds all it should.

**Why does a price filter need an amount?**
A market's filter form sends the currency and the per it shows every time, since a page with no
script cannot leave them out. If a currency alone filtered, a form sent for a rating would hide
every listing priced in another currency. So `price.currency` and `price.per` say what an amount is
in, and filter once there is one, `price.min` or `price.max`, or with `sort=price`.

**Why does a filter leave out a listing that says nothing in that field, when the markets match a
missing answer?**
Someone who filters by Spanish wants listings that say Spanish; one that says nothing may not have
it. The markets' `match` compares two answers of one field and leaves how fields combine, and what
a missing one means, to each index: this one counts only what a listing says.

**Why does a profile no one rated sort at its market's average, and not last?**
Search adds the market's average to every profile's ratings, as one more rater; with no other rater,
the average is all there is. A profile rated below the average sorts below one no one has rated yet:
its ratings say it is worse than the market's usual. Its page still says it has no rating.

**Why do rounds move half as far once the biggest move stops shrinking?**
Reports can make whole moves flip for ever: thirty profiles that all report each other go from high
trust, so heavy reports, to low trust, so light reports, and back, every round. Moving half as far
settles them where trust is what the reports leave of it, 6 each. Where whole moves settle on their
own, the result is the same, within `tolerance`.

**Can one of my other profiles rate or vouch for me?**
Only in the same market, and only as the other role: a review, a vouch or a report counts only
between two profiles of one market, and a seed has one profile per market and role. Nothing here
can link two profiles of one seed, so this index cannot catch it. The ranking bounds it: a rater's
reviews of one profile, across all its listings, count as one score, so many listings don't multiply
it; and two faces lift each other from 38 to 45, and never past their uniqueness, 75.
