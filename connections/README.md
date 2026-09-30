# connections

The connections service: forest's MCP server for assistants (`forest/records/src/connections.ts`),
run as a service, unchanged. An assistant reads a person's public notes, drafts a note, and hands
the person an approval link; the person's own device shows the exact note, signs it and posts it.
The protocol is `forest/records/SPEC.md`, section 12.

**Nothing here is shipped.** Its tests run against forest's reference host on loopback. On devnet it
runs on Railway and serves the approval page its links open (`deploy/README.md`).

## What it does

MCP, protocol revision 2026-07-28, stateless, over HTTP at `/mcp`, with no login. Two tools:

- **`forest_read {profile}`**: the profile's public notes (its card, offers, reviews and proofs),
  read from its hosts. A sealed note shows as sealed.
- **`forest_draft {profile, path, body}`**: a note for the person to approve: a card, an offer, a
  review or a proof, or a delete (`body` null). The answer is `input_required` with the approval
  link (URL mode). When the assistant comes back, the service reads the profile's hosts for up to
  `WAIT_SECONDS`: the note is there, signed by the person, or the draft waits in its link.

It finds a profile on the hosts in `HOSTS`, then on the hosts the profile's own folder names.

**It also serves the approval page** its links open: forest's own (`forest/records/web`), built
unchanged by forest's `web/build.ts`, at `/approve`, with `/approve.js`, `/approve.css`, the
bundle's hash at `/approve.js.sha256` and the libraries in it at `/approve.deps.txt`. Every page
file is sent with the policy `forest/records/SPEC.md` §12 asks for: its own script and style only,
no HTML from strings (Trusted Types), reads and posts over `https:` only, `frame-ancestors 'none'`.
The files are read once at start, so the published hash is the hash of what is served. The page
is where the seed is opened: the passkey belongs to the page's origin, this service's.

## What it never does

- **Holds no key, no grant and no draft.** A draft lives only in its link, after the `#`, which
  never reaches the approval page's server. A second copy of the service, which never saw the draft,
  gives the same answer.
- **Signs nothing, and publishes nothing.** Only the person's device signs, on the approval page.
- **Has no accounts and asks for no login.**
- **Logs nothing per request.** It logs one line at start.
- **Puts nothing a person sends in a URL.** Every call is a POST to `/mcp`; the draft is in its
  body.

## How it runs

Forest's `Connections` answers on 127.0.0.1 only. A service on a host must answer on every
interface, so `src/service.ts` puts a front before it: each request is passed, untouched, to that
loopback address, and the answer is passed back as it streams. The front reads nothing and keeps
nothing. A `hostname` option on `Connections.listen` in forest, like the reference host's, would
remove it.

## Running it locally

Node 22.18 or later runs the TypeScript directly. Forest's records library is imported from
`forest/records/src` by relative path (forest at the commit in `../FOREST`). From the repo root:

```
./forest.sh records
cd connections && npm ci
npm run check                # type-check, forest's files included
npm test                     # forest's reference host, the service, and an MCP client, on loopback
APPROVAL_PAGE=https://… HOSTS=https://… npm start
```

The tests need `@modelcontextprotocol/client` 2.2.0, the version forest's records tests use. The
service itself has no dependency of its own.

## Environment variables

| Variable | Required | Default | What |
|---|---|---|---|
| `APPROVAL_PAGE` | yes | | The approval page every link opens, e.g. `https://forest.foundation/approve`: forest's `records/web/approve.html`, served somewhere |
| `HOSTS` | yes | | Comma-separated host origins it reads profiles from first |
| `WAIT_SECONDS` | no | `30` | How long a returning `forest_draft` reads the hosts for the person's approval before answering |
| `APPROVAL_PAGE_DIR` | no | `../forest/records/web/dist` | Where forest's built approval page is; `none` serves no page. The service refuses to start if the page is not built there |
| `PORT` | no | `8080` | |

Nothing here is a secret.

## Chosen, not decided

Where the task was silent, the option that adds no rule and no text a person reads was taken. Each
is in this repo's `docs/changes.md`.

1. **A front that passes requests through,** rather than a second copy of forest's HTTP handling,
   since `Connections.listen` binds loopback only.
2. **`HOSTS` is required.** Forest's `Connections` needs at least one host to find a profile.
3. **No health check route.** Every route but `/mcp` and the page's is forest's 404.
4. **The approval page is served by this service** (the founder's choice, 2026-09-30), at
   `/approve`, from forest's own build. No other host for it.
5. **The page's files are sent `no-cache`, `nosniff` and `no-referrer`,** besides the policy.
