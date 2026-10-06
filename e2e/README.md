# e2e

The loop: two new people do everything a person does on Forest, on devnet, against the services
this repo deploys, and the run checks that the index shows the result.

It is not a service: the foundation runs it by hand, with the devnet phrase. It tests the
foundation's host, issuer, fee payer, connections and index; anyone running their own can point
`devnet.json` at theirs. It runs on Solana's devnet, with test dollars and the stand-in for both of
the issuer's checks.
Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md). The host it writes to: [`host/`](../host/README.md).

## How it works

`e2e.ts` is the whole run; `devnet.json` names what it runs against; each run's record goes to
`runs/`. Two people, a seller and a buyer, in the market `tutoring`, each the way their app would do
it:

1. **A seed from 24 words,** and from it the main key, the inbox key and a stamp for each of the
   issuer's two lists (forest's keys).
2. **Setup:** each gets a test-dollar account and some test dollars, paid by the devnet deploy key.
   Nothing a person does after this needs anything but test dollars, and the seller's row not even
   those.
3. **Stamped by the issuer:** a face check (the devnet stand-in passes it), the stamp submitted,
   then polled until it is on the list.
4. **A row each in the registry,** proven against the issuer's newest snapshot and carrying the
   issuer's signature on its root. The seller's goes through the fee payer's voucher door with a
   voucher (a second proof from the same stamp, under `sponsor/1`) and costs the seller nothing; the
   buyer's goes through its at-cost door, paid in test dollars. Then the seller takes the issuer's
   ID check (the stand-in passes it too), its stamp for the ID list goes onto that list, and it
   registers its profile again: a second row for the same main key, proven against the ID list,
   through the voucher door with an ID-list voucher (`sponsor/10`). The run reads each row back
   and checks the signature and that the fee payer paid for it.
5. **Each app publishes** the profile's hosts record and its profile record on the host, with its
   inbox key. Each declares an inbox for senders holding a row from the devnet issuer. The
   seller's takes one message from each, and lists among its readers a read key the seller's app
   made at random for its assistant; the buyer's takes as many as come, so the seller's replies
   can reach it.
6. **An assistant connects to each** through connections, with OAuth. The app adds the access key
   the connection shows to the profile's permissions record. The seller's assistant posts an offer
   with a photo through MCP, signed by its access key; the seller's app then puts the photo's bytes
   on the host, which takes them because the offer names them.
7. **The inbox:** the buyer's app reads the seller's card, puts a message in one envelope only the
   seller's inbox key and the read key open, signs it and delivers it to the seller's host, which
   checks that the buyer holds a row from the devnet issuer. A second message is refused (`once`).
   The seller's app pulls its inbox with a pull its main key signs, and opens the one message.
8. **Delegated messages:** the seller's app lists a message key in its permissions record (scope
   `message`), beside its assistant's write key. Holding the message key and the read key, as an
   assistant would, the loop pulls the seller's inbox with the message key, opens the buyer's
   message with the read key, and replies to the buyer, signed by the message key for the seller
   and naming the seller's host, where the buyer's host reads the seller's permissions. The buyer's
   app pulls the reply, opens it, and sees the message key sent it. Then the seller revokes the
   message key (scope `revoked`): its pull is refused at once (`permission`), and after the host's
   cache time (`senderCacheSeconds` in `devnet.json`, 60 seconds) and ten more, a second reply is
   refused too (`permission`).
9. **The buyer pays through the escrow** in one tap: pay and release in one transaction, through
   the fee payer, paid in test dollars.
10. **Each assistant posts a review** of the other, naming the deal.
11. **The index shows it:** both profiles with their rows counted, the seller's under both of the
    issuer's lists, so its page shows it ID-checked, and the buyer's under the face list; the offer
    with its photo shown from the host, the deal released to the seller, and both reviews counted at
    full weight. Not the messages.
12. **The loop proves:** the seller's app finds its own leaf among the index's reputation leaves
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
ID step needs the fee payer with both of the issuer's lists in `VOUCHER_ISSUERS`.

### The latest run

2026-10-06, 00:36 to 00:40 UTC, against all five services as deployed from `main` at `e0c6acd`
(forest at `09b5b96`): **passed** in 230 seconds, most of it waiting for the issuer's two batches.
Its record is [`runs/2026-10-06T00-36-31-297Z.json`](runs/2026-10-06T00-36-31-297Z.json). It is the
first run through the fee payer as one service: both doors at one address, the voucher door at
`/vouchers`.

| Step | What happened |
|---|---|
| People | Seller `2CJPX1FGJBRJQTvbNeCA7HL42UqNgtZxbYc5xAUFAJdS`, buyer `8yMNeq1MBF416xFAQVxPn3ZkZcBcV5oqJs2Ta6fLT5g7` |
| The lists | Both stamped in one batch on the face list: 22 stamps, snapshot root `210a4990…`, signed by `7zPD6AZc…`. Then the seller on the ID list: 3 stamps, root `065b0d80…`, signed by `BVT1PcgV…` |
| Rows, through the fee payer | `tutoring/seller` through the voucher door with the voucher `sponsor/1`, 651 bytes, charged nothing; `tutoring/buyer` through the at-cost door, 795 bytes, charged 1.77276 test dollars; the seller's second `tutoring/seller`, against the ID list, through the voucher door with `sponsor/10`, 651 bytes, charged nothing. The seller held no SOL and paid no dollar for either |
| Access keys | Seller's assistant `PA9qWaBC…`, buyer's `FT9c9f2u…`, each on its profile's permissions list |
| Records | The seller's offer `offer/maths`, signed by the access key, and its photo, 79 bytes, on the host; two reviews |
| The inbox | The buyer's message, 2,563 bytes, taken by the seller's host; a second refused (`once`); the seller pulled one message and opened it with the key forest now calls its inbox key |
| The deal | Escrow `MAuZc3cm74jxJ2wGHiLxAe2uk6rFfH7TQTSB2Nct1CV`, one tap, 715 bytes, charged 3.69808 test dollars |
| The index | The seller's rows counted under both of the foundation's lists, its page showing it ID-checked; the buyer's under the face list; the offer listed with its photo from the host; the deal released to the seller; both reviews counted (`oneSidedConfirmed`, weight 1); the message nowhere. Seller and buyer each rating 10 |
| The proof | The seller's leaf found by its market stamp `02c6d4c7…` among the index's 11 leaves, scored 100 tenths from one review; proven on the device against root `2d4b92b7…`, signed by "Forest index (devnet)" (`8117HhEb…`), and put on its card. The index checked it and the seller's page says "Rated 10.0 of 10 in Tutoring (per Forest index (devnet), 6 Oct 2026)" |

Its permissions records are in the shape before forest's scoped permissions (`until`, no
`scope`), which forest's view now reads as listing no write key, and no app can sign them again:
the run forgot its people's words. So since that change the index no longer counts what its
assistants wrote, the offer and both reviews, though the host keeps them.

Open them: [the seller](https://index-production-1b6e.up.railway.app/profiles/2CJPX1FGJBRJQTvbNeCA7HL42UqNgtZxbYc5xAUFAJdS),
[the buyer](https://index-production-1b6e.up.railway.app/profiles/8yMNeq1MBF416xFAQVxPn3ZkZcBcV5oqJs2Ta6fLT5g7),
[the deal](https://index-production-1b6e.up.railway.app/deals/MAuZc3cm74jxJ2wGHiLxAe2uk6rFfH7TQTSB2Nct1CV).

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
- **One inbox rule and one photo.** It tests inboxes open to one issuer's rows, with and without
  one message from each sender, not `anyone` or `maxBytes`; and a photo on an offer, not a
  profile's photo or a video.
- **Keys handed over by the loop itself.** The message key and the read key never travel in a
  grant: the loop holds them as the seller's app made them. A host other than the foundation's,
  or a seller and buyer on different hosts, is not tested.
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
who wrote to whom would be public. A message goes to the recipient's hosts, and only its main key,
or a message key it lists, pulls it. The index's page tests still check that a private record is
left alone.

**Why is the read key in the seller's card from the start, and not listed in the delegated step?**
A sender seals a message to the readers the card lists when it sends. The seller's inbox takes
one message from the buyer, so a read key listed after it would open nothing the buyer sent.

**Why keep every run's record in the repo?**
So anyone can check, on devnet itself, what the latest run did: every address and signature in it
is public.
