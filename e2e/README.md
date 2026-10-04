# e2e

The loop: two new people do everything a person does on Forest, on devnet, against the services
this repo deploys, and the run checks that the index shows the result.

It is not a service: anyone runs it by hand, with the devnet phrase. It tests Soil's host, issuer,
fee payer and connections and the foundation's index; anyone running their own can point
`devnet.json` at theirs. It runs on Solana's devnet, with test dollars and a stand-in face check.
Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md). The host it writes to: [`host/`](../host/README.md).

## How it works

`e2e.ts` is the whole run; `devnet.json` names what it runs against; each run's record goes to
`runs/`. Two people, a seller and a buyer, in the market `tutoring`, each the way their app would do
it:

1. **A seed from 24 words,** and from it the main key, the reading key and the stamp for the issuer
   (forest's keys).
2. **Setup:** each gets a test-dollar account and some test dollars, paid by the devnet deploy key.
   Nothing a person does after this needs anything but test dollars.
3. **Stamped by the issuer:** a face check (the devnet stand-in passes it), the stamp submitted,
   then polled until it is on the list.
4. **A row each in the registry,** proven against the issuer's newest snapshot and carrying the
   issuer's signature on its root, sent through the fee payer and paid in test dollars. The run
   reads the row back and checks the signature.
5. **Each app publishes** the profile's hosts record and its profile record on the host. The
   seller's declares an inbox: senders holding a row from the devnet issuer, one message from each.
6. **An assistant connects to each** through connections, with OAuth. The app adds the access key
   the connection shows to the profile's permissions record. The seller's assistant posts an offer
   with a photo through MCP, signed by its access key; the seller's app then puts the photo's bytes
   on the host, which takes them because the offer names them.
7. **The inbox:** the buyer's app reads the seller's card, puts a message in an envelope only the
   seller's reading key opens, signs it and delivers it to the seller's host, which checks that the
   buyer holds a row from the devnet issuer. A second message is refused (`once`). The seller's app
   pulls its inbox with a pull its main key signs, and opens the one message.
8. **The buyer pays through the escrow** in one tap: pay and release in one transaction, through
   the fee payer, paid in test dollars.
9. **Each assistant posts a review** of the other, naming the deal.
10. **The index shows it:** both profiles with their rows counted under the trusted issuer, the
    offer with its photo shown from the host, the deal released to the seller, and both reviews
    counted at full weight. Not the message.

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

Run it against the services as deployed from `main`: the index step waits for the deployed index
to show the offer's photo. The first run with the inbox and the photo also needs the registration
step's own change, which comes in its own pull request; until both are deployed, the latest run
below is the one before them.

### The latest run

2026-10-03, 23:40 to 23:41 UTC, against all five services as deployed from `main` at `f0e3da8`
(forest at `7adf341`): **passed** in 62 seconds. Its record is
[`runs/2026-10-03T23-40-27-219Z.json`](runs/2026-10-03T23-40-27-219Z.json). It ran the loop as it
was then: a private record where the inbox is now, and no photo.

| Step | What happened |
|---|---|
| People | Seller `2kqhNQm3tn7YCiHyc99JiDyXEtEFXBEUxQDuWyWGGHP1`, buyer `394TwRgAmEmRiqoA2EJXhWuLdzBRrCwchFf4DpjxuiRR` |
| The list | Both stamped in one batch: 16 stamps, snapshot root `238c5309…`, signed by the issuer `7zPD6AZc…` |
| Rows, through the fee payer | `tutoring/seller`, 796 bytes, charged 1.77784 test dollars; `tutoring/buyer`, 795 bytes, charged 1.77276 |
| Access keys | Seller's assistant `E32PeXp7…`, buyer's `ofRSpzc8…`, each on its profile's permissions list |
| Records | The seller's offer `offer/maths`, signed by the access key; the buyer's private message, 4,388 bytes, opened by the seller's reading key; two reviews |
| The deal | Escrow `ChakmuTfUTsyzPZdTZ4wCHQdqYGFwVPgbSCSWWrFVGhC`, one tap, 715 bytes, charged 3.69808 test dollars |
| The index | Both rows counted under "Soil issuer (devnet)"; the offer listed; the deal released to the seller; both reviews counted (`oneSidedConfirmed`, weight 1). Seller and buyer each rating 10 |

Open them: [the seller](https://index-production-1b6e.up.railway.app/profiles/2kqhNQm3tn7YCiHyc99JiDyXEtEFXBEUxQDuWyWGGHP1),
[the buyer](https://index-production-1b6e.up.railway.app/profiles/394TwRgAmEmRiqoA2EJXhWuLdzBRrCwchFf4DpjxuiRR),
[the deal](https://index-production-1b6e.up.railway.app/deals/ChakmuTfUTsyzPZdTZ4wCHQdqYGFwVPgbSCSWWrFVGhC).

## Promises

- **No key, phrase or keyed URL in this directory.** The devnet phrase comes from the environment,
  and a run's record holds addresses, signatures and charges only.
- **It does what an app would,** with forest's own pieces: keys, records, the registry and escrow
  clients. Nothing in it reaches around a service.
- **A run passes only if every step passed.** A failed run's record holds the steps it finished
  and the error.

## Limits

- **CI does not run it,** since it needs the devnet phrase and the deployed services; CI only
  type-checks it. It runs by hand, and its records in `runs/` say when it last passed.
- **Every run leaves its people on devnet for good:** their rows, their deal and their stamps on the
  issuer's list. Their records stay on the host until it is wiped.
- **The face check is the stand-in,** so a run says nothing about Didit.
- **One market, one test dollar, one tap.** It does not pay in the Open-USD-shaped test dollar
  (the fee payer's test does, on a local validator, and its README says why a one tap in it fails
  through Kora), and it does not test a refund.
- **One inbox rule and one photo.** It tests an inbox open to one issuer's rows, one message from
  each sender, not `anyone` or `maxBytes`; and a photo on an offer, not a profile's photo or a
  video.
- **The index step waits up to 15 minutes** for the index's next read of the host and the chain;
  a slower devnet fails the run.

## FAQ

**Why on devnet, against the deployed services, and not on a local validator?**
The local tests (the index's `e2e.test.ts`, the fee payer's test) already run every piece on
loopback. This run checks the pieces as they are deployed: the real programs, Kora, the hosting,
and the services talking to each other over the internet.

**Why does the deploy key pay the setup?**
A new person has no test dollars. On mainnet they would come in at a ramp; on devnet the deploy key
makes the accounts and the test dollar's own authority mints them. Nothing after setup touches SOL.

**Why does the buyer write to the seller's inbox, and no longer a private record?**
forest's records say a message is not a record in the sender's folder: anyone reads a folder, so
who wrote to whom would be public. A message goes to the recipient's hosts, and only its main key
pulls it. The index's page tests still check that a private record is left alone.

**Why keep every run's record in the repo?**
So anyone can check, on devnet itself, what the latest run did: every address and signature in it
is public.
