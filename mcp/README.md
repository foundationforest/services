# mcp

A hosted copy of forest's CLI that serves Forest's actions as MCP tools, for AI chats that cannot
run a program on the person's device.

The foundation runs this one, on devnet. Anyone can run another, from this Dockerfile or from
forest's CLI alone, or run `forest mcp` on their own device instead.

Up: [the repo](../README.md). What it runs: forest's
[CLI](https://github.com/foundationforest/forest/blob/main/cli/README.md).

## How it works

`deploy/Dockerfile` builds one image: Node 22.22.2, forest at the commit in `FOREST`
(`forest.sh records cli`), and forest's CLI, unchanged, started as

    forest mcp --http 0.0.0.0:$PORT --index https://index.devnet.forest.foundation

Nothing of this repo runs in it, so what it does is what forest's CLI README says
([its two doors](https://github.com/foundationforest/forest/blob/main/cli/README.md#two-doors),
[the actions and their keys](https://github.com/foundationforest/forest/blob/main/cli/README.md#the-actions-and-their-keys)):

- **The tools.** Every action is a tool, over Streamable HTTP at `/mcp`, each saying which key it
  needs. A chat first gets forest's text on how Forest works.
- **No session.** Each request gets a fresh server, gone when the answer is sent. Nothing is
  written.
- **Keys only in the call.** A tool that needs a key takes it in the call (`writeKey`,
  `messageKey`, `readKey`), with the `profile` it acts for. The image sets none, and forest's CLI
  refuses to start a hosted copy with one: every caller would act as that person.
- **What it reads.** Folders from its start hosts, the hosts on the foundation's index's public
  list ([`index/lists/hosts.json`](../index/lists/hosts.json) on this repo's `main`, read once per
  start), and from every host a profile's hosts record names, every signature checked; markets and
  summaries from the foundation's devnet index, passed on as that index's word.

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

This copy is the cloud setup: who sees the keys, and what they open, is in forest's
[three setups](https://github.com/foundationforest/forest/blob/main/cli/README.md#three-setups).
Hosts and indexes see this copy's network address, not the person's.

### Run it

```sh
./forest.sh records cli
cd mcp && npm ci
npm run check                                   # type-check
npm test                                        # the image's own command, on loopback
npm run smoke -- https://mcp.devnet.forest.foundation/mcp [<profile address>]
```

The test reads the command and working directory from `deploy/Dockerfile`, runs them in forest's
CLI with `PORT=0`, and connects with the MCP SDK's own client (`smoke.ts`). It checks that forest's
text comes first, as the server's instructions; that there is no session; that every action is a
tool saying which key it needs; that a call refused before it reads anything (an address that is
not one, a write with no key) says why in forest's words; and that a request for `//` gets 400 and
it goes on answering. It also checks that the same command, with a key in its environment, refuses
to start. `npm run smoke` runs the same client against a deployed copy, and reads the market
`tutoring` and, if given, a profile through it.

### On devnet

The foundation's devnet copy runs that image on Railway, service `mcp`, at
https://mcp.devnet.forest.foundation, the tools at `/mcp`:

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`.
- **One replica,** a public domain to the port in `PORT`, no volume.
- **No health check:** `/mcp` answers only what an MCP client sends (a plain `GET` gets 406), and
  every other path 404.
- **Variables:** `PORT=8080`. Nothing else, and no key.

## Policy

- **Free:** no price and no sign-in.
- **Keeps nothing:** no key, record, message or call is written; each request gets a fresh server.
- **Logs no call:** forest's CLI writes one line when it starts, and nothing for a request.
- **Its index** is the foundation's devnet index; **its start hosts,** that index's public list.
- **No rate limit.**
- **Where it runs:** Railway, one replica.

## Promises

- **Forest's CLI, unchanged,** at the commit in `FOREST`, so its promises hold here: it keeps
  nothing, never takes a main key, checks what it reads from hosts, and moves no money.
- **No key in its environment.**
- **No accounts.**
- **No address logs in this code.** On Railway, Railway's own request logs exist, with each
  request's client address and path.

## Limits

- **It sees each key passed in a call while it acts.** It keeps none, but you trust its operator,
  the foundation, while it acts. The AI's maker sees the key too, since the AI writes it into the
  call.
- **No rate limit.** Anyone can keep it busy, and every call reads whole folders from hosts.
- **Profiles on other hosts are out of reach** until their host is added to the foundation's
  index's list.
- **One replica.** When it stops, the tools stop until Railway starts it again.
- **The rest is forest's CLI's:** slow, and no paying, photos or videos, handing out keys, or
  reviews others wrote except through the index's summary
  ([its limits](https://github.com/foundationforest/forest/blob/main/cli/README.md#limits)).

## Who decides what

- **The standard (forest):** the actions, what each says and which key it needs, and the request
  body; this copy runs forest's CLI at the commit in `FOREST`.
- **The foundation, by this copy's policy:** the index it reads, where it runs, and that it is free.
- **The person, through their app:** which access keys to give a chat, with which scopes and paths,
  and when to make one past.
- **The AI's maker:** what it keeps of a conversation, keys included.

## FAQ

**Why is the index in the Dockerfile, and not a Railway variable?**
So the image says what it reads, as the index's lists in this repo do. Another copy changes that
line.

**Why is the deployed copy not checked in CI?**
CI checks only what this repo holds, and a check that cannot reach what it needs would skip, which
fails CI. `npm run smoke` checks a deployed copy by hand, after a deploy.
