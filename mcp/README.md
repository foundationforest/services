# mcp

A hosted copy of forest's CLI as MCP tools, for AI chats that cannot run a program on the person's
device.

The foundation runs this one, on devnet. Anyone can run another, from this Dockerfile or from
forest's CLI alone, or run `forest mcp` on their own device instead. Nothing is on mainnet, and
nothing is shipped.

Up: [the repo](../README.md). What it runs: forest's
[CLI](https://github.com/foundationforest/forest/blob/main/cli/README.md).

## How it works

`deploy/Dockerfile` builds one image: Node 22.22.2, forest at the commit in `FOREST`
(`forest.sh records cli`), and forest's CLI, unchanged, started as

    forest mcp --http 0.0.0.0:$PORT --index https://index.devnet.forest.foundation

Nothing of this repo runs in it.

- **The tools.** Every forest action is a tool, over Streamable HTTP at `/mcp`. A chat first gets
  forest's text on how Forest works, then the tools, each saying which key it needs.
- **No session.** Each request gets a fresh server, gone when the answer is sent. Nothing is
  written.
- **Keys only in the call.** A tool that needs a key takes it in the call (`writeKey`, `messageKey`,
  `readKey`), with the `profile` it acts for. The image sets none, and forest's CLI refuses to start a
  hosted copy with one: every caller would act as that person.
- **What it reads.** Folders from the hosts on the foundation's index's public list
  ([`index/lists/hosts.json`](../index/lists/hosts.json) on this repo's `main`, read once per start)
  and from every host a profile's hosts record names, every signature checked; markets and summaries
  from the foundation's devnet index, passed on as that index's word.
- **What it never does,** as forest's CLI never does: take a main key, or move money. Paying is a
  request, which the person's own app answers.

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

To act for a profile, the chat needs the profile's address and an access key the person's app made
for it, which the person gives it in the chat. Reading needs no key.

### Three setups

| Setup | The model | forest's tools | Who sees the access keys | Who sees what the tools read and write |
|---|---|---|---|---|
| Cloud | the AI's maker's | this hosted copy | the AI's maker, since the key is in the chat and in each call; and this copy, while it acts | the AI's maker; and this copy, while it acts |
| Hybrid | the AI's maker's | `forest mcp` on the person's device, started with the keys | the person's device only: the AI never sees them | the AI's maker |
| Local | on the person's device | `forest mcp` on the person's device | the person's device only | the person's device only |

In every setup, hosts and indexes see only what any reader sees: public records, and messages sealed
so only their readers open them. Through this copy, they see its network address, not the person's.

### Run it

```sh
./forest.sh records cli
cd mcp && npm ci
npm run check                                   # type-check
npm test                                        # the image's own command, on loopback
npm run smoke -- https://mcp.devnet.forest.foundation/mcp [<profile address>]
```

The test reads the command and working directory from `deploy/Dockerfile`, runs them in forest's CLI
with `PORT=0`, and connects with the MCP SDK's own client (`smoke.ts`): forest's text comes first as
the server's instructions, there is no session, every action is a tool saying which key it needs, and
a call refused before it reads anything (an address that is not one, a write with no key) says why
in forest's words. It also checks that the same command, with a key in its environment, refuses to
start. `npm run smoke` runs the same client against a deployed copy, and reads the market `tutoring`
and, if given, a profile through it.

### On devnet

The foundation's devnet copy runs that image on Railway, project `forest-devnet`, service `mcp`, at
https://mcp.devnet.forest.foundation, the tools at `/mcp`:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`.
- **One replica,** a public domain to the port in `PORT`, no volume.
- **No health check:** `/mcp` answers only what an MCP client sends (a plain `GET` gets 406), and
  every other path 404.
- **Variables:** `PORT=8080`. Nothing else, and no key.

## Policy

- **Free:** no price, no sign-in, no account.
- **Keeps nothing:** no key, record, message or call is written; each request gets a fresh server.
- **Logs no call contents:** forest's CLI writes one line when it starts, and nothing for a request.
- **Its index** is the foundation's devnet index; **its hosts,** that index's public list.
- **No rate limit yet.**

## Promises

- **Forest's CLI, unchanged,** at the commit in `FOREST`, so its promises hold here: it keeps
  nothing, never takes a main key, checks what it reads from hosts, and moves no money.
- **No key in its environment.**
- **No address logs in this code.** On Railway, Railway's own request logs exist, with each
  request's client address and path.

## Limits

- **It sees each key passed in a call while it acts.** It keeps none, but you trust its operator
  while it acts.
- **The AI's maker sees every key the AI writes into a call,** and every answer, and keeps what its
  own policy keeps.
- **A request for `//` stops it** until Railway starts it again: forest's CLI reads the request's
  path in a way that throws on that URL. The fix is forest's, then `FOREST` moves.
- **No rate limit.** Anyone can keep it busy, and every call reads whole folders from hosts.
- **Slow.** Every call reads the profile's whole folder from every start host, and checks each
  signature in JavaScript.
- **Profiles off the index's hosts list are out of reach,** unless a hosts record on a listed host
  names their host.
- **What forest's CLI does not do, this does not either:** paying, photos and videos, handing out
  keys, and reviews others wrote about a profile except through the index's summary.
- **One replica.**

## Who decides what

- **The standard (forest):** the actions, what each says and which key it needs, and the request
  body; this copy runs forest's CLI at the commit in `FOREST`.
- **The foundation, by this copy's policy:** the index it reads, where it runs, and that it is free.
- **The person, through their app:** which access keys to give a chat, with which scopes and paths,
  and when to make one past.
- **The AI's maker:** what it keeps of a conversation, keys included.

## FAQ

**Why a hosted copy, when forest's CLI runs anywhere?**
A chat in a browser or on a phone cannot start a program on the person's device. This gives it the
same tools, at the cost the cloud setup's row says.

**Why is the index in the Dockerfile, and not a Railway variable?**
So the image says what it reads, as the index's lists in this repo do. Another copy changes that
line.

**Why is the deployed copy not checked in CI?**
CI checks only what this repo holds, and a check that cannot reach what it needs would skip, which
fails CI. `npm run smoke` checks a deployed copy by hand, after a deploy.
