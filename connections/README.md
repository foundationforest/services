# connections

Devnet only: the foundation's connections service runs on devnet, reading the test board. Nothing
is shipped.

Up: [the repo](../README.md). The protocol: `forest/records/SPEC.md`, §12.

Connections lets an AI assistant work for a person without holding their key. The assistant reads
a profile's public records and drafts a new one; the service answers with an approval link; the
person opens it on their own device, sees exactly what will be published, and signs it there with
their passkey.

It is forest's own MCP service (`forest/records/src/connections.ts`), unchanged, run as a service,
and it serves the approval page its links open: forest's own (`forest/records/web`), built
unchanged.

## What it does

MCP over HTTP at `/mcp`, stateless, no login (protocol revisions 2026-07-28 and 2025-11-25). Two
tools:

- **`forest_read {profile}`:** the profile's public records (its profile record, offers, reviews and
  proofs), read from its boards. A sealed record shows as sealed.
- **`forest_draft {profile, path, body}`:** a record for the person to approve: a profile, an offer,
  a review or a proof, or a delete (`body` null). The answer is `input_required` with the approval
  link (URL mode). When the assistant calls again, the service reads the profile's boards for up to
  `WAIT_SECONDS`: either the record is there, signed by the person, or the draft still waits in its
  link.

It finds a profile on the boards in `HOSTS`, then on the boards the profile's own folder names.

**The approval page** is served at `/approve`, with `/approve.js`, `/approve.css`, the bundle's
SHA-256 at `/approve.js.sha256` and the libraries in it at `/approve.deps.txt`. Every page file goes
out with the policy §12 asks for: its own script and style only, Trusted Types, reads and posts over
`https:` only, never in a frame (`frame-ancestors 'none'`); plus `no-cache`, `nosniff` and
`no-referrer`. The files are read once at start, so the published hash is the hash of what is
served. The page is where a person's seed is opened, by a passkey that belongs to the page's
origin: this service's.

Forest's service listens on 127.0.0.1 only, so `src/service.ts` puts a front before it that passes
each request, untouched, to that loopback address and streams the answer back. The front reads
nothing, keeps nothing and logs nothing.

## What it never does

- **Holds no key, no grant and no draft.** A draft lives only in its link, after the `#`, which no
  server receives. A second copy of the service, which never saw the draft, gives the same answer.
- **Signs and publishes nothing.** Only the person's device signs, on the approval page, and posts
  to the boards the profile's signed folder names.
- **Has no accounts.**
- **Logs nothing per request,** one line at start; and nothing a person sends is in a URL: every
  call is a POST to `/mcp`.

## What it trusts

- **Boards, for presence only.** It reads records and checks their signatures with forest's reader;
  a board can withhold a record, never forge one.
- **The approval page trusts the person's device:** its passkey for the seed, its browser for the
  page.

## Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `APPROVAL_PAGE` | yes | | The approval page every link opens, such as `https://<this service>/approve` |
| `HOSTS` | yes | | The boards it reads a profile from first: origins separated by commas |
| `WAIT_SECONDS` | no | `30` | How long a returning `forest_draft` reads the boards for the person's approval |
| `APPROVAL_PAGE_DIR` | no | `../forest/records/web/dist` | Where forest's built approval page is; `none` serves no page. It refuses to start if the page is not built there |
| `PORT` | no | `8080` | |

Nothing here is a secret.

## Run it

Node 22.18 or later. From the repo root:

```
./forest.sh records
(cd forest/records && node web/build.ts)    # forest's approval page, into forest/records/web/dist
cd connections && npm ci
npm run check                               # type-check, forest's files included
npm test                                    # forest's reference board, the service and an MCP client, on loopback
APPROVAL_PAGE=https://… HOSTS=https://… npm start
```

The tests use `@modelcontextprotocol/client` 2.2.0, the version forest's own tests use; the service
has no dependency of its own.

## Deploy

Any platform that runs Node 22.18. It holds nothing, so any number of copies give the same answers. The
build context is the repo root. `deploy/Dockerfile` builds it: Node 22.22.2 and git,
`forest.sh records`, forest's page build (`node web/build.ts`), `npm ci`, then
`node src/main.ts`. Assistants connect to `https://<domain>/mcp`.

**The foundation's devnet service** runs that image on Railway, project `forest-devnet`, service
`connections`:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=connections/deploy/Dockerfile`.
- **One replica,** health check `GET /approve`, a public domain to port 8080, no volume.

| Variable | On devnet |
|---|---|
| `APPROVAL_PAGE` | `https://connections-production-ebc4.up.railway.app/approve`, its own |
| `HOSTS` | the test board, `https://board-devnet-test-production.up.railway.app` |
| `WAIT_SECONDS` | `30` |
| `PORT` | `8080` |

## Limits

- **No health route of its own:** every path but `/mcp` and the page's files is forest's 404.
- **No login and no rate limit.** Anyone may read and draft; nothing is published without the
  person's passkey.
- **The passkey belongs to the page's origin.** On devnet that is this service's Railway address,
  so a passkey made there opens nothing on any other address.
- **Address logs.** Connections keeps no network address and logs nothing per request. A hosting
  provider's own request logs are the operator's choice; on Railway they exist, with each request's
  client address and path (always `/mcp` or one of the page's files).
