# e2e

The loop: two new people do everything a person does on Forest, on devnet, against the services
this repo deploys, and the run checks that the index shows the result.

It is not a service: anyone runs it by hand, with the devnet phrase. It tests Soil's host, issuer,
fee payer and connections and the foundation's index; anyone running their own can point
`devnet.json` at theirs. It runs on Solana's devnet, with test dollars and the stand-in for both of
the issuer's checks.
Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md). The host it writes to: [`host/`](../host/README.md).

## How it works

`e2e.ts` is the whole run; `devnet.json` names what it runs against; each run's record goes to
`runs/`. Two people, a seller and a buyer, in the market `tutoring`, each the way their app would do
it:

1. **A seed from 24 words,** and from it the main key, the reading key and a stamp for each of the
   issuer's two lists (forest's keys).
2. **Setup:** each gets a test-dollar account and some test dollars, paid by the devnet deploy key.
   Nothing a person does after this needs anything but test dollars, and the seller's row not even
   those.
3. **Stamped by the issuer:** a face check (the devnet stand-in passes it), the stamp submitted,
   then polled until it is on the list.
4. **A row each in the registry,** proven against the issuer's newest snapshot and carrying the
   issuer's signature on its root. The seller's goes through the fee payer's sponsored node with a
   voucher (a second proof from the same stamp, under `sponsor/1`) and costs the seller nothing; the
   buyer's goes through its general node, paid in test dollars. Then the seller takes the issuer's
   ID check (the stand-in passes it too), its stamp for the ID list goes onto that list, and it
   registers its profile again: a second row for the same main key, proven against the ID list,
   through the sponsored node with an ID-list voucher (`sponsor/10`). The run reads each row back
   and checks the signature and that the fee payer paid for it.
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
10. **The index shows it:** both profiles with their rows counted, the seller's under both of the
    issuer's lists, so its page shows it ID-checked, and the buyer's under the face list; the offer
    with its photo shown from the host, the deal released to the seller, and both reviews counted at
    full weight. Not the message.
11. **The loop proves:** the seller's app finds its own leaf among the index's reputation leaves
    (`/v1/reputation/leaves`), by the market stamp its face-list secret gives, scored 10 from one
    review. It proves that rating in its market on the device, with forest's circuits (one profile,
    its market shown), puts the proof on its card and publishes the card again. The index checks the
    proof and the seller's page says "Rated 10.0 of 10 in Tutoring (per Forest index (devnet), …)".

Every address, signature and charge goes to `runs/<time>.json`, and the run exits 0 only if every
step passed.

### Run it

Node 22.18 or later, with forest fetched at the commit in `FOREST`, and the registry's and the
reputation circuit's proving files:

```sh
./forest.sh keys records registry/client registry/artifacts escrow/client circuits/reputation
(cd forest/registry/artifacts && npm run fetch)
(cd forest/circuits/reputation && npm run fetch)
cd e2e && npm ci
FOREST_DEVNET_SEED='<the devnet phrase>' npm run e2e
```

| Variable | Required | What |
|---|---|---|
| `FOREST_DEVNET_SEED` | yes | The devnet phrase. Its `deploy` key pays the setup; its `test-dollar-authority` key mints the test dollars. Never in this repo |
| `HELIUS_API_KEY` | no | Reads and sends through Helius's devnet RPC instead of `api.devnet.solana.com`; the key never goes into a run's record |

Run it against the services as deployed from `main`: the index step waits for the deployed index
to show the offer's photo and the seller's ID row, and the proof step for its reputation tree. The
ID step needs the sponsored node with both of the issuer's lists in `VOUCHER_ISSUERS`.

### The latest run

2026-10-05, 02:09 to 02:13 UTC, against all five services as deployed from `main` at `edb9d68`
(forest at `09b5b96`), the fee payer's two nodes included: **passed** in 230 seconds, most of it
waiting for the issuer's two batches. Its record is
[`runs/2026-10-05T02-09-34-894Z.json`](runs/2026-10-05T02-09-34-894Z.json). It is the first run
with step 11: the seller proved its rating on the device, and the index checked the proof and shows
it.

| Step | What happened |
|---|---|
| People | Seller `9m6Vki3PmxGF5WN2kHxwdUKd1sMZNbLUzW6i7ynQT4dW`, buyer `hYtSXUuWTP8XWDxwGioyaX4sMn11nF19pvcnm6Lxa4n` |
| The lists | Both stamped in one batch on the face list: 20 stamps, snapshot root `3014e388…`, signed by `7zPD6AZc…`. Then the seller on the ID list: 2 stamps, root `1bae2ace…`, signed by `BVT1PcgV…` |
| Rows, through the fee payer | `tutoring/seller` through the sponsored node with the voucher `sponsor/1`, 651 bytes, charged nothing; `tutoring/buyer` through the general node, 795 bytes, charged 1.77276 test dollars; the seller's second `tutoring/seller`, against the ID list, through the sponsored node with `sponsor/10`, 651 bytes, charged nothing. The seller held no SOL and paid no dollar for either |
| Access keys | Seller's assistant `FntAGQHD…`, buyer's `99xAEe7n…`, each on its profile's permissions list |
| Records | The seller's offer `offer/maths`, signed by the access key, and its photo, 79 bytes, on the host; two reviews |
| The inbox | The buyer's message, 2,562 bytes, taken by the seller's host; a second refused (`once`); the seller pulled one message and opened it with its reading key |
| The deal | Escrow `7dqTiBEwtaDBXEsGRS112jaYfz9KK64DVECK88RAz3DH`, one tap, 715 bytes, charged 3.69808 test dollars |
| The index | The seller's rows counted under "Soil issuer (devnet)" and "Soil issuer, ID (devnet)", its page showing it ID-checked; the buyer's under "Soil issuer (devnet)"; the offer listed with its photo from the host; the deal released to the seller; both reviews counted (`oneSidedConfirmed`, weight 1); the message nowhere. Seller and buyer each rating 10 |
| The proof | The seller's leaf found by its market stamp `1a914296…` among the index's 8 leaves, scored 100 tenths from one review; proven on the device against root `0e0344d1…`, signed by "Forest index (devnet)" (`8117HhEb…`), and put on its card. The index checked it and the seller's page says "Rated 10.0 of 10 in Tutoring (per Forest index (devnet), 5 Oct 2026)" |

Open them: [the seller](https://index-production-1b6e.up.railway.app/profiles/9m6Vki3PmxGF5WN2kHxwdUKd1sMZNbLUzW6i7ynQT4dW),
[the buyer](https://index-production-1b6e.up.railway.app/profiles/hYtSXUuWTP8XWDxwGioyaX4sMn11nF19pvcnm6Lxa4n),
[the deal](https://index-production-1b6e.up.railway.app/deals/7dqTiBEwtaDBXEsGRS112jaYfz9KK64DVECK88RAz3DH).

## Promises

- **No key, phrase or keyed URL in this directory.** The devnet phrase comes from the environment,
  and a run's record holds addresses, signatures and charges only.
- **It does what an app would,** with forest's own pieces: keys, records, the registry and escrow
  clients, and the reputation circuit's client. Nothing in it reaches around a service.
- **A run passes only if every step passed.** A failed run's record holds the steps it finished
  and the error.

## Limits

- **CI does not run it,** since it needs the devnet phrase and the deployed services; CI only
  type-checks it. It runs by hand, and its records in `runs/` say when it last passed.
- **Every run leaves its people on devnet for good:** their rows, their deal and their stamps on the
  issuer's list. Their records stay on the host until it is wiped.
- **Both checks are the stand-in,** so a run says nothing about Didit; and the ID check is free on
  devnet, so a run says nothing about its payment.
- **One market, one test dollar, one tap.** It does not pay in the Open-USD-shaped test dollar
  (the fee payer's test does, on a local validator, and its README says why a one tap in it fails
  through Kora), and it does not test a refund.
- **One inbox rule and one photo.** It tests an inbox open to one issuer's rows, one message from
  each sender, not `anyone` or `maxBytes`; and a photo on an offer, not a profile's photo or a
  video.
- **One proof:** the seller's own rating in its own market, from one profile. It does not prove
  across several profiles or hide the market.
- **Each wait on the index is up to 15 minutes:** the index step's, and the proof step's two (for
  the seller's leaf, then for the proof to show). A slower devnet fails the run.

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
