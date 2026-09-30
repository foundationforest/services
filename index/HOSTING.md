# Hosting the index

**Nothing is shipped.** This page says what each part needs. On devnet the index runs as one
process on Railway, with its Postgres on Supabase (`docs/services.md`); as two processes it has run
only on one machine.

The index is two processes over one Postgres database:

| | Readers | Pages |
|---|---|---|
| Command | `node src/main.ts readers` (`npm run start:readers`) | `node src/main.ts web` (`npm run start:web`) |
| Does | Applies migrations; reads the firehose and the chain; recomputes and signs scores; writes the index's public keys for the pages | Serves every page, its JSON twin, the sitemap, `robots.txt`, `llms.txt` and `skill.md` |
| Runs | Always, exactly one copy | On request, as many copies as wanted |
| Database | Reads and writes | Reads only |
| Holds the signing seed | Yes | No |
| Port | None | `PORT` |

`node src/main.ts` with no argument runs both in one process, for local use.

Both need Node 22.18 or later (they run TypeScript directly) and the repo's root checked out,
not only `index/`: the index imports `shapes/`, `registry/client` and `escrow/client` by relative
path. Install them first, from the repo root:

```
(cd shapes && npm ci) && (cd registry/client && npm ci) && (cd escrow/client && npm ci) && (cd index && npm ci)
```

## The database

Postgres 14 or later: a Railway Postgres, or Supabase's.

- The readers run the migrations when they start. The pages never do.
- Give the pages a role that can only read:

  ```sql
  create role index_pages login password '…';
  grant connect on database forest_index to index_pages;
  grant usage on schema public to index_pages;
  grant select on all tables in schema public to index_pages;
  alter default privileges in schema public grant select on tables to index_pages;
  ```

## Readers on Railway

One service, from this repo:

- **Build:** the install line above, from the repo root (Railway's "shared monorepo": build from
  the root, override the build and start commands per service).
- **Start:** `cd index && node src/main.ts readers`.
- **Replicas:** one. Two would read the same events twice and race to write the same scores.
- **Networking:** no public domain. It opens connections; nothing connects to it.
- **Restart:** always. It holds a websocket to the firehose and a poll loop on the RPC; a restart
  resumes from the cursors kept in Postgres.
- **Variables:**

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | The database, with a role that can write |
  | `INDEX_SIGNING_SEED` | 64 hex characters, as a secret. It is the index's signing identity: keep it, and never give it to the pages |
  | `MARKETS_URL` | Unset: the `markets` repo's main branch, read over HTTPS at start. Set it to pin a commit |
  | `FIREHOSE_URL` | The carrier's relay, `wss://`: its own stream, which the readers check commit by commit, not Jetstream's JSON |
  | `PLC_URL` | `https://plc.directory` (the default) |
  | `SOLANA_RPC_URL` | An RPC for the network the programs are on |
  | `CHAIN_COMMITMENT` | `finalized` (the default) |
  | `ISSUERS_FILE`, `SCORING_FILE` | Only to use other files than `config/` |

## Pages on Railway

A second service from the same repo, same build:

- **Start:** `cd index && node src/main.ts web`.
- **Replicas:** any number; it keeps nothing between requests.
- **Networking:** a public domain (forest.foundation), to `PORT`.
- **Variables:**

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | The read-only role above |
  | `MARKETS_URL` | The same as the readers', so both read one directory |
  | `PUBLIC_URL` | `https://forest.foundation`: every canonical link, the sitemap, the pay link and the read skill use it |
  | `PORT` | Railway sets it |
  | `CURRENCIES_FILE`, `ISSUERS_FILE` | Only to use other files than `config/`; must match the readers' |

  No `INDEX_SIGNING_SEED`: the pages read the public keys the readers write to `index_meta`.

## Pages on Vercel, if split there

The pages answer through one web-standard handler, `createWeb(...).handle(Request) → Response`,
which is the shape of a Vercel Function's `export default { fetch }`. What it would take (not
built, not tried):

- **One function** that builds the handler once per instance and answers every path:

  ```ts
  // api/index.ts, in a project whose root is the repo root
  import { loadConfig } from '../index/src/config.ts'
  import { createPool } from '../index/src/db.ts'
  import { Directory } from '../index/src/markets.ts'
  import { createWeb } from '../index/src/web/routes.ts'

  const config = loadConfig(process.env, { seed: false })
  const db = createPool(config.databaseUrl)
  const web = createWeb({ db, directory: await Directory.fetch(config.marketsUrl), config })
  export default { fetch: (req: Request) => web.handle(req) }
  ```

  and a rewrite of every path to it in `vercel.json` (`{ "source": "/(.*)", "destination": "/api" }`).
- **The Node.js runtime,** not Edge: it uses `pg` and reads files.
- **The repo root as the project's root,** for the relative imports to `shapes/` and the clients.
- **The files it reads at start, included in the function:** `index/config/*.json`,
  `index/skill.md` and `index/llms.txt`, through the function's `includeFiles`. The market
  directory is fetched from the `markets` repo when an instance starts.
- **A pooled connection:** Supabase's pooler in transaction mode, with a pool of one client per
  instance (`createPool` takes 10 today; a serverless instance should take 1).
- **The same variables** as the pages on Railway, less `PORT`.
- **Caching:** every answer says `public, max-age=30, stale-while-revalidate=300`, which Vercel's
  CDN honours, so most reads never reach the function.

The readers cannot run on Vercel: a function cannot keep a websocket or a poll loop alive.

## No address logs

Neither process writes a visitor's address anywhere: the pages log only a failed request's path
and its error, never an address or a query. Railway and Vercel keep request logs of their own:
Railway's keep each request's client address and path, with no documented way to turn it off, and
Vercel's are not checked (`docs/handoff.md`, Open).
