# loop/board

Devnet only, and for testing only: a board for the loop and the devnet index to read and write
records on. It may be wiped at any time. Nothing is shipped.

Up: [the loop](../README.md).

Boards are run by apps; the foundation runs none. This one exists so the devnet services have
somewhere to read records from. It is forest's reference board (`forest/records/src/host.ts`),
unchanged, with one line in front saying what it is. It takes anyone's records and sets no policy
of its own.

## What it does

- **Forest's board, unchanged:** `POST /v1/entries` and `GET /v1/entries?after=&profile=&badged=1`
  as `forest/records/SPEC.md` §7 says; one SQLite file; no keys, no accounts, no login.
- **`GET /`** answers one line saying it is for devnet testing only. Every other request goes,
  untouched, to forest's board on loopback, which answers only `/v1/entries`.
- **The badged feed asks the registry:** a profile's key counts as badged when any registry line
  names it (`getProgramAccounts` on the registry, filtered on a line's discriminator and the profile
  key at offset 8, as forest's `fetchLines` filters). A failed RPC call counts as not badged.
- **Once an hour** it forgets what stopped counting (`prune`) and asks the registry again about
  every profile (`refreshBadges`).

## What it trusts

- **Signatures,** as forest's board does: it stores a record only if it checks.
- **The registry, through its RPC,** for the badged hint. It asks only whether a line names the
  key, not which issuer vouched for it, so its `badged=1` feed is a hint; readers check lines
  themselves.

## Settings

| Variable | Required | What |
|---|---|---|
| `PUBLIC_URL` | yes | This board's `https://` origin, exactly as folders name it |
| `DATABASE_PATH` | no | The SQLite file; in memory when unset |
| `SOLANA_RPC_URL`, `REGISTRY_PROGRAM_ID` | no | For the badged feed; without both, no profile counts as badged |
| `PORT` | no | Default `8080` |

## Run it

Node 22.18 or later. From the repo root:

```
./forest.sh records registry/client     # registry/client for the test only
cd loop/board && npm ci
npm run check
npm test                                # forest's board behind the front, with a stand-in registry RPC
PUBLIC_URL=https://… npm start
```

## Deploy

The build context is the repo root. `deploy/Dockerfile` builds it: Node 22.22.2 and git,
`forest.sh records`, `npm ci`, then `node src/main.ts`.

**The devnet test board** runs that image on Railway, project `forest-devnet`, service
`board-devnet-test`, at https://board-devnet-test-production.up.railway.app:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=loop/board/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, health check `GET /`, a public domain to port 8080.

| Variable | On devnet | Sealed |
|---|---|---|
| `PUBLIC_URL` | its own Railway address | no |
| `DATABASE_PATH` | `/data/board.sqlite` | no |
| `SOLANA_RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `REGISTRY_PROGRAM_ID` | `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf` | no |
| `PORT` | `8080` | no |

## Limits

- **Open to anyone,** and it grows with every loop run. Wipe its volume when it gets in the way.
- **Badged means any line,** whoever vouched: a hint only.
- **Address logs at the hosting platform.** Forest's board logs no address; Railway keeps every request's
  client address and path in its own logs.
