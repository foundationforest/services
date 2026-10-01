# services

Devnet only: everything here runs on Solana devnet or nowhere. Nothing is on mainnet, and nothing
is shipped.

The services the Forest Foundation runs on Forest's open standard: an **index**, an **issuer**, a
**relayer** and **connections**. The foundation is one operator among many. Anyone may run their
own copy of any of them from this code (Apache 2.0), or write their own; none of them holds anyone's
keys, and nothing here has user accounts.

| Service | What it does, in one line |
|---|---|
| **index** | Reads every profile's records, badges and payment receipts, scores each profile, and serves pages for people and JSON for AI agents |
| **issuer** | Checks once, by face, that someone is one real human, and adds them to its public list, which is what a badge is proven against |
| **relayer** | Pays the network costs of a person's transaction and charges them back, at cost, in the token the person pays with |
| **connections** | Lets an AI assistant read a profile and draft a record, which the person approves and signs on their own device |

## What this repo is not

- **Not the standard.** Records, keys, the registry and the escrow live in
  [foundationforest/forest](https://github.com/foundationforest/forest). This repo uses forest's
  pieces unchanged, at one pinned commit (below).
- **Not a board.** Boards (record hosts) are run by apps; the foundation runs none.
  [`loop/board/`](loop/board/README.md) is a board for devnet testing only.
- **Not an app.** Apps, Roots first, live in their own repos.
- **Not the market directory.** The recommended labels live in
  [foundationforest/markets](https://github.com/foundationforest/markets).

## Folders

| Folder | What it is | On devnet |
|---|---|---|
| [`index/`](index/README.md) | The index: reads boards and the chain, scores each profile, serves pages and their JSON twins, `llms.txt` and the read skill | Running |
| [`issuer/`](issuer/README.md) | The issuer: a passed face check becomes a place on its list; publishes the list and its signed roots, and writes each batch on chain | Running, with a stand-in face check that passes everyone |
| [`relayer/`](relayer/README.md) | The relayer: Kora 2.0.5, configured, with no custom code | Running, paid in two test dollars |
| [`connections/`](connections/README.md) | forest's MCP service for assistants, run as a service, and the approval page its links open | Running |
| [`loop/`](loop/README.md) | A script that runs Forest end to end on devnet against these services | Run by hand; four passing runs recorded, the latest against `main` |
| [`loop/board/`](loop/board/README.md) | A board for devnet testing only: forest's reference board, unchanged | Running |
| [`docs/`](docs/) | [Why things are as they are](docs/decisions.md); [what runs on devnet](docs/devnet.md); [an issue drafted for Kora](docs/kora-issue.md) | |

## How the services connect

```
                      face check (Didit)
  person's app ───────────────────────────▶ issuer ── list.json ──▶ apps (to prove against)
       │                                       ├───── roots.json ──▶ index, apps
       │                                       └───── each batch, in notes on chain ──▶ index
       │ transaction (badge, payment)
       └──────────▶ relayer ── co-signs, sends ──▶ Solana: registry line, escrow
                                                        │
  assistant ── MCP ──▶ connections ── approval link     │ lines, escrow events
                            │                           ▼
  person's device ◀── approval page ── signed record ──▶ board ── records ──▶ index ──▶ pages, JSON
```

1. **Badge.** A person's app opens a face check at the issuer. Once it passes, the issuer adds the
   person's identity commitment (made on their device) to its list, in a batch. The app proves
   against that list and sends one registry line through the relayer: a badge under a label such
   as `tutoring/seller`.
2. **Records.** The person's device signs every record (profile, offer, review, proof) and posts it
   to the boards their folder names. An assistant can draft one through connections; the person
   approves and signs it on the approval page, never on the service.
3. **Payment.** A buyer pays into an escrow through the relayer; money leaves only when both sides
   agree. The relayer is paid back, at cost, in the token the buyer paid with.
4. **Reading.** The index reads the boards, the registry's lines, the issuer's roots and the
   escrows' own events. It keeps only profiles holding a badge an issuer it trusts vouches for,
   scores each one, and serves every page as HTML for people and as JSON for AI agents.

Each arrow is open: an app can use another issuer, relayer, board or index, and each index decides
which issuers it trusts.

## Forest, pinned

`FOREST` holds one forest commit. `./forest.sh` fetches forest at that commit into `forest/` (not
committed), then runs `npm ci` in each forest package named after it. Every `forest/…` path in this
repo means forest at that commit. Each service imports what it needs by relative path:

```
./forest.sh records registry/client escrow/client escrow/v2/client   # index
./forest.sh registry/client records                                  # issuer
./forest.sh registry/client escrow/client escrow/v2/client           # relayer (its type-check and local run)
./forest.sh records && (cd forest/records && node web/build.ts)      # connections (and its approval page)
./forest.sh records registry/client                                  # loop/board (registry/client for its test)
./forest.sh records keys registry/client registry/artifacts escrow/v2/client   # loop
```

Moving the pin is a one-line change to `FOREST`, in its own pull request. A change a service needs
in forest is made in forest first.

## Run the checks

What [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs on every pull request and
on `main`, from a clean install. Node 22.18 or later; the index's page and roots tests need a
Postgres (`DATABASE_URL`).

```
./forest.sh records registry/client escrow/client escrow/v2/client
(cd forest/records && node web/build.ts)

(cd issuer      && npm ci && npm run check && npm test)
(cd connections && npm ci && npm run check && npm test)
(cd loop/board  && npm ci && npm run check && npm test)
(cd relayer     && npm ci && npm run check) && bash relayer/deploy/devnet-config.sh relayer/kora.toml > /dev/null
(cd index       && npm ci && npm run check && \
  node --test --test-force-exit test/markets.test.ts test/scoring.test.ts test/sign.test.ts test/pages.test.ts test/roots.test.ts)
```

A test that cannot find what it needs skips; the workflow fails on any skip. Not in CI, because they
need forest's programs built, its proving files, a local validator and (for the relayer) Kora built:
the index's end-to-end test and the relayer's local run. Each folder's README says how to run them.

## Devnet

All five run on Railway (project `forest-devnet`), each built from this repo's `main`.
[docs/devnet.md](docs/devnet.md) says what each one holds and what to open.

| Service | Address |
|---|---|
| index | https://index-production-1b6e.up.railway.app |
| issuer | https://issuer-production-4976.up.railway.app |
| relayer | https://relayer-production-8d40.up.railway.app |
| connections | https://connections-production-ebc4.up.railway.app (MCP at `/mcp`, the approval page at `/approve`) |
| test board | https://board-devnet-test-production.up.railway.app |

Licensed Apache 2.0. [`CLAUDE.md`](CLAUDE.md) holds the rules for AI sessions working here.
