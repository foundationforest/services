# index

The index reads what profiles publish, the registry's rows and the escrow's receipts, scores each
profile, publishes its ratings as a tree a person proves from, and serves it all at open URLs, as
pages for people and as JSON for AI agents.

The foundation runs this one, on devnet: it reads Solana devnet and the foundation's host. Anyone
can run another, from this code or their own. What this one reads and how it weighs it are files in
this directory (Policy), so anyone can rebuild what it shows from them, the hosts and the chain.
Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md). How an AI agent reads it: [`skill.md`](skill.md).

## How it works

```
lists/hosts.json ── each host, in full ── records ──▶ forest's view (the access rule) ──┐
lists/issuers.json ── registry rows of those issuers' keys ───────────────────────────┼─▶ scores ─▶ pages + JSON, the reputation tree
the escrow's own events ── receipts ───────────────────────────────────────────────────┤
lists/markets.json ── each market's file, from the markets directory ──────────────────┘
```

### What it reads

- **Records, from the hosts in `lists/hosts.json`, each in full.** What is new on the whole host
  (`GET /v1/records?after=`), from a cursor kept in Postgres, so a profile this index has never seen
  is found the first time it writes there. No other host is read: a profile's hosts record is not
  followed, and nothing is looked up by profile.
  - Every record is checked by forest's reader (`readPage`): its canonical text and its signature.
    One that fails is dropped and reported. Every record that checks is kept, as its text, per
    host.
  - Each profile is viewed with forest's own `viewProfile`, which applies the access rule: an access
    key's record counts while the profile's permissions record lists the key with scope `write` or
    `past`, its paths covering the record's path; a key not listed, or listed with another scope,
    counts for nothing, and no date is checked. The main key's record wins over an access key's at
    the same path.
  - Three shapes are read, by path: `profile`, `offer/<id>` and `review/<id>`. Each live body is
    checked against forest's shape for it (`forest/records/schemas/`); one that fails is not
    stored. A private record (a body that is only `{private}`) is left alone: only its readers can
    open it. Every other path is not this index's.
  - Only a profile holding a counted row is stored; any other's records wait in the kept records,
    so the day its row is read it is stored with nothing to read again.
- **Pictures, from the same hosts.** A profile's `photo`, and the `media` of an offer or a review,
  name bytes by their SHA-256, with a type and a size (forest's records, "Blobs"). After each read,
  for every picture a stored record names, the readers ask each listed host that served that record
  for the bytes (`GET /v1/blobs/<sha256>`, forest's `getBlob`, which hashes them), and keep the
  host, the hash and the type the host serves them as, never the bytes (`src/records/blobs.ts`).
  Bytes that are not their hash count as not there. A picture not there yet is asked for again
  after the next read.
- **Rows, from the registry.** Every row of each issuer key in `lists/issuers.json`, from the
  program's own accounts (`fetchRows`, filtered on the issuer's key), on every poll. A row holds the
  profile, its stamp, the issuer's key, who paid, when the chain wrote it, and the label. A row never
  changes, so only new ones are stored. The program writes a row only after checking the person proof
  against the issuer's key the row names, so a row from a trusted key counts; it needs nothing else,
  no file from the issuer.
- **Receipts, from the escrow's own events.** Every transaction that named the escrow, oldest first;
  failed ones skipped. Each transaction's log lines are kept in the index's own archive
  (`chain_transactions`), since RPC nodes are not an archive. Only events the program itself wrote
  are read (the client's `decodeEvents`). Everything the index knows about the escrow is in
  `src/chain/escrow.ts`.
- **Markets, from `lists/markets.json`.** The markets it uses, by name, each read from the markets
  directory the list names, over HTTPS, at start: `directory.md` gives each name's file. Each file
  is checked for the fields the index reads (`name`, `folder`, `description`, `sides`, `roleNames`,
  `evidenceTypes`, `offerFields`, `reviewFields`, `ratings`, `howDealsGo`). An offer names no market:
  it is listed in its profile's market, and only when that market is one this index uses, byte for
  byte.

### How it scores

Three scores. They are never added together or blended into one number. A counted row means real
and accountable, not good. The code is `src/scores/compute.ts`, and it says the same as this section.

**Which rows count.** A row counts for a profile only if all of these hold:

1. **Its issuer's key is in `lists/issuers.json`.**
2. **Its label is `market/role`, the market one this index uses, byte for byte,** and the role one
   the market's sides allow: `seller` or `buyer` in a two-sided market, `peer` in a one-sided one. A
   market's role names (`teacher`, `student`) are words for pages, never roles. A plain market, with
   no role, counts for nothing, and so does any other separator: if other spellings counted, one
   person could register under two and hold two rows in one market.
3. **It is the profile's own label:** the `market` and `role` its card names. A person in a second
   market, or on the other side of the same one, holds a second profile.

**Uniqueness,** per counted label, from 0 to 1: how sure this index is that the profile is one real
person there. Each issuer has a weight from 0 to 1 in `lists/issuers.json`; for the issuers whose
counted rows the profile holds under that label,

    uniqueness = 1 − (1 − w1) × (1 − w2) × …

One issuer at weight w gives w; two independent issuers give more than either and never more than
1 (two at 0.5 give 0.75); an issuer at 0 adds nothing.

**Evidence: what backs a review.** A review can name a deal with its `dealId`. When that id is an
escrow's address, the index reads that escrow's receipt. It counts only if the reviewer and the
reviewed are the escrow's buyer and seller, in either order (a profile's address is where it is
paid), and its token is one this index counts (`countedMints` in `config/scoring.json`). Then the
index asks who said yes. The escrow has no accept step: the seller says yes by signing for the deal,
that is creating the escrow (an invoice), signing its ending (a split, or a release back to the
buyer), or reviewing the deal.

| What the receipt shows | Evidence | Weight |
|---|---|---|
| Paid, and the seller created it (an invoice) | `both` | 1 |
| Paid, the buyer created it, and the seller signed its ending (a split, or a refund) | `both` | 1 |
| Paid, the buyer created it, and the seller reviewed the same deal | `oneSidedConfirmed` | 1 |
| Paid, the buyer created it, the seller signed nothing and has not reviewed it | `oneSided` | 0.5 |
| Not paid yet, or closed unfunded | `none` | 0.05 |
| No deal id, an id with no receipt, someone else's receipt, or a token not counted | `none` | 0.05 |

"Paid" means someone marked the escrow funded, or it ended: every way out pays a balance that held
the amount (the program checks it), so an ending proves the payment.

**Standing,** per profile, from zero, any number, below zero too. Each review received adds

    reviewer's weight × evidence weight × signal

- **Signal:** `(overall − 5.5) / 4.5`: an `overall` of 10 is +1, 5.5 is 0, 1 is −1. No `overall`
  says neither, so it adds 0. Other rating names show on the review and weigh nothing here.
- **Reviewer's weight:** `max(u, 0.05) × (1 + t / (|t| + 1))`, where u is the reviewer's best
  uniqueness (a reviewer with no counted row gets the floor, `unstampedReviewer`) and t its own
  standing, which moves the weight between nothing and twice the base.
- The index repeats the sum, everyone starting at 0, until no profile moves by more than 10⁻⁹, or
  100 rounds.
- A review of oneself is ignored. Per reviewer and subject, one review counts per deal id with
  evidence under it, and the reviews with none count once in all: the latest. Inventing deal ids
  adds nothing.

**Rating,** per profile, from 1.0 to 10.0: the reviews that count for standing and give an
`overall`, averaged with the weights standing gives them. No such review: no rating, rather than a
zero.

**How the pages show them:** side by side, never as one number. A market lists sellers counted as a
real person first, then by standing. Uniqueness shows as a percentage with who checked it. The JSON
twins carry `rating` (`value`, `reviews`) and `standing`; each profile's JSON-LD carries an
`AggregateRating` from the rating, and each offer its seller's rating and standing.

**Signatures.** Every score is served with a statement and two signatures, Ed25519 over the
statement's text and EdDSA-Poseidon (zk-kit's, the scheme Semaphore uses) over one field element,
so a later zero-knowledge proof can check the index's word cheaply:

    forest.foundation/index/v2/score
    kind uniqueness            (or standing, or rating)
    profile <the profile's address>
    label online-tutors/seller (empty for standing and rating)
    value 1000000              (millionths; may be negative for standing)
    at 1790300000              (unix seconds, when this value was first computed)

The field element is `Poseidon(domain, kind, profile, label, value + 2^63, at)`: `domain` is
`fieldHash("forest.foundation/index/v2/score")`, `kind` is 1, 2 or 3, `profile` is
`fieldHash("forest.foundation/index/v2/profile/", profile)`, `label` is the registry's own
`scopeOf(label)` (0 for standing and rating), and `fieldHash` is the registry client's. Both keys
come from one 32-byte seed (`INDEX_SIGNING_SEED`) by HKDF-SHA256, and both public keys are at `/`.
A score whose value has not changed keeps its statement and signatures. When anything arrives, the
index waits a quarter of a second and recomputes everything.

### The reputation tree

The index publishes its ratings as a tree in forest's format
([circuits](https://github.com/foundationforest/forest/blob/main/circuits/README.md), "The tree an
index publishes"), so a person proves on their device a rating from their own profiles, naming none
of them. The code is `src/scores/reputation.ts`.

- **A leaf** per stamp of a counted row (How it scores, "Which rows count"), for each profile with a
  rating: the row's stamp; the scope of its label, as the registry computes it; the rating times
  ten, as the pages round it (1.0 to 10.0 is 10 to 100); and how many reviews the rating comes from.
  A profile with no rating has no leaf. A profile with rows from two issuers has two leaves, one per
  stamp.
- **In order of stamp.**
- **The root** is circuits' `buildTree` over the leaves, signed with the index's ed25519 key (the one
  that signs its scores) over circuits' `signedBytes(root, time)`, the time in milliseconds.
- **Rebuilt after every scoring pass,** in the same database transaction. Leaves that did not change
  keep their root, time and signature. With no leaf there is no tree.

| URL | What |
|---|---|
| `/v1/reputation` | `index` (the signing key, as an address), `root` (64 hex), `time` (ms), `signature` (base64url) and how many `leaves` |
| `/v1/reputation/leaves` | Every leaf in order: `stamp` and `scope` (64 hex), `score`, `count`; with the `root` they make |

Both are JSON only, with the pages' headers, and answer 404 while there is no tree. They use the
formats a profile's proof carries, so an app copies them into its card as they are. Every root the
index signed stays in its database.

### Proofs a profile shows

A profile's card may carry reputation proofs (forest's
[records](https://github.com/foundationforest/forest/blob/main/records/README.md#proofs), "Proofs").
When the readers store a card, each proof whose circuit is `reputation` and whose `index` is in
`lists/indexes.json` is checked with circuits' `verifyReputation`: for the profile's own main key,
the label the proof shows, and the root and time its index signed. The ones that pass are stored
with the card. One that fails, or names an index not listed, is left out; it is not an error. A
proof of another circuit is left alone.

A page shows a stored proof only while its root is one of its index's newest roots, as many as
`roots` in `lists/indexes.json`. This index knows only its own roots, so it shows only proofs made
against its own tree. Under Rating, the page says "Rated 9.5 of 10 in Tutoring (per Forest index
(devnet), 5 Oct 2026)", or "across their profiles" when the proof shows no market. The twin's
`proofs` give `score` (out of 10), `label`, `market`, `index` (`address`, `name`), `root` and `time`.

### The pages

Everything a person can read, an AI agent can read as data, at the same address. Plain HTML
rendered on the server, readable on a phone, with no JavaScript. No page a person reads says a
crypto word; the twins keep the records' own field names (`mint`), since they are for machines.

| Page | Twin | What it shows |
|---|---|---|
| `/` | `/index.json` | Folders, their markets and live offer counts. The twin also has the index's two public keys, how its scores are signed, its four lists, and where its reputation tree is |
| `/folders/{folder}` | `.json` | One folder's markets |
| `/markets/{market}?near=&km=&offset=` | `.json` | The market file, counts, and its live offers, 50 a page. `near=lat,lon&km=N` keeps offers within N km |
| `/profiles/{address}` | `.json` | A counted profile: its rows, counted or not and why, and their issuers; its scores, apart and signed; the reputation proofs it shows; offers and requests; reviews received and given, each with the payment behind it |
| `/deals/{dealId}` | `.json` | The receipt in plain words (or none), the two profiles with their scores, and the reviews that name it |
| `/search?q=&near=&km=` | `/search.json?q=` | Markets whose name, folder, roles or role names contain `q`, and live offers by full-text search (Postgres's `simple` configuration) |
| `/pay?…` | `/pay.json?…` | An offer's Pay link, checked against the offer as indexed |

Also `/llms.txt` (what Forest is, and where everything is), `/skill.md` (the read skill: how an
agent searches, reads a profile, checks a row and a receipt), `/sitemap.xml` and `/robots.txt`;
schema.org JSON-LD on every page; plain GET and HEAD only, `access-control-allow-origin: *`,
`cache-control: public, max-age=30, stale-while-revalidate=300`. `llms.txt` and `skill.md` are files
in this directory, written for `https://forest.foundation`; each index serves them with its own
`PUBLIC_URL` in that place. A live offer is an offer, not expired, from a profile whose market this
index uses. Search results, pay links, a market filtered by `near`, and deals with no receipt say
`noindex` and are left out of the sitemap.

**Pictures** show from the host that holds them, never from the index: an image for a png or a
jpeg, a video for an mp4, with the type the record names. A page shows a picture only when a listed
host that served its record holds the bytes as that type; otherwise it shows nothing. Each twin
gives every picture as its record names it (`sha256`, `mimeType`) with its `url` on that host, or
null. A profile's twin also gives its card's `inboxKey` and `inbox`: who may deliver it a message,
and the readers it is sealed to besides. A message goes to the profile's own hosts, in an envelope
only its inbox key and those readers open, and only its main key, or a message key it lists, pulls
it: no message passes through the index.

### The Pay link

The one format for paying for an offer from any app. The index shows it on every live offer with a
price. It never pays and never holds money: it links.

    https://forest.foundation/pay?v=2
      &offer=<profile address>/offer/<id>
      &record=<the id of the record that holds the offer>
      &price.amount=<whole units, decimal text>&price.mint=<mint>&price.per=<hour | day | job>
      [&terms.arbiter=<key>][&terms.timer.days=<1..65535>&terms.timer.to=<seller | buyer>]

Parameters come in exactly this order, so two apps write the same link. Every parameter after
`record` is the offer record's own field, named by its path. The seller is the profile the offer
address names, paid at its address: the link carries no other key, so a forged link cannot send
money anywhere else. An app reads the offer at `offer` (from its hosts, or `/profiles/<address>.json`),
shows the record's terms if its id is not `record`, agrees the amount, and pays with forest's
escrow client. `/pay.json?…` says whether the link still matches (`check`): `matches`, `changed`
(the offer was edited since), `differs` (the link was altered), `notLive`, `noPrice`, `notFound`,
`invalid`. Version 1 named profiles by did:key.

### Settings

Environment variables, read once at start; a change means a restart.

| Variable | Required | Default | What |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres 14 or later |
| `INDEX_SIGNING_SEED` | readers | | 32 bytes as 64 hex characters: the index's signing identity. The pages never need it |
| `SOLANA_RPC_URL` | no | none | Unset: no chain reader. Must answer `getProgramAccounts` for the registry |
| `REGISTRY_PROGRAM_ID`, `ESCROW_PROGRAM_ID` | no | the devnet registry and escrow | The programs to read |
| `CHAIN_COMMITMENT` | no | `finalized` | Or `confirmed` (tests) |
| `POLL_MS` | no | `5000` | How often the readers look for anything new |
| `PUBLIC_URL` | no | `https://forest.foundation` | Where the pages are published: an origin, no path |
| `PORT` | no | `8080` | |
| `HOSTS_FILE`, `MARKETS_FILE`, `ISSUERS_FILE`, `INDEXES_FILE` | no | the files in `lists/` | Another index's lists |
| `SCORING_FILE`, `CURRENCIES_FILE` | no | the files in `config/` | Another index's opinions |

| File | What it says |
|---|---|
| `lists/hosts.json` | The hosts it reads, each in full |
| `lists/markets.json` | The markets it uses, by name, and the directory their files are read from |
| `lists/issuers.json` | The issuers it trusts, by key (128 hex, x then y, as a row holds it), each with a name and a weight from 0 to 1 |
| `lists/indexes.json` | The indexes whose reputation proofs it shows, by the address of their signing key, each with a name; and `roots`, how many of an index's newest roots a proof may be made against |
| `config/scoring.json` | The evidence weights, the floor for a reviewer with no counted row, and `countedMints`: the tokens whose receipts count |
| `config/currencies.json` | Which tokens the pages show as which currency, and their decimals |

### Two processes

The index is two processes over one Postgres database. `node src/main.ts` runs both in one, as on
devnet.

| | Readers | Pages |
|---|---|---|
| Command | `node src/main.ts readers` | `node src/main.ts web` |
| Does | Applies migrations; reads the hosts (records and which pictures they hold) and the chain; checks the proofs on cards; recomputes and signs scores and the reputation tree; writes the public keys for the pages | Serves every page, its twin, the reputation tree, the sitemap, `robots.txt`, `llms.txt` and `skill.md` |
| Runs | Always, exactly one copy | As many copies as wanted |
| Database | Reads and writes | Reads only |
| Holds the signing seed | Yes | No |

The pages answer through one web-standard handler, `createWeb(...).handle(Request) → Response`, so
they can also run as a serverless function (not tried). The readers cannot: they keep poll loops.

### Run it

Node 22.18 or later and Postgres 14 or later. From the repo root:

```
./forest.sh keys records registry/client escrow/client circuits/reputation
(cd forest/circuits/reputation && npm run fetch)   # the proving files: the reputation test makes proofs
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
npm run test:unit                                  # markets, scoring, signatures, the server: nothing else needed
DATABASE_URL=postgres://… node --test --test-force-exit test/pages.test.ts
DATABASE_URL=postgres://… node --test --test-force-exit test/reputation.test.ts
DATABASE_URL=postgres://… npm test                 # all of the above and the end-to-end test
```

- **The server test** (`test/server.test.ts`) needs nothing: a request the pages cannot read (a Host
  header no URL reads, a method a web Request refuses) gets an answer, and the server goes on.
- **The page tests** (`test/pages.test.ts`) need only Postgres. On a fixed story in a fresh database
  they check that every page and twin renders, every JSON-LD block validates against schema.org's
  vocabulary, each twin matches its page, the sitemap lists every page, every URL in the read skill
  and `llms.txt` resolves, no page says a crypto word, the Pay link reads back to the offer, a
  past access key's record counts and a message key's does not, a private record is never
  stored, and a picture shows from the host that holds it with the type its record names, and not
  at all when no host does (forest's reference host, on loopback). In a database of their own, they
  check that the foundation's host under its new name keeps its cursor, its records and its
  pictures.
- **The reputation test** (`test/reputation.test.ts`) needs Postgres and circuits' proving files.
  It checks that a row is stored as the registry holds it, its stamp, issuer's key and time read
  from the row itself; then, on the page tests' story, that the served leaves rebuild the served
  root with circuits' `buildTree` and a proof made from them checks with circuits' verifier against the
  served root, time and signature; that a proof on a card shows on the page and in its twin; and
  that one with a byte changed, or against a root past the window, shows nothing.
- **The end-to-end test** (`test/e2e.test.ts`) runs forest's reference host, a local validator with
  the registry and the escrow, notes from two issuers signed with forest's `signNote`, and the index.
  It needs the two programs built (`cargo build-sbf --arch v3` in `forest/registry/program` and
  `forest/escrow/program`), `solana-test-validator` on the PATH and a Postgres where it may create
  and drop a database; the person circuit's files come with forest. It skips, saying which, if one is
  missing. Not in CI. It took about 15 seconds before rows came from the person proof, and has not
  been run since.

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
- **What it reads:** the foundation's host (`host/`), the rows of the devnet issuer's key, the
  devnet registry and escrow, and the markets directory's `main`.

| Variable | On devnet | Sealed |
|---|---|---|
| `DATABASE_URL` | Supabase's session pooler | yes |
| `INDEX_SIGNING_SEED` | 32 random bytes, hex | yes |
| `SOLANA_RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `CHAIN_COMMITMENT` | `finalized` | no |
| `POLL_MS` | `10000` | no |
| `PUBLIC_URL` | `https://index.devnet.forest.foundation` | no |
| `PORT` | `8080` | no |

A new `INDEX_SIGNING_SEED` is a new signing identity: every score is signed again under new public
keys.

## Policy

Each of these is this index's opinion, not a rule, and a file in this directory, read at start.
Another index holds its own.

- **Which hosts count:** the hosts in `lists/hosts.json`, each read in full. Today: the
  foundation's host on devnet. It does not answer the hosts request (forest's
  [records](https://github.com/foundationforest/forest/blob/main/records/README.md), "Indexes"), so
  no profile can ask it to read another host. Reading any host a verified profile names is a later
  feature.
- **Which issuers count, and how much:** `lists/issuers.json`, each issuer by its key with a weight
  from 0 to 1. No issuer counts unless it is named there. Today: the foundation's devnet issuer, at
  0.7. A row does not say the tier of the note behind it, so every row from it weighs the same.
- **Which markets count:** `lists/markets.json`, 57 names, each read from the markets directory's
  `main`.
- **The reputation tree:** rebuilt after every scoring pass, from every counted row of every
  profile with a rating. Leaves that did not change keep their root, time and
  signature.
- **Which reputation proofs show:** `lists/indexes.json`. Today this index alone (its devnet signing
  key, `8117HhEbnw4z1KVE1sryQfoqTRVsruNpLRZvqWWJnJvC`), and a proof against one of its 10 newest
  roots: the newest and the nine before it.
- **How reviews weigh:** `config/scoring.json`. Evidence: `both` 1, `oneSided` 0.5, `none` 0.05; a
  reviewer with no counted row starts at 0.05. A receipt counts in USDC, devnet USDC and the two
  devnet test dollars (`countedMints`). Standing settles within 100 rounds, to 10⁻⁹.
- **What the pages show as money:** `config/currencies.json`: those four tokens, as dollars.
- **Pictures:** shown only from a listed host that served the record and holds the bytes, checked
  against their SHA-256, as the type the record names. The readers fetch each picture once per host
  to check it, and keep the host, the hash and the type, never the bytes. One not there yet is asked
  for again after every read.
- **No request logs.** The pages log only a failed request's path and its error.

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
- **It cannot weigh a tier.** A row does not say which tier the person's note was; until profiles
  show their tier, every row from one issuer weighs the same.
- **It trusts its Solana RPC** for rows and escrow events; no second source cross-checks it.
- **A shown market and an exact rating can name the profile.** The tree is public. In a market with
  few rated profiles, the leaves under one label with one score may be just one, and a proof that
  shows that market and that rating then points to it. A proof that shows no market narrows it too,
  when few leaves share its score. An app should say so before a proof is shown (forest's circuits,
  Limits).
- **Roots are counted, not timed.** A proof shows while its root is one of the newest 10. The root
  moves with every new rating, so on a busy index a proof goes stale sooner than on a quiet one.
- **Only its own roots.** A proof made against another index's tree shows nothing here, even from
  an index the list names, until this index reads other indexes' roots: later work.
- **It reads only the hosts it lists.** A profile whose records live on other hosts is not shown
  here, whatever its rows.
- **A page with a picture has the reader's browser fetch it from the host,** which sees the
  reader's network address, though not the page: no referrer is sent. The foundation's host keeps
  no address (`host/`); on Railway, Railway's own request logs do.
- **A picture is checked once.** A host that loses the bytes after that leaves a broken picture on
  the page.
- **It keeps every record its hosts serve,** for every profile, counted or not, and every version
  it saw. A host can make it keep junk.
- **The markets are read once, at start.** A change in the markets directory reaches the index at
  its next restart. A market the list names that the directory no longer lists counts for nothing.
- **Everything is recomputed on every change,** and signing runs in JavaScript, inside one database
  transaction.
- **Scale:** one sitemap file (past 50,000 pages it needs a sitemap index); a profile page lists
  every review; `near` measures every live offer in the market; a pool of 10 connections per
  process; every issuer's rows are read again on every poll; after every read, every stored record
  is looked through for pictures not yet found, and each is asked for again; the reputation tree is
  built whole when its leaves change, about 0.6 ms a leaf at circuits' measure, and every leaf goes
  out in one response.
- **On devnet, readers and pages are one process,** so the pages hold the signing seed.
- **Pages in English only.**
- **Address logs.** A hosting provider's own request logs are the operator's choice; on Railway they
  exist, with each request's client address and path.

## Who decides what

- **The standard (forest):** what a record, a row and a receipt are, and the access rule.
- **This index, by its policy:** which hosts, issuers and markets count, how much each review
  weighs, which indexes' reputation proofs it shows and how many roots back, and what its pages
  show.
- **The markets directory:** each market's name and the fields it adds; which of them this index
  uses is its own.
- **A person, through their app:** where their records live, and which index they read.

## FAQ

**Why lists in the repo, and not settings on the server?**
So anyone can rebuild what this index shows: the lists say exactly which hosts, markets, issuers
and indexes it uses, and the rest is public on the hosts and the chain.

**Why read each listed host in full, and not follow the hosts each profile names?**
Reading what is new on the whole host finds new people the first time they write there, and what
the index reads stays a list anyone can see, instead of growing with whatever profiles name.

**Why does a row count by its issuer's key alone?**
The program writes a row only after checking the person proof against the issuer's key the row
names, so the row is the proof, read by anyone forever without asking the issuer. Which issuers to
trust is the reader's call: `lists/issuers.json` is this one's.

**Why apply the access rule with forest's own view?**
Every reader computes the same view from the same records, so this index counts exactly what any
other reader counts.

**Why does the index fetch a picture it never keeps?**
To check that the bytes are their hash, served as the type the record names, before a page shows
them. A reader of forest's blobs checks the hash itself; a page here shows only what checked.

**Why is a picture not there yet asked for again after every read?**
An app posts the record first and the bytes after it, so the first look often finds nothing.

**Why leave private records alone?**
Only their readers can open them; an index is not one of them. Anyone can still see that one
exists.

**Why is the markets directory read from the markets repo itself, never copied?**
One source of names, and only the fields the index reads are checked.

**Why is every score signed twice, and why does a score that did not change keep its signatures?**
Anyone can check the first; a later zero-knowledge proof can check the second cheaply; and a
signature someone holds stays good.

**Why is every page plain HTML with a JSON twin at the same address?**
People and AI agents read the same facts, and the two never disagree: the twin is the very object
the page renders.

**Why do the pages say nothing about an offer's or a receipt's escrow options?**
What to advise is each app's.

**Why serve every leaf, and no URL for one leaf and its path?**
A path asked for by stamp tells the index, and whoever logs its requests, which profile is
the caller's, and an app that asked for two would link them. With every leaf, an app finds its
person's own on the device. forest's prover takes every leaf anyway.

**Why count roots, and not how old a root is?**
A proof against the newest root stays exact however old it is, until someone's rating moves; an age
would expire it while it is still true.

**Why are escrow events read only as the program itself wrote them, and their logs archived here?**
Another program can print the same bytes, and RPC nodes are not an archive.
