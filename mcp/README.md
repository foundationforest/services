# mcp

Part of Forest's services: [the top README](../README.md).

The mcp carries what an AI app asks to the person's Forest app, on one of their own devices, and the
answer back; and it passes on what an index says and what the markets hold.

It is the AI's door to Forest: a connector, a service an AI app adds, over MCP (the Model Context
Protocol, the way AI apps call outside tools). It reaches three places, and nothing more:

- **the index,** whose answers it passes on whole;
- **the markets,** the directory at the commit in `MARKETS`;
- **the person's app,** over the live link the standard's
  [signers/](https://github.com/foundationforest/standard/blob/main/signers/README.md) defines.

The foundation runs one copy, at https://mcp.forest.foundation. Anyone can run another; the main way
is this directory, or its image.

**What it keeps:** nothing of the person's. No seed (the secret all their keys come from), no key,
no permission (what the person lets each AI app ask their app to do), no record, no message. Its own
key, which signs the logins it gives, on its volume. The live sockets from the person's devices, in
memory, gone when it stops.

**What it sees:** each ask and its answer, in plain text. Never a key, and never the person's own
profiles' addresses: the AI names a profile by its label ("write this offer as tutoring/tutor"), the
person's app signs and publishes straight to the hosts, and its answers carry none of the person's
own addresses.

## How it works

```
AI app ── MCP, over HTTPS ──▶ mcp ◀── the live link, a WebSocket ── the person's app ──▶ hosts
                               ├──▶ the index
                               └──▶ the markets, at MARKETS
```

How anyone asks a person's app to act for them is the standard's
[signers/](https://github.com/foundationforest/standard/blob/main/signers/README.md): the asks and
their answers, connecting an AI app, the live link's frames and what each signs, and each profile's
[permissions](https://github.com/foundationforest/standard/blob/main/signers/README.md#permissions).
This copy uses its library, `@foundationforest/signers`, for each: it checks every ask
(`checkAsk`), sends it as its frame (`askFrame`), reads each frame (`readFrame`), passes on only an
answer's known fields (`checkAnswer`), and checks each login and each socket's registration
(`checkLogin`, `checkRegister`). What follows is this copy's own.

### The tools

Five read, with no login:

- `markets`: every market in the markets directory this copy reads, with its roles and what each
  posts.
- `market`: a market's file, as the
  [markets manual](https://github.com/foundationforest/markets/blob/main/build/README.md) defines it,
  with `preview`, the fields a post's preview shows first (the manual's default when the file leaves
  it out), and `kinds`, the kinds of record it defines; and, under `index`, the index's whole answer
  for the market.
- `search`: the index's search. It takes `filters`, an object of text values, and passes them to the
  index as they are; under `index`, the index's whole answer.
- `profile`: any profile, by its address: under `index`, the index's whole answer for it.
- `index`: what the index says about itself: `skill`, its `skill.md`, its guide for AI agents to what
  its answers hold and which filters its search takes; and `home`, its home's JSON (`index.json`). The
  server's instructions say to call it before reading ratings or filtering a search.

**An index's answers pass through whole.** Nothing here names a field or a filter of an index's, so
an index can change what it shows, or another index show other things, and this copy passes it on the
same; the AI learns what each holds from the index itself, through `index`. Each answer comes as
`{ url, word, answer }`: the URL it was read from; `word`, saying it is the index's own, passed on
whole and unchecked; and `answer`, its JSON, or `skill.md`'s text, as the index sent it, never merged
with this copy's own fields. An index that does not answer never hides what the markets gave:
`market` and each half of `index` then give `{ url, word, unread }`, saying why; `search` and
`profile`, which are the index's alone, are refused. The markets come from `../markets`, the
directory at the commit in `MARKETS`, never over the network. This copy reads no host.

Three go to the person's app, and need a login. Each is one of the standard's asks: the tool's name
is the ask, its arguments are the ask's fields, and the standard's check (`checkAsk`) runs before
anything is sent, so an ask that does not fit is refused, saying why, and never reaches the app.

| Tool | The AI gives | What the app does |
|---|---|---|
| `read` | nothing | gives the person's profiles this AI app sees, each by its label, with what it may do there |
| | `label`, `path` | gives the record at that path in the profile's folder |
| | `label`, `inbox: true` | gives the messages to that profile |
| `write` | `label`, `path`, `body` (null removes the record) | writes the record at that path in the profile's folder |
| | `label`, `to`, `body` | sends a message to the profile at `to`; a reply is a write to the address a message came from |
| `pay` | `label`, `to`, `amount`, `currency` | pays `amount` of `currency` to a profile, or to a post's full address |

Each answer is the app's, the tool's result as the app gave it, with only the fields the standard
names for it: `done`, with what the ask returns; `waiting`, with a link and why, when the person
must approve it in their Forest app; `refused`, with why. This copy checks no body against its
market: the person's app does, and its refusal names the field.

What this copy says itself is an error, in plain words: an ask the standard does not take; and, with
no device of the person's keeping the live link open for the connection, "Forest is not open on any
of the person's devices, or it no longer serves this connection: ask them to open Forest on one of
their devices, then try again." An ask with no answer in 45 seconds, or whose socket closes first,
is told it may still be done, and to read before asking again.

An AI app first gets how Forest works, as the server's instructions (`HOW` in `src/tools.ts`): start
with `read` with nothing named, to learn the person's profiles by label and what it may do on each;
name a profile by its label, never an address; read the market before writing to it; `waiting` means
the person must approve in their Forest app, so tell them; and if no device of theirs is open, say
Forest is not open on any of their devices.

### The live link, this copy's side

The standard sets the frames and what each signs. This copy chooses the rest (`src/link.ts`):

- an ask goes to the newest live socket for its connection, once, and never again, so a payment is
  never asked twice; when that socket closes before it answers, the AI is told it may or may not be
  done;
- a registration whose signature does not hold, for this copy's origin and the socket's challenge,
  is refused; a frame that is not one, or one only a connector sends, closes the socket (1008);
- an answer to no ask, or to one that timed out, is dropped;
- its numbers are in How we run it; the live sockets are the only thing it holds between calls, in
  memory.

### The login

Each AI app is its own connection. Its login is the MCP specification's authorization flow, version
2025-11-25, the one AI apps implement today (OAuth 2.1, the web's usual way to let one app act for
you at another, with PKCE, Protected Resource Metadata, and Authorization Server Metadata), with
this copy as both the resource and its own authorization server. It also sends RFC 9207's `iss`,
which the next version asks for. Nothing about a login is stored: each piece below is a body this
copy wrote, in base64url JSON, a dot, then an HMAC-SHA256 of it under this copy's key.

1. **The challenge.** A call to a tool that goes to the person's app, with no token, gets a 401 with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`; a
   token this copy did not give gets the same on any request to its MCP door (`/` or `/mcp`), with
   `error="invalid_token"`.
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
5. **The connect page** is the app's, as signers/ says
   ([Connecting an AI app](https://github.com/foundationforest/standard/blob/main/signers/README.md#connecting-an-ai-app)):
   the person picks which of their profiles this AI app sees, and their app makes the connection,
   writes a permission with `can` empty on each profile picked, signs the request with the
   connection's key, and sends the browser to `/connected`.
6. **`/connected`** checks `request` is this copy's and less than 10 minutes old, then the
   connection's signature on it (`checkLogin`). A login signed by any other key is a page saying so,
   and no code. It sends the browser to the AI app's redirect address with `code`, `state` and
   `iss`; `code` names the connection, the client, the redirect, the challenge and the resource, for
   60 seconds. On a no, the AI app gets `access_denied`.
7. **`/token`** (`grant_type=authorization_code`) checks the code, the client (and its secret, if it
   has one), the redirect, `code_verifier` against the challenge, and `resource`, and gives an
   access token naming the connection, the client and this copy. It carries no expiry, so there is
   no refresh token: the login ends when the person removes its permissions, at any of their
   devices, or their `until` passes, and no device of theirs serves it from its next ask.

Without `APP_URL`, step 4 is a page saying logins wait for the Forest app's connect page, and reading
still works.

### The reference signer

[`test/signer.ts`](test/signer.ts) is what Forest on a person's device does with what this copy
carries, in plain code, with the standard's libraries; the tests and the loop run it. It follows
signers/: it makes connections on the connect page, keeps the live link to each connector its
permissions name, reads each profile's permissions before every ask (`readPermissions`), does what
one covers (`allows`), asks the person about the rest, and leaves the person's own addresses out of
every answer (`leaveOut`). As the app's choice, it also:

- checks a write against its market (`test/market.ts`), each field of its type, for its role, and
  refuses it naming the field;
- asks the person about any profile no permission covers, whether or not the person holds it, so an
  AI cannot map the person's profiles by asking;
- on the person's yes to a write of `profile` under a label they hold no profile under, makes the
  profile: its hosts record, and its profile record with its market and role, inbox key, inbox and
  pay addresses, and a stamp proof for each stamp the device holds; for a profile that exists, it
  keeps those fields and takes only the market's own from the write, none in the markets today;
- refuses a write of the hosts record or a permission, and a read of a permission, which holds
  another connection's key: the person does those in their Forest app;
- on money: the same `to` and amount asked again within an hour is done and pays nothing; any other
  payment for what it paid already waits for the person's yes; a review of a post the profile paid
  gets that payment as its evidence, and a review naming evidence is refused; it pays in USD only,
  from the profile's Solana pay address to the one the other profile signed, and keeps its payments
  in memory, on the device that paid.

### Run it

```sh
./standard.sh                      # from the repo root: the standard, built, and the markets
(cd host && npm ci)                # this repo's host, which the tests run
cd mcp && npm ci                   # the standard's packages by name, linked into standard/
npm run check                      # type-check
npm test                           # everything below, on loopback
DATA_DIR=./data PUBLIC_URL=http://127.0.0.1:8080 npm start
npm run smoke -- https://mcp.forest.foundation
```

Node 22.18 or later. Built from existing pieces, used unchanged: the standard's records and signers
packages (`@foundationforest/records`, `@foundationforest/signers`, through file: links into
`standard/`); `@modelcontextprotocol/sdk`, for the MCP door; `ws`, for the live link; Node's
`crypto`, for HMAC. The reference signer also uses the standard's keys and stamp clients, and `ajv`
and `ajv-formats` for its market check, the versions the markets directory's own check uses.

| Variable | What it sets | Unless set |
|---|---|---|
| `DATA_DIR` | Where its key is kept: `mcp-key.json`, 32 random bytes made at the first start, readable by its own user only | needed |
| `PUBLIC_URL` | Its origin: the resource, the authorization server, and the connector in a person's permissions | https://mcp.forest.foundation |
| `APP_URL` | The app's connect page | none: logins wait |
| `INDEX_URL` | The index whose answers it passes on: its `skill.md` and home, its search, and its answer for each market and profile | https://index.forest.foundation |
| `PORT`, `BIND` | Where it listens | 8080, 127.0.0.1 |

The tests run this repo's host (its plug); a stand-in index serving its `skill.md` and four answers
in the index's JSON as it is now, each with `badge`, a field this copy has never seen, and a search
that answers with the filters it got; a stand-in connect page; and the reference signer, holding a
person's seed with three profiles. A login writes a permission with `can` empty into the folders of
their two tutoring profiles; then the person allows reading, writing and paying $50 a day on each:

- `test/login.test.ts`: reading with no login; the challenge and the metadata; the login end to end
  through the MCP SDK's own client, by registration and by a client document; each login its own
  connection, in a permission of its own; a login ending when the person removes its permissions;
  refused: a login signed by a key that is not the connection's, a login changed on the way, an
  unknown AI app, a person who says no, a code with the wrong verifier or for another client, a
  token this copy did not give; with no `APP_URL`, reading works and logins wait.
- `test/tools.test.ts`: each of the eight tools. The five reads, each of the index's answers whole,
  `badge` in it, and the filters given reaching the index as they are, `badge` among them; a filter
  that is not text refused; a profile the index has nothing for refused; and no file in `src/`
  reading a host, or naming a field or filter of the index's, as its `skill.md` gives them today,
  quoted, read as a property, written as a key or put in a query (those that are also this copy's
  own words or the markets' are left out, since the test could not tell them apart). The connect
  step's permission in each picked folder, encrypted to that profile alone, the connection's key
  inside, `can` empty, and none in the third; with `can` empty, a write waiting, then done after
  the yes. `read` with nothing named, before and after the person allows more. Another device on
  the same seed serving the login from the permissions. Inside them, done without asking; outside
  them, waiting, and a label the person has no profile under waiting the same and refused on the
  yes. The standard's refusals from this copy, before anything reaches the app; the app's own: a
  kind the market does not define, a field that does not fit, a role the market lacks, the hosts
  record, a permission, a read of a permission. A write of the profile record asking the person and
  keeping the app's fields; a new profile made on the yes, its stamp proof checking. A remove, a
  message, the inbox with a message from another of the person's own profiles shown by its label,
  a reply. `pay` answering only done; past the student's limit, waiting, while the tutor's limit
  counts on its own; a currency the app does not pay in refused; the same pay again within the
  hour, nothing paid; another payment for a post already paid, and the same one an hour on,
  waiting, and a yes given twice pays once; a permission with no limit, any amount, done. A review
  of a paid post carrying the app's evidence, and none for a post the profile never paid. A
  permission removed on the other device gone at the next ask, and with none left the login ended.
  With no app open, said plainly; and no answer in this file holds one of the person's addresses
  (each profile's, each pay address).
- `test/link.test.ts`, with an app made by hand: a registration by another key, or for another
  connector, refused; a frame that is not JSON, or one only a connector sends, closing the socket;
  each ask as the standard's frame; only an answer's known fields passed on; a waiting link that is
  not https refused; a pay to no address never sent; a socket closing mid-ask said plainly; and
  nothing kept between calls but live sockets: a token one copy gave works on another copy of the
  same service with no store, no socket is left once the app closes, and the data directory holds
  only the key.
- `test/smoke.test.ts` reads the command and working directory from `deploy/Dockerfile`, runs them
  here, and connects with the MCP SDK's own client (`smoke.ts`): how Forest works first, as the
  server's instructions, the mark as its icon, no session, every tool, reading with no login, the
  challenge and the metadata, registration, `/authorize` on to the connect page, the same tools at
  `/mcp`, the icon's two files, a login through the stand-in page, and the answer with no app open;
  `//` answered 400 while it goes on answering; with no `APP_URL`, logins wait; with no `DATA_DIR`,
  it refuses to start. `npm run smoke` runs the same client against a deployed copy, without the
  login, which needs a person.

## How we run it

The foundation's copy, at https://mcp.forest.foundation:

- **The image.** `deploy/Dockerfile`: Node 22.22.2, the standard at `STANDARD` and the markets at
  `MARKETS` (`standard.sh`), and this directory, started as `node src/main.ts` on every address
  (`BIND=0.0.0.0`), with `DATA_DIR=/data`.
- **Where it runs:** Railway, service `mcp`: this repo,
  `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`, one replica, a volume at `/data`, a public domain
  to the port in `PORT`, WebSockets through Railway's proxy, and no health check (the root answers
  only what an MCP client sends). `APP_URL` is unset until the Forest app's connect page exists;
  until then reading works and logins wait.
- **Its connect page:** this copy sends logins to the Forest app's page; another app runs its own
  copy, with its own page.
- **What it reads:** the foundation's index, whose answers it passes on whole, and the markets from
  the directory at `MARKETS`. No host.
- **The tools.** All eight, over Streamable HTTP at its root, and at `/mcp` for connectors added
  before. An AI app first gets how Forest works, as the server's instructions (`HOW` in
  `src/tools.ts`).
- **Its numbers, and why:**
  - 45 seconds for an app's answer: under the 60 seconds the MCP SDK's client waits by default, so
    the AI hears these words, not a bare timeout;
  - a ping every 30 seconds, and a socket with no pong by the next one closed: under the 60 seconds
    many proxies let a quiet connection live, and a phone that slept is noticed within a minute;
  - 30 seconds for a new socket to register its first connection, and at most 100 connections on one
    socket;
  - 10 minutes on the connect page, to unlock the device and choose; 60 seconds for a code, which
    the AI app redeems at once; no end for a login, which lasts until the person ends it;
  - at most 4,194,304 bytes for an MCP request, a frame from an app, or an index's answer; the
    records library's 60 seconds for a read of the index.
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

Payments are the person's app's. The index sees this copy's network address, not the person's.

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

- **It holds nothing of the person's.** No seed, no key, no permission; it never receives the
  person's own profiles' addresses, keys or folders.
- **It acts only through the person's app,** which acts by the person's permissions and asks them
  about the rest, so whoever runs it can do no more than the connections it carries may. It signs
  nothing for anyone.
- **It never moves money itself, and holds nothing that could.** A payment is made by the person's
  app, inside the limits their permissions set, or with their yes.
- **It keeps nothing between calls but live sockets,** in memory. No login, call or answer is written.
- **A login ends only when the person ends it, or when this copy's key changes.** Its access token
  carries no expiry. A login ends when the person removes its permissions, in their app, or a
  permission's `until` passes, and their app then serves it no more; a new key here ends every login
  at once.
- **What an index says is passed on as the index's word,** whole, and labelled so.
- **No sign-up and no password.**
- **No address logs in this code.** On Railway, Railway's own request logs exist, with each request's
  client address and path.

## Limits

- **It can act as any connection it carries,** within that connection's permissions: it sees each
  ask in plain text and each token passed through it. You trust its operator, the foundation for this
  copy, as far as the limits you set; anyone can run their own
  ([signers/](https://github.com/foundationforest/standard/blob/main/signers/README.md#limits)). The
  AI's maker sees the same, and keeps what it chooses.
- **The AI can still find a profile it posted for:** what it posts is public, and an index lists it.
  What this copy keeps from it is the map of the person's profiles.
- **Nothing acts while Forest is closed** on every one of the person's devices.
- **The AI is not told when the person says yes.** It reads again, or asks again.
- **An answer that comes after 45 seconds is lost,** though what was asked may be done.
- **A write that does not fit its market reaches the person's device,** which refuses it: this copy
  checks no body.
- **A login does not expire.** Its access token works for as long as a permission for the connection
  stays in one of the person's profiles' folders and has not ended. The AI's maker holds it all that
  time, and whoever takes it from them acts as that connection, within its permissions, while the
  person's app serves it. This copy cannot end one token alone: only a new key ends a login here,
  and it ends every one.
- **A code works more than once in its 60 seconds,** since nothing is kept; only the AI app holding
  the login's PKCE verifier can use it.
- **One replica.** The sockets live in one process; when it restarts, each of the person's devices
  opens again, and until it does, nothing acts.
- **The markets are the directory's at one commit.** A market or kind added since is unknown here
  until `MARKETS` moves.
- **A profile the index does not show is out of reach for reading:** this copy reads no host.
- **An index's answer may hold a profile's inbox key and more,** since nothing here picks from it.
- **No rate limit.** Anyone can keep the copy busy.
- **Not here:** putting or deleting blobs (photos and videos), buying credits (a host's prepaid
  units of writes) for a host that charges, views in the AI app (MCP Apps), a post's preview in
  pictures, and a copy on the person's own computer.

## Who decides what

- **The standard:** keys, records, and signers/: the asks and their answers, the connect step, the
  live link's frames, and each profile's permissions.
- **The markets directory, at the commit in `MARKETS`:** each market's roles, kinds and fields.
- **The foundation, in this directory:** the tools and what each says, the login, its side of the
  live link and its numbers; and, as it runs the copy, its origin, its connect page, the index it
  reads, where it runs, and that it is free.
- **Whoever runs a copy:** the same, for theirs.
- **The person, through their app:** which AI apps connect, which of their profiles each sees, what
  each may do there, within which limits and until when; each yes; and removing a permission.
- **The person's app:** how it asks the person, what it checks before it writes, and what it does
  with a payment asked twice.
- **An index, by its own choice:** what its answers hold, and which filters its search takes.
- **The AI's maker:** what it keeps of a conversation, the token included.

## FAQ

**Why does reading need no login?**
So an AI app can read before the person connects anything, and so reading works while logins wait.
An AI app logs in when a call answers 401, and with no token, only a call to a tool that goes to the
person's app does.

**Why does a login not expire?**
The person's permissions already say what a connection may do and until when (a permission's
`until`). An expiry here would only send the person through the connect page again for nothing they
chose, and a refresh token no store can retire would never expire either. Ending a connection is the
person's, in their app.

**Why does the person's app check a body, and not this copy?**
Only the app knows which profile a label is, what that profile may write, and what it paid, and it
must check whatever reaches it, from this copy or from any other connector. A check here would be a
second copy of what the market says, which the app could not rely on.

**Why does this copy read no host?**
What a stranger's profile shows, an index has read and checked already, and gives whole; what the
person's own profiles hold, their app reads for them. Reading hosts here meant following any
stranger's hosts record and checking every signature again, on every call.

**Where is the typed command line, and the copy over stdio?**
Gone: without keys they could only read, which the index's own pages and JSON already do. A copy on
the person's own computer comes later.

**Why are markets read from a checkout, and not from the network?**
So every answer comes from the commit in `MARKETS`, the one the tests ran against, and a market file
changing upstream changes nothing here until the pin moves.

**Why is the deployed copy not checked in CI?**
CI checks only what this repo holds, and a check that cannot reach what it needs would skip, which
fails CI. `npm run smoke` checks a deployed copy by hand, after a deploy.
