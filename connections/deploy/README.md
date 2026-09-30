# connections on Railway

How the foundation would run its connections service. Nothing here is mainnet, and nothing is
shipped.

**Where it runs today.** Nowhere. It needs two things the foundation does not run yet: a records
host to read profiles from (`HOSTS`), and the approval page (`APPROVAL_PAGE`, forest's
`records/web/`). The earlier devnet host was Bluesky's PDS, which records do not use.

## Files

| | |
|---|---|
| `Dockerfile` | Node 22.22.2 and git; `forest.sh records`, then `npm ci` in `connections/`. Runs `node src/main.ts` |

## The Railway service

- **Source:** this repo. The build context is the repo root.
- **Build:** `RAILWAY_DOCKERFILE_PATH=connections/deploy/Dockerfile`.
- **Replicas:** any number: it holds nothing, so every copy gives the same answers. **Restart:**
  always.
- **Health check:** none; every route but `/mcp` is a 404.
- **Volume:** none.
- **Networking:** a public domain to port 8080. Assistants connect to `https://<domain>/mcp`.

**Variables.** None is a secret.

| Variable | Value |
|---|---|
| `APPROVAL_PAGE` | Where the approval page is served |
| `HOSTS` | The records hosts to read first, comma-separated |
| `WAIT_SECONDS` | `30`, or unset |
| `PORT` | `8080` |

**Railway's HTTP logs** keep every request's client address and path. The path is always `/mcp`;
drafts travel in request bodies, which it does not log. The address is still an address log, the
open item every service here shares (`../../docs/changes.md`).
