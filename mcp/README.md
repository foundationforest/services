# mcp

The [MCP](https://modelcontextprotocol.io) server lets your AI app (Claude, ChatGPT) act for you:
find people, post, review and message, within the access keys you give it, and it hands you a link
to your Forest app whenever something needs your passkey or is better seen than read. An access key is a key
one of your profiles hands out: its profile entry lists each one with what it `can` do (`read`,
`read-inbox`, `write`, `message`). Hosts and readers check `write` and `message`; `read` and
`read-inbox` work by envelopes: whoever locks an entry or a message locks it to the keys listed with
them. The Forest Foundation runs this copy, at https://mcp.forest.foundation. Anyone can run
another; the main way is this directory, or its image. It keeps nothing of yours between calls, and
never holds your seed or a main key: the access keys your app hands it wait in your AI app's
connection, a folder like any other that holds its access keys instead of listings, locked to this
copy's public encryption key. No account, no password.

## How it works

```
AI app ── MCP, over HTTPS ──▶ MCP server ──▶ the index: its guide, its search, its profile pages
                                      ├──▶ the markets, at MARKETS
                                      └──▶ the person's folders, on their hosts, with the connection's access keys
```

It reaches those three places, and the AI app's client document, fetched at login, and nothing more.
It signs with the access keys and reads what they open using the standard's `@foundationforest/keys`
and `@foundationforest/folders`, unchanged
([access keys](https://github.com/foundationforest/standard/blob/main/folders/README.md#access-keys)).
During a call it sees the connection, the access key and address of each profile it acts in, and
what it reads and writes there. The AI sees none of them: it names a profile by its label ("write
this offer as tutoring/tutor").

### The tools

Eight. Each name starts with a verb, each has a title, and each sets all three of the MCP
specification's marks, `readOnlyHint`, `destructiveHint` and `openWorldHint`, true or false, as both
Claude's and ChatGPT's app directories require. Two read with no login, so an AI app can read before
the person connects anything; six act for the person and need one.

| Tool | Read only | Destructive | Open world | The AI gives | What it does |
|---|---|---|---|---|---|
| `list_markets` | yes | no | no | `name`, or nothing | With no name, every market in the directory, as the directory gives it: its summary, description, status (`live` or `beta`), number and icon, its roles and what each lists (offers or requests). With a name, that market as the markets package's `ask` says it ([the markets manual](https://github.com/foundationforest/markets/blob/main/build/README.md)): `market` (the file's name, summary, description, status, icon, number and roles, and `preview`, the fields a listing's preview shows first, after its title and description); `fields`, for each kind (`listing`, `review`, `vouch`, `report`), each field's rules once, with the `roles` it is for (a field can be for some roles only) and its piece, `several`, `when`, a number's `unit`, a price's `per`, a choice's `choices`, each value with how it reads, and `takes`, how an answer is written; `roles`, for each role, the fields its listings ask and those a review about it asks, in order, each with its `label`, `question`, `hint` and `start`, where its input opens; and `vouch` and `report`, the same. A choice that takes a shared list gives the list's name, `list`, in place of its values, and its `takes` says how they are written: languages by their ISO 639-1 codes, countries by their ISO 3166-1 alpha-2 codes, which any AI knows, so a market's answer stays a few KB |
| `search` | yes | no | yes | `filters`, or `address`, or `guide: true` | The index's search, its `filters` (each a text value) passed on as they are, its description naming those the foundation's index takes on a market's fields; or a profile's page at the index; or its guide. Answers `{ word, page, answer }`, below |
| `list_my_profiles` | yes | no | no | `label`, or nothing | With no label, each profile this login acts in whose market the directory still lists (the rest are left out, as the app forgets them): its label, what its access key `can` do as its profile entry lists it now (nothing once it has ended), its listings (`id`, `title` and the link to it in the app), `inSearch` (whether the index counts the profile), and its rating, trust and review count as the index shows them. With a label, that profile in full: its listings with their fields, and the reviews, vouches and reports it received (under `strangersWrote`) and wrote, as the index shows them, each one it wrote with its `path` |
| `read_messages` | yes | no | no | `label`, `with`, or nothing | With nothing, every profile's conversations, newest first: for each, the person's profile it is with (`label`), the other side (its address, and its market, role and checks as the index shows them, or the label of another of the person's profiles), its newest message, how many there are, and the link to the conversation in the app. With `label` and `with` (an address), that one conversation, the newest 100 messages |
| `send_message` | no | yes | yes | `to`, `text`, `listing`, `label` | A message `{ text, listing? }`, the app's shape, signed by the access key and locked to the recipient's public encryption keys, from the person's profile `label` or, with none, their profile on the other side of the recipient's market (the same role in a market with one role); with none, refused with the link to make that profile |
| `post_listing` | no | yes | yes | `label`, `id`, `fields` | `listing/<id>`, a new id when `id` is left out, checked against the market with `checkEntry`, written to the profile's hosts. Answers the link to it in the app |
| `write_review` | no | yes | yes | `label`, `kind`, `subject`, `fields` | A `review`, `vouch` or `report` about another profile, checked the same way |
| `delete_entry` | no | yes | yes | `label`, `path` | Deletes one of the person's listings, reviews, vouches or reports |

**Why those marks.** Read only is a tool that changes nothing. Destructive is one whose change cannot
be taken back, or replaces what was there: a message once sent, a listing posted with an id that
exists (it replaces the listing), a review written again about the same profile (it replaces the
earlier one), a deletion. Open world is a tool that reaches other people or the public: search reads
the index, which holds other people's words; a message goes to someone; a listing or a review is
public. `list_markets`, `list_my_profiles` and `read_messages` read the directory this copy holds
and the person's own folders, and what the index shows of their own profiles, so they are not open
world.

MCP tool names take no spaces, so the person's profiles are `list_my_profiles`, titled "List my
profiles".

- **The instructions** are what the AI app first gets, `instructionsFor` in `src/tools.ts`, under
  2,000 characters (Claude Code cuts them at 2,048, and Claude at 4,096),
  the most important first: what Forest is in one line; name a profile by its label, never the
  person's addresses, and never link two of their profiles; when to hand which link; what sits under
  `strangersWrote` is a stranger's, not the person asking; ask before anything public; beta markets;
  no paying here. They hold nothing an index or any page said: the AI apps' rules forbid taking
  behavior from an outside source, so the index's guide is `search` with `guide: true`, an answer the
  AI asks for. Everything about one tool is in that tool's description, each under 2,048
  characters: how to write a place, a price, a date and spots is in `post_listing`'s.
- **An index's answers pass through as the index gave them,** so any index can take what it likes,
  and a field an index adds later reaches the AI with no change here, with two rules that name no
  field of an index's own making: fields only machines read are left out (`proofs`, `keys`,
  `openKey`, `pay`, `statement`, `signature` and each check's `key`: an app directory rejects debug
  payloads), and every entry's `body`, the words its writer wrote, moves under `strangersWrote`, so
  the AI tells a stranger's words from the person's own. Each answer of `search` is `{ word, page,
  answer }`: a `word` saying the answer is the index's own, unchecked; `page`, the same search (or the
  profile's page) at the index, for the person to open; and the answer. Its description names the
  filters the foundation's index takes on a market's own fields once `market` is given (a choice as
  `<field>=<value>`, a number as `<field>.min` and `<field>.max`, in its unit, matching a number or a
  range that overlaps them, and spots as `spots=<n>`, room for that many: an offer's spots at least
  `n`, a time's own over the listing's, a request's at most) and on prices (`price.currency`,
  `price.per`, `price.min`, `price.max` and `sort=price`), so an AI app that never reads the guide
  still finds, say, a language exchange by `learns` and `languages`. An index that does not answer is a
  refusal saying so.
- **`search`, the person's own.** With a login, a result whose profile is one this login acts in
  comes back as `{ mine: <label>, listing: { id, link } }`, with no words, so the AI never offers the
  person their own listing. No login, or one gone or out of reach, is no refusal: `unmarked` says why.
- **`list_my_profiles`** reads each profile's folder from its hosts for its listings (the person's own
  words, so with no `strangersWrote` around them) and asks the index for its page: `inSearch` is
  true when the page holds the index's signed statement, which only a profile it counts has. A
  profile whose market left the directory is left out of the list; asked for by label, it is read
  all the same.
- **`read_messages`** lists the profile's inbox at each of its hosts, every page, each inbox entry
  once, in order of arrival (an inbox entry carries no time), and opens the newest 100 with the
  access key, each signature checked as the standard says (`openInbox`) and each sender's profile
  entry checked to stand behind the signing key (`senderCounts`); a message whose sender's entry
  does not is dropped, as the Forest app drops it. Among them, the newest 100 of the profile's sent
  copies (below), so a conversation reads whole. A message shows `time`, `from` (`you`, `them`, or
  `your other profile`) and its `text` and `listing`, the other side's under `strangersWrote`.
  Whatever else its body holds, a photo or anything the standard adds that this copy does not know,
  is named in `unreadable`, and the conversation's link in the app is given, where the person sees
  it and sends a photo, a proof or their location. `unopened` counts, when more than none, the
  entries the key does not open: inbox entries left before it was listed with `read-inbox`, copies
  locked before it was listed with `read`.
- **`send_message`'s sender.** With a `label`, that profile. With none, the recipient's profile entry
  names its market and role, and the sender is the person's profile in that market in another role
  (in a market with one role, the same role); none, or more than one, is refused (with the link to
  make the profile, `<app>/new#market=<market>&role=<role>`, or asking for a `label`). `listing` is
  the recipient's, its full address, or `listing/<id>` for one of the sending profile's own, which
  this copy fills in as `<address>/listing/<id>` (a reply to a request with an offer); any other is
  refused. It checks first that the sender's profile entry lists the key with `message` and it has
  not ended, since only the recipient's app would see it does not count. The recipient's `hosts`
  each take their price, by its bytes, from the profile's balance there, with a payment signed by
  the access key.
- **`send_message`, its copy:** once a host took the message, a copy in the sending profile's own
  folder, as the Forest app keeps one: at `sent/<id>`, 16 random bytes in hex, `{ to, time, body }`,
  locked to every key that may read the folder (`lockKeysOf`) and written as any entry, so the
  person's app shows the AI's side of a thread. When no host took it, as for a key listed without
  `write`, the message went all the same and the answer says so in `note`.
- **`post_listing`** checks `fields` against the profile entry's `market` before anything is signed,
  with the markets package's `checkEntry`, the index's own check, so a listing refused here would
  not be listed: each field one the market names for the role, or `contact`, held only where its
  `when` matches, written as its piece is, a choice among its values. A body that does not fit is
  refused with `checkEntry`'s own words, naming the field. With the id of a listing that exists,
  it updates it: fields left out stay, a field sent as `null` is removed. A listing's photos, its
  `files` list and each photo field the market names for the role, are always carried over from
  what is there by this copy, which takes no photo field from the AI (it is refused, with the
  link to the listing in the app); a new listing has none. The answer is `{ posted, link }`, and
  `beta` for a market that is beta (it works at the person's own risk and may change), and
  `notInSearch` when the index does not count the profile.
- **`write_review`** writes the body `{ ...fields, subject }` at `<kind>/<id>`: `subject` an
  address, never one of the person's own profiles, and for a review the `listing` it names a full
  address. The index counts one vouch and one report per writer and profile, the latest, and a
  review's latest per profile and listing, so when the profile's folder already holds an entry of
  that kind about that subject (for a review, that listing too) this writes at its path, which
  updates it, and the folder holds no dead copies; otherwise at a new id, 8 random bytes in hex.
- **`delete_entry`** takes `listing/<id>`, `review/<id>`, `vouch/<id>` or `report/<id>`, one that
  holds an entry now. Nothing else is written or deleted by any tool: not `profile`, which no access
  key writes, nor the person's notes at `key/…`, nor any other path, and no locked entry.
  Whether the key may write is the hosts' to say, and each host's refusal is passed on, so an ended
  key hears `unlisted`. A host out of credits is said as one plain refusal, with no link.
- **Other folders** (a recipient, a sender, a review's subject) are looked for at the hosts the
  person's own profiles use, and a message's own `host`, then every host the folder's profile entry
  names: that is where the profiles the person deals with live today, and a message names its
  sender's host, so a reply finds it. A profile's address names no host, and the index says where
  only in its own format, which `search` never names. Following any host anyone names would reach
  any address, so every host is reached with `publicFetch` (`src/public.ts`), which reaches only
  public addresses and follows no redirect.
- **The person's own addresses.** In every answer of every tool, each address of a profile in the
  connection becomes its label, and each pay address of a profile entry it read becomes `<label>'s
  <type> pay address`, wherever it appears.

What this copy says itself is a refusal, in plain words: an argument that does not fit, a label the
login does not act in, a path that is none, a body that does not fit, a host that took nothing, with
each host's reason.

### The links

The AI hands the person a link whenever something needs their passkey (making a profile, getting
verified, photos, proofs, their location) or is better seen than read (an offer, someone's profile, a
page of results). The Forest app's links put what they are about after `#`, which a browser never
sends to a server, and their origin is `APP_URL`'s. The app's chat builds the same strings, so they
are written exactly:

| For | Link |
|---|---|
| Make a profile | `<app>/new#market=<market>&role=<role>` |
| One of their listings | `<app>/listing#label=<label>&id=<id>` |
| A conversation, to send a photo, a proof or their location | `<app>/thread#label=<label>&with=<address>` |
| Get verified, or add the ID check | `<app>/id` |
| Which profiles the AI uses | `<app>/ai-apps` |
| Anything else: email, passkeys | `<app>/you` |

A label's `/` stays as it is; each other part is made of characters a link takes as they are. The
instructions carry these with the app's origin filled in, and the tools give the ones they know the
parts of: a listing's link (`list_my_profiles`, `post_listing`, `search`'s `mine`), a conversation's
(`read_messages`, `send_message`), the profile to make (`send_message`'s refusal). Other people's
things link to the index: a result's `url`, a profile's page at `<index>/profiles/<address>`, a
search's `page`. There is no link to buy credits or to any checkout anywhere, since OpenAI's
directory rejects one: a profile that runs out of credits is told to add credits in the Forest app.
With no `APP_URL` the instructions say the app's links are not set up here, and no answer holds one.

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
   `publicFetch`, 10 seconds, 64 KB, at each login, naming itself and the redirect it lists), or by
   `POST /register` (DCR: the `client_id` is a body holding 1 to 8 redirect addresses, its name and
   how it signs in at `/token`; unless public, `none`, it gets a secret, HMAC(key, client_id), RFC
   7591's default). Nothing is kept for either.
4. **`/authorize`** checks the client and its redirect (a bad one is a page, never a redirect),
   `response_type=code`, an S256 `code_challenge`, and `resource` if given, then sends the browser to
   `APP_URL?connector=<origin>&request=<request>`, the request being base64url of
   `{ client, name, redirect, challenge, state?, resource, exp }`, a dot, its MAC, `exp` 10 minutes
   ahead. Without `APP_URL`, it is a page saying logins wait, and reading still works.
5. **The connect page,** the app's, shows the AI app's name and this copy's origin; the person
   ticks the profiles it acts in and what it may do. On a yes the app makes the connection and sends
   the browser to `<origin>/connected?request=<request>&pointer=<pointer>`; on a no, with
   `error=access_denied`.
6. **`/connected`** checks the request is this copy's and under 10 minutes old, opens the pointer
   and checks its shape and that it names this request; else a page saying so, and no code. It sends
   the browser to the redirect with `code`, `state` and `iss`; the code carries the pointer, still
   locked, with the client, redirect, challenge and resource, for 60 seconds.
7. **`/token`** (`grant_type=authorization_code`) checks the code, the client and its secret, the
   redirect, `code_verifier` and `resource`, and gives an access token carrying the pointer, still
   locked. It has no expiry and no refresh token. A profile added to the connection needs no new
   login.

### The connection

The connection is this service's own format, which an app follows to hand this copy access keys: a
folder of the person's for each AI app, and a pointer to it, which the AI app's token carries.

- **This copy's public encryption key,** `GET /open-key`: `{ "openKey": "age1pq1…" }`, age's
  post-quantum kind, from its encryption key, readable from any page, the same while the volume
  keeps `mcp-opening.json`.
- **The connection folder** is an ordinary folder on the person's hosts, named by a key the app makes
  at random (keys/'s `newAccessKey()`, listed nowhere), so its name says and links nothing. Its
  profile entry holds only `hosts`; each other entry is locked, with folders/locked's `lock`, to the
  folder's own public encryption key and this copy's, and no other:
  - `connection`: `{ name: <the AI app's name>, secret: <32 random bytes, base64url> }`;
  - `access/<id>`, a random id, one a profile: `{ label, address, hosts, key: <its access key's 64
    bytes, base64url> }`.
- **Each access key** the app makes with `newAccessKey()` and lists in the profile entry as `{ key,
  open, can }`, with the switches the person chose (all four unless fewer, never more; `open` only with `read`
  or `read-inbox`), and notes at `key/<id>`, locked to the main key alone, as `{ key, connection, …
  }`: `connection`, the folder's key, lets any of the person's devices find it from the seed; the
  rest is the app's (the reference app's: the AI app's name, this copy's origin, the time).
- **The pointer** is an envelope's text, locked to this copy's public encryption key alone, at most
  4,096 characters: exactly `{ request: <SHA-256 of the request text, lowercase hex>, folder: <the
  folder's address>, hosts: <its 1 to 8>, secret: <the connection entry's> }`. It comes back through
  the browser, in a URL a history or a proxy's log may keep, so naming the request makes it open
  that one login only.
- **Each call that acts** opens the pointer, reads the folder from its hosts, opens `connection` and
  checks its secret, then opens the `access/` entries and acts with their keys, keeping none. No
  `connection` entry, one that does not open, or another secret: a 401, a login to make again. An
  access entry that does not open or fit, or names a profile already named, counts for nothing. A
  `search` with a login reads it the same way, at most once a request, and hears a gone one as
  `unmarked`, never a 401.
- **Adding a profile** is one more key and access entry; **removing one** ends its key, which the
  profile entry then lists with `until`, the time of the profile entry that ends it, and deletes its
  access entry and note; **ending** deletes `connection`, then removes each profile. None needs a
  new login.

[`test/app.ts`](test/app.ts), the reference app, is what the person's app does around this copy, in
plain code with the standard's libraries; the tests and the end-to-end test run it. It keeps the
person's Profiles folder (the empty label's, its `label/<id>` and `stamp/<id>` entries locked to its
own public encryption key), makes a profile with its market, role, hosts, public encryption key,
both pay addresses and a verification for each stamp, does the connect page's work, the connection
folder's first write paid as the device chooses (`pay`), finds each connection from the seed by its
notes, adds a profile or ends one, and on a new device finds the profiles and stamps from the
Profiles folder. Its wallet, the Profiles folder's balance, takes gifts and buys, and funds a folder
(`fund`): a buy paid from it by the Profiles folder's main key, spent into that folder.

## Its API

| Route | What |
|---|---|
| `/`, `/mcp` | MCP over Streamable HTTP: [the eight tools](#the-tools). `/mcp` is for connectors added before |
| `GET /open-key` | This copy's public encryption key |
| `GET /.well-known/openai-apps-challenge` | `OPENAI_APPS_CHALLENGE` as plain text, for OpenAI's domain check; 404 while it is unset |
| `GET /.well-known/oauth-protected-resource` | The resource's metadata |
| `GET /.well-known/oauth-authorization-server` | The authorization server's metadata |
| `POST /register` | Registration (DCR) |
| `GET /authorize` | Checks the login, then on to the app's connect page; with no `APP_URL`, 503 and a page saying logins wait |
| `GET /connected` | Back from the connect page with the pointer, on to the AI app with a code |
| `POST /token` | The code for an access token |
| `GET /icon.svg`, `GET /favicon.ico` | The mark |

## How we run it

- **The image:** `deploy/Dockerfile`, built from the repo root: Node 22.22.2, the standard and the
  markets at their pins (`standard.sh`), the host's credits client (`host/client/`, with its
  packages) and this directory, started as `node src/main.ts` on every address, `DATA_DIR=/data`.
- **Where:** Railway, service `mcp`, `RAILWAY_DOCKERFILE_PATH=mcp/deploy/Dockerfile`, one replica, a
  volume at `/data` holding its two keys, a public domain to `PORT`, and no health check, since the
  root answers only what an MCP client sends. `APP_URL` is the Forest app's connect page, and its
  origin is the one every app link is built on ([the links](#the-links)). Another app runs its own
  copy, and its page.
- **What it reads:** the foundation's index, the markets at `MARKETS` (from the checkout, so every
  answer comes from the commit the tests ran against), and the folders each login points to and deals
  with, on public hosts only.
- **Its numbers, and why:**
  - 10 minutes on the connect page, to unlock the device and choose; 60 seconds for a code, which the
    AI app redeems at once; no end for a login;
  - at most 4,096 characters for a pointer, one envelope to one key holding up to 8 hosts, so the
    token that carries it stays well under the 16 KB of headers Node takes;
  - at most 100 access entries opened a call, the first by path, and the newest 100 inbox entries
    and 100 sent copies a profile read: each takes a post-quantum opening, and anyone can leave
    entries in an inbox;
  - under 2,000 characters of instructions, and under 2,048 for each tool's description, checked
    when it starts: the limits of the AI apps that cut them;
  - 60 seconds for any read of the index, and the folders client's 60 for a host;
  - at most 4,194,304 bytes for an MCP request or an index's answer.
- **Free,** with no rate limit. **Keeps** only its two keys, on the volume. **Logs** one line when it
  starts, nothing for a request, and no address. Payments are the person's app's. The index and the
  hosts see this copy's network address, not the person's.
- **Public:** this code and its public encryption key. **Secret:** its two keys.
- **The icon:** the mark, drawn by `src/icon.ts` as the SVG the server declares and the ICO it
  serves.

| Variable | What it sets | Unless set |
|---|---|---|
| `DATA_DIR` | Where its two keys are kept: `mcp-key.json`, which signs its logins, and `mcp-opening.json`, its encryption key's secret; 32 random bytes each, made at the first start, readable by its own user only | needed |
| `PUBLIC_URL` | Its origin: the resource and the authorization server | https://mcp.forest.foundation |
| `APP_URL` | The app's connect page | none: logins wait |
| `INDEX_URL` | The index whose `skill.md`, search and profile pages it passes on | https://index.forest.foundation |
| `OPENAI_APPS_CHALLENGE` | What `GET /.well-known/openai-apps-challenge` answers, as plain text | none: that path is a 404 |
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
reference app), the markets package's `checkEntry` and `ask`, the host's credits client,
`@modelcontextprotocol/sdk`, `undici` for `publicFetch`, and Node's `crypto`. `test/` covers, on
loopback, with this repo's host, a stand-in index whose answers carry a field this copy has never
seen, and a stand-in connect page running the reference app: the login end to end through the MCP
SDK's own client and every refusal on its way, every tool and its refusals, on markets of its own
(`test/markets/`), so no market at `MARKETS` changes what it finds, a key ended and the
connection ended, the limits of the instructions and the descriptions, each link, OpenAI's domain
check, `publicFetch`, and the image's own command. `npm run smoke` runs the same client
(`smoke.ts`) against a deployed copy, without the login, which needs a person; CI does not, since a
check that cannot reach it would skip.

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

- **It holds no key of yours between calls, and keeps only its own two keys.** No seed and no main
  key, ever. The access keys the person's app hands it wait in the connection folder, locked to its
  public encryption key; it opens them for one call and forgets them. No login, call, connection or
  answer is written.
- **It acts only as far as the access keys a connection holds may, and only for the token whose
  secret matches.** Every host and reader checks a key against what the profile entry lists, so a key
  the person ends stops acting; a connection folder's address alone acts for no one.
- **It moves no money, and spends only the credits in the profiles the person connected, as their
  access keys allow:** what each write and message stores, from its profile's balance.
- **The AI never gets a key, nor one of the person's own addresses,** from any tool: it names each
  profile by its label.
- **What an index says is passed on as the index's word, whole but for the fields only machines
  read,** and labelled so, with every entry's words under `strangersWrote`; `read_messages` picks only
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
- **The AI sees the newest 100 inbox entries and 100 sent copies of a profile,** and cannot reach
  older ones: `read_messages` has no paging.
- **The AI writes only listings, reviews, vouches and reports,** and reads only the listings of the
  person's folders and their messages: no profile entry, no notes, no locked entry, no other path.
- **The AI cannot send a photo, a proof or a location,** or add photos to a listing: the person does,
  in the Forest app, at the link it hands them.
- **A key listed without `write` keeps no copy of what it sends.**
- **Each call that acts, and each search with a login, reads the connection from its hosts,** one
  post-quantum opening a profile; with none of the hosts answering, the tools that act refuse, and
  search marks nothing.
- **A connection folder is public:** anyone can see it exists and how many profiles it holds, never
  which.
- **Search tells the AI which results are the person's own:** `mine` names, by label, each result
  whose profile is one this login acts in.
- **A code works more than once in its 60 seconds,** only for the AI app holding its PKCE verifier.
- **The markets are the directory's at one commit:** a market added since is unknown until `MARKETS`
  moves.
- **An index's answer may hold anything,** its words in the places it chooses, and a field only
  machines read under a name this copy does not know reaches the AI: the two rules name the
  fields they know.
- **No rate limit:** anyone can keep the copy busy.
- **Not here:** paying, buying a host's credits (a profile out of credits is told to add them in the
  Forest app, with no link), putting or deleting files, views in the AI app (MCP Apps), and a copy
  on the person's own computer.
- **Railway's own request logs** hold each request's client address and path.

## FAQ

**Why does a login not expire?**
The person's profile entries already say which access keys count and what each may do. An expiry
would only send the person through the connect page again for nothing they chose, and a refresh
token no store can retire would never expire either. Ending a connection is the person's, in their
app.

**Why a secret, when the connection entry is locked to this copy?**
Anyone can read this copy's public encryption key, so anyone can lock a pointer naming someone's
connection folder, in a login of their own. Only the app that wrote the entry, and this server,
which opens it on each call, know the secret in it.

**Why does the AI send no photos, and why do its updates keep the ones a listing has?**
A photo is a file the person picks on their device and a listing names by its hash, which the Forest
app does with their passkey. So `post_listing` takes no photo field, and when it updates a listing
that has photos it carries them over itself: an AI that did not see them must not lose them. The
person adds more at the link in its answer.

**Why does `search` pass the index's answer on instead of choosing its fields?**
An index changes: its fields are reworked, and another index shows others. A copy that chose fields
would need a change each time, and would hide what a newer index adds. It names only what no
person or AI acts on (the fields only machines read) and what someone else wrote (every entry's
`body`, moved under `strangersWrote`), so those two rules hold for any index.
