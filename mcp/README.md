# mcp

Part of Forest's services: [the top README](../README.md).

`forest`, one small program that does Forest actions for a profile, given its address and an
access key, as typed commands and as MCP tools; and the Open Forest Foundation's hosted copy of its
MCP door (a door is one way in: typed commands, or MCP tools), for AI chats that cannot run a
program on the person's device.

The foundation runs the hosted copy, on devnet. Anyone can run another, from this Dockerfile or
from this directory alone, or run `forest` on their own device instead.


## How it works

`forest` is for people, scripts and AI chats. It reads folders from hosts with the standard's
records library, and checks every signature itself. It reads markets and scores from an index. It writes
and sends only with access keys
([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#permissions)),
never a main key. With only a message key you can send messages as the profile and ask for anything
else; you can write no record and move no money. It stores nothing: every call carries the key it
needs, or the copy was started with it.

### Two doors

Both doors read one file, `src/actions.ts`: a short text on how Forest works, and each action's
words, key and parameters.

- **Typed commands,** for people, scripts and agents that run commands:
  `forest <action> [<argument>] [--name value …]`. Objects are given as JSON. Every answer is
  JSON; a refusal is one line, with exit status 1. `forest help` shows how Forest works, then
  every action and the key it needs.
- **MCP tools,** for AI chats. Every action is also a tool, whose description starts with the key
  it needs (`No key.`, `Writing key.` or `Inbox key.`), then says what it does; the AI first gets
  the text on how Forest works, as the server's instructions, and the mark on paper is the server's
  icon ([The hosted copy](#the-hosted-copy)).
  - `forest mcp` serves the tools over stdio, for an AI app on the same device.
  - `forest mcp --http [hostname:]port` serves them over Streamable HTTP at its root, and at `/mcp`
    for connectors added before, for a hosted copy; it leaves out `private`. It listens on
    127.0.0.1 unless told otherwise; TLS is the operator's.

### The actions and their keys

| Action | Key | What it does |
|---|---|---|
| `markets` | none | The markets an index uses, one line each, with each role's plain word: `tutoring: teacher (seller), student (buyer)`, `plumbing: seller, buyer`, `tennis: peer` |
| `market <market>` | none | What an index says of a market |
| `profile <address>` | none | A profile's card, its offers and the reviews it wrote, from its hosts, every signature checked; and, if an index is set, that index's summary of it, such as its scores, less what the hosts gave ([Hosts and the index](#hosts-and-the-index)). The card's inbox key and its inbox's readers, long public keys a message is sealed to, are left out unless `publicKeys` is true |
| `offer <action> [<id>]` | writing | `post`, `update` or `remove` an offer at `offer/<id>`. An offer from a buyer-side profile is a request: direction `request` |
| `review` | writing | A review at `review/<id>` |
| `inbox` | inbox | The messages to the profile, from each of its hosts; each one opened if the inbox key's read key is one of the inbox's readers, and marked `unopened` if not |
| `send <to>` | inbox | A message to another profile's inbox; and, when it is text, a copy, `{ text, to }`, in the profile's own inbox, where the person's app shows it. The copy costs the sender's folder one write, as any message does |
| `ask <kind>` | inbox | Ask the person, through the profile's own inbox, for one of the standard's request kinds ([Requests](#requests)) |
| `private` | inbox (its read key) | The profile's private records the read key opens. Typed and over stdio only: a hosted copy leaves it out |

### The keys

The person's app gives two access keys for one profile
([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#permissions)),
each as a grant writes it (a grant is the message that hands an access key to someone)
([grants](https://github.com/foundationforest/standard/blob/main/records/README.md#grants)):

- **The writing key** (`writingKey`): a write key, which posts, updates and removes offers, and
  posts reviews.
- **The inbox key** (`inboxKey`): a message key and a read key joined by a dot,
  `<message key>.<read key>`, which `forest` splits on the dot. The message key pulls the inbox,
  sends messages as the profile, and asks; the read key opens the messages. It is not the
  profile's own inbox key, which the app keeps with the main key.

The older names, `writeKey`, `messageKey` and `readKey`, are still taken, for chats and setups made
before; when a call gives both, the app's name wins. Before it signs anything, `forest` checks each
key against the profile's permissions record, and refuses in plain words:

- No key: `no key for this; use ask`.
- A key that is not listed, is listed with another scope or as past, or whose paths don't cover
  the path.
- The profile's main key, or its own inbox key: only access keys are taken
  ([the standard's keys](https://github.com/foundationforest/standard/blob/main/keys/README.md#rules-for-apps-that-hold-keys)).
- A path the owner wrote. The owner wins, so only the owner's app can change it.
- An offer or a review that does not fit its shape
  ([the standard's schemas](https://github.com/foundationforest/standard/tree/main/records/schemas)).
  `createdAt` is set if it is missing.

### Requests

The one way to have something done that no key here allows. `ask` names one of the standard's
request kinds, with that kind's parameters, and sends them to the profile's own inbox as a request
body
([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#inbox),
Requests). The kinds are the standard's, by its names, since the person's app reads the body
whatever asked: `post-offer`, `update-offer` and `remove-offer` (what `offer` does), `post-review`
(what `review` does), `send`, `inbox`, `private`, and `pay`. Typed:
`forest ask post-offer --params '{"offer": {…}}'`. Over MCP: `action` and `params`. The parameters
are checked against that kind's own, the ones the standard lists, so a request never carries a
key. For `pay` they are `offer`, the offer's address (`<profile address>/offer/<id>`), and if
wanted `units`, a whole number of hours or days, and `note`. The person's app shows it, and does it
with the main key, or not.

`inbox` marks a message `"request": <kind>` only when the profile sent it to itself, by its main
key or by a message key its permissions record lists, and its parameters fit that kind. Any other
`request` body, such as a stranger's, shows as a plain message.

### Settings

| Flag | Variable | What it sets |
|---|---|---|
| `--host <origin>` | `FOREST_HOSTS`, comma separated | The hosts to start from. Without one: the hosts the foundation's index reads, from its public list ([`index/lists/hosts.json`](../index/lists/hosts.json) on this repo's `main`), read once per run |
| `--index <url>` | `FOREST_INDEX` | The index for markets and scores. No default; the foundation's devnet index is https://index.devnet.forest.foundation |
| `--profile <address>` | `FOREST_PROFILE` | The profile acted for |
| | `FOREST_WRITING_KEY`, `FOREST_INBOX_KEY` | The keys, as the app gives them; the older `FOREST_WRITE_KEY`, `FOREST_MESSAGE_KEY` and `FOREST_READ_KEY` are still taken. They come from the environment only, because a flag shows in the process list and in the shell's history |

Over MCP, each tool also takes `profile` and its key in the call (`writingKey` or `inboxKey`). A
key in the call wins over one from the start.

### Hosts and the index

A folder is always read from hosts, never from an index:

- `forest` reads the profile on each start host, then on every host its hosts record names, by
  POST so the address is in no URL; the standard's records library (`readProfile`) checks every record.
- Writes and messages go to the hosts that the hosts record names.
- A profile with no records on any start host is out of reach until one of its hosts is added with
  `--host`.
- A host other than the start hosts is reached only at a public address, through the standard's public
  fetch (`publicFetch`, records/src/public.ts): one in any range IANA marks as not globally
  reachable, written or looked up, is refused before anything is sent. No request follows a
  redirect, and a folder read, or an inbox pull, stops after 100 pages.

An index is read for three things only: `GET <index>/index.json`, for its markets and each one's
role words (`roleWords`); `GET <index>/markets/<market>.json`; and
`GET <index>/profiles/<address>.json`. All are passed on as that index's word. This JSON is the
foundation's index's own format ([`index/`](../index/README.md)), not part of the standard: the
market's carries no signatures, a profile's carries its scores signed, and other indexes may
differ. `forest` checks none of it. Of a profile's, `profile` passes on what the hosts did not
give: it leaves out the offers and requests, and the reviews the profile wrote, which it read
signed from the hosts; and, unless `publicKeys` is true, the card's keys, as on the card.

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

`deploy/Dockerfile` builds one image: Node 22.22.2, the standard's records library at the commit in
`STANDARD` (`standard.sh records`), and this directory, started as

    forest mcp --http 0.0.0.0:$PORT --index https://index.devnet.forest.foundation

- **The tools.** Eight, over Streamable HTTP at the copy's root, and at `/mcp` for connectors added
  before: `markets`, `market` and `profile`; `offer` and `review`; `inbox`, `send` and `ask`. Each
  description starts with the key it needs. `private` is left out ([FAQ](#faq)). A chat first gets
  the text on how Forest works.
- **No session.** Each request gets a fresh server, gone when the answer is sent. Nothing is
  written.
- **Keys only in the call.** A tool that needs a key takes it in the call (`writingKey` or
  `inboxKey`, or an older name), with the `profile` it acts for. The image sets none, and `forest`
  refuses to start a hosted copy with one.
- **The icon.** The mark on paper: ink `#121A15` on paper `#EDEAE0`, three chevrons
  (`8,12 20,3 32,12`, `8,22 20,13 32,22` and `8,32 20,23 32,32`) and a trunk (`20,24` to
  `20,38`), stroke 4, in a 56-unit square with 8 of margin. The server's info declares it as an
  SVG; the copy serves it at `/icon.svg`, and at `/favicon.ico` as an ICO of 16, 32, 48 and 64
  pixels. `src/icon.ts` draws both from the mark's strokes.
- **What it reads.** Folders from its start hosts, the hosts on the foundation's index's public
  list, read once per start, and from every host a profile's hosts record names, every signature
  checked; markets and summaries from the foundation's devnet index, passed on as that index's
  word.

This copy is the cloud setup (Three setups). Hosts and indexes see this copy's network address,
not the person's.

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

On connecting, a chat gets a short text on how Forest works (`HOW` in `src/actions.ts`):

- one profile per market and role, and nothing public links a person's profiles: keep it so;
- reading needs no key: `markets`, a `market`, any `profile`;
- what each key allows: the writing key (`writingKey`) posts, updates and removes offers, and
  posts reviews; the inbox key (`inboxKey`) pulls and opens the inbox, sends messages as the
  profile, and asks the person;
- the keys come in each call that needs one, and the tool keeps none;
- an offer from a buyer-side profile, such as `tutoring/buyer`, is a request: direction `request`;
- for money, or what a key it doesn't hold would do, it uses `ask` and tells the person to open
  their app and approve it with their face; for a new profile or a removed key, which are not
  requests, it tells the person to do it in their app.

To act for a profile, the person pastes into the chat the block their app gives: `profile` (the
profile's address) and the two keys the app made for it, as `writingKey` and `inboxKey`, the
tools' own names.

### Run it

```sh
./standard.sh keys records         # the CLI runs on records' library; the tests take their keys from keys/
cd mcp && npm ci
npm run check                      # type-check
npm test                           # every action on records' reference host on loopback; both doors; the image's own command
node src/main.ts help
npm run smoke -- https://mcp.forest.foundation [<profile address>]
```

Node 22.18 or later. Built from existing pieces, used unchanged:

- the standard's records library, and its public fetch, to reach a host only at a public address;
- `@modelcontextprotocol/sdk`, for the MCP door;
- `ajv` and `ajv-formats`, for the record shapes;
- `age-encryption`, to work out a read key's public half.

`test/actions.test.ts` and `test/doors.test.ts` run every action, through both doors, against
records' reference host on loopback, with the keys by the app's names and by the older ones.
`test/smoke.test.ts` reads the command and working directory from `deploy/Dockerfile`, runs them
here with `PORT=0`, and connects at its root with the MCP SDK's own client (`smoke.ts`). It checks
that the text on how Forest works comes first, as the server's instructions, with the mark as the
server's icon; that there is no session; that the hosted copy's eight tools are there, each
description starting with the key it needs; that a call refused before it reads anything (an
address that is not one, a write with no key) says why in the CLI's words; that `/mcp` lists the
same tools; that `/favicon.ico` and `/icon.svg` serve the mark; and that a request for `//` gets
400 and it goes on answering. It also checks that the same command, with a key in its environment,
refuses to start. `npm run smoke` runs the
same client against a deployed copy, and reads the market `tutoring` and, if given, a profile
through it.

### On devnet

The foundation's devnet copy runs that image on Railway, service `mcp`, at
https://mcp.forest.foundation, the tools at its root and at `/mcp`:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`.
- **One replica,** a public domain to the port in `PORT`, no volume.
- **No health check:** the root and `/mcp` answer only what an MCP client sends (a plain `GET`
  gets 406), `/favicon.ico` and `/icon.svg` the icon, and every other path 404.
- **Variables:** `PORT=8080`. Nothing else, and no key.

## How we run it

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
- **Never a main key.** It refuses a profile's main key and its own inbox key. It acts only with
  access keys, within the scopes and paths the permissions record lists.
- **It checks what it reads from hosts.** The standard's records library checks every record and message
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
  can send messages as the profile and ask, and nothing else.
- **What an index says goes unchecked.** The market list carries no signatures; the scores on a
  profile's page are signed, and `forest` passes them on as the index gave them, without checking
  the signatures. It can't tell whether an index is honest; it only passes on what the index says.
- **Not here:**
  - paying;
  - blobs (photos and videos);
  - handing out keys: a message carrying a grant is refused;
  - reviews others wrote about a profile, except through an index's summary: they sit in their
    writers' folders, and only an index gathers them.
- **Slow.** On every call it reads the whole folder from every start host, and checks signatures
  in JavaScript
  ([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#limits)).
- **No rate limit.** Anyone can keep the hosted copy busy, and every call reads whole folders from
  hosts.
- **One replica.** When it stops, the tools stop until Railway starts it again.

## Who decides what

- **The standard:** only the request body, its kinds and each one's parameters, which
  [the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#inbox)
  holds.
- **The foundation, in this directory:** the actions, what each says and which key it needs; and,
  as it runs the hosted copy, the index it reads, where it runs, and that it is free.
- **Whoever runs a copy:** the hosts it starts from, the index it reads, and, for a copy run at
  home, the keys it starts with.
- **The person, through their app:** which access keys to hand out, with which scopes and paths,
  when to make one past, and what to do with each request.
- **An index, by its own choice:** what its markets and scores say.
- **The AI's maker:** what it keeps of a conversation, keys included.

## FAQ

**Why is there no pay action?**
A seller's invoice is an escrow anyone can pay into with a plain transfer, so a person's own setup
could let an AI pay one; this copy offers no tool that moves money.

**Why can't a request ask for a new profile or a removed key?**
A request names one of the standard's request kinds: the actions here that need a key, and `pay`
([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#inbox),
Requests). A new profile and a removed key are neither, so the chat tells the person to do them in
their app.

**Why does it refuse the profile's own inbox key?**
The profile's own inbox key opens every message and grant sent to the profile, and grants hold
keys. It is mixed from the main key, and stays on the device with it. The inbox key the app gives
(`inboxKey`) is two access keys instead: a message key, and a read key, which opens only what is
encrypted to it.

**Why does the hosted copy leave out `private`?**
So that a chat given the inbox key reads the inbox through it, and nothing else of the folder: the
inbox key's read key would also open the private records encrypted to it. Where `forest` runs on
the person's own device, typed or over stdio, `private` is there.

**Why is the index in the Dockerfile, and not a Railway variable?**
So the image says what it reads, as the index's lists in this repo do. Another copy changes that
line.

**Why is the deployed copy not checked in CI?**
CI checks only what this repo holds, and a check that cannot reach what it needs would skip, which
fails CI. `npm run smoke` checks a deployed copy by hand, after a deploy.
