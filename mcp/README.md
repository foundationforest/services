# mcp

Part of Forest's services: [the top README](../README.md).

The mcp lets an AI app act for a person in Forest: it reads the markets, passes on what an index
says, and acts in the person's own profiles with the access keys their app keeps for it.

It is a connector, a service an AI app adds, over MCP (the Model Context Protocol, the way AI apps
call outside tools). It reaches three places, and nothing more:

- **the index,** whose search and pages it passes on whole;
- **the markets,** the directory at the commit in `MARKETS`;
- **the person's own folders,** on their hosts: the AI app's connection folder, where the person's
  app keeps its access keys, and the profiles' folders it acts in with them.

The foundation runs one copy, at https://mcp.forest.foundation. Anyone can run another; the main way
is this directory, or its image.

**What it keeps:** nothing of the person's between calls. No seed (the secret all their keys come
from), no main key, ever. The access keys the person's app hands it wait in the AI app's connection
folder, locked to this copy's open key, and are read and opened in memory for one call and
forgotten; the AI app's access token carries only where that folder is, still locked. On its
volume: its own two keys, one that signs its logins and one whose opening half opens connections.

**What it sees:** during a call, the connection, the access key and the address of each profile the
login acts in, and what it reads and writes there. The AI sees none of them: it names a profile by
its label ("write this offer as tutoring/tutor"), and no answer of a tool that acts for the person
holds one of the person's own addresses.

## How it works

```
AI app ── MCP, over HTTPS ──▶ mcp ──▶ the index: its guide, its search, its profile pages
                               ├──▶ the markets, at MARKETS
                               └──▶ the person's folders, on their hosts, with the connection's access keys
```

What an access key is, and what it can do, is the standard's
([folders](https://github.com/foundationforest/standard/blob/main/folders/README.md#access-keys)):
each profile entry lists the access keys it hands out, each with what it `can` do (`read`,
`read-inbox`, `write`, `message`), and every host and reader checks that. This copy signs with those
keys and reads what they open, using the standard's libraries, `@foundationforest/keys` and
`@foundationforest/folders`, unchanged. What follows is this copy's own.

### The tools

Six, each with a title and the MCP specification's hints, so an AI app groups them. Two read with
no login; four act for the person and need one.

| Tool | Marked | The AI gives | What it does |
|---|---|---|---|
| `markets` | read-only | `name`, or nothing | With no name, every market in the directory, with its roles and what each posts. With a name, that market's file, as the [markets manual](https://github.com/foundationforest/markets/blob/main/build/README.md) defines it, with `preview`, the fields a post's preview shows first (the manual's default when the file leaves it out), and `kinds`, the kinds of entry it defines, each with its fields |
| `search` | read-only | `filters`, or `address` | The index's search, its `filters` (each a text value) passed to it as they are; or, given a profile's address, that profile's page at the index |
| `my_profiles` | read-only | nothing | From the connection: each profile the login acts in, by its label, with what its access key `can` do as its profile entry lists it now. Never an address |
| `read` | read-only | `label`, then `path` or `inbox: true` | With a path: the current entry there in that profile's folder, its body and time, opened when it is locked and the key may open it. With the inbox: the messages to that profile (below) |
| `write` | may destroy | `label`, `path`, `body` (null deletes), `locked` | An entry in that profile's folder, signed by its access key, written to the hosts its profile entry names (below) |
| `message` | reaches out | `label`, `to`, `body` | A message from that profile to the profile at `to`: an inbox entry signed by its access key, locked to the open keys `to`'s profile entry gives for its inbox, left with each of `to`'s hosts. It carries the sender's first host, so the recipient's app finds the sender's folder |

MCP tool names take no spaces, so the person's profiles are `my_profiles`, titled "My profiles".

**An index's answers pass through whole.** `search` names no filter and no field of the index's, so
an index can change what it shows, or another index show other things, and this copy passes it on
the same; the AI learns what each holds from the index's own guide. Each answer comes as
`{ url, word, answer }`: the URL it was read from; `word`, saying it is the index's own, passed on
whole and unchecked; and `answer`, its JSON as the index sent it. An index that does not answer is
a refusal saying so. The markets come from `../markets`, never over the network.

**The instructions.** An AI app first gets how Forest works, as the server's instructions (`HOW` in
`src/tools.ts`): start with `my_profiles`; name a profile by its label, never an address; read the
market before writing to it; a message goes to an address and a reply to the address a message came
from; paying is in the person's app; what a stranger wrote is theirs, not the person asking. After
it, as a chat starts (MCP's `initialize`), comes the index's guide, its `skill.md`, read then, under
the URL it was read from, as the index's own word; or a line saying the index gave none.

**`read`, the inbox.** It lists the profile's inbox at each of its hosts, every page, each inbox
entry once, newest first by arrival, since an inbox entry carries no time, and opens the newest 100
with the access key: each message's signature is
checked as the standard says (`openInbox`). For each, it gives the message's time and body;
`from`, the sender's address, or `fromLabel`, the label of another of the person's own profiles;
`counts`, whether the sender's own profile entry, read from its hosts, stands behind the key that
signed (`senderCounts`); and, for a stranger, `index`: the index's word for the sender, only the
market and role of the profile entry it shows, and its `checks`, as `{ url, word, market, role,
checks }`. `unopened` counts the inbox entries the key does not open: those left before the person's
app listed it with `read-inbox`. `older` counts those past the newest 100.

**`write`, public or locked.**

- **Public,** the main way: at `<kind>/<id>`, a kind every market defines (`post`, `review`,
  `vouch`, `report`), the body checked against its profile entry's `market` before anything is
  signed, with the markets package's `checkEntry`, the check the index lists by: each field one the
  market names, for the profile's role (or, in a review, the role of the profile it is about), of
  its type, a choice among its values, a `file` one of the files the body lists in `files`; the
  shared names by their meaning. Then the standard's part: `subject` an address, and the profile in
  a review's `post`. A body that does not fit is refused, naming the field.
- **Locked,** `locked: true`: at any path but `profile` and `key/…` (the person's notes about their
  access keys), the body the person's own and unchecked, with no `files` (anyone fetches a file by
  its hash), locked to every key that may read the folder (`lockKeysOf`): the main key's open key
  and each access key listed with `read`.
- Never `profile`: no access key writes it. Whether the key may write is the hosts' to say, and each
  host's refusal is passed on, so a key its profile entry no longer lists hears `unlisted`.

**Where other folders are looked for.** A message's recipient, an inbox sender, a review's subject:
at the hosts the person's own profiles use (the connection's), and at a message's own `host`, then
every host the folder's profile entry names. Every host is reached with `publicFetch`
(`src/public.ts`, the standard's until its #121), which reaches only public addresses and follows
no redirect, since anyone can make a connection and any profile entry names any host.

**The person's own addresses.** In every answer of the four tools that act for the person, each
address of a profile in the connection becomes its label, and each pay address of a profile entry
the call read becomes `<label>'s <type> pay address`, wherever it appears in a text.

What this copy says itself is a refusal, in plain words: an argument that does not fit; a label the
login does not act in; a path that is none; a body that does not fit, naming the field; a host that
took nothing, naming each host's reason.

### The login

Each AI app logs in on its own. Its login is the MCP specification's authorization flow, version
2025-11-25, the one AI apps implement today (OAuth 2.1, the web's usual way to let one app act for
you at another, with PKCE, Protected Resource Metadata, and Authorization Server Metadata), with
this copy as both the resource and its own authorization server. It also sends RFC 9207's `iss`,
which the next version asks for. Nothing about a login is stored: each piece below is a body this
copy wrote, in base64url JSON, a dot, then an HMAC-SHA256 of it under this copy's key.

1. **The challenge.** A call to a tool that acts for the person, with no token, gets a 401 with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`; a
   token this copy did not give, or one from before connections, gets the same on any request to
   MCP (`/` or `/mcp`), with `error="invalid_token"`; and so, on a call that acts for the person,
   does a token whose connection is gone, or whose pointer no longer opens once this copy's opening
   half changed ([The connection](#the-connection)).
2. **Discovery.** `/.well-known/oauth-protected-resource` names this copy as the resource and its
   authorization server; `/.well-known/oauth-authorization-server` names `/authorize`, `/token` and
   `/register`, S256, and that client documents work.
3. **The AI app.** It registers one of two ways, and nothing is kept for either:
   - by a client document (CIMD): its `client_id` is an https address with a path, read with the
     `publicFetch` (10 seconds, 64 KB) each time a login starts; it must name itself as its
     `client_id` and list the redirect address;
   - by registration (DCR, `POST /register`): its `client_id` is a body holding its redirect addresses
     (1 to 8), its name and how it signs in at `/token`. Unless it registers as public (`none`), it
     gets a client secret, HMAC(key, client_id), checked at `/token`: a secret is RFC 7591's default.
4. **`/authorize`** checks the client and its redirect address (a bad one is a page, never a
   redirect), `response_type=code`, an S256 `code_challenge`, and `resource` if given; then it sends
   the person's browser to the app's connect page: `APP_URL?connector=<origin>&request=<request>`.
   `request` is base64url of `{ client, name, redirect, challenge, state?, resource, exp }`, a dot,
   then its MAC; `exp` is 10 minutes ahead, and `name` is the AI app's, for the page to show.
5. **The connect page** is the app's. It shows the person the AI app's name and the connector's
   origin, and the person ticks the profiles the AI app acts in, and what it may do there. On their
   yes, the app does what [The connection](#the-connection) says, and sends the browser back to
   `<origin>/connected?request=<request>&pointer=<pointer>`; on a no, to
   `<origin>/connected?request=<request>&error=access_denied`.
6. **`/connected`** checks `request` is this copy's and less than 10 minutes old, then opens the
   pointer with this copy's identity and checks it: its shape, and that it names this request. A
   pointer that does not open, is not one, or is for another login is a page saying so, and no code.
   It sends the browser to the AI app's redirect address with `code`, `state` and `iss`; `code`
   carries the pointer, still locked, with the client, the redirect, the challenge and the
   resource, for 60 seconds. On a no, the AI app gets `access_denied`.
7. **`/token`** (`grant_type=authorization_code`) checks the code, the client (and its secret, if it
   has one), the redirect, `code_verifier` against the challenge, and `resource`, and gives an
   access token carrying the pointer, still locked, the client and this copy. It carries no expiry,
   so there is no refresh token: what it can do ends when the person ends the connection in their
   app. A profile added to the connection needs no new login.

Without `APP_URL`, step 4 is a page saying logins wait for the Forest app's connect page, and reading
still works.

### The connection

The connection is this service's own format, which an app follows to hand this copy access keys: a
folder of the person's for each AI app, and a pointer to it, which the AI app's token carries.

**This copy's open key** is at `GET <origin>/open-key`: `{ "openKey": "age1pq1…" }`, the open key of
this copy's opening half, an age post-quantum key, readable from any page
(`access-control-allow-origin: *`). It stays the same while the volume keeps `mcp-opening.json`.

**The connection folder** is an ordinary folder on the person's hosts, named by a key the app makes
at random (keys/'s `newAccessKey()`, listed nowhere), so its name says nothing and links nothing.
Its profile entry holds only `hosts`; each other entry is locked, with folders/locked's `lock`, to
the folder's own open key and this copy's, and no other:

- `connection`: `{ name: <the AI app's name>, secret: <32 random bytes, base64url> }`;
- `access/<id>`, a random id, one a profile: `{ label, address, hosts, key: <its access key's 64
  bytes, base64url> }`.

**Each access key** the app makes with `newAccessKey()`, lists in the profile entry as `{ key, open,
can }`, with the switches the person chose (all four unless fewer, never more; `open` only with
`read` or `read-inbox`), and notes at `key/<id>`, locked to the main key alone, `{ key, connection,
… }`: `connection`, the folder's key in base64url, lets any of the person's devices find it from the
seed. The rest is the app's (the reference app's: the AI app's name, this copy's origin, the time).

**The pointer,** what the app hands `/connected`, is an envelope's text, locked to this copy's open
key alone, at most 4,096 characters: exactly `{ request: <SHA-256 of the request text, in lowercase
hex>, folder: <the folder's address>, hosts: <its 1 to 8>, secret: <the connection entry's> }`.

**Each call that acts for the person** opens the pointer, reads the folder from its hosts, opens
`connection` and checks that its secret is the pointer's, then opens each `access/` entry and acts
with their keys, keeping none after the call. No `connection` entry, one that does not open, or
another secret: a 401, a login to make again. An access entry that does not open or fit, or names a
profile already named, counts for nothing. **Adding a profile** is one more key and access entry;
**removing one** takes its key out of its profile entry, with its access entry and note; **ending**
deletes `connection`, then removes each key. None needs a new login.

### The reference app

[`test/app.ts`](test/app.ts) is what the person's app does around this copy, in plain code, with the
standard's libraries; the tests and the loop run it. It keeps the person's Profiles folder, the
empty label's, its `label/<id>` and `stamp/<id>` entries at random ids, locked to its own open key;
makes a profile, its profile entry with market, role, hosts, open key, both pay addresses, and a
verification for each stamp it keeps; does the connect page's work above, the connection folder's
first write paid as the device chooses (`pay`); from the seed alone, finds each connection by its
notes, adds a profile to it or ends it, and removes a key with its access entry and note; and, on a
new device, finds the person's profiles and stamps by opening every entry the Profiles folder holds.

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

Node 22.18 or later. Built from existing pieces, used unchanged: the standard's keys and folders
packages (`@foundationforest/keys`, `@foundationforest/folders`, through file: links into
`standard/`); the markets package (`@foundationforest/markets`, through a file: link into
`markets/build`), for the markets and their one check; `@modelcontextprotocol/sdk`, for MCP; `undici`,
for `publicFetch`; Node's `crypto`, for HMAC and SHA-256. The reference app also uses the standard's
proofs package.

| Variable | What it sets | Unless set |
|---|---|---|
| `DATA_DIR` | Where its two keys are kept: `mcp-key.json`, which signs its logins, and `mcp-opening.json`, its opening half's secret; 32 random bytes each, made at the first start, readable by its own user only | needed |
| `PUBLIC_URL` | Its origin: the resource and the authorization server | https://mcp.forest.foundation |
| `APP_URL` | The app's connect page | none: logins wait |
| `INDEX_URL` | The index whose answers it passes on: its `skill.md`, its search, and its page for each profile | https://index.forest.foundation |
| `PORT`, `BIND` | Where it listens | 8080, 127.0.0.1 |

The tests run this repo's host (its plug); a stand-in index serving its `skill.md`, its home, a
search that answers with the filters it got, and a stranger's page, each with `badge`, a field this
copy has never seen; a stand-in connect page running the reference app; and the person, with three
profiles, the page ticking their two tutoring ones:

- `test/login.test.ts`: reading with no login; the challenge for each of the four tools that act for
  the person, and the metadata; the open key, the same after a restart; the login end to end
  through the MCP SDK's own client, by registration and by a client document: the connection
  folder, each entry locked to two keys, a token holding only the pointer, a key in each profile
  ticked, its note; fewer switches. With no new login: a profile added from another device and acted
  in, one removed, the connection ended and its next call a 401. Refused: a pointer locked to
  another key, for another login (with its own, taken), not one or too long; a login changed on the
  way, a no, a code with the wrong verifier or client; a 401 for a pointer naming the person's folder
  with a secret of its own, or a folder with no connection, a token this copy did not give, one from
  before connections, one whose pointer no longer opens; an access entry that does not open or fit,
  counted for nothing; hosts that do not answer, a refusal; with no `APP_URL`, logins wait. Nothing
  kept: a token works on another copy with the same two keys, the data directory holds only them.
- `test/tools.test.ts`: the six tools and their marks; the instructions, then the index's guide, or
  a line saying it gave none; the markets; the index's search and a profile's page, each whole,
  `badge` in it and among the filters; `my_profiles`, the switches as listed; `read` of the profile
  entry with its pay addresses by label, of a missing path, of a locked entry opened and of one
  locked before the login, not opened; `write` of a post signed by the access key, and each refusal
  naming its field or why; a review naming its post; a delete; a locked entry at any path, opened
  by the main key and the access key, and refused at `key/…`, at `profile`, with files; the inbox, a
  stranger's message with its sender counted and the index's word, one from before the login
  unopened, one from another of the person's profiles by its label, one signed by a key its sender
  does not list, not counted; `message` to a stranger, who opens it, signed by the access key; a
  login with `write` alone, a file field named in `files` and not, and no message; then the key out
  of its profile entry, the host refusing its next write as `unlisted` and what it wrote no longer
  current, then removed by the app with its note and access entry; and no answer in the file
  holding one of the person's addresses.
- `test/public.test.ts`: `publicFetch`, the standard's own tests of it: every range that is not
  public refused, written in the URL or reached through a name, before anything is sent, and no
  redirect followed, even when asked.
- `test/smoke.test.ts` reads the command and working directory from `deploy/Dockerfile`, runs them
  here, and connects with the MCP SDK's own client (`smoke.ts`): how Forest works first, as the
  server's instructions, the mark as its icon, no session, every tool, reading with no login, the
  challenge and the metadata, the open key, registration, `/authorize` on to the connect page, the
  same tools at `/mcp`, the icon's two files, a login through the stand-in page, and `my_profiles`,
  saying it did not reach the connection, on a loopback host `publicFetch` refuses;
  `//` answered 400 while it goes on answering; with no `APP_URL`, logins wait; with no `DATA_DIR`,
  it refuses to start. `npm run smoke` runs the same client against a deployed copy, without the
  login, which needs a person.

## How we run it

The foundation's copy, at https://mcp.forest.foundation:

- **The image.** `deploy/Dockerfile`: Node 22.22.2, the standard at `STANDARD` and the markets at
  `MARKETS` (`standard.sh`), and this directory, started as `node src/main.ts` on every address
  (`BIND=0.0.0.0`), with `DATA_DIR=/data`.
- **Where it runs:** Railway, service `mcp`: this repo,
  `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`, one replica, a volume at `/data` holding its two
  keys, a public domain to the port in `PORT`, and no health check (the root answers only what an
  MCP client sends). `APP_URL` is unset until the Forest app's connect page exists; until then
  reading works and logins wait.
- **Its connect page:** this copy sends logins to the Forest app's page; another app runs its own
  copy, with its own page.
- **What it reads:** the foundation's index, whose answers it passes on, the markets from the
  directory at `MARKETS`, and the connection folder each login points to, the folders of the
  profiles it acts in, and of those they deal with, on public hosts only.
- **The tools.** All six, over Streamable HTTP at its root, and at `/mcp` for connectors added
  before.
- **Its numbers, and why:**
  - 10 minutes on the connect page, to unlock the device and choose; 60 seconds for a code, which
    the AI app redeems at once; no end for a login, which does what its access keys may until the
    person ends its connection;
  - at most 4,096 characters for a pointer, one envelope to one key holding up to 8 hosts, so the
    access token, which carries it, stays well under the 16 KB of headers Node takes; no limit on
    the profiles a connection holds, one entry each;
  - the newest 100 inbox entries a read opens: each takes a post-quantum opening, and anyone can
    leave entries in an inbox;
  - 10 seconds for the index's guide as a chat starts, so a slow index does not hold the chat; 60
    seconds for any other read of the index, and the folders client's 60 for a host;
  - at most 4,194,304 bytes for an MCP request or an index's answer.
- **Free:** no price.
- **Keeps nothing of anyone's:** its two keys on the volume; no call, token, connection or answer
  is written.
- **Logs no call:** it writes one line when it starts, and nothing for a request.
- **No rate limit.**
- **The icon.** The mark on paper: ink `#121A15` on paper `#EDEAE0`, three chevrons
  (`8,12 20,3 32,12`, `8,22 20,13 32,22` and `8,32 20,23 32,32`) and a trunk (`20,24` to `20,38`),
  stroke 4, in a 56-unit square with 8 of margin. The server's info declares it as an SVG; the copy
  serves it at `/icon.svg`, and at `/favicon.ico` as an ICO of 16, 32, 48 and 64 pixels. `src/icon.ts`
  draws both from the mark's strokes.

Payments are the person's app's. The index and the hosts see this copy's network address, not the
person's.

### Connect an AI app

The address is `https://mcp.forest.foundation`. Reading works at once; the first time the AI acts, the
AI app sends the person to log in, and the Forest app's connect page hands over the access keys. A
connector added before, at that address or at `/mcp`, keeps working, and logs in again the first time
it acts.

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

- **It holds no key between calls.** No seed and no main key, ever. The access keys the person's app
  hands it wait in the connection folder, locked to its open key; it reads and opens them for one
  call and forgets them.
- **It acts only as far as the access keys a connection holds may,** and every host and reader
  checks that against the profile entry's listing: the person removes a key, and what it does stops
  counting.
- **A connection folder's address acts for no one:** a call counts only when its token's secret
  matches the one in the folder's connection entry.
- **It never moves money, and holds nothing that could.** No access key pays; payments are the
  person's app's.
- **It keeps nothing between calls.** No login, call, connection or answer is written.
- **The AI never gets a key, nor one of the person's own addresses,** from a tool that acts for
  them: it names each profile by its label.
- **What an index says is passed on as the index's word, whole, and labelled so;** `read` picks only
  a sender's market, role and checks from it, labelled the same.
- **No sign-up and no password.**
- **No address logs in this code.** On Railway, Railway's own request logs exist, with each request's
  client address and path.

## Limits

- **Its operator can act as any connection its logins point to,** within the switches of its
  access keys: it opens each connection for a call, and could keep the keys. You trust the
  operator, the foundation for this copy, as far as the switches you hand out; anyone can run their
  own. The AI's maker sees what the AI does, and keeps what it chooses.
- **A login does not expire.** Its token points to the connection for as long as the AI's maker
  keeps it, and whoever takes it acts within the keys' switches until the person ends the
  connection in their app.
- **A key opens nothing locked before it was listed:** messages left, and locked entries written,
  before the person's app listed it.
- **A stranger's folder is found only on the hosts the person's profiles use,** or a message's own
  host. A profile whose folder lives only elsewhere can be read about through the index, not
  messaged.
- **The newest 100 inbox entries** a read; older ones wait for the newest to leave their hosts, after
  each host's keep days.
- **Each call reads the connection from its hosts,** with a post-quantum opening for each profile:
  many profiles make each call slower, and when none of the hosts answers, the tools that act refuse.
- **A connection folder is public, like any folder:** anyone can see it exists and how many profiles
  it holds, never which.
- **The AI can still find a profile it posted for:** what it posts is public, and an index lists it.
  What this copy keeps from it is the map of the person's profiles.
- **A code works more than once in its 60 seconds,** since nothing is kept; only the AI app holding
  the login's PKCE verifier can use it.
- **The markets are the directory's at one commit.** A market or kind added since is unknown here
  until `MARKETS` moves.
- **An index's answer may hold anything,** since `search` picks nothing from it.
- **No rate limit.** Anyone can keep the copy busy.
- **Not here:** paying, putting or deleting files (photos and videos), buying credits (a host's
  prepaid units of writes) for a host that charges, views in the AI app (MCP Apps), and a copy on
  the person's own computer.

## Who decides what

- **The standard:** keys and access keys, entries and what each access key can do, locked entries
  and the inbox, files, and the profile entry.
- **The markets directory, at the commit in `MARKETS`:** each market's roles, kinds and fields.
- **The foundation, in this directory:** the tools and what each says, the login, the connection's
  format, and its numbers; and, as it runs the copy, its origin, its connect page, the index it
  reads, where it runs, and that it is free.
- **Whoever runs a copy:** the same, for theirs.
- **The person, through their app:** which AI apps connect, which of their profiles each acts in,
  adding and removing one, what each access key can do there, and ending a connection.
- **The person's app:** how it asks the person, what its notes say, and which switches it offers.
- **An index, by its own choice:** what its answers hold, and which filters its search takes.
- **The AI's maker:** what it keeps of a conversation, the token included.

## FAQ

**Why does reading need no login?**
So an AI app can read before the person connects anything, and so reading works while logins wait.
An AI app logs in when a call answers 401, and with no token, only a call to a tool that acts for
the person does.

**Why does a login not expire?**
The person's profile entries already say which access keys count and what each may do. An expiry
here would only send the person through the connect page again for nothing they chose, and a
refresh token no store can retire would never expire either. Ending a connection is the person's,
in their app.

**Why does the pointer name its login request?**
The pointer comes back through the person's browser, in a URL a history or a proxy's log may keep.
Anyone holding it could start a login of their own and hand it to `/connected`. Naming the request,
which carries the AI app's PKCE challenge and lasts 10 minutes, makes the pointer open that one
login only.

**Why a secret, when the connection entry is locked to this copy?**
This copy's open key is public: anyone can lock a pointer naming someone's connection folder, in a
login of their own. Only the app that wrote the entry knows the secret in it.

**Why does this copy check a public body against its market, and not the person's app?**
This copy signs it, with the access key, so this copy is the last to see it before the hosts do. The
check is the markets package's, the one the index runs before it lists a post, so a body refused
here would not be listed.
A locked body is the person's own, and no market defines it.

**Why does `write` not check the key's listing first, when `message` does?**
Every host checks an entry against the profile entry's listing, and its refusal says why, so a check
here would only say it first. No host checks who signed a message: only the recipient's app does,
once it opens it, so this copy checks before it sends one that would not count.

**Why are other folders looked for only on the person's own hosts?**
A profile's address names no host. The index, which knows where each profile it lists lives, would
have to be asked in its own format, which `search` never names; and following every host anyone
names would reach any address. The person's hosts are where the profiles they deal with live today,
and a message names its sender's host, so a reply finds it.

**Why does the index's guide come with the instructions, and not with a tool?**
So the AI has it before its first search, as the index wrote it for AI agents, read from the index
this copy passes on, so another index's guide comes with another index. It is read once a chat, and
an AI app that cuts long instructions short cuts the guide first, after how Forest works.

**Why are markets read from a checkout, and not from the network?**
So every answer comes from the commit in `MARKETS`, the one the tests ran against, and a market file
changing upstream changes nothing here until the pin moves.

**Why is the deployed copy not checked in CI?**
CI checks only what this repo holds, and a check that cannot reach what it needs would skip, which
fails CI. `npm run smoke` checks a deployed copy by hand, after a deploy.
