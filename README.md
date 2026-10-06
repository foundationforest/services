# services

The first services on Forest's open standard, [forest](https://github.com/foundationforest/forest):
a host, an issuer, a fee payer, connections and an index. The Forest Foundation runs all five. Each
is the first of its kind, and anyone can run another, from this code (Apache 2.0) or their own.

Devnet only: everything here runs on Solana's devnet or nowhere. Nothing is on mainnet, and nothing
is shipped.

## Who runs what

| Directory | What it is | Who runs it | On devnet |
|---|---|---|---|
| [`host/`](host/README.md) | Keeps people's signed records, messages and photos, and serves them to anyone: forest's reference host, with its policy | the foundation | Running |
| [`issuer/`](issuer/README.md) | Checks once, by face, that a person is one real human, and puts their stamp on a list it publishes with signed snapshots; for a person already on it, a second check, by face and a government ID, onto a second list | the foundation | Running, with a stand-in that passes everyone on both checks; the ID check free |
| [`fee-payer/`](fee-payer/README.md) | Kora, configured, at one address with two doors: the voucher door pays for a person's registry rows, free, against a voucher (three per stamp on the issuer's face list, ten per stamp on its ID list); the at-cost door pays Solana's fee for any other transaction and is paid back at cost, in the dollar the person holds | the foundation | Running, one service; paid in two test dollars |
| [`connections/`](connections/README.md) | An MCP server an AI assistant connects to with a login, so it can post for a person without ever holding a key | the foundation | Running |
| [`index/`](index/README.md) | Reads the hosts it lists, the registry's rows of the issuers it trusts, and the escrow's receipts; scores each profile; publishes its ratings as a reputation tree and shows the proofs made from it; serves pages for people and JSON for AI agents | the foundation | Running |
| [`e2e/`](e2e/README.md) | The loop, end to end on devnet, against these services | the foundation, by hand | Passed on 2026-10-06 |

None of them holds a person's main key, and nothing here has user accounts: there are keys,
records and rows.

## Who decides what

- **The standard (forest):** what every service here must agree on, at the pinned commit.
- **Each service, by its own policy:** what its README's Policy section says; the one who runs it
  changes it.
- **An app, with the person:** which host, issuer, fee payer, index and connections to use.
- **Promises:** the promises in each README change only when Carlos says so in a chat.

## How it works

```
             face, then face and ID (Didit), stamp
  person's app ─────────────────────────────▶ issuer ── two lists: stamps, signed snapshots ──▶ apps
       │
       │ transaction: a row, a payment (a row with a voucher: free)
       └────────▶ fee payer ── co-signs, sends ──▶ Solana: registry rows, escrow
                                                        │ rows, receipts
  assistant ── MCP ──▶ connections                      ▼
                         │ access key signs          index ──▶ pages, JSON
  person's app ──────────┴── records ──▶ host ── what's new ──▶ index
```

**The loop.** A person's app makes a seed from 24 words, and from it a main key for a label such as
`tutoring/seller`, and a stamp for the issuer. The issuer checks their face once and puts the stamp
on its list; the app proves against the list's newest snapshot and writes one row in the registry,
through the fee payer, paid in a dollar, or free with a voucher: a second proof from the same stamp,
three per stamp. A person on the face list may then pass the issuer's ID check, by face and a
government ID: it puts a second stamp on a second list, signed by a second key so a reader can weigh
it higher, and the app registers the same profile again against that list, with a voucher from it
(ten per stamp). The app
signs the profile's records with the main key and posts them to the host its hosts record names; an
AI assistant posts offers and reviews through connections, signed by an access key the person lists
in the profile's permissions record. A buyer pays into an escrow through the fee payer, and the
money moves only as the escrow allows. The index reads the host, the rows of the issuers it trusts
and the escrow's receipts, scores each profile, and serves every page as HTML and as JSON. It also
publishes its ratings as a tree: the seller's app proves its rating from it on the device, puts the
proof on its card, and the index shows it.
[`e2e/`](e2e/README.md) runs this loop on devnet.

Each arrow is open: an app can use another issuer, fee payer, host or index, and each reader decides
which issuers it trusts.

### What this repo is not

- **Not the standard.** Keys, records, the registry and the escrow live in
  [foundationforest/forest](https://github.com/foundationforest/forest). This repo uses forest's
  pieces unchanged, at one pinned commit.
- **Not an app.** Apps live in their own repos; the Forest app's is
  [foundationforest/app](https://github.com/foundationforest/app).
- **Not the market directory.** The recommended market names live in
  [foundationforest/markets](https://github.com/foundationforest/markets).

### Forest, pinned

`FOREST` holds one forest commit. `./forest.sh` fetches forest at that commit into `forest/` (not
committed), then runs `npm ci` in each forest package named after it. Every `forest/…` path here
means forest at that commit, and each service imports what it needs by relative path. Each
directory's README says which packages it needs.

The pin rule: a change one of forest's pieces needs is made in forest first; then `FOREST` moves, in
a pull request here that fixes every service the move touches and keeps every README true.

### Run the checks

What [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs on every pull request and
on `main`, from a clean install. Node 22.18 or later; the index's tests need a Postgres
(`DATABASE_URL`).

```sh
./forest.sh keys records registry/client registry/artifacts escrow/client circuits/reputation
(cd forest/registry/artifacts && npm run fetch)
(cd forest/circuits/reputation && npm run fetch)

(cd host        && npm ci && npm run check && npm test)
(cd issuer      && npm ci && npm run check && npm test)
(cd connections && npm ci && npm run check && npm test)
(cd e2e         && npm ci && npm run check)
(cd fee-payer   && npm ci && npm run check) && bash fee-payer/deploy/devnet-config.sh fee-payer/at-cost/kora.toml > /dev/null \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/free/kora.toml > /dev/null
(cd fee-payer/vouchers && npm ci && npm run check && npm test)
(cd index       && npm ci && npm run check && \
  node --test --test-force-exit test/markets.test.ts test/scoring.test.ts test/sign.test.ts test/pages.test.ts test/reputation.test.ts)
```

A test that cannot find what it needs skips; the workflow fails on any skip. Not in CI: the index's
end-to-end test and the fee payer's local run, which need forest's programs built, its proving
files, a local validator and (for the fee payer) Kora built; and the e2e run, which needs the devnet
phrase. Each directory's README says how to run them.

### On devnet

Five services on Railway, project `forest-devnet`, environment `production`, each built from this
repo's `main` and redeployed on every push to it. Each directory's README lists its settings.

| Service | Address | Railway id | Dockerfile | Volume |
|---|---|---|---|---|
| `index` | https://index-production-1b6e.up.railway.app | `37f23042-b2a0-4ff0-90c6-e0521fc811d2` | `index/deploy/Dockerfile` | none: Postgres on Supabase |
| `issuer` | https://issuer-production-4976.up.railway.app | `9a9538d9-1a79-4860-9705-c85b8b538306` | `issuer/deploy/Dockerfile` | `/data` |
| `fee payer` | https://relayer-production-8d40.up.railway.app, the voucher door at `/vouchers` | `05e3d61b-7052-45cf-98f0-8928628425b7` | `fee-payer/deploy/Dockerfile` | `/data` |
| `connections` | https://connections-production-ebc4.up.railway.app | `5f024a9d-b760-4a5a-8613-0ae014b12661` | `connections/deploy/Dockerfile` | `/data` |
| `host` | https://board-devnet-test-production.up.railway.app | `6bc0708f-1171-4c93-a47e-56e5bcd82685` | `host/deploy/Dockerfile` | `/data` |

| On devnet | Address |
|---|---|
| The registry | `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC` (forest's `registry/devnet/devnet.json`) |
| The escrow | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` (forest's `escrow/devnet/devnet.json`) |
| The classic test dollar (six decimals) | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` |
| The Open-USD-shaped test dollar (Token-2022 with Open USD's extensions, six decimals) | `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz` |
| The issuer's key, which signs its face list | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` |
| The issuer's ID list key, mixed from its key under `id` | `BVT1PcgV7PAUVipZzm2xP9g6qQS97vdhofvZbkJy1JX4` |
| The address the ID check's price is paid to once one is set, mixed from the issuer's key under `payments` | `3Ht8GtvWYJi1bUFvWL53gPuV77VZmmpnSDzWPCf6xEiH` |
| The fee payer's key (`payer`) | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` |
| The deploy key, which pays e2e's setup | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` |

Every key is derived from the devnet phrase by the recipe in forest's `devnet/deploy.sh` scripts, and
the issuer's other two from its key by forest's `mainKey`; none is in this repo. The first escrow,
`3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR`, was closed on 2026-10-02 and its 1.43794988 SOL
deposit returned to the deploy key
([`4uXu5XR…`](https://explorer.solana.com/tx/4uXu5XR1Q9XMfofLtTs7itdACXVRqFppBnMZxQDfKLnq1KC3nJgy7erzZZvJPr6xEoHXkH8ApEGEPmohHfXLK9ta?cluster=devnet)).

Open in a browser: [the index](https://index-production-1b6e.up.railway.app/), the latest e2e run's
[seller](https://index-production-1b6e.up.railway.app/profiles/2CJPX1FGJBRJQTvbNeCA7HL42UqNgtZxbYc5xAUFAJdS)
and [deal](https://index-production-1b6e.up.railway.app/deals/MAuZc3cm74jxJ2wGHiLxAe2uk6rFfH7TQTSB2Nct1CV),
the issuer's [face list](https://issuer-production-4976.up.railway.app/list.json) and
[ID list](https://issuer-production-4976.up.railway.app/id/list.json).

## Promises

These hold for every service here; each README adds its own.

- **Keys never leave the person's device.** No service here holds, asks for or signs with a main
  key.
- **No accounts.** There are keys, records and rows.
- **No address logs in this code.** No service here keeps a network address. A hosting provider's
  own request logs are the operator's choice; on Railway they exist.
- **Everything here competes.** Anyone can run another of each; prices and margins are each
  service's own policy, written in its README.
- **Reputation is per profile.** Nothing here links one person's profiles, and nothing server-side
  holds a person next to a profile.
- **Never on chain:** seeds, private keys, records, issuers' lists, the index.

## Limits

- **Devnet only.** The issuer's two checks are a stand-in, the dollars are test dollars, and every
  service is one replica on Railway.
- **The services trust what they read:** the index its lists, the issuer Didit and its RPC,
  connections the hosts, the host its RPC. Each README says how.

## FAQ

**Who runs what, and why one actor?**
The Forest Foundation runs every service here, and anyone can run another. The body that writes
the standard runs the first of each service, so no second body ever has a reason to lock people in.
One name, one set of books; the foundation has no shareholders and pays nothing out. A company
would exist only if outside capital or a liability ever required one, and neither does.

**What of what the foundation runs is public?**
Everything but its secrets and what it keeps private for people:

- **Public:** this code and every setting these READMEs list; the issuer's two lists and their
  snapshots; every record on the host (a private record as an envelope only its readers open); the
  registry's rows and the escrow's receipts, on chain; the index's pages, JSON and reputation tree;
  and each e2e run's record.
- **Secret:** the signing keys (the fee payer's, the issuer's, the index's), the devnet phrase, and
  the API keys and keyed URLs (Didit's, the RPC's).
- **The key holder's contents:** [connections](connections/README.md), to be renamed keyholder,
  keeps each connection's access key and the hashes of its tokens; none of it is public.
- **Private by design:** the issuer's private tables (the hash of each session id used, the stamps
  still waiting, the payments that opened ID sessions), and the messages in an inbox, which only the
  recipient's main key pulls.
- **Kept, not published:** the fee payer's used set (the market stamp of each spent voucher), and
  Railway's own request logs.

**What are we waiting on?**
Five things. Each changes something here when it comes; until then, there is nothing to do.

- **Agave 4.4** (November): Solana's rent falls about 90%, so a registry row costs about 7 cents
  and the voucher float shrinks.
- **Real Didit checks:** on devnet the issuer's stand-in passes everyone, so stamps, and vouchers,
  are unlimited; real checks bound them by faces.
- **Mainnet:** forest's programs are on devnet only, and these services with them.
- **The privacy pool in the app:** until a person pays through one, paying from their own profiles
  links them (forest's keys).
- **The UK entity:** the issuer's ID check stays free until an entity can receive its price.

**Why is forest pinned by `forest.sh`, and not a submodule or a copy?**
Railway builds every image from the repo root, and a copy would drift from forest. One commit in
one file is the whole pin, and moving it is a one-line change plus whatever it touches.

**Why does CI fail on a skipped test?**
A test skips when a piece it needs is missing. A missing piece must never pass as green.

**Why one repo for five services?**
They share one forest pin, one CI and one devnet. Each directory stands alone: its own package, its
own Dockerfile, its own README.
