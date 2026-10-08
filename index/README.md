# index

The index reads what profiles publish on hosts, the registry's rows and the escrow's receipts,
scores each profile, and serves it all at open URLs: pages for people, JSON for AI agents.

The foundation runs this one, on devnet, at https://index.devnet.forest.foundation. Anyone can run
another, from this code or their own. What this one reads and how it weighs it are its
[Policy](#policy), files in this directory, so anyone can rebuild what it shows from them, the hosts
and the chain.

Up: [the repo](../README.md). For AI agents: [`skill.md`](skill.md) and [`llms.txt`](llms.txt).

## How it works

```
hosts in lists/hosts.json ── records ───────────────────────┐
registry ── rows of the issuers in lists/issuers.json ──────┤
escrow ── its own events: receipts ─────────────────────────┼──▶ scores ──▶ pages, JSON, the tree
markets directory ── the markets lists/markets.json names ──┘
```

### What it reads

- **Records, from each host in `lists/hosts.json`, in full.** Everything new on the whole host
  (`GET /v1/records?after=`, forest's
  [records](https://github.com/foundationforest/forest/blob/main/records/README.md#hosts)), from a
  cursor kept in Postgres, so a profile is found the first time it writes there. No other host is
  read, and a profile's hosts record is not followed.
  - Every record is checked by forest's reader (`readPage`): its canonical text and its signature.
    One that fails is dropped and logged; every one that checks is kept, as its text, per host.
  - Each profile is viewed with forest's own `viewProfile`, which applies the access rule (forest's
    [records](https://github.com/foundationforest/forest/blob/main/records/README.md), "Which record
    counts"), so this index sees exactly what any other reader sees.
  - Three paths are read: `profile`, `offer/<id>` and `review/<id>`, each body checked against
    forest's shape for it (`forest/records/schemas/`); one that fails is not stored. A private
    record is left alone: only its readers can open it. Other paths are not this index's.
  - Only a profile holding a row from an issuer it trusts (below) is stored. Any other's records
    wait, kept, and are stored the day its row is read, with nothing to read again.
- **Rows, from the registry.** Every row of each issuer key in `lists/issuers.json`, read from the
  program's own accounts on every poll (`fetchRows`). A row
  ([registry](https://github.com/foundationforest/forest/blob/main/registry/README.md#the-row))
  names the profile, its stamp, the issuer's key, the payer, when the chain wrote it, and the label.
  It never changes, so only new ones are stored. The program writes a row only after checking a
  person proof against the issuer's key the row names, so the row is the proof: nothing is asked of
  the issuer.
- **Receipts, from the escrow's own events.** Every transaction that named the escrow, oldest
  first, failed ones skipped. Each one's log lines are archived in Postgres (`chain_transactions`),
  since RPC nodes are not an archive. Only events the program itself wrote are read (the escrow
  client's `decodeEvents`), since another program can print the same bytes. From `Created`,
  `Funded`, `Ended`, `Closed` and `Objected` it keeps each deal's receipt
  ([escrow](https://github.com/foundationforest/forest/blob/main/escrow/README.md)).
  Everything it knows of the escrow is in `src/chain/escrow.ts`.
- **Markets, from the markets directory.** Each name in `lists/markets.json`, read at start from
  the directory that list names (its `directory.md` gives each name's file), never copied, so there
  is one source of names. Each file is checked for the fields the index reads (`name`, `folder`,
  `description`, `sides`, `roleNames`, `evidenceTypes`, `offerFields`, `reviewFields`, `ratings`,
  `howDealsGo`). A name the directory does not list, or a file that fails, is not used. An
  offer names no market: it is listed in its profile's.
- **Pictures, from the same hosts.** A profile's `photo`, and the `media` of an offer or a review,
  name bytes by their SHA-256, with a type
  ([records](https://github.com/foundationforest/forest/blob/main/records/README.md#blobs)). For
  each picture a stored record names, the readers ask each listed host that served that record for
  the bytes (forest's `getBlob`, which checks the hash), and keep which host holds which hash as
  which type, never the bytes. One not there yet is asked for again after every read, since an app
  posts the record before its bytes.

### How it scores

Three scores, never added together or blended into one number. The method is this index's own,
like its numbers ([Policy](#policy)): another index may weigh differently. The code is
`src/scores/compute.ts`, and it says the same as this section.

**Which rows count.** A row counts for a profile only if all of these hold:

1. **Its issuer's key is in `lists/issuers.json`, and the chain wrote the row no later than that
   issuer's `until`, when the list gives one.** That is the leak date: when an issuer's key leaks,
   `until` is set to when it leaked, so the rows made after it count for nothing and the rows made
   before still count.
2. **Its label is `market/role`, the market one this index uses, byte for byte,** and the role one
   the market's sides allow: `seller` or `buyer` in a two-sided market, `peer` in a one-sided one. A
   market's role names (`teacher`, `student`) are words for pages, never roles. A plain market, with
   no role, counts for nothing, and so does any other separator: if other spellings counted, one
   person could hold two rows in one market.
3. **It is the profile's own label:** the `market` and `role` its card names. A person in a second
   market, or on the other side of the same one, holds a second profile.

A counted row means real and accountable, not good.

**Uniqueness,** per counted label, from 0 to 1: how sure this index is that the profile is one real
person there. Each issuer in the list has a weight for each tier of its notes. A row weighs its
issuer's weight at the tier the profile's card shows for it, checked
([Proofs a profile shows](#proofs-a-profile-shows)), or its issuer's smallest weight when it shows
none. Over the issuers whose counted rows the profile holds under that label:

    uniqueness = 1 − (1 − w1) × (1 − w2) × …

One issuer at weight w gives w; two give more than either, and never more than 1; an issuer at 0
adds nothing.

**Evidence: what backs a review.** A review can name a deal with its `dealId`. When that id is an
escrow's address, the index reads that escrow's receipt. It backs the review only if the reviewer
and the reviewed are the escrow's buyer and seller, in either order (a profile's address is where it
is paid), and its token is one this index takes. Then the index asks whether the seller said yes.
The escrow has no accept step: the seller says yes by creating the escrow (an invoice), by signing
its ending (a split, or a release back to the buyer), or by reviewing the deal.

| What the receipt shows | Evidence |
|---|---|
| Paid, and the seller created it or signed its ending | `both` |
| Paid, the buyer created it, and the seller reviewed the deal | `oneSidedConfirmed`, as `both` |
| Paid, the buyer created it, and the seller signed nothing and wrote no review | `oneSided` |
| Not paid; no deal id, no receipt, someone else's receipt, a token it does not take | `none` |

"Paid" means someone marked the escrow funded, or it ended: every way out pays a balance that held
the amount (the program checks it), so an ending proves the payment. Each kind's weight is Policy.

**Standing,** per profile, from zero, any number, below zero too. Each review received adds

    reviewer's weight × evidence weight × signal

- **Signal:** `(overall − 5.5) / 4.5`: an `overall` of 10 is +1, 5.5 is 0, 1 is −1. No `overall`
  says neither, so it adds 0. Other rating names show on the review and weigh nothing here.
- **Reviewer's weight:** `max(u, floor) × (1 + t / (|t| + 1))`, where u is the reviewer's best
  uniqueness, the floor is what a reviewer with no counted row gets (`unstampedReviewer`), and t is
  the reviewer's own standing, which moves the weight between nothing and twice the base.
- The sum is repeated, everyone starting at 0, until no profile moves by more than a tolerance, or
  for at most a number of rounds.
- A review of oneself is ignored. Per reviewer and subject, standing takes one review per deal id
  with evidence under it, and of the reviews with none, only the latest. Inventing deal ids adds
  nothing.

**Rating,** per profile, from 1.0 to 10.0: the reviews standing takes that give an `overall`,
averaged with the weights standing gives them. No such review: no rating, rather than a
zero.

**The signature.** Every score is served with a statement and an Ed25519 signature over its text,
in hex:

    forest.foundation/index/v2/score
    kind uniqueness            (or standing, or rating)
    profile <the profile's address>
    label online-tutors/seller (empty for standing and rating)
    value 1000000              (millionths; may be negative for standing)
    at 1790300000              (unix seconds, when this value was first computed)

The key comes from a 32-byte seed (`INDEX_SIGNING_SEED`) by HKDF-SHA256, and its public half is in
`/index.json` as `index.keys.ed25519`, in hex. A score whose value has not changed keeps its
statement and signature, so a signature someone holds stays good. Whenever anything new is read,
every score is computed again.

### What it publishes

#### The pages

Every page is plain HTML rendered on the server, readable on a phone, with no JavaScript, and has a
JSON twin at the same address with `.json` added to the path. The twin is the very object the page
is rendered from, so people and AI agents read the same facts and the two never disagree. No page a
person reads says a crypto word; the twins keep the records' own field names (`mint`), since they
are for machines.

- **`/`**, twin `/index.json`: the folders, their markets and live offer counts. The twin also has
  the index's public key, how its scores are signed, its four lists, and where its tree is.
- **`/folders/{folder}`**: one folder's markets.
- **`/markets/{market}?near=&km=&offset=`**: the market file, counts, and its live offers, 50 a
  page: sellers with a counted row there first, then by standing, then newest. `near=lat,lon&km=N`
  keeps the offers whose point is within N km.
- **`/profiles/{address}`**: a stored profile: its rows, counted or not and why, their issuers and
  the tier each shows; its scores, apart and signed; the reputation proofs it shows; its offers and
  requests; the reviews it received and gave, each with the payment behind it.
- **`/deals/{dealId}`**: the receipt in plain words (or none), the two profiles with their scores,
  and the reviews that name the deal.
- **`/search?q=&near=&km=`**: the markets whose name, folder, roles or role names contain `q`, and
  live offers by full-text search (Postgres's `simple` configuration).
- **`/pay?…`**: an offer's Pay link, checked against the offer as indexed (The Pay link, below).

A live offer is an offer, not expired, from a profile whose market this index uses. The pages show
the scores side by side, never as one number: uniqueness as a percentage with who checked it, and
"ID-checked" for a row shown at tier 2; the rating out of 10 and the standing. Also `/llms.txt`,
`/skill.md` (the read skill, for AI agents), `/sitemap.xml` and `/robots.txt`; schema.org JSON-LD on
every page (each profile's an `AggregateRating` from its rating); GET and HEAD only,
`access-control-allow-origin: *`, `cache-control: public, max-age=30, stale-while-revalidate=300`.
`llms.txt` and `skill.md` are files in this directory, written for `https://forest.foundation`; each
index serves them with its own `PUBLIC_URL` in its place. Search, Pay links, a market filtered by
`near`, and a deal with no receipt say `noindex` and are left out of the sitemap.

**Pictures** show from the host that holds them, never from the index: an image for a png or a
jpeg, a video for an mp4. A page shows one only when a listed host that served its record holds the
bytes as the type the record names; otherwise it shows nothing. Each twin gives every picture as its
record names it (`sha256`, `mimeType`) with its `url` on that host, or null.

**Inboxes.** A profile's twin gives its card's `inboxKey` and `inbox`: who may send it a message,
and the readers each message is encrypted to besides. A message goes to the profile's own hosts
([records](https://github.com/foundationforest/forest/blob/main/records/README.md#inbox)): none
passes through the index.

#### The Pay link

The one format for paying for an offer from any app is forest's
[escrow](https://github.com/foundationforest/forest/blob/main/escrow/README.md)'s ("The pay link").
This index shows it on every live offer with a price, at its own address (`/pay?…`), and never pays
or holds money: it links. `/pay.json?…` says whether the link still matches the offer as this index
holds it (`check`): `matches`, `changed` (the offer was edited since), `differs` (the link was
altered), `notLive`, `noPrice`, `notFound` or `invalid`.

#### The reputation tree

The index publishes its ratings as a tree in forest's format (forest's
[circuits](https://github.com/foundationforest/forest/blob/main/circuits/README.md), "The tree an
index publishes"), so a person proves on their device a rating from their own profiles, naming none
of them. The code is `src/scores/reputation.ts`.

- **A leaf** per stamp of a counted row, for each profile with a rating: the row's stamp; the scope
  of its label, as the registry computes it; the rating times ten, as the pages round it (1.0 to
  10.0 is 10 to 100); and how many reviews the rating comes from. A profile with no rating has no
  leaf; one with rows from two issuers has two.
- **In order of stamp,** which says nothing about whose leaf is whose.
- **The root** is circuits' `buildTree` over the leaves, signed with the key that signs the scores,
  over circuits' `signedBytes(root, time)`, the time in milliseconds.
- **Rebuilt after every scoring pass,** in the same database transaction. Leaves that did not change
  keep their root, time and signature. With no leaf there is no tree.

Two URLs serve it:

- **`/v1/reputation`:** `index` (the signing key, as an address), `root` (64 hex), `time` (ms),
  `signature` (base64url) and how many `leaves`.
- **`/v1/reputation/leaves`:** every leaf in order, `stamp` and `scope` (64 hex), `score` and
  `count`, with the `root` they make.

Both are JSON only, with the pages' headers, and answer 404 while there is no tree. They use the
formats a profile's proof carries, so an app copies them into its card as they are.

#### Proofs a profile shows

A profile's card may carry reputation proofs and person proofs
([records](https://github.com/foundationforest/forest/blob/main/records/README.md#proofs)). The
readers check them whenever they store the card, and store with it the ones that pass:

- **A reputation proof** whose `index` is in `lists/indexes.json`: circuits' `verifyReputation`, for
  the profile's own main key, the label the proof shows, and the root and time its index signed.
- **A person proof** whose `issuer` is in `lists/issuers.json`: the registry client's `verifyTier`,
  against the row at its stamp, read over the readers' RPC, for the profile's own main key and the
  issuer and label the proof shows. One that passes weighs its row at that tier
  ([How it scores](#how-it-scores)). With no RPC, none passes; when the RPC fails, the index keeps
  what it held for the profile and checks its card again on the next poll.

One that fails, or names an index or issuer not listed, is left out; it is not an error. A proof of
any other circuit is left alone.

A page shows a stored reputation proof only while its root is one of its index's newest roots
(Policy). This index knows only its own roots, so it shows only proofs made against its own tree.
Under Rating, the page says "Rated 9.5 of 10 in Tutoring (per Forest index (devnet), 5 Oct 2026)",
or "across their profiles" when the proof shows no market. The twin's `proofs` give `score` (out of
10), `label`, `market`, `index` (`address`, `name`), `root` and `time`.

### Settings

Environment variables, read once at start; a change means a restart.

| Variable | Required | Default | What |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres 14 or later |
| `INDEX_SIGNING_SEED` | readers | | 32 bytes as 64 hex characters: the index's signing identity |
| `SOLANA_RPC_URL` | no | none | Unset: no chain reader. Must answer `getProgramAccounts` |
| `REGISTRY_PROGRAM_ID`, `ESCROW_PROGRAM_ID` | no | the devnet programs | The programs to read |
| `CHAIN_COMMITMENT` | no | `finalized` | Or `confirmed` (tests) |
| `POLL_MS` | no | `5000` | How often the readers look for anything new |
| `PUBLIC_URL` | no | `https://forest.foundation` | Where the pages are published: an origin |
| `PORT` | no | `8080` | |
| `HOSTS_FILE`, `MARKETS_FILE`, `ISSUERS_FILE`, `INDEXES_FILE` | no | the files in `lists/` | |
| `SCORING_FILE`, `CURRENCIES_FILE` | no | the files in `config/` | |

The `_FILE` variables point the index at another index's lists and weights ([Policy](#policy)).

### Two processes

The index is two processes over one Postgres database. `node src/main.ts` runs both in one, as on
devnet.

- **The readers,** `node src/main.ts readers`: always exactly one copy. They apply the migrations,
  read the hosts (records and which pictures they hold) and the chain, check the proofs on cards,
  compute and sign the scores and the tree, and write the public key for the pages. They read and
  write the database, and hold the signing seed.
- **The pages,** `node src/main.ts web`: as many copies as wanted. They serve every page and its
  twin, the tree, the sitemap, `robots.txt`, `llms.txt` and `skill.md`. They only read the
  database, and never hold the seed.

The pages answer through one web-standard handler, `createWeb(...).handle(Request) → Response`, so
they can also run as a serverless function. The readers cannot: they keep poll loops.

### Run it

Node 22.18 or later and Postgres 14 or later. From the repo root:

```
./forest.sh keys records registry/client escrow/client circuits/reputation
(cd forest/circuits/reputation && npm run fetch)   # proving files, for the reputation test
cd index && npm ci
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/forest_index
export INDEX_SIGNING_SEED=$(openssl rand -hex 32)   # keep it: it is the index's signing identity
export SOLANA_RPC_URL=https://api.devnet.solana.com
export PUBLIC_URL=http://localhost:8080
npm start                                          # migrates, reads, scores, serves on :8080
```

Checks:

```
npm run check                                      # type-check
npm run test:unit                                  # markets, scoring, signatures, the server
DATABASE_URL=postgres://… node --test --test-force-exit test/pages.test.ts
DATABASE_URL=postgres://… node --test --test-force-exit test/reputation.test.ts
DATABASE_URL=postgres://… node --test --test-force-exit test/tiers.test.ts
DATABASE_URL=postgres://… npm test                 # all of the above and the end-to-end test
```

- **The server test** needs nothing: a request the pages cannot read (a Host header no URL reads, a
  method a web Request refuses) gets an answer, and the server goes on.
- **The page tests** need Postgres. On a fixed story in a fresh database: every page and twin
  renders; every JSON-LD block validates against schema.org's vocabulary; each twin matches its
  page; the sitemap lists every page; every URL in `skill.md` and `llms.txt` resolves; no page says
  a crypto word; the Pay link reads back to the offer; a past access key's record stands and a
  message key's does not; a private record is never stored; a picture shows from the host that
  holds it, as the type its record names, and not at all when no host does; a row made after its
  issuer's `until` counts for nothing. In a database of their own: renaming the foundation's host
  keeps its cursor, records and pictures.
- **The reputation test** needs Postgres and circuits' proving files: a row is stored as the
  registry holds it; the served leaves rebuild the served root, and a proof made from them checks
  against the served root, time and signature; a proof on a card shows on the page and its twin;
  one with a byte changed, or against a root past the window, shows nothing.
- **The tier test** needs Postgres: forest's example card's person proof (tier 2 under
  `tutoring/seller`), against a stand-in RPC holding its row, counts the row at 0.9, and the page
  and twin say "ID-checked"; a byte changed, another tier, another issuer than the row's, an issuer
  the list does not name, or no RPC: no tier, and the row counts at 0.7; an RPC that fails leaves
  what the index held, and the next poll checks the card again.
- **The end-to-end test** (`test/e2e.test.ts`) runs forest's reference host, a local validator with
  the registry and the escrow, notes from two issuers signed with forest's `signNote`, and the
  index. It needs the two programs built (`cargo build-sbf --arch v3` in `forest/registry/program`
  and `forest/escrow/program`), `solana-test-validator` on the PATH and a Postgres where it may
  create and drop a database; it skips, saying which, if one is missing. Not in CI, and not run on
  the code as it is now.

### On devnet

The build context is the repo root. `deploy/Dockerfile` builds it: Node 22.22.2 and git,
`forest.sh records registry/client escrow/client circuits/reputation` (the circuit's committed
verification key; no proving file), `npm ci`, then `node src/main.ts` (readers and pages in one
process). The lists and the config are in the image.

The foundation's devnet index runs that image on Railway, project `forest-devnet`, service `index`,
at https://index.devnet.forest.foundation:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=index/deploy/Dockerfile`.
- **One replica,** health check `GET /`, a public domain to port 8080, no volume: its state is in
  Postgres, on Supabase (project `forest-devnet`), through the session pooler, with TLS verified
  against Supabase's public root, `deploy/supabase-root-2021.crt` (`NODE_EXTRA_CA_CERTS`).

| Variable | On devnet | Secret |
|---|---|---|
| `DATABASE_URL` | Supabase's session pooler | yes |
| `INDEX_SIGNING_SEED` | 32 random bytes, hex | yes |
| `SOLANA_RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `CHAIN_COMMITMENT` | `finalized` | no |
| `POLL_MS` | `10000` | no |
| `PUBLIC_URL` | `https://index.devnet.forest.foundation` | no |
| `PORT` | `8080` | no |

A new `INDEX_SIGNING_SEED` is a new signing identity: every score is signed again under a new public
key.

## Policy

Each of these is this index's opinion, not a rule. The lists and weights are files in this
directory, read at start, not settings on a server, so anyone can rebuild what this index shows from
them, the hosts and the chain. Another index holds its own.

- **Which hosts it reads** (`lists/hosts.json`): each in full. Today one: the foundation's host on
  devnet, https://host.devnet.forest.foundation. It takes no hosts records (`POST /v1/hosts`,
  forest's [records](https://github.com/foundationforest/forest/blob/main/records/README.md),
  "Indexes"), so no profile can ask it to read another host.
- **Which issuers count, and how much** (`lists/issuers.json`): each by its key (128 hex, x then y,
  as a row holds it), with a name, a weight from 0 to 1 for each tier (the tier in decimal) and, for
  a key that leaked, `until`: the last time a row of it counts, in UTC to the second
  (`2026-11-01T00:00:00Z`). No issuer counts unless it is named there. Today one: the foundation's
  devnet issuer, "Forest issuer (devnet)", at 0.7 for tier 1 (its face check) and 0.9 for tier 2
  (its document check), with no `until`. A row whose card shows no tier counts at 0.7. Tier 2 shows
  as "ID-checked".
- **Which markets count** (`lists/markets.json`): 57 names, each read from the
  [markets directory](https://github.com/foundationforest/markets)'s `main`.
- **How reviews weigh** (`config/scoring.json`): evidence `both` 1 (and so `oneSidedConfirmed`),
  `oneSided` 0.5, `none` 0.05; the floor for a reviewer's weight, 0.05; standing repeated until no
  profile moves by more than 10⁻⁹, for at most 100 rounds.
- **Which escrow it reads:** one program, forest's escrow at
  `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` on devnet (`ESCROW_PROGRAM_ID`). A deal through any
  other escrow is not evidence here.
- **Which tokens it takes** (`countedMints` in `config/scoring.json`): USDC, devnet USDC and the two
  devnet test dollars.
- **What the pages show as money** (`config/currencies.json`): those four tokens, as dollars with
  six decimals. Any other token shows with no number.
- **Which reputation proofs show** (`lists/indexes.json`): those from the indexes it names, by the
  address of their signing key, each with a name, made against one of an index's newest `roots`.
  Today this index alone (its devnet signing key, `8117HhEbnw4z1KVE1sryQfoqTRVsruNpLRZvqWWJnJvC`),
  and 10 roots: the newest and the nine before it.
- **Pictures:** shown only from a listed host that served the record and holds the bytes, checked
  against their SHA-256, as the type the record names. Each is fetched once per host, to check it.
- **How often:** every host and the chain are read every `POLL_MS` (10 seconds on devnet); a host
  that takes more than 60 seconds to serve a page fails that read, and the next poll tries again.
  A quarter of a second after anything new is read, every score and the tree are computed again.
- **What it keeps, and for how long,** in Postgres, with nothing deleted: every record its hosts
  serve, for every profile, stored or not, and every version it saw; every row of the issuers it
  lists; each escrow transaction's log lines; and every root it signed. A picture's bytes, never.
- **What the pages advise:** nothing. An offer's and a receipt's escrow options (an arbiter, a
  timer) are shown as they are: what to advise is each app's.
- **No request logs.** The pages log only a failed request's path and its error.
- **Providers, on devnet:** Railway runs it, its Postgres is on Supabase, and it reads Solana
  through Helius's devnet RPC ([On devnet](#on-devnet)).

## Promises

- **It holds no key of anyone's** but its own signing seed, and no account: everything it serves is
  open to anyone, with no login.
- **It keeps no network address.** The pages log only a failed request's path and its error, never
  an address or a query.
- **What it reads is public, and listed in this repo:** the hosts, the markets and the issuers it
  uses are three files in `lists/`, and its weights are files in `config/`.
- **It scores each profile on its own.** Nothing here links two profiles; nothing ties a profile to
  a person.
- **It never blends its scores into one number,** and signs every one it serves.
- **No page a person reads says a crypto word.**

## Limits

- **It trusts its issuers** to sign notes only for the people they say they do (the foundation's
  devnet issuer: one note number per face, with a stand-in that passes everyone). It cannot tell.
- **It trusts its Solana RPC** for rows, escrow events and the checks of tiers against rows; no
  second source cross-checks it.
- **One person's two profiles can raise each other's standing** with small deals between them: each
  is evidence whatever its amount, and nothing here links the two. How to weigh that is this index's
  choice.
- **A shown market and an exact rating can name the profile.** The tree is public. In a market with
  few rated profiles, the leaves under one label with one score may be just one, and a proof that
  shows that market and that rating then points to it. A proof that shows no market narrows it too,
  when few leaves share its score. An app should say so before a proof is shown (forest's
  [circuits](https://github.com/foundationforest/forest/blob/main/circuits/README.md#limits)).
- **Roots go stale by number, not by age.** The root moves with every new rating, so on a busy index
  a proof goes stale sooner than on a quiet one.
- **Only its own roots.** A proof made against another index's tree shows nothing here, even from an
  index the list names.
- **It reads only the hosts it lists.** A profile whose records live on other hosts is not shown
  here, whatever its rows.
- **A page with a picture has the reader's browser fetch it from the host,** which sees the reader's
  network address, though not the page: no referrer is sent. The foundation's host keeps no address
  ([host](../host/README.md)); on Railway, Railway's own request logs do.
- **A picture is checked once.** A host that loses the bytes after that leaves a broken picture on
  the page.
- **It keeps every record its hosts serve,** for every profile, stored or not, and every version
  it saw. A host can make it keep junk.
- **The markets are read once, at start.** A change in the markets directory reaches the index at
  its next restart, and while the directory does not answer, the index does not start.
- **Everything is computed again on every change,** and signing runs in JavaScript, inside one
  database transaction.
- **Scale:** one sitemap file (past 50,000 pages it needs a sitemap index); a profile page lists
  every review; `near` measures every live offer in the market; a pool of 10 Postgres clients per
  process; every issuer's rows are read again on every poll; after every read, every stored record
  is looked through for pictures not yet found, and each is asked for again; the tree is built whole
  when its leaves change, about 0.6 ms a leaf at circuits' measure, and every leaf goes out in one
  response.
- **On devnet, readers and pages are one process,** so the pages hold the signing seed.
- **Pages in English only.**
- **Address logs.** A hosting provider's own request logs are the operator's choice; on Railway they
  exist, with each request's client address and path.

## Who decides what

- **The standard (forest):** what a record, a row, a receipt and the tree are, and the access rule.
- **This index, by its policy:** which hosts it reads, which issuers and markets count, how much
  each tier and each review weighs, from when a leaked issuer's rows stop counting, which indexes'
  reputation proofs it shows and how many roots back, and what its pages show.
- **The markets directory:** each market's name and the fields it adds; which of them this index
  uses is its own.
- **A person, through their app:** where their records live, which index they read, and which
  proofs their card shows.

## FAQ

**Why read each listed host in full, and not follow the hosts each profile names?**
Reading what is new on the whole host finds new people the first time they write there, and what
the index reads stays a list anyone can see, instead of growing with whatever profiles name.

**Why does a row whose card shows no tier count at its issuer's smallest weight?**
A row does not say which tier its note was, and every note an issuer signs is at one of its tiers.
The smallest is the least it can be, so a row never weighs more than its card shows, and showing
a higher tier only adds.

**Why serve every leaf, and no URL for one leaf and its path?**
A path asked for by stamp tells the index, and whoever logs its requests, which profile is the
caller's, and an app that asked for two would link them. With every leaf, an app finds its person's
own on the device. forest's prover takes every leaf anyway.

**Why a number of roots, and not an age?**
A proof against the newest root stays exact however old it is, until someone's rating moves; an age
would expire it while it is still true.
