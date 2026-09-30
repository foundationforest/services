# relayer on Railway, devnet

How the foundation runs its relayer on Solana devnet, in front of the registry and both escrow
versions. Nothing here is mainnet, and nothing is shipped.

**Where it runs today.** The devnet relayer (https://feepayer-production.up.railway.app) runs the
earlier configuration, which allows the earlier registry and escrow v1 only. It was built from
forest's `deploy/feepayer/Dockerfile`, which forest's `main` no longer has, as the Railway service
`feepayer` with its key in `FOREST_FEEPAYER_KEY`, set up by forest's `deploy/railway.ts`. This
folder sets up this configuration from this repo, with the key in `FOREST_RELAYER_KEY`. No Railway
service builds from it yet.

## Files

| | |
|---|---|
| `Dockerfile` | Kora's own published image, `ghcr.io/solana-foundation/kora:v2.0.5`, pinned by digest; checks it is the version in `../KORA`, writes the devnet `kora.devnet.toml`, runs `../run.sh` |
| `devnet-config.sh` | Prints `../kora.toml` with exactly six lines changed, and stops if any is not there exactly once: the three programs' devnet ids, the devnet test dollar as the paid token (twice), and Kora's mock price, since Jupiter prices mainnet only |

## The Railway service

- **Source:** this repo. The build context is the repo root.
- **Build:** `RAILWAY_DOCKERFILE_PATH=relayer/deploy/Dockerfile`.
- **Replicas:** one. **Restart:** always.
- **Health check:** `GET /liveness`, timeout 300 seconds.
- **Volume:** none.
- **Networking:** a public domain to port 8080.

**Variables.** Sealed ones reach the build and the service and can never be read back.

| Variable | On devnet | Sealed |
|---|---|---|
| `FOREST_RELAYER_KEY` | The devnet relayer key (forest's `devnet/keys.sh` calls it `payer`), as its JSON array, since Railway has no secret files | yes |
| `RPC_URL` | Helius's devnet RPC when there is a Helius key, then sealed since the URL holds it; otherwise `https://api.devnet.solana.com` | with Helius |
| `PORT` | `8080` | no |

**Before the first transaction,** the key needs SOL for the deposits it fronts, and a test-dollar
account to be paid into. Forest's `deploy/fund.ts`, which forest's `main` no longer has, sent 1 SOL
from the devnet deploy key and made that account; the key the earlier relayer used has both. What
it is paid comes in test dollars; turning dollars back into SOL is an operations loop, not code.

## Rotating a secret

| Secret | How |
|---|---|
| `FOREST_RELAYER_KEY` | A devnet key from the phrase. A new key needs SOL and a test-dollar account first |
| The Helius key | Set the new `RPC_URL`, redeploy |

A sealed value cannot be read back, so check the new one works (`/liveness`, logs) before revoking
the old.

## What it costs

Measured on 2026-09-25 for the earlier configuration, idle: 0.01 GB of memory and under 0.001 vCPU. At Railway's published
prices ($10 a GB-month, $20 a vCPU-month) that is about $0.12 a month, plus the SOL it fronts, which
comes back in test dollars.
