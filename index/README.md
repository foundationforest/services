# index

The Forest index. It reads signed records from a firehose and the registry's and escrow's own
events from the chain. It scores every profile apart: uniqueness per badge, and a rating out of 10
and a standing per profile, never blended, each score signed twice. It serves the same data two
ways at the same open URLs, with no session and no login: pages for people, plain HTML with no
JavaScript, and for machines schema.org JSON-LD on every page, a JSON twin of every page, a
sitemap, `robots.txt`, `llms.txt` and the read skill.

**Nothing here is shipped.** It runs on devnet, its readers and pages in one process on Railway and
its Postgres on Supabase (`docs/services.md`); its tests run against a local host, a local directory
of DIDs, a local validator and a local Postgres.

## What it reads

- **Records**, from a firehose: the host's own (`host/`) in tests, the carrier later.
  - It uses Bluesky's own consumer, `@atproto/sync`, unchanged. For every commit, the consumer
    resolves the DID document, checks the commit's signature against the signing key the document
    names, and checks each record against the signed commit by its Merkle proof. A commit that fails
    is dropped whole.
  - Each record is then checked against its lexicon with `shapes/`' own validator, and a record that
    fails is not stored.
  - Only the four Forest collections are read: profile, post, review, credential. The cursor is kept
    in Postgres, so a restart resumes where it stopped.
- **Chain events**, from an RPC: a local validator in tests.
  - For each program, it reads every transaction that named it, oldest first; failed transactions
    are skipped.
  - It keeps each transaction's log lines in its own archive (`chain_transactions`), because RPC
    nodes are not an archive.
  - It reads only events the programs themselves wrote. The clients' decoders already refuse a
    `Program data:` line that another program wrote.
  - From the registry, **badges**: the scope (market, and role after a slash), the DID, the profile's
    wallet, the list, and the list's owner.
  - From the escrow, **receipts**: buyer, seller, who created it, its two options, token, amount,
    when it was created, marked funded and ended, the outcome, and what each side got.
- **The market directory**, from the `markets` repo itself, over HTTPS (`MARKETS_URL`, its main
  branch by default), never copied: its `directory.md` and each market file that page links, at
  `<folder>/<name>.json`, checked with `shapes/`' validator. A market has one name: there are no
  aliases. A post names no market; it is listed in its author profile's market, and only when the
  directory has that market, byte for byte. It is read once at
  start, so a change in the `markets` repo reaches the index at its next restart. The tests serve
  a stand-in from `test/markets/`.

**The escrow program may still change.** Everything the index knows about its events is in one
file, `src/chain/escrow.ts`, which maps the escrow client's events to the index's own `EscrowFact`.
It follows the escrow as rewritten to the handoff's "Escrow" (six events, no accept step, who
created it in `Created`). When the events change, change that file; the receipt table and its
store in `src/chain/poll.ts` change only if a receipt gains or loses a fact.

## How it scores

In [SCORING.md](SCORING.md), in plain words. In short:

- A badge counts only as `market/role`, the market a directory name byte for byte and the role one
  its sides allow (`seller` or `buyer` when two, `peer` when one), only when that is the profile's
  own scope (the market and role its record names), and only for the wallet the profile declares.
  A plain `market` counts for nothing.
- **Uniqueness** combines the weights this index gives the issuers vouching for a badge. The
  weights are in `config/issuers.json`: the foundation's list starts at 1, everyone else at 0.
- **Standing** sums the reviews received, from each one's `overall`
  rating. Each weighs by its reviewer (their badge, then their own standing) and by what is under
  its deal id:
  - a paid receipt the seller signed for (created it as an invoice, or signed a split or a refund): 1
  - a paid receipt the buyer created and the seller signed nothing on: 0.5, or 1 once the seller
    reviews it too
  - no receipt, or not paid: 0.05
- **Rating** averages the same reviews' `overall`, from 1.0 to 10.0, with the same weights.
- Every score is signed with Ed25519, and with EdDSA-Poseidon on BabyJubJub for later proofs.

## Pages and their twins

Every page is plain HTML rendered on the server, readable on a phone, with no JavaScript. Its JSON
twin is the same URL with `.json` (the home page's is `/index.json`), and it is the very object the
page is rendered from. Both answer GET and HEAD only, with `cache-control: public, max-age=30,
stale-while-revalidate=300`, `access-control-allow-origin: *`, no cookies, no session, no login.

| Page | Twin | What |
|---|---|---|
| `/` | `/index.json` | Folders, their markets and live offer counts. The twin also has the index's two public keys and the statement format |
| `/folders/{folder}` | `.json` | The folder's markets |
| `/markets/{market}?near=&km=&offset=` | `.json` | The market file (with how deals go), counts, and live offers: badged sellers first, then standing, then newest, 50 a page. `near=lat,lon&km=N` keeps the offers whose point is within N km |
| `/profiles/{did}` | `.json` | The profile; every badge, counted or not and why, and who vouched; its scores, apart and signed; live offers and requests; reviews received and given, each with the payment behind it; credentials |
| `/deals/{dealId}` | `.json` | The receipt in plain words (or none), the profiles that declare its two keys with their two numbers, and the reviews that name it |
| `/search?q=&near=&km=` | `/search.json?q=` | Directory markets matching `q` by substring (name, folder, roles, labels), and live offers by full-text search (Postgres's `simple` configuration, which favours no language), near a point if asked |
| `/pay?…` | `/pay.json?…` | An offer's Pay link, checked against the offer as indexed ([PAYLINK.md](PAYLINK.md)) |

For machines, at the root:

- `/sitemap.xml`: every page meant for search engines. Search results, pay links and deals with no
  receipt answer to everyone but say `noindex`, and are not listed.
- `/robots.txt`: everyone may read everything.
- `/llms.txt`: what Forest is in three lines, and where everything is.
- `/skill.md`: the read skill ([skill.md](skill.md)): how any AI agent searches Forest, reads a
  profile, checks a badge and a receipt, and what the scores mean.

`llms.txt` and `skill.md` are written for `https://forest.foundation`; an index serves them with
its own `PUBLIC_URL` in its place.

Every page carries schema.org JSON-LD. A profile is a `ProfilePage` about a `Person` (or a
`LocalBusiness` when an offer names a place) whose offers are `Offer`s of a `Service`; its reviews
are `Review`s with their authors, rated out of 10; and an `AggregateRating` is its rating, with
`bestRating` 10. Each `Offer` carries its seller's rating as `aggregateRating` and standing as a
`PropertyValue`. The JSON twins keep the records' own field names, such as `wallet` and `mint`,
because they are for machines; the pages for people say none of them.

An offer's escrow options (`terms`) and a receipt's (`arbiter`, `timer`) are plain data in the
twins; the pages say nothing about them, and what to say is each app's. A profile lives in one
market, as one side of it, as its record names them; a badge counts for it only under that scope.
Where a market file has labels, the pages use them for seller and buyer; a receipt takes its
seller's market's. A review's market is the market of the profile it is about: its extra fields
are that market's `reviewFields`.

### Changed from part one

Part one served its JSON at the bare paths. Those paths are now the pages, and the JSON moved to
the `.json` twins: `/` to `/index.json`; `/categories` into `/index.json`; `/markets/{m}/offers`
into `/markets/{m}.json`; `/profiles/{did}/reviews` into `/profiles/{did}.json`.

## Run it locally

Needs Node 22.18 or later (it runs TypeScript directly) and Postgres 14 or later. The index imports
`registry/client`, `escrow/client`, `shapes` and, in tests, `keys` and `host/` by path, so install
those first:

```
(cd shapes && npm install) && (cd registry/client && npm install) && (cd escrow/client && npm install)
cd index && npm install

export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/forest_index
export INDEX_SIGNING_SEED=$(openssl rand -hex 32)     # keep it: it is the index's signing identity
export FIREHOSE_URL=ws://localhost:2583              # a host from host/run.sh, or the carrier
export PLC_URL=https://plc.directory
export SOLANA_RPC_URL=http://127.0.0.1:8899
export PUBLIC_URL=http://localhost:8080              # where the pages say they are
npm start                                            # migrates, reads, scores, serves on :8080
```

`npm start` runs the readers and the pages in one process. Deployed, they are two
(`npm run start:readers`, `npm run start:web`); [HOSTING.md](HOSTING.md) says what each needs.

Tests:

```
npm run test:unit                                    # the directory, the scoring rules and the signatures; nothing else needed
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
```

`npm test` also runs the page tests and the end-to-end test.

The page tests (`test/pages.test.ts`) need only Postgres. They write part one's story into a fresh
database (`test/fixture.ts`) and check that every page and twin renders, that every JSON-LD block
validates against schema.org's vocabulary (release 30.1, cut down in `test/schemaorg/`), that each
twin matches its page, that the sitemap lists every page, that every URL in the read skill and
`llms.txt` resolves, that no page says a crypto word, and that the Pay link reads back to the
offer's terms.

The end-to-end test needs:

- `host/` built (`./build.sh`) and `keys` installed;
- both programs built (`cargo build-sbf` in `registry/program` and `escrow/program`);
- the proving files (`npm run fetch` in `registry/artifacts`);
- `solana-test-validator` on the PATH;
- a Postgres where it may create and drop a database.

It skips, saying which, if one is missing. The whole of `npm test` takes about 30 seconds here, 19
of them making three registration proofs.

`npm run check` type-checks; `npm run migrate` applies the migrations and stops (`npm start` does
that too).

## Environment variables

| Variable | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. A local one, or Supabase's connection string later |
| `MARKETS_URL` | no | Where the `markets` repo's files are read: the folder holding its `directory.md`, over HTTP(S). Default `https://raw.githubusercontent.com/foundationforest/markets/main`; a commit in place of `main` pins it. Only these names count in badges |
| `INDEX_SIGNING_SEED` | readers | 32 bytes as 64 hex characters. Both signing keys come from it. The pages never need it |
| `PUBLIC_URL` | no | Where the pages are published: an origin, no path. Canonical links, the sitemap, the Pay link and the read skill use it. Default `https://forest.foundation` |
| `FIREHOSE_URL` | no | `ws://` or `wss://`. Unset: no record reader |
| `PLC_URL` | no | Where DIDs resolve. Default `https://plc.directory`. An `http://` URL (a local directory) makes the resolver use plain fetch |
| `SOLANA_RPC_URL` | no | Unset: no chain reader |
| `CHAIN_COMMITMENT` | no | `finalized` (default) or `confirmed` (tests) |
| `CHAIN_POLL_MS` | no | Default 5000 |
| `REGISTRY_PROGRAM_ID`, `ESCROW_PROGRAM_ID` | no | Default: the clients' own ids |
| `PORT` | no | Default 8080 |
| `ISSUERS_FILE`, `SCORING_FILE`, `CURRENCIES_FILE` | no | Default: the files in `config/` |

## Files

| | |
|---|---|
| `migrations/` | The schema, in plain SQL, applied in order, each once |
| `config/` | This index's opinions: issuer weights, scoring weights, and which tokens the pages show as which currency |
| `src/records/` | The firehose reader and the record store |
| `src/chain/` | The chain reader, the registry adapter, and **the escrow adapter** |
| `src/scores/` | The scores as pure functions, the signatures, and the recompute |
| `src/web/` | The pages and their twins: the page models (`data.ts`), the HTML (`pages.ts`, `html.ts`, `words.ts`), the JSON-LD, the Pay link, the machine files, the routes and a node:http server |
| `src/main.ts` | The readers, the pages, or both |
| `skill.md`, `llms.txt` | The read skill and `llms.txt`, as served |
| `SCORING.md` | The rules, in plain words |
| `PAYLINK.md` | The Pay link's one format |
| `HOSTING.md` | The two processes: what each needs on Railway, and what the pages need on Vercel |

The choices made where the handoff was silent, and the open questions, are in `docs/changes.md`.
