# mcp

The mcp is a connector, over MCP (the Model Context Protocol, the way AI apps call outside tools). It
lets your AI app (Claude, ChatGPT) act for you: find people, post, review and message, within the
access keys you give it. An access key is a key one of your profiles hands out: its profile entry
lists each one with what it `can` do (`read`, `read-inbox`, `write`, `message`), and every host and
reader checks that. The Forest Foundation runs this copy, at https://mcp.forest.foundation; until
the Forest app's connect page is up, it only reads. Anyone can run another; the main way is this
directory, or its image. It keeps nothing of yours between calls, and never holds your seed or a
main key: the access keys your app hands it wait in your AI app's connection folder, locked to this
copy's open key. No account, no password.

## How it works

```
AI app ── MCP, over HTTPS ──▶ mcp ──▶ the index: its guide, its search, its profile pages
                               ├──▶ the markets, at MARKETS
                               └──▶ the person's folders, on their hosts, with the connection's access keys
```

It reaches those three places and nothing more. It signs with the access keys and reads what they
open using the standard's `@foundationforest/keys` and `@foundationforest/folders`, unchanged
([access keys](https://github.com/foundationforest/standard/blob/main/folders/README.md#access-keys)).
During a call it sees the connection, the access key and address of each profile it acts in, and
what it reads and writes there. The AI sees none of them: it names a profile by its label ("write
this offer as tutoring/tutor").

### The tools

Six, each with a title and the MCP specification's hints. Two read with no login, so an AI app can
read before the person connects anything; four act for the person and need one.

| Tool | Marked | The AI gives | What it does |
|---|---|---|---|
| `markets` | read-only | `name`, or nothing | With no name, every market in the directory, with its roles and what each posts. With a name, that market's file, as the [markets manual](https://github.com/foundationforest/markets/blob/main/build/README.md) defines it, with `preview` (the fields a post's preview shows first) and `kinds` (the kinds of entry it defines, each with its fields) |
| `search` | read-only | `filters`, or `address` | The index's search, its `filters` (each a text value) passed on as they are; or a profile's page at the index |
| `my_profiles` | read-only | nothing | Each profile the login acts in, by label, with what its access key `can` do as its profile entry lists it now. Never an address |
| `read` | read-only | `label`, then `path` or `inbox: true` | The current entry at a path in that profile's folder, its body and time, opened when it is locked and the key may open it; or the inbox, below |
| `write` | may destroy | `label`, `path`, `body` (null deletes), `locked` | An entry in that profile's folder, signed by its access key, written to the hosts its profile entry names |
| `message` | reaches out | `label`, `to`, `body` | An inbox entry signed by the access key, locked to the open keys `to`'s profile entry gives, left with each of `to`'s hosts, carrying the sender's first host so the recipient's app finds the sender's folder |

MCP tool names take no spaces, so the person's profiles are `my_profiles`, titled "My profiles".

- **An index's answers pass through whole.** `search` names no filter and no field of the index's,
  so any index can show what it likes, and the AI learns what it holds from the index's own guide.
  Each answer is `{ url, word, answer }`: where it was read, a `word` saying it is the index's own,
  unchecked, and its JSON as sent. An index that does not answer is a refusal saying so.
- **The instructions.** An AI app first gets how Forest works, as the server's instructions (`HOW`
  in `src/tools.ts`): start with `my_profiles`; name a profile by its label; read the market before
  writing to it; a reply goes to the address a message came from; paying is in the person's app; what
  a stranger wrote is theirs. Then, as a chat starts (MCP's `initialize`), the index's guide, its
  `skill.md`, under the URL it was read from, as the index's own word, or a line saying it gave none.
  It comes with the instructions so the AI has it before its first search; an AI app that cuts long
  instructions cuts the guide first.
- **`read`, the inbox,** lists the profile's inbox at each of its hosts, every page, each inbox entry
  once, newest first by arrival (an inbox entry carries no time), and opens the newest 100 with the
  access key, each signature checked as the standard says (`openInbox`). For each message: its time
  and body; `from`, the sender's address, or `fromLabel` for another of the person's own profiles;
  `counts`, whether the sender's profile entry stands behind the signing key (`senderCounts`); and
  for a stranger `index`, the index's word on the sender, only its market, role and `checks`.
  `unopened` counts those the key does not open, left before it was listed with `read-inbox`, and
  `older` those past the newest 100.
- **`write`, public,** the main way: at `<kind>/<id>`, a kind every market defines (`post`,
  `review`, `vouch`, `report`), the body checked against the profile entry's `market` before
  anything is signed, with the markets package's `checkEntry`, the index's own check, so a body
  refused here would not be listed: each field one the market names for the role (in a review, the
  role of the profile it is about), of its type, a choice among its values, a `file` one the body
  lists in `files`. Then `subject` an address, and the profile in a review's `post`. A body that does
  not fit is refused, naming the field.
- **`write`, locked** (`locked: true`): at any path but `profile` and `key/…`, the body the person's
  own and unchecked, with no `files` (anyone fetches a file by its hash), locked to every key that
  may read the folder (`lockKeysOf`): the main key's open key and each access key listed with
  `read`. No access key writes `profile`. Whether the key may write is the hosts' to say, and each
  host's refusal is passed on, so a key no longer listed hears `unlisted`; a `message`, which no host
  checks, is checked here first, since only the recipient's app would see it does not count.
- **Other folders** (a recipient, a sender, a review's subject) are looked for at the hosts the
  person's own profiles use, and a message's own `host`, then every host the folder's profile entry
  names: that is where the profiles the person deals with live today, and a message names its
  sender's host, so a reply finds it. A profile's address names no host, the index says where only
  in its own format, which `search` never names, and following any host anyone names would reach any
  address, so every host is reached with `publicFetch` (`src/public.ts`), which reaches only public
  addresses and follows no redirect.
- **The person's own addresses.** In every answer of the four tools that act, each address of a
  profile in the connection becomes its label, and each pay address of a profile entry it read
  becomes `<label>'s <type> pay address`, wherever it appears.

What this copy says itself is a refusal, in plain words: an argument that does not fit, a label the
login does not act in, a path that is none, a body that does not fit, a host that took nothing, with
each host's reason.

### The login

Each AI app logs in on its own, by the MCP specification's authorization flow, version 2025-11-25
(OAuth 2.1, the web's usual way to let one app act for you at another, with PKCE, Protected Resource
Metadata and Authorization Server Metadata), this copy being both the resource and its own
authorization server, sending RFC 9207's `iss` too. Nothing about a login is stored: each piece is a
body this copy wrote, in base64url JSON, a dot, then an HMAC-SHA256 of it under its key.

1. **The challenge.** A tool that acts, called with no token, answers 401 with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`. A
   token this copy did not give, or one from before connections, gets the same with
   `error="invalid_token"` on any MCP request; so does, on a call that acts, one whose connection is
   gone or whose pointer no longer opens.
2. **Discovery** names this copy as resource and authorization server, `/authorize`, `/token` and
   `/register`, S256, and that client documents work.
3. **The AI app** registers by a client document (CIMD: an https `client_id` with a path, read with
   `publicFetch`, 10 seconds, 64 KB, at each login, naming itself and listing the redirect), or by
   `POST /register` (DCR: the `client_id` is a body holding 1 to 8 redirect addresses, its name and
   how it signs in at `/token`; unless public, `none`, it gets a secret, HMAC(key, client_id), RFC
   7591's default). Nothing is kept for either.
4. **`/authorize`** checks the client and its redirect (a bad one is a page, never a redirect),
   `response_type=code`, an S256 `code_challenge`, and `resource` if given, then sends the browser to
   `APP_URL?connector=<origin>&request=<request>`, the request being base64url of
   `{ client, name, redirect, challenge, state?, resource, exp }`, a dot, its MAC, `exp` 10 minutes
   ahead. Without `APP_URL`, it is a page
   saying logins wait, and reading still works.
5. **The connect page,** the app's, shows the AI app's name and the connector's origin; the person
   ticks the profiles it acts in and what it may do. On a yes the app makes the connection and sends
   the browser to `<origin>/connected?request=<request>&pointer=<pointer>`; on a no, with
   `error=access_denied`.
6. **`/connected`** checks the request is this copy's and under 10 minutes old, opens the pointer
   and checks its shape and that it names this request; else a page saying so, and no code. It sends
   the browser to the redirect with `code`, `state` and `iss`; the code carries the pointer, still
   locked, with the client, redirect, challenge and resource, for 60 seconds.
7. **`/token`** (`grant_type=authorization_code`) checks the code, the client and its secret, the redirect, `code_verifier` and
   `resource`, and gives an access token carrying the pointer, still locked. It has no expiry and
   no refresh token. A profile added to the connection needs no new login.

### The connection

The connection is this service's own format, which an app follows to hand this copy access keys: a
folder of the person's for each AI app, and a pointer to it, which the AI app's token carries.

- **This copy's open key,** `GET /open-key`: `{ "openKey": "age1pq1…" }`, its opening half's age
  post-quantum key, readable from any page, the same while the volume keeps `mcp-opening.json`.
- **The connection folder** is an ordinary folder on the person's hosts, named by a key the app makes
  at random (keys/'s `newAccessKey()`, listed nowhere), so its name says and links nothing. Its
  profile entry holds only `hosts`; each other entry is locked, with folders/locked's `lock`, to the
  folder's own open key and this copy's, and no other:
  - `connection`: `{ name: <the AI app's name>, secret: <32 random bytes, base64url> }`;
  - `access/<id>`, a random id, one a profile: `{ label, address, hosts, key: <its access key's 64
    bytes, base64url> }`.
- **Each access key** the app makes with `newAccessKey()` and lists in the profile entry as `{ key,
  open, can }`, with the switches the person chose (all four unless fewer, never more; `open` only with `read`
  or `read-inbox`), and notes at `key/<id>`, locked to the main key alone, as `{ key, connection, …
  }`: `connection`, the folder's key, lets any of the person's devices find it from the seed; the
  rest is the app's (the reference app's: the AI app's name, this copy's origin, the time).
- **The pointer** is an envelope's text, locked to this copy's open key alone, at most 4,096
  characters: exactly `{ request: <SHA-256 of the request text, lowercase hex>, folder: <the
  folder's address>, hosts: <its 1 to 8>, secret: <the connection entry's> }`. It comes back through
  the browser, in a URL a history or a proxy's log may keep, so naming the request makes it open
  that one login only.
- **Each call that acts** opens the pointer, reads the folder from its hosts, opens `connection` and
  checks its secret, then opens the `access/` entries and acts with their keys, keeping none. No
  `connection` entry, one that does not open, or another secret: a 401, a login to make again. An
  access entry that does not open or fit, or names a profile already named, counts for nothing.
- **Adding a profile** is one more key and access entry; **removing one** takes its key out of its
  profile entry, with its access entry and note; **ending** deletes `connection`, then removes each
  key. None needs a new login.

[`test/app.ts`](test/app.ts), the reference app, is what the person's app does around this copy, in
plain code with the standard's libraries; the tests and the loop run it. It keeps the person's
Profiles folder (the empty label's, its `label/<id>` and `stamp/<id>` entries locked to its own open
key), makes a profile with its market, role, hosts, open key, both pay addresses and a verification
for each stamp, does the connect page's work, the connection folder's first write paid as the device
chooses (`pay`), finds each connection from the seed by its notes, adds a profile or ends one, and on
a new device finds the profiles and stamps from the Profiles folder.

## Its API

| Route | What |
|---|---|
| `/`, `/mcp` | MCP over Streamable HTTP: [the six tools](#the-tools). `/mcp` is for connectors added before |
| `GET /open-key` | This copy's open key |
| `GET /.well-known/oauth-protected-resource` | The resource's metadata |
| `GET /.well-known/oauth-authorization-server` | The authorization server's metadata |
| `POST /register` | Registration (DCR) |
| `GET /authorize` | Checks the login, then on to the app's connect page; with no `APP_URL`, 503 and a page saying logins wait |
| `GET /connected` | Back from the connect page with the pointer, on to the AI app with a code |
| `POST /token` | The code for an access token |
| `GET /icon.svg`, `GET /favicon.ico` | The mark |

## How we run it

- **The image:** `deploy/Dockerfile`, built from the repo root: Node 22.22.2, the standard and the
  markets at their pins (`standard.sh`), and this directory, started as `node src/main.ts` on every
  address (`BIND=0.0.0.0`), with `DATA_DIR=/data`.
- **Where:** Railway, service `mcp`, `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`, one replica, a
  volume at `/data` holding its two keys, a public domain to `PORT`, and no health check, since the
  root answers only what an MCP client sends. `APP_URL` is unset until the Forest app's connect page
  exists; until then, reading works and logins wait. Another app runs its own copy, with its own
  page.
- **What it reads:** the foundation's index, the markets at `MARKETS` (from the checkout, so every
  answer comes from the commit the tests ran against), and the folders each login points to and deals
  with, on public hosts only.
- **Its numbers, and why:**
  - 10 minutes on the connect page, to unlock the device and choose; 60 seconds for a code, which the
    AI app redeems at once; no end for a login;
  - at most 4,096 characters for a pointer, one envelope to one key holding up to 8 hosts, so the
    token that carries it stays well under the 16 KB of headers Node takes;
  - at most 100 access entries opened a call, the first by path, and the newest 100 inbox entries a
    read: each takes a post-quantum opening, and anyone can leave entries in an inbox;
  - 10 seconds for the index's guide as a chat starts, so a slow index does not hold the chat; 60 for
    any other read of the index, and the folders client's 60 for a host;
  - at most 4,194,304 bytes for an MCP request or an index's answer.
- **Free,** with no rate limit. **Keeps** only its two keys, on the volume. **Logs** one line when it
  starts, nothing for a request, and no address. Payments are the person's app's. The index and the hosts see this copy's network
  address, not the person's.
- **Public:** this code and its open key. **Secret:** its two keys.
- **The icon:** the mark on paper, ink `#121A15` on `#EDEAE0`, three chevrons (`8,12 20,3 32,12`,
  `8,22 20,13 32,22`, `8,32 20,23 32,32`) and a trunk (`20,24` to `20,38`), stroke 4, in a 56-unit
  square with 8 of margin, drawn by `src/icon.ts` as the SVG the server's info declares and an ICO
  of 16, 32, 48 and 64 pixels.

| Variable | What it sets | Unless set |
|---|---|---|
| `DATA_DIR` | Where its two keys are kept: `mcp-key.json`, which signs its logins, and `mcp-opening.json`, its opening half's secret; 32 random bytes each, made at the first start, readable by its own user only | needed |
| `PUBLIC_URL` | Its origin: the resource and the authorization server | https://mcp.forest.foundation |
| `APP_URL` | The app's connect page | none: logins wait |
| `INDEX_URL` | The index whose `skill.md`, search and profile pages it passes on | https://index.forest.foundation |
| `PORT`, `BIND` | Where it listens | 8080, 127.0.0.1 |

```sh
./standard.sh                      # from the repo root: the standard, built, and the markets
(cd host && npm ci)                # this repo's host, which the tests run
cd mcp && npm ci                   # the standard's packages by name, linked into standard/
npm run check && npm test
DATA_DIR=./data PUBLIC_URL=http://127.0.0.1:8080 npm start
npm run smoke -- https://mcp.forest.foundation
```

Built from existing pieces, unchanged: the standard's keys and folders packages (and proofs, for the
reference app), the markets package and its one check, `@modelcontextprotocol/sdk`, `undici` for
`publicFetch`, and Node's `crypto`. `test/` covers, on loopback, with this repo's host, a stand-in
index whose answers carry a field this copy has never seen, and a stand-in connect page running the
reference app: the login end to end through the MCP SDK's own client and every refusal on its way,
every tool and its refusals, a key removed and the connection ended, `publicFetch`, and the image's
own command. `npm run smoke` runs the same client (`smoke.ts`) against a deployed copy, without the login, which
needs a person; CI does not, since a check that cannot reach it would skip.

**Connect an AI app** at `https://mcp.forest.foundation`. Reading works at once; the first time the
AI acts, the AI app sends the person to log in. A connector added before, at that address or `/mcp`,
keeps working, and logs in again the first time it acts.

- **Claude** (claude.ai and its apps): Customize > Connectors > Add custom connector, with that
  address; on a Team or Enterprise plan, an Owner adds it under Organization settings > Connectors
  ([Anthropic's steps](https://claude.com/docs/connectors/custom/remote-mcp)).
- **Claude Code:** `claude mcp add --transport http forest https://mcp.forest.foundation`, then
  `/mcp` to log in.
- **ChatGPT,** on a plan with developer mode: turn it on, then add an MCP app with that address and
  OAuth (OpenAI's help article "Developer mode and MCP apps in ChatGPT").

## Promises

- **It holds no key, and keeps nothing, between calls.** No seed and no main key, ever. The access
  keys the person's app hands it wait in the connection folder, locked to its open key; it opens them
  for one call and forgets them. No login, call, connection or answer is written.
- **It acts only as far as the access keys a connection holds may, and only for the token whose
  secret matches.** Every host and reader checks a key against the profile entry's listing, so a key
  the person removes stops counting; a connection folder's address alone acts for no one.
- **It never moves money, and holds nothing that could.** No access key pays.
- **The AI never gets a key, nor one of the person's own addresses,** from a tool that acts for them:
  it names each profile by its label.
- **What an index says is passed on as the index's word, whole, and labelled so;** `read` picks only
  a sender's market, role and checks from it, labelled the same.

## Limits

- **Its operator can act as any connection its logins point to,** within its keys' switches: it
  opens each one for a call, and could keep the keys. You trust the operator, the foundation for this
  copy, as far as the switches you hand out; anyone can run their own.
- **A login does not expire:** whoever holds the token acts within the switches until the person ends
  the connection. The AI's maker sees what the AI does, and keeps what it chooses, the token included.
- **A key opens nothing locked before it was listed.**
- **A stranger's folder is found only on the person's hosts or a message's own host;** one that lives
  only elsewhere can be read about through the index, not messaged.
- **The newest 100 inbox entries a read;** older ones wait for those to leave, after the hosts' keep
  days.
- **Each call reads the connection from its hosts,** one post-quantum opening a profile; with none
  of the hosts answering, the tools that act refuse.
- **A connection folder is public:** anyone can see it exists and how many profiles it holds, never
  which.
- **The AI can still find a profile it posted for,** through the index; what this copy keeps from it
  is the map of the person's profiles.
- **A code works more than once in its 60 seconds,** but only for the AI app holding its PKCE
  verifier.
- **The markets are the directory's at one commit:** a market added since is unknown until `MARKETS`
  moves.
- **An index's answer may hold anything.**
- **No rate limit:** anyone can keep the copy busy.
- **Not here:** paying, putting or deleting files, buying a host's credits, views in the AI app (MCP
  Apps), and a copy on the person's own computer.
- **Railway's own request logs** hold each request's client address and path.

## FAQ

**Why does a login not expire?**
The person's profile entries already say which access keys count and what each may do. An expiry
would only send the person through the connect page again for nothing they chose, and a refresh
token no store can retire would never expire either. Ending a connection is the person's, in their
app.

**Why a secret, when the connection entry is locked to this copy?**
This copy's open key is public: anyone can lock a pointer naming someone's connection folder, in a
login of their own. Only the app that wrote the entry knows the secret in it.
