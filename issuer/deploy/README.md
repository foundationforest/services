# issuer on Railway, devnet

How the foundation runs its issuer on Solana devnet, on list 0. Nothing here is mainnet, and nothing
is shipped.

**Where it runs today.** The devnet issuer (https://issuer-production-fd68.up.railway.app) is still
built from forest's `deploy/issuer/Dockerfile`, on forest's `main`, and set up by forest's
`deploy/railway.ts`. This folder is the same setup from this repo. No Railway service builds from it
yet.

## Files

| | |
|---|---|
| `Dockerfile` | Node 22.22.2 and git; `forest.sh registry/client`, then `npm ci` in `issuer/`. Runs `start.sh` |
| `start.sh` | With no `DIDIT_API_KEY`, starts the stand-in Didit on 127.0.0.1 and points the issuer at it, and says so; then `npm start` |
| `fake-didit.ts` | The stand-in: every session it opens passes. Only for a devnet issuer with no Didit key; the devnet issuer has one |

## The Railway service

- **Source:** this repo. The build context is the repo root.
- **Build:** `RAILWAY_DOCKERFILE_PATH=issuer/deploy/Dockerfile`.
- **Replicas:** one, never more: the queue is one SQLite file. **Restart:** always.
- **Health check:** none; every route is POST.
- **Volume:** at `/data`, for the SQLite file.
- **Networking:** a public domain to port 8080.

**Variables.** Sealed ones reach the build and the service and can never be read back.

| Variable | On devnet | Sealed |
|---|---|---|
| `ISSUER_KEYPAIR` | The devnet issuer key, from forest's `devnet/keys.sh`, as its JSON array | yes |
| `SOLANA_RPC_URL` | Helius's devnet RPC when there is a Helius key, then sealed since the URL holds it; otherwise `https://api.devnet.solana.com` | with Helius |
| `REGISTRY_PROGRAM_ID` | `8sUyd9JXRGEUqf2hYVnLCybi74549VG27dAK6YvbbU3i` | no |
| `LIST_INDEX` | `0` | no |
| `DATABASE_PATH` | `/data/issuer.sqlite` | no |
| `BATCH_MAX` | `50` | no |
| `BATCH_INTERVAL_SECONDS` | `120` | no |
| `SESSION_LIMIT_PER_HOUR` | `5` | no |
| `CLIENT_ADDRESS_HEADER` | `x-real-ip` | no |
| `PORT` | `8080` | no |
| `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID` | Didit's, when set; unset, `start.sh` runs the stand-in | yes |

**Before it starts,** its key must be an insert key of an open list (list 0's owner makes it one),
and hold SOL for its inserts, about 5,000 lamports each.

## Rotating a secret

| Secret | How |
|---|---|
| `ISSUER_KEYPAIR` | A devnet key from the phrase. A new key must first be made an insert key of list 0 by its owner, and funded |
| Didit's key and workflow | Set the new `DIDIT_API_KEY` and `DIDIT_WORKFLOW_ID`, redeploy |
| The Helius key | Set the new `SOLANA_RPC_URL`, redeploy |

A sealed value cannot be read back, so check the new one works (logs) before revoking the old.

## What it costs

Measured on 2026-09-25, idle: 0.11 GB of memory and 0.001 vCPU on average, and a 500 MB volume.
At Railway's published prices ($10 a GB-month, $20 a vCPU-month, $0.15 a volume GB-month) that is
about $1.20 a month.
