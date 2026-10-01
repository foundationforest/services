# The devnet test board

**For devnet testing only.** A board for the loop (`../`) and the devnet index to read and write
records on: forest's reference host (`forest/records/src/host.ts`), unchanged. The foundation runs
no board; boards are run by apps. This one takes anyone's entries, sets no policy of its own, and
may be wiped at any time. Nothing here is shipped.

## What it is

- **Forest's host, unchanged:** `POST /v1/entries` and `GET /v1/entries?after=&profile=&badged=1`
  as `forest/records/SPEC.md` §7 says, one SQLite file, no keys, no accounts, no login.
- **`GET /`** answers one line saying what this is. Every other request goes, untouched, to the host
  on loopback, since forest's host answers only `/v1/entries`.
- **The badged feed** asks the registry: a key is badged when a registry line names it
  (`getProgramAccounts` on the registry, the line discriminator and the profile key at offset 8, as
  forest's `fetchLines` filters). An RPC that fails counts as not badged. Readers check lines
  themselves; the flag is a hint.
- **Once an hour** it forgets what stopped counting (`prune`) and asks the registry again about
  every profile (`refreshBadges`).

## Run it

```
./forest.sh records registry/client   # registry/client for the test only
cd loop/board && npm ci
npm run check
npm test
PUBLIC_URL=https://… npm start
```

| Variable | Required | What |
|---|---|---|
| `PUBLIC_URL` | yes | This board's `https://` origin, exactly as folders name it |
| `DATABASE_PATH` | no | The SQLite file; in memory when unset |
| `SOLANA_RPC_URL`, `REGISTRY_PROGRAM_ID` | no | For the badged feed; without both, no key is badged |
| `PORT` | no | `8080` |

## On Railway

- **Service:** `board-devnet-test` in `forest-devnet`, built from this repo with
  `RAILWAY_DOCKERFILE_PATH=loop/board/deploy/Dockerfile`, the repo root as context.
- **Volume** at `/data`; `DATABASE_PATH=/data/board.sqlite`. **Replicas:** one. **Restart:** always.
  **Health check:** `GET /`.
- **Variables:** `PUBLIC_URL` (its own domain), `SOLANA_RPC_URL` (Helius's devnet RPC, sealed, since
  its URL holds the key), `REGISTRY_PROGRAM_ID=Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf`.
- **Railway's HTTP logs** keep every request's address and path; forest's host logs none. The same
  open item as every service here (`../../docs/changes.md`).
