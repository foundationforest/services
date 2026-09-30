# connections on Railway

How the foundation runs its connections service on devnet. Nothing here is mainnet, and nothing is
shipped.

**Where it runs today.** The Railway service `connections` in `forest-devnet`, built from this repo
since 2026-09-30 (`../../docs/devnet.md` has its address). It serves the approval page itself, and
its links open it. It reads the loop's test board (`../../loop/board/`), for devnet testing only.

## Files

| | |
|---|---|
| `Dockerfile` | Node 22.22.2 and git; `forest.sh records` and forest's page build (`node web/build.ts`), then `npm ci` in `connections/`. Runs `node src/main.ts` |

## The Railway service

- **Source:** this repo. The build context is the repo root.
- **Build:** `RAILWAY_DOCKERFILE_PATH=connections/deploy/Dockerfile`.
- **Replicas:** any number: it holds nothing, so every copy gives the same answers. **Restart:**
  always.
- **Health check:** `GET /approve`.
- **Volume:** none.
- **Networking:** a public domain to port 8080. Assistants connect to `https://<domain>/mcp`.

**Variables.** None is a secret.

| Variable | Value |
|---|---|
| `APPROVAL_PAGE` | Where the approval page is served: this service's own `https://<domain>/approve` |
| `HOSTS` | The records hosts to read first, comma-separated: on devnet, the loop's test board |
| `WAIT_SECONDS` | `30`, or unset |
| `PORT` | `8080` |

**Railway's HTTP logs** keep every request's client address and path. The path is always `/mcp` or
one of the page's; drafts travel in request bodies and after the `#` of the page's link, which no
server receives, so none is logged. The address is still an address log, the
open item every service here shares (`../../docs/changes.md`).
