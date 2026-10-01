# Devnet

Devnet only: this is Solana's practice network, with test SOL and test dollars and no real money.
The issuer's face check is a stand-in that passes everyone. Nothing is on mainnet, and nothing is
shipped.

Up: [the repo](../README.md). Each service's settings: its README's "Deploy" section.

Read on 2026-10-01, after the loop's run of 04:36 UTC and the deploy of `main` at 04:51 UTC.

## Open these in a browser

| What | Link |
|---|---|
| The index's home | https://index-production-1b6e.up.railway.app/ |
| The tutoring market, with the loop's offers | https://index-production-1b6e.up.railway.app/markets/tutoring |
| The latest run's seller: badge, rating, standing, offer, two reviews | https://index-production-1b6e.up.railway.app/profiles/did:key:z6MkrbM5tgcLEiukotxsm9PRonM8cTmXcyubMomgbPj3N9cD |
| The latest run's buyer | https://index-production-1b6e.up.railway.app/profiles/did:key:z6MkrTEXxukPgwHvTtM2QREcK7sPBpiHs2TX4mLvpCLCG9Uq |
| Deal 1, USDC-shaped dollar, one tap: the receipt and both reviews | https://index-production-1b6e.up.railway.app/deals/3xSr9wWVssLaHpdvL16DoRZxa1zmQpyM4qqspyJZVXDd |
| Deal 2, Open-USD-shaped dollar, pay then release | https://index-production-1b6e.up.railway.app/deals/GSE7R6Hnj1Weckbe5tT5ZQykeZiH7n9aag4N5URaMeo8 |
| Any page as data: add `.json` | https://index-production-1b6e.up.railway.app/profiles/did:key:z6MkrbM5tgcLEiukotxsm9PRonM8cTmXcyubMomgbPj3N9cD.json |
| What AI agents read first | https://index-production-1b6e.up.railway.app/llms.txt and https://index-production-1b6e.up.railway.app/skill.md |
| The issuer's list and its signed roots | https://issuer-production-4976.up.railway.app/list.json and https://issuer-production-4976.up.railway.app/roots.json |
| The issuer's list on chain: every note its key signed | https://explorer.solana.com/address/7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7?cluster=devnet |
| What the approval page shows for a draft | [an offer draft for an earlier run's seller](https://connections-production-ebc4.up.railway.app/approve#eyJib2R5Ijp7ImNyZWF0ZWRBdCI6IjIwMjYtMTAtMDFUMDA6MDA6MDBaIiwiZGVzY3JpcHRpb24iOiJPbmUgZXZlbmluZyBob3VyIG9mIG1hdGhzIHR1dG9yaW5nLCBvbmxpbmUuIEEgZGV2bmV0IHRlc3QgZHJhZnQuIiwiZGlyZWN0aW9uIjoib2ZmZXIiLCJwcmljZSI6eyJhbW91bnQiOiIxIiwibWludCI6IkoyUUJBQ2ZQUGIxeXMyVXlHeDNlY1hIZ0NyNGhXdUhGVDNDMk5yNlRTVlNhIiwicGVyIjoiaG91ciJ9LCJyZW1vdGUiOnRydWV9LCJob3N0cyI6WyJodHRwczovL2JvYXJkLWRldm5ldC10ZXN0LXByb2R1Y3Rpb24udXAucmFpbHdheS5hcHAiXSwicGF0aCI6Im9mZmVyL2V2ZW5pbmciLCJwcm9maWxlIjoiZGlkOmtleTp6Nk1rZ3djYXFHM1FCRXRFbnBuWmlOM0ZES1Zad1ZiUlJDOTRqSjFmQjhkTkVGZ0ciLCJ2IjoxfQ) |
| The approval page's bundle hash and libraries | https://connections-production-ebc4.up.railway.app/approve.js.sha256 and https://connections-production-ebc4.up.railway.app/approve.deps.txt |
| The test board, and everything on it | https://board-devnet-test-production.up.railway.app/ and https://board-devnet-test-production.up.railway.app/v1/entries |

**The approval link** shows the draft in plain text: "Publish offer/evening:", each field, and "For
your profile ending …FgG". That profile's passkey lived in a virtual authenticator that is gone, so
Approve cannot succeed from a real phone: the page asks for a passkey on its origin, then says the
profile is not yours. Decline signs nothing.

## What runs

Five services on Railway, project `forest-devnet`, environment `production`. **Every one builds this
repo's `main`** and redeploys on each push to it; all five run commit `588dc44`, deployed 2026-10-01
between 04:50 and 04:52 UTC.

| Service | Address | What answers there |
|---|---|---|
| `index` | https://index-production-1b6e.up.railway.app | Every page and its `.json` twin, `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/skill.md`. Readers and pages in one process; Postgres on Supabase |
| `issuer` | https://issuer-production-4976.up.railway.app | `POST /session`, `/submit`, `/status`; `GET /list.json`, `/roots.json`. Each batch also written on devnet in notes |
| `relayer` | https://relayer-production-8d40.up.railway.app | Kora's JSON-RPC at `/` (POST); `GET /liveness`. Signs as `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` |
| `connections` | https://connections-production-ebc4.up.railway.app | MCP at `/mcp` (POST); the approval page at `/approve` |
| `board-devnet-test` | https://board-devnet-test-production.up.railway.app | Forest's board: `GET`/`POST /v1/entries`; `GET /` says it is for devnet testing only |

| Service | Railway id | Dockerfile | Volume |
|---|---|---|---|
| `index` | `37f23042-b2a0-4ff0-90c6-e0521fc811d2` | `index/deploy/Dockerfile` | none |
| `issuer` | `9a9538d9-1a79-4860-9705-c85b8b538306` | `issuer/deploy/Dockerfile` | `/data` |
| `relayer` | `05e3d61b-7052-45cf-98f0-8928628425b7` | `relayer/deploy/Dockerfile` | none |
| `connections` | `5f024a9d-b760-4a5a-8613-0ae014b12661` | `connections/deploy/Dockerfile` | none |
| `board-devnet-test` | `6bc0708f-1171-4c93-a47e-56e5bcd82685` | `loop/board/deploy/Dockerfile` | `/data` |

Secrets are sealed in Railway and cannot be read back: the index's `DATABASE_URL` and
`INDEX_SIGNING_SEED`, the issuer's `ISSUER_KEYPAIR`, the relayer's `FOREST_RELAYER_KEY`, and the
Helius RPC URLs of the index, issuer, relayer and board, each of which holds Helius's key. The issuer has no Didit key, so its stand-in
face check runs.

**How they are wired:**

- The **index** reads the test board (`HOSTS`), the issuer's roots file and its notes on chain, and
  devnet's registry and both escrows. It trusts one issuer, the devnet issuer, at weight 1, and
  counts receipts in devnet USDC and the two test dollars.
- The **issuer** writes each batch's notes with its own key.
- The **relayer** allows devnet's registry and both escrows, and is paid in the two test dollars at
  Kora's mock price (one base unit buys one lamport).
- **Connections** reads the test board and links to its own `/approve`.
- The **test board** asks devnet's registry who holds a line, for its badged feed.

## What is on devnet

| Program | Program id |
|---|---|
| Registry | `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf` |
| Escrow v1 | `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` |
| Escrow v2 | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` |

Deployed and recorded by forest (`forest/registry/devnet/devnet.json`, `forest/devnet/devnet.json`,
`forest/escrow/v2/devnet/devnet.json`).

| Test dollar | Mint |
|---|---|
| USDC-shaped (classic SPL token, six decimals) | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` |
| Open-USD-shaped (Token-2022 with Open USD's extensions, six decimals) | `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz` |

- **The issuer's list:** 10 members and 5 roots; on chain, 5 notes with members (label
  `…/root/v2`) and 4 older memos with roots alone (`…/root/v1`).
- **The index:** 10 profiles with a counted badge in `tutoring`, and 5 live offers, all from the
  loop's runs.
- **The loop's runs:** three passing runs recorded in [`loop/runs/`](../loop/runs/). Every run
  leaves its people, records and receipts on devnet for good.

## The latest run

[`loop/loop.ts`](../loop/README.md), 2026-10-01 04:36 to 04:39 UTC: **passed** in 3 minutes 13
seconds. Its record, with every address and signature, is
[`loop/runs/2026-10-01T04-36-04-193Z.json`](../loop/runs/2026-10-01T04-36-04-193Z.json).

| Step | What happened |
|---|---|
| People | Seller `did:key:z6MkrbM5tgcLEiukotxsm9PRonM8cTmXcyubMomgbPj3N9cD`, buyer `did:key:z6MkrTEXxukPgwHvTtM2QREcK7sPBpiHs2TX4mLvpCLCG9Uq`, each a virtual passkey on the approval page's origin |
| The list | Both listed by one batch: 10 members. The batch on chain in one note, [`2comvBb…`](https://explorer.solana.com/tx/2comvBbGDRYCRRWe4Hr16KRXwALHTWH7hZQiB1w73XwS2GskpL6FctUiiJ4uuVQ5kAykYjwyPnpAbN1R8di1w9rx?cluster=devnet). The whole list rebuilt from the 5 notes on chain alone equals `list.json`, and all 5 roots match |
| Badges, through the relayer | `tutoring/seller`, [`32rCCss…`](https://explorer.solana.com/tx/32rCCssSooGiDU4swzp2xYnP9mg9VgAexPW4wFwygFEEM2fWgkLo9YVnyLdKWZr1x31NRLukEMi63cXd1U4CN7MM?cluster=devnet), charged 1.49336 test dollars; `tutoring/buyer`, [`3kzDWbF…`](https://explorer.solana.com/tx/3kzDWbFytJERAmNCRAizzpXQex3KpNRK1CEFj1R76GwKAbkZywhapbppBdMzGJmfJ319fse2MwzbueWwUPsA8EM?cluster=devnet), charged 1.48828 |
| Records, through approvals | Both profiles, the seller's offer (1 USDC-shaped dollar an hour) and four reviews, each drafted through connections, approved with the passkey and published to the test board |
| Deal 1, USDC-shaped | One tap, one transaction, [`57goG8T…`](https://explorer.solana.com/tx/57goG8ToYVMYNDy8sbKuic7i48jjvdxWiw3HWhRq4SuXmxY9Woov1gr9NCDyNnu1Qbhpuwfq3jArfkq5RAdEHBCS?cluster=devnet); the relayer charged 3.69808 |
| Deal 2, Open-USD-shaped | Kora refused the one tap as one transaction (`Account DGErqHEv… not found`, [docs/kora-issue.md](kora-issue.md)); then pay, [`4UQ6tuy…`](https://explorer.solana.com/tx/4UQ6tuyp2Bu5tL3UKFGyDPpe6ACVcu2fUrvbnJPnGFGmae4EnHkmhKNmdDsNXfo8vq4TooHeSyCYwMfPqNrk4VYJ?cluster=devnet), charged 3.76920; and release, [`4bsc1Bw…`](https://explorer.solana.com/tx/4bsc1BwEMbhznhJ8wYiPK4bHsjV547iRCqRtST4PrA5F38928tfU8oXrMHstyD8xFszkDEfzVf6dzAHiXdePhhoy?cluster=devnet), charged 0.01 |
| The index | Both badges counted, vouched for by "Forest Foundation (devnet key)"; the offer listed; both deals released to the seller, each with two reviews; all four reviews at full weight. Seller: rating 9.5, standing 3.16. Buyer: rating 10, standing 3.52 |

That run was against the issuer, relayer and index built from commit `0b917c7`, and connections
and the board from `main` at the time. `main` (`588dc44`) differs from it only in the issuer: building a
batch's notes moved inside the writer's error handling, and `listFromNotes` moved to `list.ts`. The
loop has not run against `main`.

## The keys

| Key | Address | SOL, 2026-10-01 |
|---|---|---|
| Deploy (pays the loop's setup) | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` | 4.819 |
| Relayer (`payer`); also the Open-USD-shaped dollar's issuer | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` | 1.037 |
| Issuer (`did:key:z6MkmSeFgQp3SxoPB3qmrNFmqPaZAmjMUzmv9KViBqWtPLFV`) | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` | 0.009945, about 2,000 notes |

All are derived from the devnet phrase by forest's `devnet/keys.sh`; none is in this repo.
