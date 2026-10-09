# mcp

`forest`, one small program that does Forest actions for a profile, given its address and an
access key, as typed commands and as MCP tools; and the foundation's hosted copy of its MCP door,
for AI chats that cannot run a program on the person's device.

The foundation runs the hosted copy, on devnet. Anyone can run another, from this Dockerfile or
from this directory alone, or run `forest` on their own device instead.

Up: [the repo](../README.md).

## How it works

`forest` is for people, scripts and AI chats. It reads folders from hosts with forest's records
library, and checks every signature itself. It reads markets and scores from an index. It writes
and sends only with access keys
([forest's records](https://github.com/foundationforest/forest/blob/main/records/README.md#permissions)),
never a main key, and it moves no money: an AI with only a message key can ask for anything and do
nothing alone. It stores nothing: every call carries the key it needs, or the copy was started
with it.

### Two doors

Both doors read one file, `src/actions.ts`: a short text on how Forest works, and each action's
words, key and parameters.

- **Typed commands,** for people, scripts and agents that run commands:
  `forest <action> [<argument>] [--name value …]`. Objects are given as JSON. Every answer is
  JSON; a refusal is one line, with exit status 1. `forest help` shows how Forest works, then
  every action and the key it needs.
- **MCP tools,** for AI chats. Every action is also a tool, which says what it does and which key
  it needs; the AI first gets the text on how Forest works, as the server's instructions.
  - `forest mcp` serves the tools over stdio, for an AI app on the same device.
  - `forest mcp --http [hostname:]port` serves them over Streamable HTTP at `/mcp`, for a hosted
    copy. It listens on 127.0.0.1 unless told otherwise; TLS is the operator's.

### The actions and their keys

| Action | Key | What it does |
|---|---|---|
| `market <market>` | none | What an index says of a market |
| `profile <address>` | none | A profile's card, its offers and the reviews it wrote, from its hosts, every signature checked; and, if an index is set, that index's summary of it, such as its scores |
| `private` | read | The profile's private records this read key opens |
| `inbox` | message; read to open | The messages to the profile, from each of its hosts; each one opened if the read key is one of the inbox's readers, and marked `unopened` if not |
| `post-offer`, `update-offer <id>`, `remove-offer <id>` | write | An offer at `offer/<id>` |
| `post-review` | write | A review at `review/<id>` |
| `send <to>` | message | A message to another profile's inbox |
| `request <action>` | message | Ask for one of the actions above, or `pay`, through the profile's own inbox (Requests) |

A key is written as a grant writes it
([forest's records](https://github.com/foundationforest/forest/blob/main/records/README.md#grants)).
Before it signs anything, `forest` checks the key against the profile's permissions record, and
refuses in plain words:

- No key: `no key for this; use request`.
- A key that is not listed, is listed with another scope or as past, or whose paths don't cover
  the path.
- The profile's main key, or its inbox key: only access keys are taken
  ([forest's keys](https://github.com/foundationforest/forest/blob/main/keys/README.md#rules-for-apps-that-hold-keys)).
- A path the owner wrote. The owner wins, so only the owner's app can change it.
- An offer or a review that does not fit its shape
  ([forest's schemas](https://github.com/foundationforest/forest/tree/main/records/schemas)).
  `createdAt` is set if it is missing.

### Requests

The one way to have something done that no key here allows. `request` names one of the actions
above that need a key, or `pay`, with that action's parameters, and sends them to the profile's
own inbox as a request body
([forest's records](https://github.com/foundationforest/forest/blob/main/records/README.md#inbox),
Requests). Typed: `forest request post-offer --params '{"offer": {…}}'`. Over MCP: `action` and
`params`. The parameters are checked against that action's own, so a request never carries a key.
The person's app shows it, and does it with the main key, or not.

`inbox` marks a message `"request": <action>` only when the profile sent it to itself, by its main
key or by a message key its permissions record lists, and its parameters fit that action. Any
other `request` body, such as a stranger's, shows as a plain message.

### Settings

| Flag | Variable | What it sets |
|---|---|---|
| `--host <origin>` | `FOREST_HOSTS`, comma separated | The hosts to start from. Without one: the hosts the foundation's index reads, from its public list ([`index/lists/hosts.json`](../index/lists/hosts.json) on this repo's `main`), read once per run |
| `--index <url>` | `FOREST_INDEX` | The index for markets and scores. No default; the foundation's devnet index is https://index.devnet.forest.foundation |
| `--profile <address>` | `FOREST_PROFILE` | The profile acted for |
| | `FOREST_WRITE_KEY`, `FOREST_MESSAGE_KEY`, `FOREST_READ_KEY` | The keys. They come from the environment only, because a flag shows in the process list and in the shell's history |

Over MCP, each tool also takes `profile` and its keys in the call (`writeKey`, `messageKey`,
`readKey`). A key in the call wins over one from the start.

### Hosts and the index

A folder is always read from hosts, never from an index:

- `forest` reads the profile on each start host, then on every host its hosts record names, by
  POST so the address is in no URL; forest's records library (`readProfile`) checks every record.
- Writes and messages go to the hosts that the hosts record names.
- A profile with no records on any start host is out of reach until one of its hosts is added with
  `--host`.
- A host other than the start hosts is reached only at a public address, through forest's public
  fetch (`publicFetch`, records/src/public.ts): one in any range IANA marks as not globally
  reachable, written or looked up, is refused before anything is sent. No request follows a
  redirect, and a folder read, or an inbox pull, stops after 100 pages.

An index is read for two things only, `GET <index>/markets/<market>.json` and
`GET <index>/profiles/<address>.json`. Both are passed on as that index's word. This JSON is the
foundation's index's own format ([`index/`](../index/README.md)), not part of the standard: it
carries no signatures, and other indexes may differ.

### Three setups

Who sees the keys, and what they open, depends on where `forest` and the AI run:

| Setup | `forest` runs | The AI runs | Who sees the keys | Who sees what they open |
|---|---|---|---|---|
| Cloud | hosted, `forest mcp --http` | in a company's cloud | the copy's operator while it acts, and the AI's maker, since the AI writes each key into the call | the copy's operator and the AI's maker |
| Hybrid | on your device, `forest mcp` started with keys | in a company's cloud | your device only | the AI's maker: every answer goes to the AI |
| Local | on your device, started with keys | on your device | your device only | your device only |

- **Started with keys** in its environment, `forest` uses them whenever a call carries none, so
  the AI never sees them. They stay in memory while it runs, and are never written.
- **A hosted copy** takes keys only in the call, and refuses to start with one in its
  environment: otherwise every caller would act as that person. Each request gets a fresh server,
  with no session, and nothing is written.
- In the cloud and hybrid setups, what the AI's maker sees is kept or not by that company's
  promises.

### The hosted copy

`deploy/Dockerfile` builds one image: Node 22.22.2, forest's records library at the commit in
`STANDARD` (`standard.sh records`), and this directory, started as

    forest mcp --http 0.0.0.0:$PORT --index https://index.devnet.forest.foundation

- **The tools.** Every action is a tool, over Streamable HTTP at `/mcp`, each saying which key it
  needs. A chat first gets the text on how Forest works.
- **No session.** Each request gets a fresh server, gone when the answer is sent. Nothing is
  written.
- **Keys only in the call.** A tool that needs a key takes it in the call (`writeKey`,
  `messageKey`, `readKey`), with the `profile` it acts for. The image sets none, and `forest`
  refuses to start a hosted copy with one.
- **What it reads.** Folders from its start hosts, the hosts on the foundation's index's public
  list, read once per start, and from every host a profile's hosts record names, every signature
  checked; markets and summaries from the foundation's devnet index, passed on as that index's
  word.

This copy is the cloud setup (Three setups). Hosts and indexes see this copy's network address,
not the person's.

### Connect a chat

The address is `https://mcp.devnet.forest.foundation/mcp`. It asks for no sign-in.

- **Claude** (claude.ai and Claude's apps): Customize > Connectors > Add custom connector, that
  address, and No sign-in for Authentication. On a Team or Enterprise plan, an Owner adds it under
  Organization settings > Connectors. Claude connects from Anthropic's cloud
  ([Anthropic's steps](https://claude.com/docs/connectors/custom/remote-mcp)).
- **Claude Code:** `claude mcp add --transport http forest https://mcp.devnet.forest.foundation/mcp`.
- **ChatGPT,** on a plan with developer mode (Plus, Pro, Business, Enterprise, Edu): turn developer
  mode on, then add an MCP app with that address and no authentication. OpenAI moves these menus;
  its help article "Developer mode and MCP apps in ChatGPT" says where they are now.

Reading needs no key. To act for a profile, the chat needs the profile's address and an access key
the person's app made for it, which the person gives it in the chat.

### Run it

```sh
./standard.sh keys records         # the CLI runs on records' library; the tests take their keys from keys/
cd mcp && npm ci
npm run check                      # type-check
npm test                           # every action on records' reference host on loopback; both doors; the image's own command
node src/main.ts help
npm run smoke -- https://mcp.devnet.forest.foundation/mcp [<profile address>]
```

Node 22.18 or later. Built from existing pieces, used unchanged:

- forest's records library, and its public fetch, to reach a host only at a public address;
- `@modelcontextprotocol/sdk`, for the MCP door;
- `ajv` and `ajv-formats`, for the record shapes;
- `age-encryption`, to work out a read key's public half.

`test/actions.test.ts` and `test/doors.test.ts` run every action, through both doors, against
records' reference host on loopback. `test/smoke.test.ts` reads the command and working directory
from `deploy/Dockerfile`, runs them here with `PORT=0`, and connects with the MCP SDK's own client
(`smoke.ts`). It checks that the text on how Forest works comes first, as the server's
instructions; that there is no session; that every action is a tool saying which key it needs; that
a call refused before it reads anything (an address that is not one, a write with no key) says why
in the CLI's words; and that a request for `//` gets 400 and it goes on answering. It also checks
that the same command, with a key in its environment, refuses to start. `npm run smoke` runs the
same client against a deployed copy, and reads the market `tutoring` and, if given, a profile
through it.

### On devnet

The foundation's devnet copy runs that image on Railway, service `mcp`, at
https://mcp.devnet.forest.foundation, the tools at `/mcp`:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`.
- **One replica,** a public domain to the port in `PORT`, no volume.
- **No health check:** `/mcp` answers only what an MCP client sends (a plain `GET` gets 406), and
  every other path 404.
- **Variables:** `PORT=8080`. Nothing else, and no key.

## Policy

The hosted copy's:

- **Free:** no price and no sign-in.
- **Keeps nothing:** no key, record, message or call is written; each request gets a fresh server.
- **Logs no call:** `forest` writes one line when it starts, and nothing for a request.
- **Its index** is the foundation's devnet index; **its start hosts,** that index's public list.
- **No rate limit.**
- **Where it runs:** Railway, one replica.

## Promises

- **It keeps nothing.** No key, record or message is written anywhere, and each call reads again
  what it needs. The only thing it holds between calls is the public list of hosts to start from.
- **Never a main key.** It refuses a profile's main key and its inbox key. It acts only with
  access keys, within the scopes and paths the permissions record lists.
- **It checks what it reads from hosts.** Forest's records library checks every record and message
  from a host, signature included. What an index says is passed on as the index's word, and
  labelled so.
- **It moves no money.** There is no pay action. Paying is a request, answered by the person's own
  app.
- **No key in the hosted copy's environment.**
- **No accounts.**
- **No address logs in this code.** On Railway, Railway's own request logs exist, with each
  request's client address and path.

## Limits

- **A hosted copy sees each key while it acts.** It keeps none, but you trust its operator, the
  foundation for this one, while it acts. The AI's maker also sees every key the AI writes into a
  call (Three setups).
- **Profiles off the start hosts are out of reach.** A profile that no start host holds can't be
  read, written to or sent to until its host is added; for the hosted copy, until it is added to
  the foundation's index's list.
- **An AI reading strangers' text can be steered** by what they wrote. With only a message key, it
  can only ask.
- **What an index says goes unchecked.** It carries no signatures. `forest` can't tell whether an
  index is honest; it only passes on what the index says.
- **Not here:**
  - paying;
  - blobs (photos and videos);
  - handing out keys: a message carrying a grant is refused;
  - reviews others wrote about a profile, except through an index's summary: they sit in their
    writers' folders, and only an index gathers them.
- **Slow.** On every call it reads the whole folder from every start host, and checks signatures
  in JavaScript
  ([forest's records](https://github.com/foundationforest/forest/blob/main/records/README.md#limits)).
- **No rate limit.** Anyone can keep the hosted copy busy, and every call reads whole folders from
  hosts.
- **One replica.** When it stops, the tools stop until Railway starts it again.

## Who decides what

- **The standard (forest):** only the request body, which
  [forest's records](https://github.com/foundationforest/forest/blob/main/records/README.md#inbox)
  holds.
- **The foundation, in this directory:** the actions, what each says and which key it needs; and,
  by the hosted copy's policy, the index it reads, where it runs, and that it is free.
- **Whoever runs a copy:** the hosts it starts from, the index it reads, and, for a copy run at
  home, the keys it starts with.
- **The person, through their app:** which access keys to hand out, with which scopes and paths,
  when to make one past, and what to do with each request.
- **An index, by its own policy:** what its markets and scores say.
- **The AI's maker:** what it keeps of a conversation, keys included.

## FAQ

**Why is there no pay action?**
With only an allowance, a program can't open an escrow in the person's name: the buyer signs
`create`. It could pay into the deposit address of an escrow nobody has opened yet. But opening
that escrow needs its terms, a random id among them, and if those were lost the money would wait
there for good. So paying is a request: the person's app pays with the main key, as it does for
any deal.

**Why does it refuse the inbox key?**
The inbox key opens every message and grant sent to the profile, and grants hold keys. It is mixed
from the main key, and stays on the device with it. A read key opens only what is encrypted to it.

**Why is the index in the Dockerfile, and not a Railway variable?**
So the image says what it reads, as the index's lists in this repo do. Another copy changes that
line.

**Why is the deployed copy not checked in CI?**
CI checks only what this repo holds, and a check that cannot reach what it needs would skip, which
fails CI. `npm run smoke` checks a deployed copy by hand, after a deploy.
