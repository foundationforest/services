# index

The Forest index. It reads signed records from hosts, the registry's lines from the chain, the
issuers' signed roots, and both escrow versions' own events. It scores every profile apart:
uniqueness per badge, and a rating out of 10 and a standing per profile, never blended, each score
signed twice. It serves the same data two ways at the same open URLs, with no session and no login:
pages for people, plain HTML with no JavaScript, and for machines schema.org JSON-LD on every page,
a JSON twin of every page, a sitemap, `robots.txt`, `llms.txt` and the read skill.

**Nothing here is shipped.** Its tests run against forest's reference hosts, a local validator and
a local Postgres. The devnet index on Railway runs an earlier build (`deploy/README.md`).

## What it reads

- **Records**, from hosts (`forest/records/SPEC.md` §7), read directly: no directory, no relay.
  - **Only what counts is kept:** the entries of profiles holding a line an issuer this index trusts
    vouches for. Everything else is dropped as it arrives, but the `proof/` records of a profile
    holding some other line, since a membership among them may earn it that trust. When a profile
    comes to hold a trusted line, what was dropped is read again, by `profile`, from every host
    the index follows and every host its folder names. A host's own word on who is badged is a
    hint for what it sends; the index checks the lines.
  - Every line a host serves is checked by `forest/records`' own reader: its canonical text and its
    signature. A line that fails is dropped and reported.
  - The hosts in `HOSTS` are read in full. Every other host is followed only while the folder of a
    profile with a trusted line names it, and read for badged profiles only (`badged=1`). A host still answering after 60 seconds is skipped until it
    finishes. The first time a profile turns up in a badged feed, its earlier
    entries are read from that host by `profile`, once, since a badged feed shows a profile only
    from when its host counted it badged. Each host's feed resumes from its cursor, kept in
    Postgres.
  - Each profile is merged from every host's feed with forest's own merge (`viewProfile`), and what
    it holds now replaces what the index held for it. Four kinds, by path: `profile`,
    `offer/<id>`, `review/<id>` and `proof/<id>` (a credential, or a membership). Each body is
    checked against its schema in `forest/records/schemas/`; one that fails is not stored. A record
    is addressed as `<did>/<path>`, and its `cid` is the id of the entry that holds it now. A
    profile's key is its wallet.
- **Badges**, from the registry's lines, each one a badge only when an issuer this index trusts
  vouches for it. At start, every line from the registry program's own accounts
  (`getProgramAccounts`, each line checked to sit at its code's address); then only newer
  transactions, to pick up new lines. A line names the profile's key, a label, and the root of the
  issuer's list it was proven against; it never changes.
- **Issuers' roots**, from each issuer `config/issuers.json` names, at most once a minute:
  - its signed roots file (the format is `issuer/README.md`, "The two files"), checked for canonical
    text, its issuer and its signature;
  - with an RPC, the roots it wrote on chain (`src/chain/roots.ts`): every transaction naming the
    issuer's key since the last read, keeping a root only from a memo (program v2) in a transaction
    that succeeded and that the key signed, whose text is exactly a note: the root's line with a run
    of the batch's members under `forest.foundation/issuer/root/v2`, or the root's line alone under
    `…/root/v1` (`issuer/README.md`, "Each batch on chain"). The root keeps the signature of the
    first transaction it was read from. The members are not kept.

  A line's issuers are those whose roots, from either, hold its root.
- **Memberships**: a `proof/<id>` record of the membership kind, in a profile's folder, adds its
  issuer to one of the profile's lines once it checks (`verifyMembership` in
  `forest/registry/client`, against the line, that issuer's roots and the registry's sealed
  verification key). It waits while its issuer, root or line is unknown.
- **Receipts**, from both escrow versions' events, from an RPC.
  - For each program, it reads every transaction that named it, oldest first; failed transactions
    are skipped.
  - It keeps each transaction's log lines in its own archive (`chain_transactions`), because RPC
    nodes are not an archive.
  - It reads only events the programs themselves wrote. The clients' decoders already refuse a
    `Program data:` line that another program wrote.
  - For each escrow: buyer, seller, who created it, its two options, token, amount, when it was
    created, funded and ended, the outcome, what each side got, and, in v2, which side objected
    and when.
- **The market directory**, from the `markets` repo itself, over HTTPS (`MARKETS_URL`, its main
  branch by default), never copied: its `directory.md` and each market file that page links, at
  `<folder>/<name>.json`. Forest no longer holds a market-file validator, so each file is checked
  for the fields the index reads. A market has one name: there are no aliases. An offer names no
  market; it is listed in its author profile's market, and only when the directory has that
  market, byte for byte. It is read once at start, so a change in the `markets` repo reaches the
  index at its next restart. The tests serve a stand-in from `test/markets/`.

**Escrow versions.** Everything the index knows about the escrows' events is in one file,
`src/chain/escrow.ts`, which maps both clients' events to the index's own `EscrowFact`. A new
version is one more program there; the receipt table and its store in `src/chain/poll.ts` change
only if a receipt gains or loses a fact.

## How it scores

In [SCORING.md](SCORING.md), in plain words. In short:

- A badge is a line. It counts only as `market/role`, the market a directory name byte for byte and
  the role one its sides allow (`seller` or `buyer` when two, `peer` when one), only when that is
  the profile's own scope (the market and role its record names), and only when the line names
  the profile's own key. A plain `market` counts for nothing.
- **Uniqueness** combines the weights this index gives the issuers vouching for a badge: those
  whose roots hold the line's root, and those a membership record shows. The weights are in
  `config/issuers.json`: the foundation's issuer starts at 1, everyone else at 0.
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
| `/profiles/{did}` | `.json` | The profile, if it holds a trusted badge; every such badge, counted or not and why, and who vouched; its scores, apart and signed; live offers and requests; reviews received and given, each with the payment behind it; credentials |
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
forest's `records`, `registry/client` and both escrow clients by path, from `forest/` at the commit
in `FOREST`, so fetch and install those first, from the repo root:

```
./forest.sh records registry/client escrow/client escrow/v2/client
cd index && npm ci

export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/forest_index
export INDEX_SIGNING_SEED=$(openssl rand -hex 32)     # keep it: it is the index's signing identity
export HOSTS=http://127.0.0.1:8787                   # hosts to read in full, such as forest's reference host
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

The end-to-end test runs two of forest's reference hosts in process, a local validator with the
registry and both escrows, two issuers' lists and signed roots files made by the issuer's own code
(`issuer/src/list.ts`), and the index. It needs:

- the three programs built (`cargo build-sbf --arch v3` in `forest/registry/program`,
  `forest/escrow/program` and `forest/escrow/v2/program`);
- the proving files (`npm run fetch` in `forest/registry/artifacts`);
- `npm ci` in `issuer/`;
- `solana-test-validator` on the PATH;
- a Postgres where it may create and drop a database.

It skips, saying which, if one is missing. The whole of `npm test` takes about 35 seconds here,
most of them making four registration proofs and a membership.

`npm run check` type-checks; `npm run migrate` applies the migrations and stops (`npm start` does
that too).

## Environment variables

| Variable | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. A local one, or Supabase's connection string later |
| `MARKETS_URL` | no | Where the `markets` repo's files are read: the folder holding its `directory.md`, over HTTP(S). Default `https://raw.githubusercontent.com/foundationforest/markets/main`; a commit in place of `main` pins it. Only these names count in badges |
| `INDEX_SIGNING_SEED` | readers | 32 bytes as 64 hex characters. Both signing keys come from it. The pages never need it |
| `PUBLIC_URL` | no | Where the pages are published: an origin, no path. Canonical links, the sitemap, the Pay link and the read skill use it. Default `https://forest.foundation` |
| `HOSTS` | no | The hosts read in full: origins separated by commas, `https://` (`http://` only on loopback). Hosts the folders of profiles with a trusted line name are read too, badged profiles only; a loopback one only when `HOSTS` has one. Unset: no record reader |
| `SOLANA_RPC_URL` | no | Unset: no chain reader, and issuers' roots from their files only. It must answer `getProgramAccounts` for the registry |
| `CHAIN_COMMITMENT` | no | `finalized` (default) or `confirmed` (tests) |
| `POLL_MS` | no | How often the readers look for anything new. Default 5000. The issuers' roots are read at most once a minute |
| `REGISTRY_PROGRAM_ID`, `ESCROW_PROGRAM_ID`, `ESCROW_V2_PROGRAM_ID` | no | Default: the clients' own ids |
| `PORT` | no | Default 8080 |
| `ISSUERS_FILE`, `SCORING_FILE`, `CURRENCIES_FILE` | no | Default: the files in `config/` |

## Files

| | |
|---|---|
| `migrations/` | The schema, in plain SQL, applied in order, each once |
| `config/` | This index's opinions: which issuers it trusts, their weights and where their roots are, scoring weights, and which tokens the pages show as which currency |
| `src/records/` | The host reader, and the record store |
| `src/chain/` | The chain reader, the registry's lines, and **the escrow adapter** |
| `src/issuers.ts` | The issuers' signed roots, and the membership check |
| `src/scores/` | The scores as pure functions, the signatures, and the recompute |
| `src/web/` | The pages and their twins: the page models (`data.ts`), the HTML (`pages.ts`, `html.ts`, `words.ts`), the JSON-LD, the Pay link, the machine files, the routes and a node:http server |
| `src/main.ts` | The readers, the pages, or both |
| `skill.md`, `llms.txt` | The read skill and `llms.txt`, as served |
| `SCORING.md` | The rules, in plain words |
| `PAYLINK.md` | The Pay link's one format |
| `HOSTING.md` | The two processes: what each needs on Railway, and what the pages need on Vercel |
| `deploy/` | The foundation's devnet instance: its Dockerfile, the devnet opinions, Railway and Supabase ([deploy/README.md](deploy/README.md)) |

The choices made where the plan was silent, and the open questions, are in `forest/docs/changes.md`
(before this repo) and `../docs/changes.md`.
