# services

The first services on Forest's open standard, [forest](https://github.com/foundationforest/forest):
an issuer, a registry payer, a fee payer, a host, an index, and a CLI, with a hosted copy for AI
chats. The Forest Foundation runs all six, on devnet. Anyone can run another of each, from this
code (Apache 2.0) or their own.

The foundation writes forest, and runs the first of each service until there are others
([forest's pieces](https://github.com/foundationforest/forest/blob/main/README.md#the-pieces)).
The body that writes the standard runs the first of each, so no second body ever has a reason to
lock people in, and it should want to lose each one: a person's seed, keys and records live with
them, so each service must stay good, cheap and open, or people leave. One name, one set of books;
the foundation has no shareholders and pays nothing out.

## The services

| Service | What it does | On devnet | Directory |
|---|---|---|---|
| issuer | Checks once, by face, that a person is one real human, and signs them a note; a second check, by face and a government document, signs the same note at tier 2. At the first note, it pays for the person's first credits | https://issuer.devnet.forest.foundation | [`issuer/`](issuer/README.md) |
| registry payer | Pays for a person's registry row against one of its credits, which anyone can buy for them | https://registry-payer.devnet.forest.foundation | [`fee-payer/registry/`](fee-payer/registry/README.md) |
| fee payer | Pays Solana's costs for a person's transactions at cost, in the dollar they hold | https://fee-payer.devnet.forest.foundation | [`fee-payer/`](fee-payer/README.md) |
| host | Keeps people's signed records, messages and photos, paid for in its credits, and serves them to anyone: forest's reference host, with its policy | https://host.devnet.forest.foundation | [`host/`](host/README.md) |
| index | Reads the hosts it lists, the registry's rows of the issuers it trusts, and the escrow's receipts; scores each profile; publishes its ratings as a reputation tree; serves pages for people and JSON for AI agents | https://index.devnet.forest.foundation | [`index/`](index/README.md) |
| mcp | The CLI: Forest's actions as typed commands and as MCP tools; hosted, for AI chats that cannot run a program on the person's device | https://mcp.devnet.forest.foundation/mcp | [`mcp/`](mcp/README.md) |

[`e2e/`](e2e/README.md) runs the loop below end to end on devnet, against these services, by hand.
None of them holds a person's main key, and nothing here has user accounts: there are keys,
records and rows.

## Who decides what

- **The standard (forest):** what every service here must agree on, at the pinned commit.
- **Each service, by its own policy:** what its README's Policy section says; whoever runs it
  changes it.
- **An app, with the person:** which host, issuer, registry payer, fee payer and index to use.
- **Promises:** the promises in each README change only when Carlos says so in a chat.

## How it works

```
             face, then face and ID (Didit), note number, pay links
  person's app ─────────────────────────────▶ issuer ── a note back; pays for first credits
       │
       │ a row and a credit            registry payer ──┐
       ├──────────────────────────────────▶            ├─ co-signs, sends ──▶ Solana: registry
       │ a payment, paid at cost       fee payer ───────┘                       rows, escrow
       └──────────────────────────────────▶                                      │ rows, receipts
  assistant (the CLI) ───────┐                                                   ▼
                             │ access keys sign                               index ──▶ pages, JSON
  person's app ──────────────┴── records, paid in credits ──▶ host ── what's new ──▶ index
```

A person's app holds their seed, and mixes from it a main key for each label, such as
`tutoring/seller`
([forest's keys](https://github.com/foundationforest/forest/blob/main/keys/README.md)). Then:

1. **A note.** The issuer checks the person's face once and signs a note for their note number, at
   tier 1; a document check later signs the same note at tier 2. With the first note it pays for
   the person's first credits, which their app bought: a few registrations at the registry payer,
   and writes at the host
   ([standard's credits](https://github.com/foundationforest/standard/blob/main/credits/README.md)).
2. **A row.** From the note, the app makes a person proof on the device and writes one row in the
   registry
   ([forest's registry](https://github.com/foundationforest/forest/blob/main/registry/README.md)),
   through the registry payer with one of its credits, or through the fee payer, paid in a dollar.
3. **Records.** The app signs the profile's records with the main key and posts them to the hosts
   its hosts record names; the host takes each write's price from the folder's balance of credits.
   It makes access keys for the person's AI assistant and lists them in the profile's permissions
   record
   ([forest's records](https://github.com/foundationforest/forest/blob/main/records/README.md#permissions));
   with them, through the CLI ([`mcp/`](mcp/README.md)), the assistant posts offers and reviews,
   answers messages, and asks the person, through their own inbox, for what it holds no key for.
4. **A deal.** A buyer pays into an escrow through the fee payer, and the money moves only as the
   escrow allows
   ([forest's escrow](https://github.com/foundationforest/forest/blob/main/escrow/README.md)).
5. **Scores.** The index reads the host, the rows of the issuers it trusts and the escrow's
   receipts, scores each profile, and serves every page as HTML and as JSON. It publishes its
   ratings as a tree; the seller's app proves its rating from it on the device and puts the proof
   on its card, and the index shows it.

Each arrow is open: an app can use another issuer, registry payer, fee payer, host or index, and
each reader decides which issuers it trusts.

### What this repo is not

- **Not the standard.** Keys, records, the registry and the escrow live in
  [foundationforest/forest](https://github.com/foundationforest/forest). This repo uses forest's
  pieces unchanged, at one pinned commit.
- **Not an app.** Apps live in their own repos; the Forest app's is
  [foundationforest/app](https://github.com/foundationforest/app).
- **Not the market directory.** The recommended market names live in
  [foundationforest/markets](https://github.com/foundationforest/markets).

### Forest, pinned

`STANDARD` holds one forest commit. `./standard.sh` fetches forest, from
[foundationforest/standard](https://github.com/foundationforest/standard), at that commit into
`standard/` (not committed), then runs `npm ci` in each forest package named after it. Every
`standard/…` path here means forest at that commit, and each service imports what it needs by
relative path. Each directory's README says which packages it needs.

A change one of forest's pieces needs is made in forest first; then `STANDARD` moves, in a pull
request here that fixes every service the move touches and keeps every README true.

### Run the checks

What [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs on every pull request and
on `main`, from a clean install. Node 22.18 or later; the index's tests need a Postgres
(`DATABASE_URL`).

```sh
./standard.sh keys records registry/client escrow/client reputation/client credits
(cd standard/reputation/circuit && npm run fetch)

(cd host        && npm ci && npm run check && npm test)
(cd issuer      && npm ci && npm run fetch && npm run check && npm test)
(cd mcp         && npm ci && npm run check && npm test)
(cd e2e         && npm ci && npm run check)
(cd fee-payer/at-cost  && npm ci && npm run check) && bash fee-payer/deploy/devnet-config.sh fee-payer/at-cost/kora.toml > /dev/null \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/registry/kora.toml > /dev/null
(cd fee-payer/registry && npm ci && npm run check && npm test)
(cd index       && npm ci && npm run check && \
  node --test --test-force-exit test/markets.test.ts test/scoring.test.ts test/sign.test.ts test/server.test.ts test/pages.test.ts test/reputation.test.ts test/tiers.test.ts)
```

A test that cannot find what it needs skips, and the workflow fails on any skip, so a missing piece
never passes as green. Not in CI: the index's end-to-end test and the fee payer's local run, which
need forest's programs built, its proving files, a local validator and (for the fee payer) Kora
built; the e2e run, which needs the devnet phrase; and the smoke run against the deployed `mcp`.
Each directory's README says how to run them.

### On devnet

Six services on Railway, project `forest-devnet`, environment `production`. Each is one replica,
built from its directory's `deploy/Dockerfile` (the registry payer's, `fee-payer/deploy/registry.Dockerfile`)
on this repo's `main` and redeployed on every push to it; each directory's README lists its
settings and its volume. Railway's service ids: `issuer`
`9a9538d9-1a79-4860-9705-c85b8b538306`, `fee payer` `05e3d61b-7052-45cf-98f0-8928628425b7`, `host`
`6bc0708f-1171-4c93-a47e-56e5bcd82685`, `index` `37f23042-b2a0-4ff0-90c6-e0521fc811d2`, `mcp`
`34faba28-5014-491e-aa81-f4c3d1b84e98`, `registry payer` `bcca22db-92e4-41b2-ae04-f673d93c7a0b`.

| On devnet | Address |
|---|---|
| The registry | `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4` (forest's `registry/devnet/devnet.json`) |
| The escrow | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` (forest's `escrow/devnet/devnet.json`) |
| The classic test dollar (six decimals) | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` |
| The Open-USD-shaped test dollar (Token-2022 with Open USD's extensions, six decimals) | `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz` |
| The issuer's name, which each person's secret for it is mixed from | `issuer.devnet.forest.foundation` |
| The issuer's seed, the devnet `issuer` key, which signs nothing itself | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` |
| The issuer's note key, mixed from its seed under `issuer/notes` (Baby Jubjub, x then y) | `2185f564303f0c1cd8efdb1e35e59cc128f388f1da07511a412c186b6bb5b4bf186ac19097701f2619d447c5cd68484674e48194dd7ed4d025b20ea9d063a549` |
| The address the document check's price is paid to once one is set, mixed from the issuer's seed under `payments` | `3Ht8GtvWYJi1bUFvWL53gPuV77VZmmpnSDzWPCf6xEiH` |
| The issuer's `credits` key, mixed from its seed under `credits`, which pays the welcome gift | `AWnaPYoUSbBHKqmhre77yrtfETysvYyw6j8cP5PkYSzK` |
| The registry payer's key, which its credits are paid to: a random key made for it, not mixed from the devnet phrase | `7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA` |
| The fee payer's key, the devnet `payer` key | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` |
| The address the host's credits are paid to, the devnet `host` key's; the host never signs with it | `2JuNCurwpbDj4YDaMEPQprnGod5cAJFZrAdqHVQogyr9` |
| The deploy key, which pays e2e's setup | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` |

Every key but the registry payer's is derived from the devnet phrase by the recipe in forest's
`devnet/deploy.sh` scripts, and the issuer's note key, payments address and `credits` key from its
seed, by forest's `hkdf` and `mainKey`; the registry payer's is random. None is in this repo. Open in a browser: [the index](https://index.devnet.forest.foundation/) and
[who the issuer is](https://issuer.devnet.forest.foundation/issuer.json); the latest e2e run's
seller and deal are in [`e2e/`](e2e/README.md).

## Promises

Forest's own [promises](https://github.com/foundationforest/forest/blob/main/README.md#promises)
hold here, and what never goes on chain is in its
[privacy](https://github.com/foundationforest/forest/blob/main/README.md#privacy-honestly).
Each README holds its service's own promises. One holds for all of them:

- **Everything here competes.** Anyone can run another of each; prices and margins are each
  service's own policy, written in its README.

## Limits

- **Devnet only.** Nothing is on mainnet, and nothing is shipped. The issuer's two checks are a
  stand-in that passes everyone, so notes, and the welcome gift's credits, are unlimited; the
  dollars are test dollars, which their maker mints at will, so credits bought with them are
  unlimited too; every service is one replica on Railway.
- **One foundation runs the issuer, the registry payer and the host.** Credits are signed blind, so
  no service can tell from a credit which buy it came from; but a buy the issuer paid, collected and
  spent soon after from one network address, can be tied together by whoever sees all three
  (standard's [credits, Limits](https://github.com/foundationforest/standard/blob/main/credits/README.md#limits)).
- **The services trust what they read:** the index its lists, the issuer Didit and its RPC, the
  host its RPC and, for a message key's message, the sender's host. Each README says how.

## FAQ

**What of what the foundation runs is public?**
Everything but its secrets and what it keeps private for people:

- **Public:** this code and every setting these READMEs list; the issuer's name and note key;
  every record on the host (a private record as an envelope only its readers open); the
  registry's rows and the escrow's receipts, on chain; the index's pages, JSON and reputation tree;
  and each e2e run's record.
- **Secret:** the signing keys (the registry payer's, the fee payer's, the issuer's, the index's),
  the credit keys (the registry payer's, the host's), the devnet phrase, the API keys and keyed URLs
  (Didit's, the RPC's), and the keys to the host's bucket.
- **Private by design:** what the issuer keeps ([issuer](issuer/README.md#what-it-keeps-and-why)),
  and the messages in an inbox, which only the recipient's main key, or a message key it lists,
  pulls, and only its inbox key and the read keys it lists open.
- **Kept, not published:** the registry payer's and the host's spent lists (the id of each spent
  credit), the host's balance of each folder, the issuer's list of note numbers given a gift, and
  Railway's own request logs.

**Why is forest pinned by `standard.sh`, and not a submodule or a copy?**
Railway builds every image from the repo root, and a copy would drift from forest. One commit in
one file is the whole pin, and moving it is a one-line change plus whatever it touches.

**Why one repo for six services?**
They share one forest pin, one CI and one devnet. Each directory stands alone: its own package, its
own Dockerfile, its own README.
