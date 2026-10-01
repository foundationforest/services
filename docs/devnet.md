# Devnet

What runs on Solana devnet from this repo, where, and what you can open to see it. **Devnet only,
and nothing is shipped:** test keys, two test dollars, and a stand-in face check that passes
everyone. Read 2026-10-01, after the 04:36 UTC run.

## Open these in a browser

| What | Link |
|---|---|
| The index's home | https://index-production-1b6e.up.railway.app/ |
| The tutoring market, with the loop's offers | https://index-production-1b6e.up.railway.app/markets/tutoring |
| The loop's seller (run of 04:36 UTC on 2026-10-01): badge, rating, standing, offer, two reviews | https://index-production-1b6e.up.railway.app/profiles/did:key:z6MkrbM5tgcLEiukotxsm9PRonM8cTmXcyubMomgbPj3N9cD |
| The loop's buyer: badge, rating, standing, two reviews | https://index-production-1b6e.up.railway.app/profiles/did:key:z6MkrTEXxukPgwHvTtM2QREcK7sPBpiHs2TX4mLvpCLCG9Uq |
| Deal 1, USDC-shaped dollar, one tap: the receipt and both reviews | https://index-production-1b6e.up.railway.app/deals/3xSr9wWVssLaHpdvL16DoRZxa1zmQpyM4qqspyJZVXDd |
| Deal 2, Open-USD-shaped dollar, pay then release | https://index-production-1b6e.up.railway.app/deals/GSE7R6Hnj1Weckbe5tT5ZQykeZiH7n9aag4N5URaMeo8 |
| Any page as data: add `.json` | https://index-production-1b6e.up.railway.app/profiles/did:key:z6MkrbM5tgcLEiukotxsm9PRonM8cTmXcyubMomgbPj3N9cD.json |
| What the approval page shows for a draft (below) | [an offer draft for the loop's seller](https://connections-production-ebc4.up.railway.app/approve#eyJib2R5Ijp7ImNyZWF0ZWRBdCI6IjIwMjYtMTAtMDFUMDA6MDA6MDBaIiwiZGVzY3JpcHRpb24iOiJPbmUgZXZlbmluZyBob3VyIG9mIG1hdGhzIHR1dG9yaW5nLCBvbmxpbmUuIEEgZGV2bmV0IHRlc3QgZHJhZnQuIiwiZGlyZWN0aW9uIjoib2ZmZXIiLCJwcmljZSI6eyJhbW91bnQiOiIxIiwibWludCI6IkoyUUJBQ2ZQUGIxeXMyVXlHeDNlY1hIZ0NyNGhXdUhGVDNDMk5yNlRTVlNhIiwicGVyIjoiaG91ciJ9LCJyZW1vdGUiOnRydWV9LCJob3N0cyI6WyJodHRwczovL2JvYXJkLWRldm5ldC10ZXN0LXByb2R1Y3Rpb24udXAucmFpbHdheS5hcHAiXSwicGF0aCI6Im9mZmVyL2V2ZW5pbmciLCJwcm9maWxlIjoiZGlkOmtleTp6Nk1rZ3djYXFHM1FCRXRFbnBuWmlOM0ZES1Zad1ZiUlJDOTRqSjFmQjhkTkVGZ0ciLCJ2IjoxfQ) |
| The issuer's list and its signed roots | https://issuer-production-4976.up.railway.app/list.json and https://issuer-production-4976.up.railway.app/roots.json |
| The issuer's list on chain: every note its key signed, each a root with its batch's members (and the four older memos, roots alone) | https://explorer.solana.com/address/7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7?cluster=devnet |
| The test board's label, and everything on it | https://board-devnet-test-production.up.railway.app/ and https://board-devnet-test-production.up.railway.app/v1/entries |
| The approval page's bundle hash and libraries | https://connections-production-ebc4.up.railway.app/approve.js.sha256 and https://connections-production-ebc4.up.railway.app/approve.deps.txt |

**The approval link** shows the draft as plain text: "Publish offer/evening:", then each field,
and "For your profile ending …FgG". It belongs to the loop's test seller, whose passkey lived in a
virtual authenticator that is gone, so Approve cannot succeed from any real phone: the page will
ask for a passkey on its origin and then say the profile is not yours. Decline signs nothing.

## The services

All in the Railway project `forest-devnet` (Hobby plan), environment `production`, each redeployed
on every push to the branch it builds. Since 2026-10-01 04:33 UTC, `issuer`, `relayer` and `index`
build this repo's branch `claude/quirky-bell-d1kjcj`; `connections` and `board-devnet-test` build
`main`. **After that pull request merges, the three must be switched back to `main`** (one setting
per service), or they keep building the branch.

| Service | Public URL | What answers there | Built from |
|---|---|---|---|
| index | https://index-production-1b6e.up.railway.app | every page and its `.json` twin, `/sitemap.xml`, `/llms.txt`, `/skill.md` | `index/deploy/Dockerfile` |
| issuer | https://issuer-production-4976.up.railway.app | `POST /session`, `/submit`, `/status`; `GET /list.json`, `/roots.json`; each batch on chain in notes | `issuer/deploy/Dockerfile` |
| relayer | https://relayer-production-8d40.up.railway.app | Kora's JSON-RPC at `/` (POST), `GET /liveness`; signs as `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` | `relayer/deploy/Dockerfile` |
| connections | https://connections-production-ebc4.up.railway.app | MCP at `/mcp` (POST); the approval page at `/approve` | `connections/deploy/Dockerfile` |
| board-devnet-test | https://board-devnet-test-production.up.railway.app | forest's host: `GET`/`POST /v1/entries`; `GET /` says it is for devnet testing only | `loop/board/deploy/Dockerfile` |

| Service | Railway id | Volume | Sealed variables |
|---|---|---|---|
| index | `37f23042-b2a0-4ff0-90c6-e0521fc811d2` | none | `DATABASE_URL`, `INDEX_SIGNING_SEED`, `SOLANA_RPC_URL` (kept from before) |
| issuer | `9a9538d9-1a79-4860-9705-c85b8b538306` | `/data`, new | `ISSUER_KEYPAIR` (devnet `issuer` key), `SOLANA_RPC_URL` |
| relayer | `05e3d61b-7052-45cf-98f0-8928628425b7` | none | `FOREST_RELAYER_KEY` (devnet `payer` key), `RPC_URL` |
| connections | `5f024a9d-b760-4a5a-8613-0ae014b12661` | none | none |
| board-devnet-test | `6bc0708f-1171-4c93-a47e-56e5bcd82685` | `/data`, new | `SOLANA_RPC_URL` |

- **Secrets** were set sealed through Railway's API and checked against its list of names and seal
  flags; no value was printed. The RPC variables are Helius's devnet URL, which holds its key.
- **The index kept its service, domain, Postgres (Supabase `forest-devnet`) and signing seed**; only
  its source moved here. Its migrations cleared what the earlier build stored.
- **The issuer has no Didit key,** so `issuer/deploy/start.sh` runs the stand-in face check: every
  session passes. Its list started empty on 2026-09-30.
- **The issuer's list is whole on chain:** this version wrote the four earlier batches again, with
  their members, at start (four notes); each batch since writes its own. Its key paid 5,000
  lamports a note.
- **Wiring:** the index reads the board (`HOSTS`), the issuer's roots file and its notes, and
  devnet's registry `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf`, escrow v1
  `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` and escrow v2
  `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`. Connections reads the board and links to its own
  `/approve`. The relayer allows those three programs and is paid in the USDC-shaped
  (`J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa`) or the Open-USD-shaped
  (`g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz`) test dollar, at Kora's mock price (one base unit
  buys one lamport). On mainnet its `kora.toml` takes USDC, USDT, Open USD and EURC; devnet has
  only the two test dollars.

**Retired on 2026-09-30:** `host`, `carrier`, the earlier `issuer` and `feepayer`, built from
forest's deleted `deploy/`. Their services are deleted. Their three volumes (`host-volume`,
`carrier-volume`, `issuer-volume`) are pending deletion in Railway until 2026-10-02 23:25 UTC,
restorable until then. The earlier issuer's sealed Didit key and workflow went with its service.

## The loop's run

`loop/loop.ts` (`loop/README.md`), on 2026-10-01 from 04:36:04 to 04:39:17 UTC, against the issuer,
relayer and index built from `claude/quirky-bell-d1kjcj`: **passed**, in 3 minutes 13 seconds. Its
record, with every address and signature, is `loop/runs/2026-10-01T04-36-04-193Z.json`.

| Step | What happened |
|---|---|
| People | Two virtual passkeys on the approval page's origin. Seller `did:key:z6MkrbM5tgcLEiukotxsm9PRonM8cTmXcyubMomgbPj3N9cD` (wallet `D963JSMtuBRHhQ8B5aRaxgo8ntVgD6fEfnrkm7m2Svpq`), buyer `did:key:z6MkrTEXxukPgwHvTtM2QREcK7sPBpiHs2TX4mLvpCLCG9Uq` (wallet `CzyVNfVxMPoTMPWKirGmU2KPNFSST9DANkRzyvNBLvhT`) |
| Setup | Their dollar accounts (`2dETF3…`), 5.00 USDC-shaped to the seller, 15.00 USDC-shaped and 10.00 Open-USD-shaped to the buyer (`4NMskK…`); the deploy key paid |
| The list | Both through the stand-in face check, listed by the next batch: 10 members, root `21013713…729715149`, size 10. Roots file canonical and signed by `did:key:z6MkmSeF…PLFV`; its newest root is the list's |
| The batch on chain | One note, the root with the batch's two members: [`2comvBb…di1w9rx`](https://explorer.solana.com/tx/2comvBbGDRYCRRWe4Hr16KRXwALHTWH7hZQiB1w73XwS2GskpL6FctUiiJ4uuVQ5kAykYjwyPnpAbN1R8di1w9rx?cluster=devnet) |
| **The list from the chain alone** | Every note the issuer's key signed, read from devnet: 5 notes (the four rewritten batches and this one) rebuild 10 members, equal to `list.json`; each of the 5 roots in the roots file is forest's `listRoot` of its prefix of the rebuilt list, and a note names each |
| Badges, through the relayer | `tutoring/seller`, line `E2uZSFgdU4NWf1pjvZnuRDXTNshR7a8t2rgef6jAdp5E`, [`32rCCss…`](https://explorer.solana.com/tx/32rCCssSooGiDU4swzp2xYnP9mg9VgAexPW4wFwygFEEM2fWgkLo9YVnyLdKWZr1x31NRLukEMi63cXd1U4CN7MM?cluster=devnet), 731 bytes, charged 1.49336 USDC-shaped; `tutoring/buyer`, line `5XG2Xcyja1CjSuoTMsRD3eKmKXwS8aB1Xc1WveQZcbMh`, [`3kzDWbF…`](https://explorer.solana.com/tx/3kzDWbFytJERAmNCRAizzpXQex3KpNRK1CEFj1R76GwKAbkZywhapbppBdMzGJmfJ319fse2MwzbueWwUPsA8EM?cluster=devnet), charged 1.48828 |
| Records, through approvals | Each folder written by the app; each profile, the seller's `offer/maths` (1 USDC-shaped dollar an hour) and the four reviews drafted through connections' MCP, opened on the approval page, approved with the passkey, and published |
| Deal 1, USDC-shaped | Escrow `3xSr9wWVssLaHpdvL16DoRZxa1zmQpyM4qqspyJZVXDd`, 1.00, one tap in one transaction, [`57goG8T…`](https://explorer.solana.com/tx/57goG8ToYVMYNDy8sbKuic7i48jjvdxWiw3HWhRq4SuXmxY9Woov1gr9NCDyNnu1Qbhpuwfq3jArfkq5RAdEHBCS?cluster=devnet), 715 bytes; the relayer charged 3.69808 USDC-shaped |
| Deal 2, Open-USD-shaped | Kora refused the one tap as one transaction (`Account DGErqHEv… not found`, below); then escrow `GSE7R6Hnj1Weckbe5tT5ZQykeZiH7n9aag4N5URaMeo8`, 1.00: pay [`4UQ6tuy…`](https://explorer.solana.com/tx/4UQ6tuyp2Bu5tL3UKFGyDPpe6ACVcu2fUrvbnJPnGFGmae4EnHkmhKNmdDsNXfo8vq4TooHeSyCYwMfPqNrk4VYJ?cluster=devnet), charged 3.76920 Open-USD-shaped; release [`4bsc1Bw…`](https://explorer.solana.com/tx/4bsc1BwEMbhznhJ8wYiPK4bHsjV547iRCqRtST4PrA5F38928tfU8oXrMHstyD8xFszkDEfzVf6dzAHiXdePhhoy?cluster=devnet), charged 0.01 |
| Reviews | Each side reviewed each deal, naming its escrow |
| The index | Both badges counted, vouched by "Forest Foundation (devnet key)"; the offer listed; both deals `releasedToSeller`, each with two reviews; all four reviews at full weight (`oneSidedConfirmed`). Seller: rating 9.5, standing 3.16. Buyer: rating 10, standing 3.52. Its root for size 10 came with the note's transaction (`2comvBb…`), read from the chain |

The relayer, redeployed from the branch, was paid in the two test dollars as before; on devnet its
`kora.toml` names only those (Kora's `getConfig`, read after the deploy).

### The Kora refusal

The loop asked Kora to sign the Open-USD-shaped one tap as one transaction (the deposit address
made at the top, `create`, `transfer_checked` in, `release_to_seller`, and the payment to the
relayer). Kora answered:

```
signAndSendTransaction: Account DGErqHEvTKWdW6mnAFcgWoCFyjmnGUZwMr1rpugfEs2x not found ""
```

`DGErqHEv…` is that escrow's deposit address, made in the same transaction (`2szQPn…` in the
23:50 run). Nothing was sent. The cause and the issue for Kora are in `kora-issue.md`.

### Earlier runs

- **2026-09-30 23:50 UTC**, the earlier build (roots on chain alone): **passed**, in 3 minutes 9
  seconds; `loop/runs/2026-09-30T23-50-54-394Z.json`. Seller
  `did:key:z6MkgwcaqG3QBEtEnpnZiN3FDKVZwVbRRC94jJ1fB8dNEFgG`, buyer
  `did:key:z6Mki8khK5wUSwt3QEJHALDo9wFWVrniqg3PHZPVyGkHiV13`; deals
  `83ETyYBYLvnaPM2anUbjEwRSdw9mXVm9z8YrTxo3JoXD` and `32oK5JLgdeSTiaP4mkD4wz77gL5mnWi3XwxuGjLZXMQy`;
  its root's memo [`SB6mA8r…`](https://explorer.solana.com/tx/SB6mA8rAruhGzH5hxHg1vAgQwGYN8iP61nyrSJ9gKzQWkd4vAnskhfm67cCuUyr8b9UZxd14rDmbaFRQahrmhSM?cluster=devnet).
- **2026-10-01 04:35 UTC**, this session: stopped at once, before anything was sent: the loop's
  headless Chromium did not yet trust this sandbox's proxy (`ERR_CERT_AUTHORITY_INVALID`). Its
  empty record was not kept.

- **23:34 UTC**, stopped at deal 1: the loop did not yet pass devnet's escrow v2 id, so Kora's
  simulation found no program. Its two people (`did:key:z6Mkku4P…AHec`, `did:key:z6MkoFiy…Eqb5`)
  hold badges, profiles and the seller an offer, and no deals.
- **23:37 UTC**, everything on chain and on the index (deals `3YRxw7J9…`, `6Qg3xDUa…`), but stopped
  by hand before writing its record: the loop's last check wanted evidence `both`, which only a
  seller-opened escrow gets. The check now asks for full weight.
- **00:02 UTC on 2026-10-01**, the final code (the script now exits when done): **passed** in 3
  minutes 11 seconds and exited 0; `loop/runs/2026-10-01T00-02-55-057Z.json`. Deals
  `Gzjb1c69S3MXqUDVJ89JstNqzBHUgjrCeFo99aXtj8YP` and `4gP63TmVo9qnJdHZRshy5hwWXGYE3HVmnAKEE9DccHTy`;
  Kora refused that run's one tap the same way (`Account H9sVLj5d… not found`).

Every run leaves its people, records and receipts on devnet for good.

## The keys

| Key | Address | SOL on 2026-10-01 |
|---|---|---|
| Deploy (pays the loop's setup) | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` | 4.819 |
| Relayer (`payer`), also the Open-USD-shaped dollar's issuer | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` | 1.037 |
| Issuer | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` (`did:key:z6MkmSeFgQp3SxoPB3qmrNFmqPaZAmjMUzmv9KViBqWtPLFV`) | 0.009945, about 2,000 more notes |

All are derived from the devnet phrase by forest's `devnet/keys.sh`; none is in this repo.
