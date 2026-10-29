# mcp

Part of Forest's services: [the top README](../README.md).

The mcp lets an AI app act for a person in Forest: it reads the markets, passes on what an index
says, and acts in the person's own profiles with the access keys their app hands it at login.

It is a connector, a service an AI app adds, over MCP (the Model Context Protocol, the way AI apps
call outside tools). It reaches three places, and nothing more:

- **the index,** whose search and pages it passes on whole;
- **the markets,** the directory at the commit in `MARKETS`;
- **the person's own folders,** on their hosts, with the access keys in the pack the person's app
  handed over at login.

The foundation runs one copy, at https://mcp.forest.foundation. Anyone can run another; the main way
is this directory, or its image.

**What it keeps:** nothing of the person's between calls. No seed (the secret all their keys come
from), no main key, ever. The access keys the person's app hands it travel inside the AI app's
access token, locked to this copy's open key, and are opened in memory for one call and forgotten.
On its volume: its own two keys, one that signs its logins and one whose opening half opens packs.

**What it sees:** during a call, the access key and the address of each profile the login acts in,
and what it reads and writes there. The AI sees neither: it names a profile by its label ("write
this offer as tutoring/tutor"), and no answer of a tool that acts for the person holds one of the
person's own addresses.

## How it works

```
AI app ── MCP, over HTTPS ──▶ mcp ──▶ the index: its guide, its search, its profile pages
                               ├──▶ the markets, at MARKETS
                               └──▶ the person's folders, on their hosts, with the access keys in the pack
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
| `my_profiles` | read-only | nothing | From the pack: each profile the login acts in, by its label, with what its access key `can` do. Never an address |
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
  host's refusal is passed on, so a key the person removed hears `unlisted`.

**Where other folders are looked for.** A message's recipient, an inbox sender, a review's subject:
at the hosts the person's own profiles use (the pack's), and at a message's own `host`, then every
host the folder's profile entry names. Every host is reached with `publicFetch` (`src/public.ts`,
the standard's until its #121), which reaches only public addresses and follows no redirect,
since anyone can make a pack and any profile entry names any host.

**The person's own addresses.** In every answer of the four tools that act for the person, each
address of a profile in the pack becomes its label, and each pay address of a profile entry the call
read becomes `<label>'s <type> pay address`, wherever it appears in a text.

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
   token this copy did not give, or one from before packs, gets the same on any request to MCP
   (`/` or `/mcp`), with `error="invalid_token"`, and so does a token whose pack no longer
   opens, once this copy's opening half changed, on a call that acts for the person.
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
   yes, the app does what [The pack](#the-pack) says, and sends the browser back to
   `<origin>/connected?request=<request>&pack=<pack>`; on a no, to
   `<origin>/connected?request=<request>&error=access_denied`.
6. **`/connected`** checks `request` is this copy's and less than 10 minutes old, then opens the pack
   with this copy's identity and checks it: its shape, and that it names this request. A pack that
   does not open, is not one, or is for another login is a page saying so, and no code. It sends the
   browser to the AI app's redirect address with `code`, `state` and `iss`; `code` carries the pack,
   still locked, with the client, the redirect, the challenge and the resource, for 60 seconds. On a
   no, the AI app gets `access_denied`.
7. **`/token`** (`grant_type=authorization_code`) checks the code, the client (and its secret, if it
   has one), the redirect, `code_verifier` against the challenge, and `resource`, and gives an
   access token carrying the pack, still locked, the client and this copy. It carries no expiry, so
   there is no refresh token: what it can do ends when the person removes its access keys from
   their profile entries, which every host and reader then counts for nothing. Adding a profile
   means logging in again.

Without `APP_URL`, step 4 is a page saying logins wait for the Forest app's connect page, and reading
still works.

### The pack

The pack is this service's own format, which an app follows to hand this copy access keys.

**This copy's open key** is at `GET <origin>/open-key`: `{ "openKey": "age1pq1…" }`, the open key of
this copy's opening half, an age post-quantum key, readable from any page
(`access-control-allow-origin: *`). It stays the same while the volume keeps `mcp-opening.json`.

**What the app does, on the person's yes,** for each profile they ticked:

1. makes an access key, keys/'s `newAccessKey()`: 64 random bytes, both its halves;
2. writes a new profile entry, signed by the main key, that lists it in `keys` as
   `{ key: <its address>, open: <its open key>, can: [ … ] }`, with the switches the person chose,
   all four unless they chose fewer, never more (`open` only when it can `read` or `read-inbox`);
3. writes its note, the standard's private note about an access key: at `key/<id>`, a random id,
   locked to the main key's open key alone, naming the access key, `{ key, … }`; the rest it says is
   the app's (the reference app writes the AI app's name, this copy's origin and the time).

Then it reads this copy's open key, and locks, with folders/locked's `lock`, to that key alone:

```
{ "request": <SHA-256 of the request text, as /authorize gave it, in lowercase hex>,
  "profiles": [ { "label": <the profile's label>,
                  "address": <the profile's address>,
                  "hosts": [<origin>, …],           1 to 8, its profile entry's
                  "key": <the access key's 64 bytes, base64url without padding>,
                  "can": [<"read-inbox" | "read" | "write" | "message">, …] }, … ] }
```

The pack is that envelope's text, the `private` of the locked body `lock` gives: base64url of an
age file, at most 8,192 characters. Labels and addresses are each once, and each profile is exactly
these five fields. `request` ties the pack to this one login.

### The reference app

[`test/app.ts`](test/app.ts) is what the person's app does around this copy, in plain code, with the
standard's libraries; the tests and the loop run it. It keeps the person's Profiles folder, the
empty label's, its `label/<id>` and `stamp/<id>` entries at random ids, locked to its own open key;
makes a profile, its profile entry with market, role, hosts, open key, both pay addresses, and a
verification for each stamp it keeps; does the connect page's work above; removes an access key and
its note, found by opening the folder's notes; and, on a new device, finds the person's profiles
and stamps from the seed alone, by opening every entry the Profiles folder holds.

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
  through the MCP SDK's own client, by registration and by a client document: the pack, a token
  that holds no label or address unlocked, one new access key in each profile ticked with every
  switch and none in the third, its note locked to the main key alone; fewer switches when the
  person chooses fewer. Refused: a pack locked to another key, a pack for another login (and the
  same pack with its own login, taken), a pack that is not one or is too long, a login changed on the
  way, a person who says no, a code with the wrong verifier or for another client, a token this
  copy did not give, one from before packs, and one whose pack no longer opens once the opening
  half changed; with no `APP_URL`, logins wait and reading works.
  Nothing kept: a token one copy gave works on another with the same two keys, and the data
  directory holds only them.
- `test/tools.test.ts`: the six tools and their marks; the instructions, then the index's guide, or
  a line saying it gave none; the markets; the index's search and a profile's page, each whole,
  `badge` in it and among the filters; `my_profiles`; `read` of the profile entry with its pay
  addresses by label, of a missing path, of a locked entry opened and of one locked before the
  login, not opened; `write` of a post signed by the access key, and each refusal naming its field
  or why; a review naming its post; a delete; a locked entry at any path, opened by the main key
  and the access key, and refused at `key/…`, at `profile`, with files; the inbox, a stranger's
  message with its sender counted and the index's word, one from before the login unopened, one
  from another of the person's profiles by its label, one signed by a key its sender does not list,
  not counted; `message` to a stranger, who opens it, signed by the access key; a login with
  `write` alone, a file field named in `files` and not, and no message; then the key and its note
  removed, the host refusing its next write as `unlisted` and what it wrote no longer current; and
  no answer in the file holding one of the person's addresses.
- `test/public.test.ts`: `publicFetch`, the standard's own tests of it: every range that is not
  public refused, written in the URL or reached through a name, before anything is sent, and no
  redirect followed, even when asked.
- `test/smoke.test.ts` reads the command and working directory from `deploy/Dockerfile`, runs them
  here, and connects with the MCP SDK's own client (`smoke.ts`): how Forest works first, as the
  server's instructions, the mark as its icon, no session, every tool, reading with no login, the
  challenge and the metadata, the open key, registration, `/authorize` on to the connect page, the
  same tools at `/mcp`, the icon's two files, a login through the stand-in page, and `my_profiles`;
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
  directory at `MARKETS`, and the folders of the profiles each login acts in, and of those they deal
  with, on public hosts only.
- **The tools.** All six, over Streamable HTTP at its root, and at `/mcp` for connectors added
  before.
- **Its numbers, and why:**
  - 10 minutes on the connect page, to unlock the device and choose; 60 seconds for a code, which
    the AI app redeems at once; no end for a login, which does what its access keys may until the
    person removes them;
  - at most 8,192 characters for a pack: about 15 profiles with one host each, so the access token,
    which carries it, stays well under the 16 KB of headers Node takes;
  - the newest 100 inbox entries a read opens: each takes a post-quantum opening, and anyone can
    leave entries in an inbox;
  - 10 seconds for the index's guide as a chat starts, so a slow index does not hold the chat; 60
    seconds for any other read of the index, and the folders client's 60 for a host;
  - at most 4,194,304 bytes for an MCP request or an index's answer.
- **Free:** no price.
- **Keeps nothing of anyone's:** its two keys on the volume; no call, token, pack or answer is
  written.
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
  hands it travel in the pack, locked to its open key, inside the AI app's token; it opens them for
  one call and forgets them.
- **It acts only as far as the access keys a login carries may,** and every host and reader checks
  that against the profile entry's listing: the person removes a key, and what it does stops
  counting.
- **It never moves money, and holds nothing that could.** No access key pays; payments are the
  person's app's.
- **It keeps nothing between calls.** No login, call, pack or answer is written.
- **The AI never gets a key, nor one of the person's own addresses,** from a tool that acts for
  them: it names each profile by its label.
- **What an index says is passed on as the index's word, whole, and labelled so;** `read` picks only
  a sender's market, role and checks from it, labelled the same.
- **No sign-up and no password.**
- **No address logs in this code.** On Railway, Railway's own request logs exist, with each request's
  client address and path.

## Limits

- **Its operator can act as any login it carries,** within the switches of its access keys: it
  opens each pack for a call, and could keep the keys. You trust the operator, the foundation for
  this copy, as far as the switches you hand out; anyone can run their own. The AI's maker sees what
  the AI does, and keeps what it chooses.
- **A login does not expire.** Its token carries the pack for as long as the AI's maker keeps it,
  and whoever takes it acts within the keys' switches until the person removes them. This copy
  cannot end one token alone: new keys here end every login at once.
- **`my_profiles` says what the app handed over,** not what each profile entry lists now: a switch
  the person took back since, the hosts refuse.
- **A key opens nothing locked before it was listed:** messages left, and locked entries written,
  before the login. Adding a profile means logging in again.
- **A stranger's folder is found only on the hosts the person's profiles use,** or a message's own
  host. A profile whose folder lives only elsewhere can be read about through the index, not
  messaged.
- **The newest 100 inbox entries** a read; older ones wait for the newest to leave their hosts, after
  each host's keep days.
- **At most about 15 profiles a login,** in a pack of 8,192 characters.
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
- **The foundation, in this directory:** the tools and what each says, the login, the pack's format,
  and its numbers; and, as it runs the copy, its origin, its connect page, the index it reads, where
  it runs, and that it is free.
- **Whoever runs a copy:** the same, for theirs.
- **The person, through their app:** which AI apps log in, which of their profiles each acts in,
  what each access key can do there, and removing it.
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
refresh token no store can retire would never expire either. Ending a login is the person's, in
their app.

**Why does the pack name its login request?**
The pack comes back through the person's browser, in a URL a history or a proxy's log may keep.
Anyone holding it could start a login of their own and hand it to `/connected`. Naming the request,
which carries the AI app's PKCE challenge and lasts 10 minutes, makes the pack open that one login
only.

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
