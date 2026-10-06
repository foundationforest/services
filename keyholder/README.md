# keyholder

The key holder behind connections: it holds the access keys a person's app hands it, so an AI
assistant, which can log in but cannot keep a key, can act for that person.

The foundation runs this one, on devnet, as connections. Anyone can run another, with this code or
their own: an app chooses where to send its people, and a key works wherever the profile's
permissions record lists it. Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md).

The person's app makes the keys, never the key holder: a write key, a message key and a read key,
each listed in the profile's permissions record with one scope, and hands them over in forest's
grant shape when the assistant logs in (forest's
[records](https://github.com/foundationforest/forest/blob/main/records/README.md), "Access keys" and
"Grants"). The key holder keeps them encrypted, and the assistant acts with them through tools, on
two doors with the same tools: MCP, and plain HTTP. It never holds a pay key or a main key.

## How it works

1. **The assistant registers and sends the person to `/authorize`.** This is OAuth 2.1 as MCP asks
   for it, from the MCP SDK's own authorization server: metadata at
   `/.well-known/oauth-authorization-server`, `/register` (dynamic client registration),
   `/authorize`, `/token`, `/revoke`, PKCE required. `/authorize` opens a connection and sends the
   person to its page.
2. **The page shows one link** for the person to open in their Forest app: `/connect/<id>` at this
   service's address, where the id is 128 random bits. It takes keys once, and for an hour.
3. **The app makes the keys and hands them over.** It lists each in the profile's permissions
   record, signed with the main key, and posts them to the link as `{ "grants": [ … ] }`, forest's
   grant shape, all for one profile. The key holder checks each with forest's `checkGrant`, and
   refuses the whole set if one is a pay key or the main key (Policy). It keeps them encrypted
   (The key store).
4. **The page checks every 5 seconds.** It reads the profile from the hosts in `HOSTS` and then
   every host its hosts record names (forest's `readProfile`). Once the current permissions record
   lists every key it holds, each with its grant's scope, the grant goes through: the person is
   sent back to the assistant with a one-time code, and the assistant trades it for tokens.
5. **The assistant calls the tools** with its access token, at either door: MCP at `/mcp`, or
   `POST /v1/tools/<name>` with the arguments as JSON. Each tool uses the keys this connection
   holds, and refuses in plain words when it holds none for the job.

| Tool | Key | What it does |
|---|---|---|
| `read_profile` | none | A profile as its hosts serve it: its card, its offers and the reviews it wrote, checked by forest's rules; and what the index says of it (its rows, scores and the reviews it received), or null when the index does not count it. Without an address, the connection's own profile |
| `read_market` | none | A market through the index: its file, counts and live offers, 50 a page, near a place if asked |
| `post_offer` | write | Posts an offer or a request, in forest's shape; the same id again updates it |
| `remove_offer` | write | Deletes an offer an access key posted |
| `post_review` | write | Posts a review of another profile, in forest's shape |
| `pull_inbox` | message, and read to open | Pulls the profile's inbox from each of its hosts, and opens each message a read key it holds opens; the others come back unopened. Gives a cursor per host, for only what arrives since |
| `open_private` | read | Opens one of the profile's private records, if the app sealed it to a read key it holds |
| `send_message` | message | Sends `{ "text" }` to a profile's inbox, sealed to its inbox key and readers, signed by the message key for the person, naming the first host the person's hosts record names |
| `request_payment` | message | Asks the person to pay: a message to their own inbox, `{ "request": "pay", "amount", "to", "note" }`, which they approve or not in their app |
| `list_grants` | none | What this connection may do: each key's scope, paths, address, who handed it over and when; never a private half |
| `disconnect` | none | Ends the connection (below) |

No tool writes the card, the hosts or permissions record, or the grants: those stay the main
key's.

**Posting a record.** Before signing, the key holder reads the profile again and posts only if the
permissions record lists the write key for that path now, and the main key has not written there
(the owner wins). The record goes to every host the profile names; the answer says which took it.
**Sending a message** has no such check here: each of the recipient's hosts reads the person's
permissions record from the host the message names, and takes it only while the message key is
listed (forest's records, "Send with a message key"). A refusal comes back with the host's code.

**Disconnect.** The `disconnect` tool deletes the key holder's copies of the connection's keys,
and every token for it, at once. It does not stop the keys. What stops a key is the person
removing it in their app, in the permissions record, which every host checks: scope `revoked` for
a write or message key, its entry deleted for a read key. What a write key already posted stays on
the hosts, and still counts.

### Routes

| Route | What answers |
|---|---|
| `GET /` | One line saying what this is |
| `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource/mcp` | OAuth metadata |
| `POST /register`, `GET`/`POST /authorize`, `POST /token`, `POST /revoke` | OAuth, from the MCP SDK |
| `GET /connect/<id>` | The person's page: the link for their app, then waiting for the profile to list the keys, then back to the assistant |
| `POST /connect/<id>` | The app hands over the keys, `{ "grants": [ … ] }`. Answers `{ ok, folder, keys }`, or `{ ok: false, error, message }`: 400 for a grant refused (`pay` for a pay key), 404 when the connection is gone, 409 when it already has its keys |
| `POST /mcp` | MCP over streamable HTTP, stateless, answered as JSON; a bearer token is required |
| `GET /v1/tools`, `POST /v1/tools/<name>` | The same tools over plain HTTP, with the same bearer token: the list, with each one's input schema; a call answers its result as JSON, or `{ error }` with 400 (404 for no such tool) |

### The key store

One interface (`src/keys.ts`): keep a connection's grants; list them without their private halves;
sign bytes with a write or message key it holds; open an envelope with a read key it holds; forget
them. The service never asks for a private half back, and builds forest's records, messages and
pulls around the signatures it gets (`src/sign.ts`).

The driver today, `FileKeys`, keeps each connection's grants in one row of the SQLite file,
encrypted with AES-256-GCM under a key that HKDF-SHA256 mixes from `KEYHOLDER_SECRET`, with a new
random nonce for each write and the connection's id bound in, so a row copied under another
connection does not open. The later driver is a signer inside an enclave: the same interface, with
the keys never leaving it.

### What it keeps

One SQLite file (`DATABASE_PATH`), readable by its owner only:

| Table | What |
|---|---|
| `clients` | Each assistant's OAuth registration, as it sent it |
| `connections` | One per grant: the profile, the assistant it was made for, and until the grant the authorization waiting on the person |
| `keys` | Each connection's grants, encrypted (The key store) |
| `codes` | One-time codes, as their SHA-256, for ten minutes |
| `tokens` | Access tokens (an hour) and refresh tokens (90 days), as their SHA-256 |

Every hour it deletes codes and tokens past their time, and ends the connections nobody finished
within the hour and those left with no token (90 days after the last refresh, or once revoked),
their keys first. SQLite writes over what it deletes (`secure_delete`). A file from before the key
holder, which kept each connection's write key in the clear, loses that table, its codes and its
tokens the first time the key holder opens it, and is rebuilt, so no key stays in it.

### Settings

| Variable | Required | Default | What |
|---|---|---|---|
| `PUBLIC_URL` | yes | | This service's own origin: the OAuth issuer, the MCP server at `/mcp`, and the links it shows |
| `HOSTS` | yes | | The hosts it reads a profile from first: origins separated by commas |
| `INDEX` | yes | | The index it reads markets and scores from: an origin |
| `KEYHOLDER_SECRET` | yes | | At least 32 random characters, which the key store mixes its key from. In no file: lose it, and every connection's keys are lost |
| `DATABASE_PATH` | no | `./data/keyholder.sqlite` | The one file |
| `PORT` | no | `8080` | |

### Run it

Node 22.18 or later, with forest fetched at the commit in `FOREST`:

```sh
./forest.sh keys records
cd keyholder && npm ci
npm test
KEYHOLDER_SECRET="$(node -e "console.log(crypto.randomBytes(32).toString('base64url'))")" \
  PUBLIC_URL=http://127.0.0.1:8080 HOSTS=https://… INDEX=https://… npm start
```

The first test starts forest's reference host and a stand-in index on loopback, connects an
assistant with OAuth, hands the key holder a write, a message and a read key the way an app would,
calls every tool on both doors, revokes the message key, and disconnects. The others check that a
link takes keys once and within the hour, and that a connection not finished within it ends with
its keys; that the key store opens a row only under its own connection and secret; the settings;
and that a file from before loses its keys.

### On devnet

Any platform that runs Node 22.18 with a persistent disk. **One replica:** everything is one SQLite
file. **A volume** for `DATABASE_PATH`, or each deploy drops every connection. The build context is
the repo root; `deploy/Dockerfile` builds it (Node 22.22.2 and git, `forest.sh records`, `npm ci`).

The foundation's devnet key holder runs that image on Railway, project `forest-devnet`, service
`connections`, the name people see, at https://connections-production-ebc4.up.railway.app:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=keyholder/deploy/Dockerfile`.
- **One replica,** a volume at `/data`, a public domain to port 8080, health check `/`.

| Variable | On devnet |
|---|---|
| `PUBLIC_URL` | `https://connections-production-ebc4.up.railway.app` |
| `HOSTS` | The foundation's host, `https://board-devnet-test-production.up.railway.app` |
| `INDEX` | The foundation's index, `https://index-production-1b6e.up.railway.app` |
| `KEYHOLDER_SECRET` | Set in Railway as a sealed variable, which Railway never shows again; in no file and no repo |
| `DATABASE_PATH` | `/data/connections.sqlite`, the file the service kept before it became the key holder |
| `PORT` | `8080` |

e2e connects an assistant for each of its two people on every run, through the key holder.

## Policy

- **Price:** free on devnet. Later, a price per connection, billed to the app that sends its people
  here; nothing is charged today.
- **Write, message and read keys, for one profile per connection,** at most 16, each listed in the
  profile's permissions record before the grant goes through.
- **Never a pay key.** A key it holds can sign, so holding a pay key would let it move money; that
  needs signing inside an enclave with a cap, a later version. It refuses any set of grants that
  holds one, and says why.
- **Never a main key.** It refuses a grant whose key is the profile's own.
- **One link, once, for an hour.** A connection's link takes keys once, and only within the hour
  after the assistant sent the person to `/authorize`.
- **Messages:** what `send_message` sends is `{ "text" }`; what `request_payment` sends is
  `{ "request": "pay", "amount", "to", "note" }`, to the person's own inbox. Each is signed by the
  message key for the person, and names the first host the person's hosts record names.
- **What it keeps, and for how long:**
  - an assistant's registration, as the assistant sent it, for good;
  - a connection and its keys, encrypted, until it has no token left: 90 days after the last
    refresh, once revoked, or at once on `disconnect`; one nobody finished, an hour;
  - one-time codes, as their SHA-256, ten minutes; access tokens, as their SHA-256, an hour;
    refresh tokens, as their SHA-256, 90 days.
- **No request logs,** and no network address kept.

## Promises

- **What it holds is never public.** It is the one place the foundation keeps keys that act for
  people.
- **Never a pay key, in this version.** Nothing it holds can move money.
- **Keys encrypted at rest.** A connection's keys are in its file only encrypted, under a key mixed
  from a secret in no file.
- **It never holds, asks for or signs with a main key.** It signs only with the access keys an app
  handed it, and each works only while the profile's permissions record lists it.
- **It writes only offers and reviews, never the card,** and only where the main key has not
  written.
- **It posts only to the hosts the profile's hosts record names.**
- **It never puts what a person sends in a URL.** The keys go in a request's body; the link
  carries only the connection's random id, since hosting platforms log paths.
- **It never logs a request and never writes down an address.** The MCP SDK's rate limits, which
  count each address in memory, are off.
- **It keeps no token or code,** only their SHA-256.

## Limits

- **It can act with the keys it holds until they are revoked.** Whoever runs it, or holds both its
  file and its secret, can post, message and read for every connected profile, within each key's
  scope, until the person removes the key in their app. `disconnect` deletes its copies; it does
  not stop the keys.
- **The secret and the file sit with one operator.** The variable the key is mixed from and the
  volume are on the same platform, so whoever runs the service, or controls that platform, can read
  both. A signer inside an enclave, the later driver, is what closes this.
- **A deleted key can linger.** SQLite writes over what it deletes, but a copy can stay, encrypted,
  in the disk's free space or the platform's backups until it is written over. Revoking the key is
  what stops it.
- **A revoked message key keeps working for a while.** A recipient's host takes its messages until
  it reads the person's permissions record again (forest's records, Limits); the person's own hosts
  refuse its pulls at once.
- **A payment request comes from the person's own key.** So an inbox that takes one message from
  each sender (`once`) takes one payment request, ever.
- **It trusts the hosts it reads.** A host that hides the newest permissions record can keep a
  revoked key looking listed, here and to everyone else reading that host.
- **It finds a profile through `HOSTS` first.** A profile whose records are on no host in `HOSTS`,
  and on none a hosts record there leads to, cannot be read or messaged from here.
- **Anyone can register an assistant.** Registration is open, as MCP expects. What protects a
  profile is that only the person's app can list a key.
- **An hour to finish.** A person whose app has not handed over the keys, and listed them, within
  the hour starts again from the assistant.
- **Connections made before the key holder end.** Their write keys were kept in the clear, so the
  key holder drops them the first time it opens their file. Each person connects again, and their
  app hands over new keys.
- **Address logs.** The service keeps no network address (above). A hosting provider's own request
  logs are the operator's choice; on Railway they exist, with each request's client address and
  path.

## Who decides what

- **The standard (forest):** what an access key and a grant are, the permissions record, the
  scopes, and the access rule.
- **This service, by its policy:** which keys it holds and which it refuses, which tools it offers,
  what it keeps and for how long, its price, and who may register.
- **The person, through their app:** which keys to make and hand over, for which paths, and when
  to remove each.
- **An app:** which key holder it sends its people to.

## FAQ

**Why does the app make the keys, and not the key holder?**
forest's access keys are made by the owner's app and handed out in a grant. The app lists each key
with the main key anyway, so making it there means nothing has to come back to the person's device,
and the grant can carry what it is for.

**Why keys per connection, and not a draft the person approves?**
An access key is how forest lets something other than the main key act for a profile: the person
lists it once in their app, and can remove it there at any time. A record or a message it signs
reads as that key's on every host, so nothing else has to trust this service. Approving each draft
on a page of ours would put this service between the person and everything it does.

**Why OAuth?**
MCP asks for it, and assistants that speak MCP already know how to connect with it. The MCP SDK
ships the whole authorization server; this service answers its questions from its one file and
adds the page the person sees.

**Why two doors?**
Not every assistant speaks MCP. The same login gives one token, and the same tools answer at
`/mcp` and at `/v1/tools`, from one handler.

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
No: the keys are in its file, opened only with its secret, and nowhere public. If either is lost,
every connection ends, and each person connects again and hands over new keys.
