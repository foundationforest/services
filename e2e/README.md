# e2e

Devnet only: e2e runs on Solana's devnet, with test dollars and a stand-in face check. Nothing is
on mainnet, and nothing is shipped.

Up: [the repo](../README.md). The test host: [`host/`](host/README.md).

## What it is

Forest end to end on devnet, against the services this repo deploys: two new people do everything
a person does, each the way their app would do it, and the run checks that the index shows the
result. `e2e.ts` is the whole run; `devnet.json` names what it runs against; each run's record goes
to `runs/`.

It tests the foundation's first index, issuer, relayer and connections service. Anyone running
their own can point `devnet.json` at theirs.

## How it works

Two people, a seller and a buyer, in the market `tutoring`:

1. **A seed from 24 words,** and from it the profile key, the reading key and the stamp for the
   keeper (forest's keys).
2. **Setup:** each gets a test-dollar account and some test dollars, paid by the devnet deploy key.
   Nothing a person does after this needs anything but test dollars.
3. **Stamped by the issuer:** a face check (the devnet stand-in passes it), the stamp submitted,
   then polled until it is on the list.
4. **A row each in the registry,** proven against the keeper's newest snapshot and carrying the
   keeper's signature on its root, sent through the relayer and paid in test dollars. The run reads
   the row back and checks the signature.
5. **Each app publishes** the profile's hosts record and its profile record on the test host.
6. **An assistant connects to each** through connections, with OAuth. The app adds the writer key
   the connection shows to the profile's permissions record. The seller's assistant posts an offer
   through MCP, signed by its writer key.
7. **One private record:** the buyer writes the seller a message only the seller's reading key
   opens. The run reads it back from the host and opens it.
8. **The buyer pays through the escrow** in one tap: pay and release in one transaction, through
   the relayer, paid in test dollars.
9. **Each assistant posts a review** of the other, naming the deal.
10. **The index shows it:** both profiles with their rows counted under the trusted keeper, the
    offer, the deal released to the seller, and both reviews counted at full weight. Not the private
    message.

Every address, signature and charge goes to `runs/<time>.json`, and the run exits 0 only if every
step passed.

### Run it

Node 22.18 or later, with forest fetched at the commit in `FOREST` and the registry's proving files:

```sh
./forest.sh keys records registry/client registry/artifacts escrow/client
(cd forest/registry/artifacts && npm run fetch)
cd e2e && npm ci
FOREST_DEVNET_SEED='<the devnet phrase>' npm run e2e
```

| Variable | Required | What |
|---|---|---|
| `FOREST_DEVNET_SEED` | yes | The devnet phrase. Its `deploy` key pays the setup; its `test-dollar-authority` key mints the test dollars. Never in this repo |
| `HELIUS_API_KEY` | no | Reads and sends through Helius's devnet RPC instead of `api.devnet.solana.com`; the key never goes into a run's record |

### The latest run

2026-10-02, 18:59 to 19:00 UTC, against all five services built from this branch: **passed** in 76
seconds. Its record is [`runs/2026-10-02T18-59-03-198Z.json`](runs/2026-10-02T18-59-03-198Z.json).

| Step | What happened |
|---|---|
| People | Seller `9mri3A3NyUGjKQH8cfByYfEWCtGALiPBhnBCQLQfovnN`, buyer `7M3oEDyFTgy9kyucGzvAsKbofFADcXYFEGLZV36ciYdZ` |
| The list | Both stamped in one batch: 14 stamps, snapshot root `22299dca…`, signed by the keeper `7zPD6AZc…` |
| Rows, through the relayer | `tutoring/seller`, 796 bytes, charged 1.77784 test dollars; `tutoring/buyer`, 795 bytes, charged 1.77276 |
| Writer keys | Seller's assistant `7am4FVFv…`, buyer's `H2qDubZk…`, each on its profile's permissions list |
| Records | The seller's offer `offer/maths`; the buyer's private message, 4,388 bytes, opened by the seller's reading key; two reviews |
| The deal | Escrow `3zmphLyirt3mG1yyQseu6xCbqqxxmE72QprnNXdMroKF`, one tap, 715 bytes, charged 3.69808 test dollars |
| The index | Both rows counted under "Forest Foundation issuer (devnet)"; the offer listed; the deal released to the seller; both reviews counted (`oneSidedConfirmed`, weight 1). Seller and buyer each rating 10 |

Open them: [the seller](https://index-production-1b6e.up.railway.app/profiles/9mri3A3NyUGjKQH8cfByYfEWCtGALiPBhnBCQLQfovnN),
[the buyer](https://index-production-1b6e.up.railway.app/profiles/7M3oEDyFTgy9kyucGzvAsKbofFADcXYFEGLZV36ciYdZ),
[the deal](https://index-production-1b6e.up.railway.app/deals/3zmphLyirt3mG1yyQseu6xCbqqxxmE72QprnNXdMroKF).

## Promises

- **No key, phrase or keyed URL in this folder.** The devnet phrase comes from the environment, and
  a run's record holds addresses, signatures and charges only.
- **It does what an app would,** with forest's own pieces: keys, records, the registry and escrow
  clients. Nothing in it reaches around a service.
- **A run passes only if every step passed.** A failed run's record holds the steps it finished
  and the error.

## Limits

- **CI does not run it,** since it needs the devnet phrase and the deployed services; CI only
  type-checks it. It runs by hand, and its records in `runs/` say when it last passed.
- **Every run leaves its people on devnet for good:** their rows, their deal and their stamps on the
  issuer's list. Their records stay on the test host until it is wiped.
- **The face check is the stand-in,** so a run says nothing about Didit.
- **One market, one test dollar, one tap.** It does not pay in the Open-USD-shaped test dollar
  (the relayer's test does, on a local validator, and its README says why a one tap in it fails
  through Kora), and it does not test a refund.
- **The index step waits up to 15 minutes** for the index's next read of the host and the chain;
  a slower devnet fails the run.

## FAQ

**Why on devnet, against the deployed services, and not on a local validator?**
The local tests (the index's `e2e.test.ts`, the relayer's test) already run every piece on
loopback. This run checks the pieces as they are deployed: the real programs, Kora, the hosting,
and the services talking to each other over the internet.

**Why does the deploy key pay the setup?**
A new person has no test dollars. On mainnet they would come in at a ramp; on devnet the deploy key
makes the accounts and the test dollar's own authority mints them. Nothing after setup touches SOL.

**Why keep every run's record in the repo?**
So anyone can check, on devnet itself, what the latest run did: every address and signature in it
is public.

**Why is the test host in this folder?**
The foundation runs no host; hosts are run by apps. The run needs one, and so does the devnet index,
so this one exists for devnet testing only, beside the run that uses it.
