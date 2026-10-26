# mcp

Part of Forest's services: [the top README](../README.md).

The mcp passes what an AI app asks to the person's signer, and the answer back.

It serves the AI's door to all of Forest: an AI app reads markets, posts, profiles and ratings
through it, and acts for a person through it, by asking Forest on one of that person's own devices.
It is the MCP connector your AI app adds.

The foundation runs one copy, at https://mcp.forest.foundation. Anyone can run another; the main way
is this directory, or its image.

**What it keeps:** nothing of the person's. No seed, no key, no rule, no record, no message.
Its own key, which signs the logins it gives, on its volume. The live connections from signers, in
memory, gone when it stops.

**What it sees:** what the AI asks, in plain text, and the answer the signer gives. Never a key, and
never the person's own profiles' addresses: the AI asks in words ("post this offer in tutoring as
tutor"), the signer picks the profile, signs and publishes straight to the host, and the answers
carry no addresses.

## How it works

```
AI app ── MCP, over HTTPS ──▶ mcp ◀── WebSocket ── signer (Forest on the person's device) ──▶ hosts
            reads ─────────────▶ └──▶ hosts, index, markets
```

A person's seed lives only on their signers, the devices they own that hold it
([the standard's keys](https://github.com/foundationforest/standard/blob/main/keys/README.md#signers)).
A signer acts by the rules in each of the person's profiles' folders, private records only the
person's signers open
([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#rules)),
and signs everything with the profile's main key. The mcp only carries asks and answers between an AI
app, calling from its maker's cloud, and that signer.

### Reading

Four tools read what is public, with no login and no signer:

- `markets`: every market in the markets directory this copy reads, with its roles and what each
  posts; and the markets the index lists.
- `market`: a market's file, as the
  [markets manual](https://github.com/foundationforest/markets/blob/main/build/README.md) defines it,
  with `preview`, the fields a post's preview shows first (the manual's default when the file leaves
  it out), and `kinds`, the kinds of record it defines; and its posts by role, from the index.
- `search`: the index's search, with its filters (`q`, `market`, `role`, `near`, `km`, `minRating`,
  `minReviews`, `limit`, `offset`).
- `profile`: any profile, from its hosts, every signature checked: its profile record (without its
  inbox key, about 2 KB a sender's app finds itself) and its other records by kind, each with its full
  address; and, from the index, `checks` (which verifiers' stamps it shows) and `rating`.

A folder is always read from hosts, never from an index: first from the start hosts, then from every
host its hosts record names, by POST so the address is in no URL. A host other than the start hosts is
reached only at a public address, through the standard's `publicFetch`; no request follows a redirect;
a read stops after 100 pages. The markets come from `../markets`, the directory at the commit in
`MARKETS`, never over the network. What an index says is passed on as its word, unchecked, with the
URL it was read from; an index that does not answer never hides what the hosts gave.

### Acting, through the person's signer

Seven tools go to the person's signer, and need a login:

| Tool | The AI gives | The mcp checks first | The signer's answer, when done |
|---|---|---|---|
| `profiles` | | | `profiles`: the market and role of each profile this connection may act for |
| `post` | `market`, `role`, `kind`, `body`, `id` if wanted | the market and role exist; `kind` is one the market defines; `body` fits that kind's fields, and a review's holds no `evidence` | `kind`, `id` |
| `remove` | `market`, `role`, `kind`, `id` | the same, with no body | `kind`, `id` |
| `message` | `market`, `role`, `to`, `text` | the market and role exist; `to` is an address | nothing more |
| `inbox` | `market`, `role` | the market and role exist | `messages`: each `number`, `from`, `time`, and `text` or `body` |
| `reply` | `number`, `text` | `number` is from 1 | nothing more |
| `pay` | `offer`, `role`, `amount` | `offer` is a post's address and the post is on its hosts; `role` is one of its market's; `amount` is US dollars, more than 0, up to six places; the signer gets the market too | nothing more: a review of the post from the same profile then carries the payment as its evidence, which the signer fills in |

`market` and `role` name the person's profile the signer acts as; the signer picks it, and no answer
names its address. A record of a kind sits at `<kind>/<id>` in the profile's folder.

**Kinds come from the markets' own format,** `build/market.schema.json` at `MARKETS`: a kind is a
top-level property of a market file that is fields (`offer`) or holds fields beside shared names
(`review`). So a market that adds a kind needs only `MARKETS` to move. A body is checked as the old
mcp checked it, against a JSON Schema made from each field's type in `build/types.json`: a field the
market names for that kind, for the writer's role (an `offer` field's `roles`) or the subject's (a
`review` field's, read from the subject's profile record), of its type, a choice among its values.
Shared names are checked by their meaning in the manual: `subject` an address, `score` `"1"` to
`"10"` with at most one decimal, `offer` a post's full address, `text` text; a kind with `subject`
among its shared names needs one. `evidence` is refused: the person's signer fills it in, from the
payment the profile made for the review's `offer`, so an AI never names a payment. A body that does
not fit is refused naming the field, before anything reaches the signer. A field marked `required`
is not asked for: the manual says an app asks for it, and nothing enforces it. No kind can be
`profile`, `hosts` or `rule`, so `post` never reaches the profile record, the hosts record or a
rule.

Each relayed call ends one of three ways:

- **done:** `{ "status": "done", …the fields above }`;
- **needs approval:** `{ "status": "needs approval", "link", "why" }`: the request is outside what the
  person allowed this connection, so the AI gives the person the link, to open on one of their
  devices. The AI is not told when they say yes;
- **refused:** an error, `The person's signer refused: <why>`.

With no signer open for the connection, the call is an error in plain words: "Forest is not open on
any of the person's devices, or it no longer serves this connection: ask them to open Forest on one of
their devices, then try again."

### The login

Each AI app is its own connection. Its login is the MCP specification's authorization flow, version
2025-11-25, the one AI apps implement today (OAuth 2.1 with PKCE, Protected Resource Metadata, and
Authorization Server Metadata), with this copy as both the resource and its own authorization server.
It also sends RFC 9207's `iss`, which the next version asks for. Nothing about a login is stored: each
piece below is a body this copy wrote, in base64url JSON, a dot, then an HMAC-SHA256 of it under this
copy's key.

1. **The challenge.** A relayed tool's call with no token gets a 401 with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`; a
   token this copy did not give gets the same on any request, with `error="invalid_token"`.
2. **Discovery.** `/.well-known/oauth-protected-resource` names this copy as the resource and its
   authorization server; `/.well-known/oauth-authorization-server` names `/authorize`, `/token` and
   `/register`, S256, and that client documents work.
3. **The AI app.** It registers one of two ways, and nothing is kept for either:
   - by a client document (CIMD): its `client_id` is an https address with a path, read with the
     standard's `publicFetch` (10 seconds, 64 KB) each time a login starts; it must name itself as its
     `client_id` and list the redirect address;
   - by registration (DCR, `POST /register`): its `client_id` is a body holding its redirect addresses
     (1 to 8), its name and how it signs in at `/token`. Unless it registers as public (`none`), it
     gets a client secret, HMAC(key, client_id), checked at `/token`: a secret is RFC 7591's default.
4. **`/authorize`** checks the client and its redirect address (a bad one is a page, never a
   redirect), `response_type=code`, an S256 `code_challenge`, and `resource` if given; then it sends
   the person's browser to the app's connect page:
   `APP_URL?connector=<origin>&request=<request>`. `request`'s JSON is
   `{ client, name, redirect, challenge, state?, resource, exp }`, `exp` 10 minutes ahead.
5. **The connect page** is the app's. It shows the AI app's `name`, the host of `redirect` and the
   connector's origin, and the person chooses what this AI app may do. On a yes, the signer makes a
   connection:
   - an Ed25519 key pair, whose public key, its 32 bytes in base64url (43 characters), is the
     connection's id;
   - one rule in the folder of each profile the person chose,
     `who: { connector: <origin>, connection: <id>, key, name }`, with the actions and the limit the
     person chose; `key` is the connection's own key, so each of the person's signers serves it;
   - its signature, with the connection's key, on the UTF-8 bytes of `forest-mcp/v1/login\n`
     followed by `request`, exactly as received.

   It sends the browser to `<origin>/connected?request=<request>&connection=<id>&sig=<64 bytes in base64url>`,
   or, on a no, `<origin>/connected?request=<request>&error=access_denied`.
6. **`/connected`** checks `request` is this copy's and less than 10 minutes old, then the
   connection's signature on it. A login signed by any other key is a page saying so, and no code. It
   sends the browser to the AI app's redirect address with `code`, `state` and `iss`; `code` names the
   connection, the client, the redirect, the challenge and the resource, for 60 seconds.
7. **`/token`** (`grant_type=authorization_code`) checks the code, the client (and its secret, if it
   has one), the redirect, `code_verifier` against the challenge, and `resource`, and gives an access
   token naming the connection, the client and this copy. It carries no expiry, so there is no
   refresh token: the login ends when the person removes its rules, at any of their signers, and no
   signer of theirs serves it from its next ask.

Without `APP_URL`, step 4 is a page saying logins wait for the Forest app's connect page, and reading
works as before.

### The relay protocol

A signer opens a WebSocket to `wss://<origin>/signer`. Every frame is one JSON object as text, with a
`type`:

| From | Frame |
|---|---|
| mcp | `{ "type": "challenge", "challenge" }`: first, on every socket; 32 random bytes in base64url |
| signer | `{ "type": "register", "connection", "sig" }`: `sig`, the connection key's Ed25519 signature, in base64url, on the UTF-8 bytes of `forest-mcp/v1/register\n`, then the connector's origin, then `\n`, then the socket's challenge |
| mcp | `{ "type": "registered", "connection" }`, or `{ "type": "refused", "connection", "why" }` |
| mcp | `{ "type": "ask", "id", "connection", "tool", "args" }`: `args` as the table above, `id` hex |
| signer | `{ "type": "answer", "id", "status": "done", "result" }` |
| signer | `{ "type": "answer", "id", "status": "approval", "link", "why"? }`: `link`, an https address |
| signer | `{ "type": "answer", "id", "status": "refused", "why" }` |

How the mcp behaves:

- A signer registers each connection it serves, on one socket per connector, and may register one
  more later on the same socket, signing the same challenge.
- An ask goes to the newest live socket for its connection, once, and never again: a pay is never sent
  twice. When that socket closes before it answers, the AI is told it may or may not be done.
- From a done answer, only the fields in the table above are passed on, each of its type; anything
  else in `result` is dropped. So a signer cannot hand an AI app one of the person's addresses by
  mistake.
- An answer to no ask, or to one that timed out, is dropped. A frame that is not JSON, not an object,
  or of no type above closes the socket (1008).
- The live sockets are the only thing this copy holds between calls, in memory.

What the signer does with an ask is the standard's. Before any ask it reads the rules in each of the
person's profiles' folders (`readRules`), so a rule removed on any of their devices is gone at the
next ask, and a connection with no rule left has ended. It acts only within the rule for this
connection on the profile asked for, one it knows whole (`knowsRule`) that has not ended, covering
the action (`post` and `remove` are the standard's `post`, `message` and `reply` its `message`,
`inbox` its `read`, `pay` its `pay`, within the rule's limit, counted on that profile, and a rule
with no limit sets no money cap). It refuses to write or remove the profile record, the hosts record
or a rule, and asks the person about everything else. It registers each connection its rules name
for this copy, with the key in the rule, so any of the person's devices serves it.

On money it does more, as the app's choice:

- a `pay` asked again for the same post and amount within an hour answers done, and pays nothing;
- any other payment for a post the profile already paid waits for the person's yes;
- a review of a post the profile paid gets the latest such payment as its evidence, filled in by the
  signer, which drops any evidence an ask carries;
- it keeps those payments in memory, on the device that paid, so another device of the person's
  knows none of them.

It numbers messages for each connection, so a number means the same message for as long as it keeps
them, and shows a message from another of the person's own profiles by its label.
[`test/signer.ts`](test/signer.ts) does all of it, in plain code, with the standard's libraries.

### Run it

```sh
./standard.sh                      # from the repo root: the standard, built, and the markets
cd mcp && npm ci                   # the standard's packages by name, linked into standard/
npm run check                      # type-check
npm test                           # everything below, on loopback
DATA_DIR=./data PUBLIC_URL=http://127.0.0.1:8080 npm start
npm run smoke -- https://mcp.forest.foundation
```

Node 22.18 or later. Built from existing pieces, used unchanged: the standard's keys and records
packages (`@foundationforest/keys`, `@foundationforest/records`, through file: links into
`standard/`); `@modelcontextprotocol/sdk`, for the MCP door; `ws`, for the signers' door; `ajv` and
`ajv-formats`, for the market checks, the versions the markets directory's own check uses; Node's
`crypto`, for Ed25519 and HMAC.

| Variable | What it sets | Unless set |
|---|---|---|
| `DATA_DIR` | Where its key is kept: `mcp-key.json`, 32 random bytes made at the first start, readable by its own user only | needed |
| `PUBLIC_URL` | Its origin: the resource, the authorization server, and the connector in a person's rules | https://mcp.forest.foundation |
| `APP_URL` | The app's connect page | none: logins wait |
| `INDEX_URL` | The index read for posts, search, checks and ratings | https://index.forest.foundation |
| `HOST_URLS` | Where a profile's hosts record is looked for first, comma separated | https://host.forest.foundation |
| `PORT`, `BIND` | Where it listens | 8080, 127.0.0.1 |

The tests run the standard's reference host, a stand-in index serving the four answers in the index's
JSON as it is now, a stand-in connect page, and the reference signer, holding a person's seed with
three profiles; a login writes a rule into the folders of their two tutoring profiles, to post,
message, read and pay $50 a day on each:

- `test/login.test.ts`: reading with no login; the challenge and the metadata; the login end to end
  through the MCP SDK's own client, by registration and by a client document; each login its own
  connection, in a rule on each profile chosen; a login ending when the person removes its rules, at
  their signer; refused: a login signed by a key that is not the connection's, a login changed on
  the way, an unknown AI app, a person who says no, a code with the wrong verifier or for another
  client, a token this copy did not give; with no `APP_URL`, reading works and logins wait.
- `test/tools.test.ts`: each of the eleven tools. The login's rule in each chosen folder, encrypted
  to that profile alone, the connection's key inside, and none in the third. `profiles`, the
  profiles holding a rule for the connection. Another device on the same seed serving the login from
  the rules. Inside the rules, done without asking; outside them (a profile no rule covers), needs
  approval, then done after the yes. A kind the market does not define, the profile record, the
  hosts record, a field that does not fit, a role the market lacks and a review naming `evidence`,
  refused before anything is relayed; the signer's own refusal to write or remove the profile
  record, the hosts record or a rule. `pay` answering only done; past the student's limit, needs
  approval, while the tutor's limit counts on its own; the same pay again within the hour, nothing
  paid; another payment for a post already paid, and the same one an hour on, needs approval, and a
  yes given twice pays once; a rule with no limit, any amount, done. A review of a paid post
  carrying the signer's evidence, and none for a post the profile never paid. A rule removed on the
  other device gone at the next ask, and with none left the login ended. With no signer open, said
  plainly; and no answer in the whole run holds one of the person's addresses (each profile's, each
  pay address).
- `test/relay.test.ts`, with a signer made by hand: a registration by another key refused; a frame
  that is not JSON closing the socket; only the protocol's fields passed on; an approval link that is
  not https refused; a socket closing mid-ask said plainly; and nothing kept between calls but live
  sockets: a token one copy gave works on another copy of the same service with no store, no socket is
  left once the signer closes, and the data directory holds only the key.
- `test/smoke.test.ts` reads the command and working directory from `deploy/Dockerfile`, runs them
  here, and connects with the MCP SDK's own client (`smoke.ts`): how Forest works first, as the
  server's instructions, the mark as its icon, no session, every tool, reading with no login, the
  challenge and the metadata, registration, `/authorize` on to the connect page, the same tools at
  `/mcp`, the icon's two files, a login through the stand-in page, and the no-signer answer; `//`
  answered 400 while it goes on answering; with no `APP_URL`, logins wait; with no `DATA_DIR`, it
  refuses to start. `npm run smoke` runs the same client against a deployed copy, without the login,
  which needs a person.

## How we run it

The foundation's copy, at https://mcp.forest.foundation:

- **The image.** `deploy/Dockerfile`: Node 22.22.2, the standard at `STANDARD` and the markets at
  `MARKETS` (`standard.sh`), and this directory, started as `node src/main.ts` on every address
  (`BIND=0.0.0.0`), with `DATA_DIR=/data`.
- **Where it runs:** Railway, service `mcp`: this repo,
  `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`, one replica, a volume at `/data`, a public domain
  to the port in `PORT`, WebSockets through Railway's proxy, and no health check (the root answers only
  what an MCP client sends). `APP_URL` is unset until the Forest app's connect page exists; until then
  reading works and logins wait.
- **Its connect page:** this copy sends logins to the Forest app's page; another app runs its own
  copy, with its own page.
- **What it reads:** profiles from the foundation's host first, then the hosts each profile's hosts
  record names; markets from the directory at `MARKETS`; posts, search, checks and ratings from the
  foundation's index.
- **The tools.** All eleven, over Streamable HTTP at its root, and at `/mcp` for connectors added
  before. An AI app first gets how Forest works, as the server's instructions (`HOW` in `src/tools.ts`).
- **Its numbers, and why:**
  - 45 seconds for a signer's answer: under the 60 seconds the MCP SDK's client waits by default, so
    the AI hears these words, not a bare timeout;
  - a ping every 30 seconds, and a socket with no pong by the next one closed: under the 60 seconds
    many proxies let a quiet connection live, and a phone that slept is noticed within a minute;
  - 30 seconds for a new socket to register its first connection, and at most 100 connections on one
    socket;
  - 10 minutes on the connect page, to unlock the device and choose; 60 seconds for a code, which the
    AI app redeems at once; no end for a login, which lasts until the person removes its connection;
  - at most 4,194,304 bytes for an MCP request, a frame either way, or an index's answer; at most 100
    pages for one folder read; the records library's 60 seconds for a read.
- **Free:** no price.
- **Keeps nothing of anyone's:** its key on the volume, and live sockets in memory; no call, token or
  answer is written.
- **Logs no call:** it writes one line when it starts, and nothing for a request.
- **No rate limit.**
- **The icon.** The mark on paper: ink `#121A15` on paper `#EDEAE0`, three chevrons
  (`8,12 20,3 32,12`, `8,22 20,13 32,22` and `8,32 20,23 32,32`) and a trunk (`20,24` to `20,38`),
  stroke 4, in a 56-unit square with 8 of margin. The server's info declares it as an SVG; the copy
  serves it at `/icon.svg`, and at `/favicon.ico` as an ICO of 16, 32, 48 and 64 pixels. `src/icon.ts`
  draws both from the mark's strokes.

Payments are the signer's, on the chain the escrow runs on today, Solana's devnet, in Circle's USDC.
Hosts and indexes see this copy's network address, not the person's.

### Connect an AI app

The address is `https://mcp.forest.foundation`. Reading works at once; the first time the AI acts, the
AI app sends the person to log in, and the Forest app's connect page makes the connection. A
connector added before, at that address or at `/mcp`, keeps working, and logs in the first time it
acts.

- **Claude** (claude.ai and Claude's apps): Customize > Connectors > Add custom connector, with that
  address; Claude finds the login itself. On a Team or Enterprise plan, an Owner adds it under
  Organization settings > Connectors
  ([Anthropic's steps](https://claude.com/docs/connectors/custom/remote-mcp)).
- **Claude Code:** `claude mcp add --transport http forest https://mcp.forest.foundation`, then
  `/mcp` to log in.
- **ChatGPT,** on a plan with developer mode: turn developer mode on, then add an MCP app with that
  address and OAuth. OpenAI moves these menus; its help article "Developer mode and MCP apps in
  ChatGPT" says where they are now.

## Promises

- **It holds nothing of the person's.** No seed, no key, no rule; it never receives the
  person's own profiles' addresses, keys or folders.
- **It acts only through the person's signer,** which acts by the person's rules and asks them
  about the rest. It signs nothing for anyone.
- **It never moves money itself, and holds nothing that could.** A payment is made by the person's
  signer, inside the limits their rules set, or with their yes.
- **It keeps nothing between calls but live sockets,** in memory. No login, call or answer is written.
- **A login ends only when the person ends it.** Its access token carries no expiry. A login ends
  when the person removes its rule, at their signer, which then serves it no more.
- **It checks what it reads from hosts.** The standard's records library checks every record,
  signature included. What an index says is passed on as the index's word, and labelled so.
- **No sign-up and no password.**
- **No address logs in this code.** On Railway, Railway's own request logs exist, with each request's
  client address and path.

## Limits

- **It can act as any connection it carries,** within that connection's rules: it sees each
  ask in plain text and each token passed through it. You trust its operator, the foundation for this
  copy, as far as the limits you set; anyone can run their own
  ([the standard's keys](https://github.com/foundationforest/standard/blob/main/keys/README.md#signers)).
  The AI's maker sees the same, and keeps what it chooses.
- **The AI can still find a profile it posted for:** what it posts is public, and an index lists it.
  What the relay keeps from it is the map of the person's profiles.
- **Nothing acts while Forest is closed** on every one of the person's devices.
- **The AI is not told when the person says yes.** It looks again, or asks again.
- **An answer that comes after 45 seconds is lost,** though what was asked may be done.
- **A login does not expire.** Its access token works for as long as a rule for the connection stays
  in one of the person's profiles' folders. The AI's maker holds it all that time, and whoever takes
  it from them acts as that connection, within its rules, while the person's signer serves it. This
  copy cannot end one token alone: only a new key ends a login here, and it ends every one.
- **A code works more than once in its 60 seconds,** since nothing is kept; only the AI app holding
  the login's PKCE verifier can use it.
- **One replica.** The sockets live in one process; when it restarts, each signer opens again, and
  until it does, nothing acts.
- **What an index says goes unchecked.**
- **The markets are the directory's at one commit.** A market or kind added since is unknown here
  until `MARKETS` moves.
- **A profile its start hosts do not hold is out of reach for reading,** until one of its hosts is
  given.
- **Slow reads.** Each call reads the whole folder from every host, and checks signatures in
  JavaScript.
- **No rate limit.** Anyone can keep the copy busy.
- **Not here:** putting or deleting blobs (photos and videos), buying credits for a host that charges,
  making a profile, views in the AI app (MCP Apps), a post's preview in pictures, and a copy on the
  person's own computer.

## Who decides what

- **The standard:** keys, records, signers, and each profile's rules.
- **The markets directory, at the commit in `MARKETS`:** each market's roles, kinds and fields.
- **The foundation, in this directory:** the tools, what each checks and says, the login, the relay
  protocol and its numbers; and, as it runs the copy, its origin, its connect page, the host and index
  it reads, where it runs, and that it is free.
- **Whoever runs a copy:** the same, for theirs.
- **The person, through their signer:** which AI apps connect, what each may do, on which profiles,
  within which limits and until when; each yes; and removing a rule.
- **The app that signs:** how it asks the person, how it numbers messages, and what it does with a
  payment asked twice.
- **An index, by its own choice:** what its posts, checks and ratings say.
- **The AI's maker:** what it keeps of a conversation, the token included.

## FAQ

**Why does reading need no login?**
So an AI app can read before the person connects anything, and so reading works while logins wait.
An AI app logs in when a call answers 401, and only a relayed tool's call does.

**Why does a login not expire?**
The person's rules already say what a connection may do and until when (a rule's `until`).
An expiry here would only send the person through the connect page again for nothing they chose, and
a refresh token no store can retire would never expire either. Ending a connection is the person's,
at their signer.

**Why is the connection key Ed25519, and not a Baby Jubjub key as a profile's?**
A connection key is no profile's and no service's: it signs a login and a socket's challenge, nothing
any reader checks. Ed25519 is in every browser's Web Crypto and in Node's, so a signer needs nothing
more to make one.

**Why check a body here, when the signer could?**
So a mistake is refused naming the field before the person's device is woken, and an AI fixes it in
one turn. A signer may check again.

**Where is the typed command line, and the copy over stdio?**
Gone: without keys they could only read, which the index's own pages and JSON already do. A copy on
the person's own computer comes later.

**Why are markets read from a checkout, and not from the network?**
So every answer comes from the commit in `MARKETS`, the one the tests ran against, and a market file
changing upstream changes nothing here until the pin moves.

**Why is the deployed copy not checked in CI?**
CI checks only what this repo holds, and a check that cannot reach what it needs would skip, which
fails CI. `npm run smoke` checks a deployed copy by hand, after a deploy.
