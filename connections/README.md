# connections

An MCP server an AI assistant connects to with a login, so it can post for a person without ever
holding a key.

The foundation runs this one, on devnet, posting to the foundation's host. Anyone can run another,
with this code or their own: an access key works wherever the profile's permissions record lists
it. Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md).

Each connection gets one access key of its own. The person adds that access key to their profile's
permissions record in their own app, which signs the change with the main key. From then on the
assistant has two tools, post an offer and post a review, and each record it posts is signed by the
access key and sent to the hosts the profile's hosts record names (forest's
[records](https://github.com/foundationforest/forest/blob/main/records/README.md), "Access keys").

## How it works

1. **The assistant registers and sends the person to `/authorize`.** This is OAuth 2.1 as MCP asks
   for it, from the MCP SDK's own authorization server: metadata at
   `/.well-known/oauth-authorization-server`, `/register` (dynamic client registration),
   `/authorize`, `/token`, `/revoke`, PKCE required.
2. **The person names their profile:** they paste its address from their app into a form. The
   service makes one access key for this connection and shows its address.
3. **The person adds the access key in their app,** for offers and reviews. The app signs the
   profile's new permissions record with the main key and publishes it to the profile's hosts.
4. **The waiting page checks every 5 seconds.** It reads the profile from the hosts in `HOSTS` and
   then every host its hosts record names (forest's `readProfile`). Once the current permissions
   record lists the access key for both `offer` and `review`, with its time not up, the grant goes
   through: the person is sent back to the assistant with a one-time code, and the assistant trades
   it for tokens.
5. **The assistant calls `post_offer` or `post_review` at `/mcp`** with its access token. Each tool
   takes forest's own shape for the record (its JSON Schema is the tool's input) and an optional id.
   Before signing, the service reads the profile again and posts only if the permissions record
   lists the key for that path now, and the main key has not written there (the owner wins). The
   record goes to every host the profile names; the answer says which took it.

The person ends a connection by removing the access key in their app. What it already posted stays
on the hosts.

### Routes

| Route | What answers |
|---|---|
| `GET /` | One line saying what this is |
| `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource/mcp` | OAuth metadata |
| `POST /register`, `GET`/`POST /authorize`, `POST /token`, `POST /revoke` | OAuth, from the MCP SDK |
| `POST /connect/<id>`, `GET /connect/<id>` | The person's two pages: name the profile; add the access key |
| `POST /mcp` | MCP over streamable HTTP, stateless, answered as JSON; a bearer token is required |

### What it keeps

One SQLite file (`DATABASE_PATH`), readable by its owner only:

| Table | What |
|---|---|
| `clients` | Each assistant's OAuth registration, as it sent it |
| `connections` | One per grant: the profile's address, the access key's private bytes, the assistant it was made for, and until the grant the authorization waiting on the person |
| `codes` | One-time codes, as their SHA-256, for ten minutes |
| `tokens` | Access tokens (an hour) and refresh tokens (90 days), as their SHA-256 |

Every hour it deletes codes and tokens past their time, connections nobody finished within the
hour, and connections left with no token (90 days after the last refresh, or once revoked), access
key and all.

### Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `PUBLIC_URL` | yes | | This service's own origin: the OAuth issuer, with the MCP server at `/mcp` |
| `HOSTS` | yes | | The hosts it reads a profile from first: origins separated by commas |
| `DATABASE_PATH` | no | `./data/connections.sqlite` | The one file |
| `PORT` | no | `8080` | |

### Run it

Node 22.18 or later, with forest fetched at the commit in `FOREST`:

```sh
./forest.sh keys records
cd connections && npm ci
npm test
PUBLIC_URL=http://127.0.0.1:8080 HOSTS=https://… npm start
```

The test starts forest's reference host on loopback, connects an assistant with OAuth, adds its
access key the way an app would, and posts an offer and a review through MCP. Another opens a file
written before forest's 3 October words, and finds each connection's key under its new name.

### On devnet

Any platform that runs Node 22.18 with a persistent disk. **One replica:** everything is one SQLite
file. **A volume** for `DATABASE_PATH`, or each deploy drops every connection. The build context is
the repo root; `deploy/Dockerfile` builds it (Node 22.22.2 and git, `forest.sh records`, `npm ci`).

The foundation's devnet connections service runs that image on Railway, project `forest-devnet`,
service `connections`, at https://connections-production-ebc4.up.railway.app:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=connections/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080, health check `/`.

| Variable | On devnet |
|---|---|
| `PUBLIC_URL` | `https://connections-production-ebc4.up.railway.app` |
| `HOSTS` | The foundation's host, `https://board-devnet-test-production.up.railway.app` |
| `DATABASE_PATH` | `/data/connections.sqlite` |
| `PORT` | `8080` |

e2e connects an assistant for each of its two people on every run.

## Policy

- **Write-scoped access keys only, never a pay-scoped one.** Each key it makes can only write, and
  only offers and reviews, while the profile's permissions record lists it. It never asks for a key
  that can pay, and never holds one.
- **One key per connection per folder.** A connection writes for one profile, with one access key
  made for that connection alone, so no key it makes is named in two folders.
- **What it keeps, and for how long:**
  - an assistant's registration, as the assistant sent it, for good;
  - a connection (the profile's address and its access key's private bytes) until it has no token
    left: 90 days after the last refresh, or once revoked; one nobody finished, an hour;
  - one-time codes, as their SHA-256, ten minutes; access tokens, as their SHA-256, an hour;
    refresh tokens, as their SHA-256, 90 days.
- **No request logs,** and no network address kept.

## Promises

- **It never holds, asks for or signs with a main key.** It makes access keys and signs only with
  them. An access key can post only what the profile's permissions record lets it, and only while
  the record lists it.
- **It posts only offers and reviews,** and only where the main key has not written.
- **It posts only to the hosts the profile's hosts record names.**
- **It never puts what a person sends in a URL.** The profile's address goes in a form's body; the
  waiting page's address carries only the connection's random id, since hosting platforms log
  paths.
- **It never logs a request and never writes down an address.** The MCP SDK's rate limits, which
  count each address in memory, are off.
- **It keeps no token or code,** only their SHA-256.

## Limits

- **It holds every access key it made,** private bytes in its SQLite file on the volume, not
  encrypted. Whoever reads that file can post offers and reviews for every connected profile, until
  each person removes the key in their app.
- **Anyone can register an assistant.** Registration is open, as MCP expects. What protects a
  profile is that only the person's app can list an access key.
- **It trusts the hosts it reads.** A host that hides the newest permissions record can keep a
  removed access key looking listed, here and to everyone else reading that host.
- **One access key per connection, for offers and reviews together.** A person who lists it for one
  of the two only never gets the grant.
- **An hour to finish.** A person who has not added the access key within an hour starts again from
  the assistant.
- **Connections made before forest's 3 October words stop posting.** Their keys sit in permissions
  records of the old shape, which forest now reads as listing no access key.
- **Address logs.** The service keeps no network address (above). A hosting provider's own request
  logs are the operator's choice; on Railway they exist, with each request's client address and
  path.

## Who decides what

- **The standard (forest):** what an access key is, the permissions record, and the access rule.
- **This service, by its policy:** which tools it offers, what it keeps and for how long, and who
  may register.
- **The person, through their app:** whether to list its key, for which paths, and until when.

## FAQ

**Why an access key per connection, and not a draft the person approves?**
An access key is how forest lets something other than the main key write for a profile: the person
lists it once in their app, and can remove it there at any time. A record it signs reads as the
access key's on every host, so nothing else has to trust this service. Approving each draft on a
page of ours would put this service between the person and every record.

**Why OAuth?**
MCP asks for it, and assistants that speak MCP already know how to connect with it. The MCP SDK
ships the whole authorization server; this service answers its questions from its one file and
adds the two pages the person sees.

**Why does it check the permissions record before posting, when a host checks it anyway?**
So the assistant hears why a post would fail before anything is sent, in plain words, instead of
each host's refusal.

**Why the profile's own hosts, and not the hosts in `HOSTS`?**
A profile's hosts record says where its records live. `HOSTS` only says where this service looks
first to find that record.

**Why stateless MCP, a server per request?**
Each request carries its token, and the token names the connection. Nothing has to live between
requests, so a restart loses nothing.

**Could someone rebuild this service from public data?**
No: its file holds the access keys' private bytes, which are nowhere else. If it is lost, every
connection ends, and each person connects again and lists a new access key.
