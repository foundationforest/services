# Devnet

What runs on Solana devnet from this repo, where, and what you can open to see it. **Devnet only,
and nothing is shipped:** test keys, two test dollars, and a stand-in face check that passes
everyone. Read 2026-10-01.

## Open these in a browser

| What | Link |
|---|---|
| The index's home | https://index-production-1b6e.up.railway.app/ |
| The tutoring market, with the loop's offers | https://index-production-1b6e.up.railway.app/markets/tutoring |
| The loop's seller (run of 23:50 UTC): badge, rating, standing, offer, two reviews | https://index-production-1b6e.up.railway.app/profiles/did:key:z6MkgwcaqG3QBEtEnpnZiN3FDKVZwVbRRC94jJ1fB8dNEFgG |
| The loop's buyer: badge, rating, standing, two reviews | https://index-production-1b6e.up.railway.app/profiles/did:key:z6Mki8khK5wUSwt3QEJHALDo9wFWVrniqg3PHZPVyGkHiV13 |
| Deal 1, USDC-shaped dollar, one tap: the receipt and both reviews | https://index-production-1b6e.up.railway.app/deals/83ETyYBYLvnaPM2anUbjEwRSdw9mXVm9z8YrTxo3JoXD |
| Deal 2, Open-USD-shaped dollar, pay then release | https://index-production-1b6e.up.railway.app/deals/32oK5JLgdeSTiaP4mkD4wz77gL5mnWi3XwxuGjLZXMQy |
| Any page as data: add `.json` | https://index-production-1b6e.up.railway.app/profiles/did:key:z6MkgwcaqG3QBEtEnpnZiN3FDKVZwVbRRC94jJ1fB8dNEFgG.json |
| What the approval page shows for a draft (below) | [an offer draft for the loop's seller](https://connections-production-ebc4.up.railway.app/approve#eyJib2R5Ijp7ImNyZWF0ZWRBdCI6IjIwMjYtMTAtMDFUMDA6MDA6MDBaIiwiZGVzY3JpcHRpb24iOiJPbmUgZXZlbmluZyBob3VyIG9mIG1hdGhzIHR1dG9yaW5nLCBvbmxpbmUuIEEgZGV2bmV0IHRlc3QgZHJhZnQuIiwiZGlyZWN0aW9uIjoib2ZmZXIiLCJwcmljZSI6eyJhbW91bnQiOiIxIiwibWludCI6IkoyUUJBQ2ZQUGIxeXMyVXlHeDNlY1hIZ0NyNGhXdUhGVDNDMk5yNlRTVlNhIiwicGVyIjoiaG91ciJ9LCJyZW1vdGUiOnRydWV9LCJob3N0cyI6WyJodHRwczovL2JvYXJkLWRldm5ldC10ZXN0LXByb2R1Y3Rpb24udXAucmFpbHdheS5hcHAiXSwicGF0aCI6Im9mZmVyL2V2ZW5pbmciLCJwcm9maWxlIjoiZGlkOmtleTp6Nk1rZ3djYXFHM1FCRXRFbnBuWmlOM0ZES1Zad1ZiUlJDOTRqSjFmQjhkTkVGZ0ciLCJ2IjoxfQ) |
| The issuer's list and its signed roots | https://issuer-production-4976.up.railway.app/list.json and https://issuer-production-4976.up.railway.app/roots.json |
| The issuer's roots on chain: every memo its key signed | https://explorer.solana.com/address/7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7?cluster=devnet |
| The test board's label, and everything on it | https://board-devnet-test-production.up.railway.app/ and https://board-devnet-test-production.up.railway.app/v1/entries |
| The approval page's bundle hash and libraries | https://connections-production-ebc4.up.railway.app/approve.js.sha256 and https://connections-production-ebc4.up.railway.app/approve.deps.txt |

**The approval link** shows the draft as plain text: "Publish offer/evening:", then each field,
and "For your profile ending …FgG". It belongs to the loop's test seller, whose passkey lived in a
virtual authenticator that is gone, so Approve cannot succeed from any real phone: the page will
ask for a passkey on its origin and then say the profile is not yours. Decline signs nothing.

## The services

All in the Railway project `forest-devnet` (Hobby plan), environment `production`, each built from
this repo's branch `claude/happy-shannon-noxaoh` and redeployed on every push to it. **After the
pull request merges, each must be switched to `main`** (one setting per service), or they keep
building the branch.

| Service | Public URL | What answers there | Built from |
|---|---|---|---|
| index | https://index-production-1b6e.up.railway.app | every page and its `.json` twin, `/sitemap.xml`, `/llms.txt`, `/skill.md` | `index/deploy/Dockerfile` |
| issuer | https://issuer-production-4976.up.railway.app | `POST /session`, `/submit`, `/status`; `GET /list.json`, `/roots.json` | `issuer/deploy/Dockerfile` |
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
- **Wiring:** the index reads the board (`HOSTS`), the issuer's roots file and its memos, and
  devnet's registry `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf`, escrow v1
  `3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR` and escrow v2
  `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`. Connections reads the board and links to its own
  `/approve`. The relayer allows those three programs and is paid in the USDC-shaped
  (`J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa`) or the Open-USD-shaped
  (`g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz`) test dollar, at Kora's mock price (one base unit
  buys one lamport).

**Retired on 2026-09-30:** `host`, `carrier`, the earlier `issuer` and `feepayer`, built from
forest's deleted `deploy/`. Their services are deleted. Their three volumes (`host-volume`,
`carrier-volume`, `issuer-volume`) are pending deletion in Railway until 2026-10-02 23:25 UTC,
restorable until then. The earlier issuer's sealed Didit key and workflow went with its service.

## The loop's run

`loop/loop.ts` (`loop/README.md`), on 2026-09-30 from 23:50:54 to 23:54:03 UTC: **passed**, in
3 minutes 9 seconds. Its record, with every address and signature, is
`loop/runs/2026-09-30T23-50-54-394Z.json`.

| Step | What happened |
|---|---|
| People | Two virtual passkeys on the approval page's origin. Seller `did:key:z6MkgwcaqG3QBEtEnpnZiN3FDKVZwVbRRC94jJ1fB8dNEFgG` (wallet `3VMYF1nxqhPmgKws2o5QNDwa7vKa1Jti3H6jLrfMK2tt`), buyer `did:key:z6Mki8khK5wUSwt3QEJHALDo9wFWVrniqg3PHZPVyGkHiV13` (wallet `4gVeiqh37QPaHjTaUmFxJqhWgHWsRno2bYUa8znGoGDf`) |
| Setup | Their dollar accounts (`2EMvDq…`), 5.00 USDC-shaped to the seller, 15.00 USDC-shaped and 10.00 Open-USD-shaped to the buyer (`5wZxHv…`); the deploy key paid |
| The list | Both through the stand-in face check, listed by the next batch: 6 members, root `18603756…743351`, size 6. Roots file canonical and signed by `did:key:z6MkmSeF…PLFV`; its newest root is the list's |
| Root on chain | The issuer's memo for that root: [`SB6mA8r…ahrmhSM`](https://explorer.solana.com/tx/SB6mA8rAruhGzH5hxHg1vAgQwGYN8iP61nyrSJ9gKzQWkd4vAnskhfm67cCuUyr8b9UZxd14rDmbaFRQahrmhSM?cluster=devnet) |
| Badges, through the relayer | `tutoring/seller`, line `Fi5ERaAV7bF7M9gzYURYcendX18uTQdU7ZjA1mwTnZgz`, [`3kz95C3…`](https://explorer.solana.com/tx/3kz95C3NKnuWuvhWvXTq5aav3CGjZ7VHfVY4NsisWm1AFv1eQbb1GEeQ4HbbecwUXG4xc2cCxkgnTWSruBu3mZj1?cluster=devnet), 731 bytes, charged 1.49336 USDC-shaped; `tutoring/buyer`, line `5RMYjLkSG6JfQHFCij7FcAgaryX5WKrKSTNHLGdt1MKE`, [`3uFdNiC…`](https://explorer.solana.com/tx/3uFdNiCmE74ueXZd5u2W7HUoA6eqNahNJ5dn4CVPdTG1bPdk45ZZfj7WYz2bAy3TJW9DQNCmsSs4V8BxWVrZc7MG?cluster=devnet), charged 1.48828 |
| Records, through approvals | Each folder written by the app; each profile, the seller's `offer/maths` (1 USDC-shaped dollar an hour) and the four reviews drafted through connections' MCP, opened on the approval page, approved with the passkey, and reported "Published" by connections |
| Deal 1, USDC-shaped | Escrow `83ETyYBYLvnaPM2anUbjEwRSdw9mXVm9z8YrTxo3JoXD`, 1.00, one tap in one transaction, [`4RsfpXs…`](https://explorer.solana.com/tx/4RsfpXsWGLqoiwQqaKVFtnXUN8HvsjmvKt8heA2myoc6ZoBzqKPPXu38SFhDS1UgFcKdspMRxaKLwZQ2eCcFrCg5?cluster=devnet), 715 bytes; the relayer charged 3.69808 USDC-shaped |
| Deal 2, Open-USD-shaped | Kora refused the one tap as one transaction (below); then escrow `32oK5JLgdeSTiaP4mkD4wz77gL5mnWi3XwxuGjLZXMQy`, 1.00: pay [`dBLQF5x…`](https://explorer.solana.com/tx/dBLQF5xybx4m7FR7vfGtovm7B3mqog6Torwzdwr3B6XDDJfpmQFp5z2BYVdLWdhZLtLgtuJBAKi61qeqBeB7zNG?cluster=devnet), charged 3.76920 Open-USD-shaped; release [`3KkarjF…`](https://explorer.solana.com/tx/3KkarjFaXTBRQMZmjoutr8PcJx6gXHWNReVAto964UaaTsvRbHWwZdVLFM6sChQ6uhsYFiNUh9Dz42rWZK1E7NuE?cluster=devnet), charged 0.01. The relayer was paid in Open-USD-shaped dollars for both |
| Reviews | Each side reviewed each deal, naming its escrow |
| The index | Both badges counted, vouched by "Forest Foundation (devnet key)"; the offer listed; both deals `releasedToSeller`, each with two reviews; all four reviews counted at full weight (`oneSidedConfirmed`: the buyer opened the escrow, the seller reviewed the deal). Seller: rating 9.5, standing 3.16. Buyer: rating 10, standing 3.52. Shown 15 seconds after the last review |

Every charge is what the relayer spent at the mock price: the network fee and each deposit it put
down. On devnet's rent, a line costs about 1.49 test dollars, an escrow v2 with its deposit address
about 3.7.

### The Kora refusal

The loop asked Kora to sign the Open-USD-shaped one tap as one transaction (the deposit address
made at the top, `create`, `transfer_checked` in, `release_to_seller`, and the payment to the
relayer). Kora answered:

```
signAndSendTransaction: Account 2szQPncbDkYA2cAAd6CgHjAt8ewgzx6neWoCQ4xNtXZn not found ""
```

`2szQPn…` is that escrow's deposit address, made in the same transaction. Nothing was sent. The
cause and the issue for Kora are in `kora-issue.md`.

### Earlier runs

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
| Deploy (pays the loop's setup) | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` | 4.831 |
| Relayer (`payer`), also the Open-USD-shaped dollar's issuer | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` | 1.058 |
| Issuer | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` (`did:key:z6MkmSeFgQp3SxoPB3qmrNFmqPaZAmjMUzmv9KViBqWtPLFV`) | 0.00998, about 2,000 more roots |

All are derived from the devnet phrase by forest's `devnet/keys.sh`; none is in this repo.
