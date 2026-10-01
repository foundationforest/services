# index

Devnet only: the foundation's index reads Solana devnet and a test board. Nothing is on mainnet,
and nothing is shipped.

Up: [the repo](../README.md). How it scores: [SCORING.md](SCORING.md). The Pay link:
[PAYLINK.md](PAYLINK.md). Running it as two processes: [HOSTING.md](HOSTING.md).

The index reads what is public about every profile: its records on boards, its badges in the
registry, the roots its issuers publish, and the payment receipts the escrows write on chain. It
keeps only the profiles holding a badge that an issuer it trusts vouches for. It scores each of
those profiles on its own, and serves everything at open URLs, with no login, twice over: as pages
for people and as JSON for AI agents.

It is one index among many: which issuers it trusts, how it weighs them and which tokens count are
its own settings, in `config/`. Anyone may run another with other settings.

The code says *host* for a board (`HOSTS`, `host_entries`), as forest's does.

## Agent-first

Everything a person can read, an AI agent can read as data, at the same address.

- **A JSON twin for every page.** The same URL with `.json` (the home page's is `/index.json`). The
  twin is the very object the page is rendered from, so the two never disagree.
- **`/llms.txt`:** what Forest is, in three lines, and where everything is.
- **`/skill.md`:** the read skill ([skill.md](skill.md)): how an agent searches, reads a profile,
  checks a badge and a receipt, and what the scores mean.
- **`/sitemap.xml`** lists every page meant for search engines; **`/robots.txt`** lets everyone read
  everything.
- **schema.org JSON-LD on every page:** a profile is a `ProfilePage` about a `Person` (a
  `LocalBusiness` when an offer names a place), with its offers, its reviews rated out of 10, and an
  `AggregateRating`.
- **Plain GET and HEAD only.** No key, no cookie, no session; `access-control-allow-origin: *`;
  `cache-control: public, max-age=30, stale-while-revalidate=300`.

`llms.txt` and `skill.md` are files in this folder, written for `https://forest.foundation`; each
index serves them with its own `PUBLIC_URL` in that place.

## Pages

Plain HTML rendered on the server, readable on a phone, with no JavaScript. No page a person reads
says a crypto word; the twins keep the records' own field names (`wallet`, `mint`), since they are
for machines.

| Page | Twin | What it shows |
|---|---|---|
| `/` | `/index.json` | Folders, their markets and live offer counts. The twin also has the index's two public keys and how its scores are signed |
| `/folders/{folder}` | `.json` | One folder's markets |
| `/markets/{market}?near=&km=&offset=` | `.json` | The market file, counts, and its live offers, 50 a page: badged sellers first, then by standing, then newest. `near=lat,lon&km=N` keeps offers within N km |
| `/profiles/{did}` | `.json` | A profile holding a trusted badge: each such badge, counted or not and why, and who vouched; its scores, apart and signed; offers and requests; reviews received and given, each with the payment behind it; credentials |
| `/deals/{dealId}` | `.json` | The payment receipt in plain words (or none), the two profiles with their scores, and the reviews that name it |
| `/search?q=&near=&km=` | `/search.json?q=` | Directory markets whose name, folder, roles or side words contain `q`, and live offers by full-text search (Postgres's `simple` configuration, which favours no language) |
| `/pay?…` | `/pay.json?…` | An offer's Pay link, checked against the offer as indexed ([PAYLINK.md](PAYLINK.md)) |

A live offer is an offer, not expired, from a profile whose market is in the directory. Search
results, pay links, a market filtered by `near`, and deals with no receipt answer to everyone but
say `noindex` and are left out of the sitemap.

An offer's escrow options and a receipt's are plain data in the twins; the pages say nothing about
them. What to advise is each app's.

## What it reads

- **Records, from boards** (`forest/records/SPEC.md` §7), directly, with no directory and no relay.
  - Every record is checked by forest's own reader (`readPage`): its canonical text and its
    signature. One that fails is dropped and reported.
  - The boards in `HOSTS` are read in full. Any other board is read only while the folder of a
    profile the index keeps names it, and only for badged profiles (`badged=1`). The first time a
    profile turns up in such a feed, its earlier records are read from that board by `profile`.
  - A board still answering after 60 seconds is skipped until it finishes. Each feed resumes from a
    cursor kept in Postgres.
  - Each profile is merged with forest's own merge (`viewProfile`), and what it holds now replaces
    what the index held. Four kinds, by path: `profile`, `offer/<id>`, `review/<id>`, `proof/<id>`
    (a credential or a membership). Each body is checked against its schema in
    `forest/records/schemas/`; one that fails is not stored. A record is addressed `<did>/<path>`;
    its `cid` is the id of the entry that holds it now. A profile's key is its wallet.
- **Badges: the registry's lines.** At start, every line from the registry program's own accounts
  (`getProgramAccounts`, each checked to sit at the address its code derives); then only newer
  transactions, for new lines. A line names a profile's key, a label, and the root of the issuer's
  list it was proven against. It never changes.
- **Issuers' roots,** for each issuer in `config/issuers.json`, at most once a minute:
  - its signed roots file (format in [the issuer's README](../issuer/README.md#the-two-files)),
    checked for canonical text, its issuer and its signature;
  - with an RPC, its notes on chain: every transaction naming the issuer's key since the last read;
    a root is kept only from a transaction that succeeded, that the key signed, and whose memo
    (program v2) names the key and is exactly a note (`…/issuer/root/v2`, with members) or a v1
    memo (`…/issuer/root/v1`, the root alone). The members are not kept.

  A root from either source counts. A line's issuers are those whose roots hold its root.
- **Memberships.** A `proof/<id>` membership record in a profile's folder adds its issuer to one of
  the profile's lines once it checks (`verifyMembership` from `forest/registry/client`, against the
  line, that issuer's roots and the registry's sealed verification key). It waits while its issuer,
  line or root is unknown.
- **Payment receipts: both escrow versions' events.** For each program, every transaction that
  named it, oldest first; failed ones skipped. Each transaction's log lines are kept in the index's
  own archive (`chain_transactions`), since RPC nodes are not an archive. Only events each program
  itself wrote are read. Everything the index knows about the escrows is in one file,
  `src/chain/escrow.ts`.
- **The market directory,** from the `markets` repo itself over HTTPS (`MARKETS_URL`), once at
  start: its `directory.md` and each market file it links. Each file is checked for the fields the
  index reads. An offer names no market: it is listed in its profile's market, and only when the
  directory has that market, byte for byte.

**What it keeps.** Every record of a profile holding a line a trusted issuer vouches for. Of a
profile holding only other lines, its `proof/` records, since a membership may earn it that trust.
Nothing else. When a profile comes to hold a trusted line, what was dropped is read again, by
profile, from every board the index follows and every board its folder names. When it stops, all
but its proofs goes.

## What it trusts

- **Signatures, not boards.** A board can withhold records, never forge one. A board's `badged`
  flag is a hint for what it sends; the index checks the lines itself.
- **The issuers its settings name,** each with a weight from 0 to 1 (`config/issuers.json`). An
  issuer not named vouches for nothing here.
- **Its Solana RPC** for lines, escrow events and issuers' notes. It has only that RPC's word for
  what the logs say.
- **The `markets` repo** at `MARKETS_URL` for market names.
- **The registry's sealed verification key,** read from `forest/registry/artifacts/semaphore-32.json`,
  for memberships.

## How it scores

In plain words in [SCORING.md](SCORING.md); the code is `src/scores/compute.ts`. In short:

- **Uniqueness, per badge:** how sure the index is that the badge belongs to one real human,
  from the weights of the trusted issuers vouching for it. A badge counts only under the label
  `market/role`, the market a directory name byte for byte, the role one its sides allow, and only
  when that is the profile's own market and role.
- **Rating, per profile, 1.0 to 10.0:** the `overall` ratings of the reviews it received,
  averaged, each weighed by its reviewer and by the payment behind it.
- **Standing, per profile, from zero:** the same reviews, summed with the same weights.
- **Never blended into one number.** Each score is signed with Ed25519 and with EdDSA-Poseidon,
  both keys from `INDEX_SIGNING_SEED`. When anything arrives, the index waits a quarter of a second
  and recomputes everything.

## Settings

Environment variables. Read once at start; a change means a restart.

| Variable | Required | Default | What |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres 14 or later |
| `INDEX_SIGNING_SEED` | readers | | 32 bytes as 64 hex characters: the index's signing identity. Both keys come from it. The pages never need it |
| `HOSTS` | no | none | The boards read in full: `https://` origins separated by commas (`http://` only on loopback). Unset: no record reader |
| `SOLANA_RPC_URL` | no | none | Unset: no chain reader, and issuers' roots from their files only. Must answer `getProgramAccounts` for the registry |
| `REGISTRY_PROGRAM_ID`, `ESCROW_PROGRAM_ID`, `ESCROW_V2_PROGRAM_ID` | no | the clients' own ids | The programs to read |
| `CHAIN_COMMITMENT` | no | `finalized` | Or `confirmed` (tests) |
| `POLL_MS` | no | `5000` | How often the readers look for anything new. Issuers' roots: at most once a minute |
| `MARKETS_URL` | no | `https://raw.githubusercontent.com/foundationforest/markets/main` | The folder holding the `markets` repo's `directory.md`. A commit in place of `main` pins it |
| `PUBLIC_URL` | no | `https://forest.foundation` | Where the pages are published: an origin, no path. Canonical links, the sitemap, the Pay link and the read skill use it |
| `PORT` | no | `8080` | |
| `ISSUERS_FILE`, `SCORING_FILE`, `CURRENCIES_FILE` | no | the files in `config/` | This index's opinions, below |

The three files in `config/` are this index's opinions, not the foundation's rules:

| File | What it says |
|---|---|
| `issuers.json` | Which issuers it trusts, keyed by did:key: a name, a weight from 0 to 1, and where its roots file is. Ships with one placeholder key (below) |
| `scoring.json` | The evidence weights, the unbadged reviewer's floor, and `countedMints`: the tokens whose receipts count (USDC on mainnet and on devnet) |
| `currencies.json` | Which tokens the pages show as which currency, and their decimals |

## Run it

Node 22.18 or later (it runs TypeScript directly) and Postgres 14 or later. From the repo root:

```
./forest.sh records registry/client escrow/client escrow/v2/client
cd index && npm ci

export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/forest_index
export INDEX_SIGNING_SEED=$(openssl rand -hex 32)   # keep it: it is the index's signing identity
export HOSTS=http://127.0.0.1:8787                 # a board, such as forest's reference board
export SOLANA_RPC_URL=http://127.0.0.1:8899
export PUBLIC_URL=http://localhost:8080
npm start                                          # migrates, reads, scores, serves on :8080
```

`npm start` runs the readers and the pages in one process. `npm run start:readers` and
`npm run start:web` run them apart; [HOSTING.md](HOSTING.md) says what each needs. `npm run migrate`
applies the migrations and stops.

Checks:

```
npm run check                                      # type-check
npm run test:unit                                  # directory, scoring, signatures: nothing else needed
DATABASE_URL=postgres://… node --test --test-force-exit test/pages.test.ts test/roots.test.ts
DATABASE_URL=postgres://… npm test                 # unit, pages and end to end (not roots)
```

- **The page tests** (`test/pages.test.ts`) need only Postgres. On a fixed story in a fresh
  database they check that every page and twin renders, every JSON-LD block validates against
  schema.org's vocabulary, each twin matches its page, the sitemap lists every page, every URL in
  the read skill and `llms.txt` resolves, no page says a crypto word, and the Pay link reads back to
  the offer.
- **The roots tests** (`test/roots.test.ts`) need Postgres: the issuer's own note transactions read
  back as the index reads them. `npm test` does not run them; CI does.
- **The end-to-end test** (`test/e2e.test.ts`) runs two of forest's reference boards, a local
  validator with the registry and both escrows, two issuers' roots files made by the issuer's own
  code, and the index. It needs the three programs built (`cargo build-sbf --arch v3` in
  `forest/registry/program`, `forest/escrow/program`, `forest/escrow/v2/program`), the proving files
  (`npm run fetch` in `forest/registry/artifacts`), `npm ci` in `../issuer`, `solana-test-validator`
  on the PATH, and a Postgres where it may create and drop a database. It skips, saying which, if
  one is missing. Not in CI.

## Deploy

Any platform that runs Node 22.18 and reaches a Postgres. The build context is the repo root, since
the index imports forest's pieces by relative path. `deploy/Dockerfile` builds it: Node 22.22.2 and
git, `forest.sh records registry/client escrow/client escrow/v2/client` at the commit in `FOREST`,
`npm ci`, then `node src/main.ts` (readers and pages in one process).

**The foundation's devnet index** runs that image on Railway, project `forest-devnet`, service
`index`:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=index/deploy/Dockerfile`.
- **One replica**, health check `GET /`, a public domain to port 8080, no volume: its state is in
  Postgres.
- **Postgres on Supabase** (project `forest-devnet`), through the session pooler on port 5432, with
  TLS verified against Supabase's public root, `deploy/supabase-root-2021.crt`
  (`NODE_EXTRA_CA_CERTS`).
- **Its opinions:** the Dockerfile points `ISSUERS_FILE`, `SCORING_FILE` and `CURRENCIES_FILE` at
  `deploy/*.devnet.json`: the devnet issuer (`did:key:z6MkmSeF…PLFV`) at weight 1 with its roots
  file's address; devnet USDC and the two devnet test dollars as counted money.

| Variable | On devnet | Sealed |
|---|---|---|
| `DATABASE_URL` | Supabase's session pooler | yes |
| `INDEX_SIGNING_SEED` | 32 random bytes, hex | yes |
| `SOLANA_RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `HOSTS` | the test board, `https://board-devnet-test-production.up.railway.app` | no |
| `REGISTRY_PROGRAM_ID` | `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf` | no |
| `ESCROW_PROGRAM_ID` | `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` (v1) | no |
| `ESCROW_V2_PROGRAM_ID` | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` | no |
| `CHAIN_COMMITMENT` | `finalized` | no |
| `POLL_MS` | `10000` | no |
| `PUBLIC_URL` | its own Railway address | no |
| `PORT` | `8080` | no |

`MARKETS_URL` is unset: the `markets` repo's `main`. A new `INDEX_SIGNING_SEED` is a new signing
identity: every score is signed again under new public keys.

## Files

| | |
|---|---|
| `src/records/` | The board reader (`hosts.ts`) and the record store |
| `src/chain/` | The chain reader, the registry's lines, the issuers' notes, and the escrow adapter |
| `src/issuers.ts` | Which lines are trusted; the issuers' roots files; the membership check |
| `src/markets.ts` | The market directory |
| `src/scores/` | The scores as pure functions, their signatures, and the recompute |
| `src/web/` | The pages, their twins, the JSON-LD, the Pay link, the machine files, the routes, a `node:http` server |
| `src/main.ts` | The readers, the pages, or both |
| `migrations/` | The schema, plain SQL, applied in order at start |
| `config/` | This index's opinions |
| `skill.md`, `llms.txt` | Served as `/skill.md` and `/llms.txt` |
| `SCORING.md`, `PAYLINK.md`, `HOSTING.md` | The scoring rules, the Pay link's format, the two processes |
| `deploy/` | The devnet image and its opinions |

## Limits

- **The default `config/issuers.json` is a placeholder.** It names the registry's earlier
  placeholder issuer key, which anyone with forest's code can sign for, with no roots address. With
  an RPC, an index on these defaults would take roots that key writes on chain. The foundation's
  issuer has no mainnet key yet.
- **On devnet, readers and pages are one process,** so the pages hold the signing seed.
- **The directory is read once, at start.** A change in the `markets` repo reaches the index at its
  next restart.
- **Everything is recomputed on every change,** and signing runs in JavaScript, inside one database
  transaction.
- **Scale:** one sitemap file (past 50,000 pages it needs a sitemap index); a profile page lists
  every review; `near` measures every live offer in the market; a pool of 10 connections per process.
- **A board can make it read and drop junk,** and the boards it crawls grow with whatever the kept
  profiles' folders name.
- **One RPC's word** for every log; no second source cross-checks it.
- **Two escrow versions,** each a program in `src/chain/escrow.ts`; a new version is code.
- **Pages in English only.**
- **Address logs at the hosting platform.** The pages log only a failed request's path and its error, never an
  address or a query. Railway keeps every request's client address and path in its own logs.
