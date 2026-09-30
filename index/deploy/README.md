# index on Railway, devnet

How the foundation runs this index on Solana devnet: one instance of what `../HOSTING.md` says any
index needs. Nothing here is mainnet, and nothing is shipped.

**Where it runs today.** The devnet index (https://index-production-1b6e.up.railway.app) is built
from this repo since 2026-09-30, in the same Railway service, with the same Postgres and signing
seed as before: only its source moved from forest's deleted `deploy/`. Its migrations cleared what
the earlier build stored. It reads the loop's test board (`../../loop/board/`) as `HOSTS`, the
devnet issuer's roots file and memos, and devnet's registry and both escrows.

## Files

| | |
|---|---|
| `Dockerfile` | Node 22.22.2 and git; `forest.sh records registry/client escrow/client escrow/v2/client` at the commit in `FOREST`, then `npm ci` in `index/`. Runs `node src/main.ts`: readers and pages in one process, so the pages hold the signing seed |
| `issuers.devnet.json`, `currencies.devnet.json`, `scoring.devnet.json` | The devnet opinions: which issuer counts and where its roots file is, which tokens are money. The Dockerfile names them in `ISSUERS_FILE`, `CURRENCIES_FILE` and `SCORING_FILE` |
| `supabase-root-2021.crt` | Supabase's public root CA, which Node does not carry, for the pooler's TLS (`NODE_EXTRA_CA_CERTS`) |

## The Railway service

- **Source:** this repo. The build context is the repo root.
- **Build:** `RAILWAY_DOCKERFILE_PATH=index/deploy/Dockerfile`.
- **Replicas:** one. **Restart:** always.
- **Health check:** `GET /`, timeout 300 seconds.
- **Volume:** none; the state is in Postgres.
- **Networking:** a public domain to port 8080.

**Variables.** Sealed ones reach the build and the service and can never be read back.

| Variable | On devnet | Sealed |
|---|---|---|
| `DATABASE_URL` | Supabase's session pooler, as `postgres` (below) | yes |
| `INDEX_SIGNING_SEED` | 32 random bytes, hex: the index's signing identity | yes |
| `HOSTS` | the loop's test board (`../../loop/board/`), for devnet testing only; the hosts' `https://` origins, separated by commas | no |
| `SOLANA_RPC_URL` | Helius's devnet RPC when there is a Helius key, then sealed since the URL holds it; otherwise `https://api.devnet.solana.com` | with Helius |
| `REGISTRY_PROGRAM_ID` | `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf` (`forest/registry/devnet/devnet.json`) | no |
| `ESCROW_PROGRAM_ID` | `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` (escrow v1, `forest/docs/devnet.md`) | no |
| `ESCROW_V2_PROGRAM_ID` | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` (`forest/escrow/v2/devnet/devnet.json`) | no |
| `CHAIN_COMMITMENT` | `finalized` | no |
| `POLL_MS` | `10000` | no |
| `PUBLIC_URL` | the service's own public URL | no |
| `PORT` | `8080` | no |

`MARKETS_URL` is unset: the `markets` repo's main branch.

## Postgres on Supabase

- **The project:** `forest-devnet`, free plan, `us-west-1`.
- **Locked down:** Supabase grants its Data API roles (`anon`, `authenticated`) every right on new
  tables in `public`. The index uses none of that API, so every right is revoked, now and for new
  tables, and the Data API serves no schema.
- **The pages' role:** `index_pages`, read-only, as `../HOSTING.md` writes it.
- **The connection:** the session pooler on port 5432, not the transaction port 6543, with
  `sslmode=verify-full` against `supabase-root-2021.crt`.
- **The passwords:** made at random and kept outside the repo.

## Rotating a secret

| Secret | How |
|---|---|
| `INDEX_SIGNING_SEED` | A new value, sealed, and a redeploy. It is a new signing identity: every score is signed again under new public keys |
| `DATABASE_URL` | Reset the database password in Supabase, build the new connection string, set it sealed, redeploy |
| The Helius key | Set the new `SOLANA_RPC_URL`, redeploy |

A sealed value cannot be read back, so check the new one works (health, logs) before revoking the old.

## What it costs

Measured on 2026-09-25, idle: 0.18 GB of memory and 0.002 vCPU on average. At Railway's published
prices ($10 a GB-month, $20 a vCPU-month) that is about $1.84 a month. Supabase's free plan is $0;
it pauses a project after a week without activity, and the index's poll every 10 seconds should
count as activity (not watched for a week). This version is not measured.

## Splitting readers and pages

One service runs both, so the pages hold the seed. To split: a `pages` service from the same
Dockerfile, starting `node src/main.ts web` with the `index_pages` role's connection string and no
seed; this service starts `node src/main.ts readers`, and its public domain moves to `pages`.
