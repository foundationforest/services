# issuer on Railway, devnet

How the foundation runs its issuer for devnet. Its list and roots are its own two files, and each
root is also written on devnet as a memo its key signs. Nothing here is mainnet, and nothing is
shipped.

**Where it runs today.** The Railway service `issuer` in the project `forest-devnet`, built from this
repo (`../../docs/devnet.md` has its address). It started on 2026-09-30 with a fresh list, and with
no Didit key, so its face check is the stand-in: every session passes. The earlier issuer, built
from forest's deleted `deploy/`, is retired, and its volume (list 0's queue and used sessions) with
it.

## Files

| | |
|---|---|
| `Dockerfile` | Node 22.22.2 and git; `forest.sh registry/client records`, then `npm ci` in `issuer/`. Runs `start.sh` |
| `start.sh` | With no `DIDIT_API_KEY`, starts the stand-in Didit on 127.0.0.1 and points the issuer at it, and says so; then `npm start` |
| `fake-didit.ts` | The stand-in: every session it opens passes. Only for a devnet issuer with no Didit key; the devnet issuer has one |

## The Railway service

- **Source:** this repo. The build context is the repo root.
- **Build:** `RAILWAY_DOCKERFILE_PATH=issuer/deploy/Dockerfile`.
- **Replicas:** one, never more: the queue and the list are one SQLite file. **Restart:** always.
- **Health check:** none: Railway refuses a health-check path with a dot (`/roots.json`), and the
  issuer's other routes are POST.
- **Volume:** at `/data`, for the SQLite file. It holds the list: losing it loses the list.
- **Networking:** a public domain to port 8080. The two files' address is this domain, so it
  stays fixed.

**Variables.** Sealed ones reach the build and the service and can never be read back.

| Variable | On devnet | Sealed |
|---|---|---|
| `ISSUER_KEYPAIR` | The devnet issuer key, from forest's `devnet/keys.sh`, as its JSON array | yes |
| `DATABASE_PATH` | `/data/issuer.sqlite` | no |
| `BATCH_MAX` | `50` | no |
| `BATCH_INTERVAL_SECONDS` | `120` | no |
| `SESSION_LIMIT_PER_HOUR` | `20`, so a few runs of the loop an hour fit; the default is 5 | no |
| `CLIENT_ADDRESS_HEADER` | `x-real-ip` | no |
| `SOLANA_RPC_URL` | Helius's devnet RPC, whose URL holds its key | yes |
| `PORT` | `8080` | no |
| `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID` | Didit's, when set; unset, `start.sh` runs the stand-in | yes |

**Before it starts,** the key needs a little SOL on devnet for the memos: 5,000 lamports a root.
The devnet key held 0.00999 SOL on 2026-09-30, about 2,000 roots.

## Rotating a secret

| Secret | How |
|---|---|
| `ISSUER_KEYPAIR` | A devnet key from the phrase. The roots file is then signed by the new key under its new did:key, which is a new issuer name: every reader that trusts the old one must be told |
| Didit's key and workflow | Set the new `DIDIT_API_KEY` and `DIDIT_WORKFLOW_ID`, redeploy |

A sealed value cannot be read back, so check the new one works (logs) before revoking the old.

## What it costs

Measured on 2026-09-25 for the earlier version, idle: 0.11 GB of memory and 0.001 vCPU on average,
and a 500 MB volume. This version is not measured.
At Railway's published prices ($10 a GB-month, $20 a vCPU-month, $0.15 a volume GB-month) that is
about $1.20 a month.
