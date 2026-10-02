# services

Devnet only: everything here runs on Solana's devnet or nowhere. Nothing is on mainnet, and nothing
is shipped.

## What it is

The services the Forest Foundation runs on Forest's open standard: an **index**, an **issuer**, a
**relayer** and **connections**. The foundation is one operator among many: each of these is the
foundation's first one, and anyone can run another, from this code (Apache 2.0) or their own. None
of them holds a person's key, and nothing here has user accounts: there are keys, records and rows.

| Folder | What it is | On devnet |
|---|---|---|
| [`index/`](index/README.md) | Reads the hosts it lists, the registry's rows of the keepers it trusts, and the escrow's receipts; scores each profile; serves pages for people and JSON for AI agents | Running |
| [`issuer/`](issuer/README.md) | The keeper of the human list: a face check once per person, then their stamp on a list it publishes with signed snapshots | Running, with a stand-in face check that passes everyone |
| [`relayer/`](relayer/README.md) | Kora, configured: co-signs a person's registry or escrow transaction and charges what it costs, in the token they pay with | Running, paid in two test dollars |
| [`connections/`](connections/README.md) | An MCP server: an assistant connects with OAuth and posts offers and reviews through a writer key the person lists | Running |
| [`e2e/`](e2e/README.md) | Forest end to end on devnet, against these services | Run by hand; passed on 2026-10-02 |
| [`e2e/host/`](e2e/host/README.md) | A host for devnet testing only: forest's reference host | Running |

## How it works

```
                face check (Didit), stamp
  person's app ─────────────────────────────▶ issuer ── list.json: stamps, signed snapshots ──▶ apps
       │
       │ transaction: a row, a payment
       └──────────▶ relayer ── co-signs, sends ──▶ Solana: registry rows, escrow
                                                        │ rows, receipts
  assistant ── MCP ──▶ connections                      ▼
                         │ writer key signs           index ──▶ pages, JSON
  person's app ──────────┴── records ──▶ hosts ── what's new ──▶ index
```

1. **A row.** The person's app makes a seed from 24 words, and from it the profile's key and a stamp
   for a keeper. The issuer checks their face once and puts the stamp on its list. The app proves
   against the list's newest snapshot and sends one row to the registry through the relayer: under a
   label such as `tutoring/seller`, carrying the keeper's signature on the root.
2. **Records.** The person's app signs every record with the profile's key and posts it to the hosts
   the profile's hosts record names. An assistant can post offers and reviews through connections,
   signed by a writer key the person lists in the profile's permissions record. A private record
   only its readers open.
3. **Payment.** A buyer pays into an escrow through the relayer; the money moves only as the escrow
   allows. The relayer is paid back what the transaction cost it, in the token the buyer paid with.
4. **Reading.** The index reads its hosts in full, the rows of the keepers it trusts and the
   escrow's own events, scores each counted profile, and serves every page as HTML and as JSON.

Each arrow is open: an app can use another issuer, relayer, host or index, and each reader decides
which keepers it trusts.

### What this repo is not

- **Not the standard.** Keys, records, the registry and the escrow live in
  [foundationforest/forest](https://github.com/foundationforest/forest). This repo uses forest's
  pieces unchanged, at one pinned commit.
- **Not a host.** Hosts are run by apps; the foundation runs none. `e2e/host/` is for devnet testing
  only.
- **Not an app.** Apps live in their own repos.
- **Not the market directory.** The recommended market names live in
  [foundationforest/markets](https://github.com/foundationforest/markets).

### Forest, pinned

`FOREST` holds one forest commit. `./forest.sh` fetches forest at that commit into `forest/` (not
committed), then runs `npm ci` in each forest package named after it. Every `forest/…` path here
means forest at that commit, and each service imports what it needs by relative path. Each folder's
README says which packages it needs.

### Run the checks

What [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs on every pull request and
on `main`, from a clean install. Node 22.18 or later; the index's tests need a Postgres
(`DATABASE_URL`).

```sh
./forest.sh keys records registry/client escrow/client

(cd issuer      && npm ci && npm run check && npm test)
(cd connections && npm ci && npm run check && npm test)
(cd e2e/host    && npm ci && npm run check && npm test)
(cd e2e         && npm ci && npm run check)
(cd relayer     && npm ci && npm run check) && bash relayer/deploy/devnet-config.sh relayer/kora.toml > /dev/null
(cd index       && npm ci && npm run check && \
  node --test --test-force-exit test/markets.test.ts test/scoring.test.ts test/sign.test.ts test/pages.test.ts)
```

A test that cannot find what it needs skips; the workflow fails on any skip. Not in CI: the index's
end-to-end test and the relayer's local run, which need forest's programs built, its proving files,
a local validator and (for the relayer) Kora built; and the e2e run, which needs the devnet phrase.
Each folder's README says how to run them.

### On devnet

Five services on Railway, project `forest-devnet`, environment `production`, each built from this
repo's `main` and redeployed on every push to it. Each folder's README lists its settings.

| Service | Address | Railway id | Dockerfile | Volume |
|---|---|---|---|---|
| `index` | https://index-production-1b6e.up.railway.app | `37f23042-b2a0-4ff0-90c6-e0521fc811d2` | `index/deploy/Dockerfile` | none: Postgres on Supabase |
| `issuer` | https://issuer-production-4976.up.railway.app | `9a9538d9-1a79-4860-9705-c85b8b538306` | `issuer/deploy/Dockerfile` | `/data` |
| `relayer` | https://relayer-production-8d40.up.railway.app | `05e3d61b-7052-45cf-98f0-8928628425b7` | `relayer/deploy/Dockerfile` | none |
| `connections` | https://connections-production-ebc4.up.railway.app | `5f024a9d-b760-4a5a-8613-0ae014b12661` | `connections/deploy/Dockerfile` | `/data` |
| `board-devnet-test`, the test host | https://board-devnet-test-production.up.railway.app | `6bc0708f-1171-4c93-a47e-56e5bcd82685` | `e2e/host/deploy/Dockerfile` | `/data` |

| On devnet | Address |
|---|---|
| The registry | `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC` (forest's `registry/devnet/devnet.json`) |
| The escrow | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` (forest's `escrow/devnet/devnet.json`) |
| The classic test dollar (six decimals) | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` |
| The Open-USD-shaped test dollar (Token-2022 with Open USD's extensions, six decimals) | `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz` |
| The keeper, the issuer's key | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` |
| The relayer's key (`payer`) | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` |
| The deploy key, which pays e2e's setup | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` |

Every key is derived from the devnet phrase by the recipe in forest's `devnet/deploy.sh` scripts;
none is in this repo. The first escrow, `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR`, was closed on
2026-10-02 and its 1.43794988 SOL deposit returned to the deploy key
([`4uXu5XR…`](https://explorer.solana.com/tx/4uXu5XR1Q9XMfofLtTs7itdACXVRqFppBnMZxQDfKLnq1KC3nJgy7erzZZvJPr6xEoHXkH8ApEGEPmohHfXLK9ta?cluster=devnet)).

Open in a browser: [the index](https://index-production-1b6e.up.railway.app/), the latest e2e run's
[seller](https://index-production-1b6e.up.railway.app/profiles/9mri3A3NyUGjKQH8cfByYfEWCtGALiPBhnBCQLQfovnN)
and [deal](https://index-production-1b6e.up.railway.app/deals/3zmphLyirt3mG1yyQseu6xCbqqxxmE72QprnNXdMroKF),
[the issuer's list](https://issuer-production-4976.up.railway.app/list.json).

## Promises

These hold for every service here; each README adds its own.

- **Keys never leave the person's device.** No service here holds, asks for or signs with a
  profile's key.
- **No accounts.** There are keys, records and rows.
- **No address logs in this code.** No service here keeps a network address. A hosting provider's
  own request logs are the operator's choice; on Railway they exist.
- **Charges are costs.** The relayer charges what a transaction costs it, with no margin, and pays
  for no one. Nothing else here charges anything.
- **Reputation is per profile.** Nothing here links one person's profiles, and nothing server-side
  holds a person next to a profile.
- **Never on chain:** seeds, private keys, records, keepers' lists, the index.

## Limits

- **Devnet only.** The face check is a stand-in, the dollars are test dollars, and every service is
  one replica on Railway.
- **The services trust what they read:** the index its lists, the issuer Didit, connections the
  hosts. Each README says how.

## FAQ

**Why is forest pinned by `forest.sh`, and not a submodule or a copy?**
Railway builds every image from the repo root, and a copy would drift from forest. One commit in
one file is the whole pin, and moving it is a one-line pull request.

**Why does CI fail on a skipped test?**
A test skips when a piece it needs is missing. A missing piece must never pass as green.

**Why one repo for four services?**
They share one forest pin, one CI and one devnet. Each folder stands alone: its own package, its
own Dockerfile, its own README.

**Who changes the promises?**
The promises in each README change only when Carlos says so in a chat.
