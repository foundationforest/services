# mcp

Part of Forest's services: [the top README](../README.md).

`forest` is the AI's door to Forest: one small program that reads markets, searches, reads a
profile, and acts for a person with the access keys their app made.

Its job is two things: acting for a person with the keys their app made for it, and reading what
indexes say. It does both as typed commands and as MCP tools. The foundation runs one copy, hosted
at https://mcp.forest.foundation, for AI chats that cannot run a program on the person's device.
Anyone can run another; the main way is this directory on their own device, or its image. It keeps
nothing of the person's: no key, no record, no message.

## How it works

`forest` reads folders from hosts with the standard's records library, and checks every signature
itself. It reads markets from the markets directory at one commit, and posts, search results, checks
and ratings from an index. It writes and sends only with access keys
([the standard's keys](https://github.com/foundationforest/standard/blob/main/keys/README.md#access-keys)),
never a main key, and only where the profile's permissions record lists them.

### Two doors

Both doors read one list: every file in `src/tools/`, each exporting its name, its description
(the key it needs, first), its parameters and its work. A new tool is one more file.

- **Typed commands,** for people, scripts and agents that run commands:
  `forest <tool> [<argument>] [--name value …]`. Objects are given as JSON. Every answer is JSON; a
  refusal is one line, with exit status 1. `forest help` shows how Forest works, then every tool.
- **MCP tools,** for AI chats. The AI first gets `HOW` (`src/tools.ts`), a short text on how Forest
  works, as the server's instructions; the mark on paper is the server's icon
  ([How we run it](#how-we-run-it)).
  - `forest mcp` serves the tools over stdio, for an AI app on the same device.
  - `forest mcp --http [hostname:]port` serves them over Streamable HTTP at its root, and at `/mcp`
    for connectors added before, with no session: each request gets a fresh server. It listens on
    127.0.0.1 unless told otherwise; TLS is the operator's.

### The tools

| Tool | Key | What it does |
|---|---|---|
| `markets` | none | Every market in the directory this copy reads: its name, what the dealing is, its roles and what each posts (offers, requests, or just posts); and the names of the markets the index lists |
| `market <name>` | none | The market's file, as the [markets manual](https://github.com/foundationforest/markets/blob/main/build/README.md) defines it: roles, the fields of a post and of a review, payment schedules, how deals go; and its posts by role, from the index |
| `search` | none | The index's search, with its filters: `q`, `market`, `role`, `near` (`lat,lon`), `km`, `minRating`, `minReviews`, `limit`, `offset` |
| `profile <address>` | none | The profile record, its posts and the reviews it wrote, read from its hosts, each with its full address; and the index's checks (which issuers' notes it shows) and rating for it. The profile record's inbox key and its inbox's readers, long public keys `send` finds itself, are left out |
| `post <post\|update\|remove> [<id>]` | write | A post at `offer/<id>` in the profile's folder, on each of its hosts; a fresh id, 16 hex digits, when none is given to post |
| `review <post\|update\|remove> [<id>]` | write | A review at `review/<id>`, so a person can correct or withdraw one |
| `send <to>` | write | A message to another profile's inbox: the body, any JSON object the two apps agree on, sealed to that profile's inbox key and its inbox's readers, and signed with the write key for the profile |
| `inbox` | read | The messages to the profile, pulled from each of its hosts with the read key and opened with it; one not sealed to it shows who sent it and when, unopened. `after` takes the cursors a pull returned |
| `ask <kind>` | write | A request in the profile's own inbox, for the person to act on ([Requests](#requests)) |

Each description starts with the key it needs: `No key.`, `Write key.` or `Read key.`

### The keys

The person's app makes access keys for one profile, lists them in its permissions record, and gives
them with the profile's address
([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#permissions)):

- **The write key** (`writeKey`), scope `write`: posts, updates and removes posts and reviews where
  its paths cover them, and sends messages and asks when its paths cover `inbox`.
- **The read key** (`readKey`), scope `read`: pulls the inbox when its paths cover `inbox`, and
  opens what is sealed to it. Senders seal to it when the profile record names it among its inbox's
  readers.

Each is its 32 bytes in base64url, 43 characters ([FAQ](#faq)). Every tool that needs one takes it
in the call, with `profile`, the address it acts for. A copy on the person's own device may start
with them instead, in `FOREST_PROFILE`, `FOREST_WRITE_KEY` and `FOREST_READ_KEY`, and uses them when
a call carries none, so the AI never sees them. They come from the environment only, because a flag
shows in the process list and in the shell's history. A hosted copy takes keys only in the call,
and refuses to start with one in its environment: otherwise every caller would act as that person.

**Checked before anything is signed.** Before a write, a message or a pull, `forest` reads the
profile's folder, finds the key in its permissions record with the right scope, its paths covering
the path (`offer/<id>`, `review/<id>`, or `inbox`), and otherwise refuses with
`this key is not listed for <path>`, so a mistake is caught before a host sees it. The same words
say every way a key is not listed: not there, removed, listed with the other scope, or for other
paths. It also refuses, in plain words:

- a call with no key: `this needs the write key (writeKey), as the person's app gives it`, or the
  read key;
- a key not spelled as 32 bytes in base64url;
- a path the person's main key wrote: the main key wins, so only their app changes it;
- `post` where something is already there, `update` or `remove` where nothing is.

### Market checks

A post's and a review's body is checked against the market the profile's own profile record names
(`market`, `role`), before anything is signed. Each field is checked against a JSON Schema made
from the market file and the nine types in the directory's `build/types.json`: a field the market
names, for this role, of its type, and a choice among its values. A body that fails is refused
naming the field: `subjects takes a list, each different, each one of maths, physics, …`,
`a post in tutoring has no field colour`, `photos is for posts by seller`.

A review's shared fields are checked by what the manual says they mean: `subject` an address,
`score` `"1"` to `"10"` as decimal text with at most one decimal, `offer` a post's address
(`<profile address>/offer/<id>`), `text` and `evidence` text. A review names its `subject`. A
field the market keeps for reviews of some roles reads the subject's profile record for its role.
A field the market marks `required` is not asked for here: the manual says an app asks for it, and
nothing enforces it.

### Requests

`ask` is the one way to have something done that no key here allows. It sends
`{ "request": <kind>, …its fields }` to the profile's own inbox, signed by the write key; the
person's app shows it, and does it with the main key, or not. The kinds and their fields are this
tool's own, not the standard's: the standard leaves a message's body to the two apps
([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#inbox)).

| Kind | Fields |
|---|---|
| `post-offer` | `body`, the post's fields; `id` if wanted |
| `update-offer` | `id`; `body` |
| `remove-offer` | `id` |
| `post-review` | `body`, the review's fields; `id` if wanted |
| `pay` | `offer`, the post's address, `<profile address>/offer/<id>`; `units`, a whole number from 1, and `note`, if wanted |

A body is checked against the market as `post` and `review` check it, and a request never carries a
key. Typed: `forest ask pay --params '{"offer": "<profile address>/offer/<id>", "units": 2}'`.

`inbox` marks a message `"request": <kind>` only when the profile sent it to itself, by its main key
or a write key its permissions record lists, and its fields fit that kind. Any other body that says
`request`, such as a stranger's, shows as a plain message.

### Settings

| Flag | Variable | What it sets |
|---|---|---|
| `--host <origin>` | `FOREST_HOSTS`, comma separated | Where a profile's hosts record is looked for first. https://host.forest.foundation, the foundation's host, if none |
| `--index <url>` | `FOREST_INDEX` | The index read for posts, search, checks and ratings. https://index.forest.foundation, the foundation's index, if none |
| `--profile <address>` | `FOREST_PROFILE` | The profile acted for, when a call gives none |
| | `FOREST_WRITE_KEY`, `FOREST_READ_KEY` | The keys, as the person's app gives them, when a call gives none |

### Hosts, markets and the index

A folder is always read from hosts, never from an index:

- `forest` reads the profile on each start host, then on every host its hosts record names, by
  POST so the address is in no URL, with the records library's `readProfile`, which checks every
  record.
- Writes and messages go to every host the hosts record names. A host that charges for writes, as
  the foundation's does in credits ([host](../host/README.md#credits)), refuses a write the folder's
  balance cannot pay, and `forest` passes its answer on.
- A host other than the start hosts is reached only at a public address, through the standard's
  `publicFetch`. No request follows a redirect, and a folder read, or an inbox pull, stops after
  100 pages.

The markets come from `../markets`, the markets directory at the commit in `MARKETS`, which
`standard.sh` fetches beside the standard: `directory.json`, each market's file, and
`build/types.json`. Nothing about markets is read over the network while it runs.

An index is read for four answers, each passed on as that index's word, unchecked; a `url` beside
each says where it was read:

| Request | The fields it reads |
|---|---|
| `GET <index>/index.json` | `index`, its address; `markets`, each with `name`, `description` and `roles` |
| `GET <index>/markets/<name>.json` | `index`; `market`, the market file; `posts`, by role, a list of results |
| `GET <index>/search.json?q&market&role&near&km&minRating&minReviews&limit&offset` | `index`; `total`; `results` |
| `GET <index>/profiles/<address>.json` | `index`; `checks`, each `{ issuer, key, label }`; `rating`, `{ value, reviews, withPayment }` |

A result is `{ profile, market, role, post: { address, body }, rating, checks }`. `market` passes
on only `posts`, and `profile` only `checks` and `rating`: the rest is read from the markets
directory and the hosts. An index that does not answer never hides what the directory or the hosts
gave: `markets`, `market` and `profile` say why it gave nothing, beside the rest.

### Three setups

Who sees the keys, and what they open, depends on where `forest` and the AI run:

| Setup | `forest` runs | The AI runs | Who sees the keys | Who sees what they open |
|---|---|---|---|---|
| Cloud | hosted, `forest mcp --http` | in a company's cloud | the copy's operator while it acts, and the AI's maker, since the AI writes each key into the call | the copy's operator and the AI's maker |
| Hybrid | on your device, `forest mcp` started with keys | in a company's cloud | your device only | the AI's maker: every answer goes to the AI |
| Local | on your device, started with keys | on your device | your device only | your device only |

Started with keys, `forest` keeps them in memory while it runs, and never writes them. In the cloud
and hybrid setups, what the AI's maker keeps is that company's choice.

### Run it

```sh
./standard.sh                      # from the repo root: the standard, built, and the markets
cd mcp && npm ci                   # the standard's packages by name, linked into standard/
npm run check                      # type-check
npm test                           # every tool on the standard's reference host; both doors; the image's own command
node src/main.ts help
npm run smoke -- https://mcp.forest.foundation [<profile address>]
```

Node 22.18 or later. Built from existing pieces, used unchanged: the standard's keys and records
packages (`@foundationforest/keys`, `@foundationforest/records`, through file: links into
`standard/`); `@modelcontextprotocol/sdk`, for the MCP door; `ajv` and `ajv-formats`, for the
market checks, the versions the markets directory's own check uses.

`test/tools.test.ts` runs every tool against the standard's reference host on loopback, behind a
front that counts each request, and a stand-in index serving the four answers. It shows: each of
the nine tools, what they write read back with the records library; a write with a key not listed
for its path refused with no record reaching the host; a post failing its market's fields refused
naming the field; a review with a score out of range refused; `send` sealed so that only the
recipient's inbox key opens it; `inbox` pulling with the read key and opening; and `ask` landing in
the person's own inbox with its kind. `test/doors.test.ts` runs the typed door, the MCP door over
stdio with keys from the start, and over HTTP with keys in the call. `test/smoke.test.ts` reads the
command and working directory from `deploy/Dockerfile`, runs them here with `PORT=0`, and connects
with the MCP SDK's own client (`smoke.ts`): `HOW` first, as the server's instructions, the mark as
its icon, no session, every tool with the key it needs, a call refused before it reads anything in
`forest`'s words, the same tools at `/mcp`, the icon at `/favicon.ico` and `/icon.svg`, and `//`
answered 400 while it goes on answering. With a key in its environment, the same command refuses to
start. `npm run smoke` runs the same client against a deployed copy, and reads the market `tutoring`
and, if given, a profile through it.

## How we run it

The foundation's hosted copy, at https://mcp.forest.foundation:

- **The image.** `deploy/Dockerfile`: Node 22.22.2, the standard at `STANDARD` and the markets at
  `MARKETS` (`standard.sh`), and this directory, started as
  `forest mcp --http 0.0.0.0:$PORT --index https://index.forest.foundation`.
- **The tools.** All nine, over Streamable HTTP at its root and at `/mcp`. A chat first gets `HOW`.
- **Free:** no price and no sign-in.
- **Keeps nothing:** no key, record, message or call is written; each request gets a fresh server,
  gone when the answer is sent.
- **Keys only in the call.** The image sets none, and `forest` refuses to start a hosted copy with
  one.
- **Logs no call:** `forest` writes one line when it starts, and nothing for a request.
- **What it reads:** profiles from the foundation's host first, then the hosts each profile's hosts
  record names; markets from the directory at `MARKETS`; posts, search, checks and ratings from the
  foundation's index.
- **Its numbers:** at most 100 pages for one folder read or one pull; at most 4,194,304 bytes of an
  index's answer; the records library's 60 seconds for a read.
- **No rate limit.**
- **The icon.** The mark on paper: ink `#121A15` on paper `#EDEAE0`, three chevrons
  (`8,12 20,3 32,12`, `8,22 20,13 32,22` and `8,32 20,23 32,32`) and a trunk (`20,24` to
  `20,38`), stroke 4, in a 56-unit square with 8 of margin. The server's info declares it as an SVG;
  the copy serves it at `/icon.svg`, and at `/favicon.ico` as an ICO of 16, 32, 48 and 64 pixels.
  `src/icon.ts` draws both from the mark's strokes.
- **Where it runs:** Railway, service `mcp`: this repo, `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`,
  one replica, a public domain to the port in `PORT`, no volume, and no health check (the root and
  `/mcp` answer only what an MCP client sends; a plain `GET` gets 406). Its only variable is
  `PORT=8080`, and no key.

Hosts and indexes see this copy's network address, not the person's. This copy is the cloud setup
(Three setups).

### Connect a chat

The address is `https://mcp.forest.foundation`. It asks for no sign-in. A connector added with
`https://mcp.forest.foundation/mcp` keeps working.

- **Claude** (claude.ai and Claude's apps): Customize > Connectors > Add custom connector, that
  address, and No sign-in for Authentication. On a Team or Enterprise plan, an Owner adds it under
  Organization settings > Connectors. Claude connects from Anthropic's cloud
  ([Anthropic's steps](https://claude.com/docs/connectors/custom/remote-mcp)).
- **Claude Code:** `claude mcp add --transport http forest https://mcp.forest.foundation`.
- **ChatGPT,** on a plan with developer mode (Plus, Pro, Business, Enterprise, Edu): turn developer
  mode on, then add an MCP app with that address and no authentication. OpenAI moves these menus;
  its help article "Developer mode and MCP apps in ChatGPT" says where they are now.

To act for a profile, the person pastes into the chat what their app gives: `profile`, the
profile's address, and the keys it made for it, as `writeKey` and `readKey`, the tools' own names.

## Promises

- **It keeps nothing.** No key, record or message is written anywhere, and each call reads again
  what it needs.
- **Never a main key.** It acts only with access keys, and only where the profile's permissions
  record lists them.
- **It checks what it reads from hosts.** The standard's records library checks every record and
  message from a host, signature included. What an index says is passed on as the index's word, and
  labelled so.
- **It moves no money.** There is no pay tool. Paying is a request, answered by the person's own
  app.
- **No key in the hosted copy's environment.**
- **No accounts.**
- **No address logs in this code.** On Railway, Railway's own request logs exist, with each
  request's client address and path.

## Limits

- **A hosted copy sees each key while it acts.** It keeps none, but you trust its operator, the
  foundation for this one, while it acts. The AI's maker also sees every key the AI writes into a
  call (Three setups).
- **A profile its start hosts do not hold is out of reach** until one of its hosts is given; for
  the hosted copy, any profile the foundation's host does not hold.
- **An AI reading strangers' text can be steered** by what they wrote. It can do no more than its
  keys' scopes and paths allow.
- **What an index says goes unchecked.** `forest` passes on what it says without checking any
  signature on it; it cannot tell whether an index is honest.
- **The markets are the directory's at one commit.** A market added since is unknown here until
  `MARKETS` moves, and an index may list markets this copy cannot check posts for.
- **Not here:**
  - paying;
  - putting or deleting blobs (photos and videos): a post can name a blob the folder already
    holds;
  - buying credits for a host that charges;
  - handing out keys, making a profile, or anything else only the main key does;
  - the reviews others wrote about a profile: they sit in their writers' folders, and the index
    counts them into its rating.
- **Slow.** On every call it reads the whole folder from every host, and checks signatures in
  JavaScript
  ([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#limits)).
- **No rate limit.** Anyone can keep the hosted copy busy, and every call reads whole folders from
  hosts.
- **One replica.** When it stops, the tools stop until Railway starts it again.

## Who decides what

- **The standard:** keys, records, the permissions record and its scopes, messages and their
  envelopes.
- **The markets directory, at the commit in `MARKETS`:** each market's roles and fields.
- **The foundation, in this directory:** the tools, what each says and which key it needs, the
  request kinds and their fields; and, as it runs the hosted copy, the host and index it reads,
  where it runs, and that it is free.
- **Whoever runs a copy:** the hosts it starts from, the index it reads, and, for a copy run at
  home, the keys it starts with.
- **The person, through their app:** which access keys to hand out, with which scopes and paths,
  when to remove one, and what to do with each request.
- **An index, by its own choice:** what its posts, checks and ratings say.
- **The AI's maker:** what it keeps of a conversation, keys included.

## FAQ

**Why is there no pay tool?**
Moving money takes a payment key, which only the person's app holds; anyone can pay with their own
setup, and the main way here is a `pay` request their app answers. This copy offers no tool that
moves money.

**Why are keys spelled in base64url?**
The standard gives an access key as 32 random bytes and names no way to write them down. Base64url
without padding is how the standard's records write bytes, so it adds no spelling of its own.

**Why are markets read from a checkout, and not from the network?**
So every answer comes from the commit in `MARKETS`, the one the tests ran against, and a market
file changing upstream changes nothing here until the pin moves.

**Why is the index in the Dockerfile, and not a Railway variable?**
So the image says what it reads. Another copy changes that line.

**Why is the deployed copy not checked in CI?**
CI checks only what this repo holds, and a check that cannot reach what it needs would skip, which
fails CI. `npm run smoke` checks a deployed copy by hand, after a deploy.
