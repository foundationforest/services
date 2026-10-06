# e2e

The loop: two new people do everything a person does on Forest, on devnet, against the services
this repo deploys, and the run checks that the index shows the result.

It is not a service: the foundation runs it by hand, with the devnet phrase. It tests the
foundation's host, issuer, fee payer, key holder and index; anyone running their own can point
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
6. **An assistant connects to each** through the key holder, with OAuth. Each app makes its
   assistant's keys at random, lists them in the profile's permissions record, and hands them to
   the key holder as forest's grants, through the link the key holder's page shows: the seller's
   app a write key (offers and reviews), a message key and the read key its card lists; the
   buyer's a write key. The seller's assistant posts an offer with a photo through MCP, signed by
   the write key; the seller's app then puts the photo's bytes on the host, which takes them
   because the offer names them.
7. **The inbox:** the buyer's app reads the seller's card, puts a message in one envelope only the
   seller's inbox key and the read key open, signs it and delivers it to the seller's host, which
   checks that the buyer holds a row from the devnet issuer. A second message is refused (`once`).
   The seller's app pulls its inbox with a pull its main key signs, and opens the one message.
8. **The seller's assistant, through the key holder's tools:** it pulls the seller's inbox with the
   message key and opens the buyer's message with the read key (`pull_inbox`); replies to the
   buyer (`send_message`), signed by the message key for the seller and naming the seller's host,
   where the buyer's host reads the seller's permissions, and the buyer's app pulls the reply,
   opens it and sees the message key sent it; and asks the seller to pay (`request_payment`), a
   message to the seller's own inbox, which the seller's app pulls with its main key and opens.
   Then the seller revokes the message key (scope `revoked`): the assistant's pull is refused at
   once (`permission`), and after the host's cache time (`senderCacheSeconds` in `devnet.json`, 60
   seconds) and ten more, its second reply is refused too (`permission`).
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

2026-10-06, 05:06 to 05:12 UTC, against all five services as deployed from `main` at `578cee1`
(forest at `7cf5992`): **passed** in 359 seconds, most of it waiting for the issuer's two batches
and the host's cache time. Its record is
[`runs/2026-10-06T05-06-38-646Z.json`](runs/2026-10-06T05-06-38-646Z.json). It is the first run
through the key holder: the assistants held keys the apps made and handed over, and the seller's
assistant did its inbox, its reply and a payment request with them.

| Step | What happened |
|---|---|
| People | Seller `Fns43wUgK9em76tPfZL5yw9zM4JpbHQwKuCztWNnYSM6`, buyer `GfdksNkRzWUV7Mq8MSE9HB5a9xMiAwLTDc3aEtPt1V5r` |
| The lists | Both stamped in one batch on the face list: 26 stamps, snapshot root `14938940…`, signed by `7zPD6AZc…`. Then the seller on the ID list: 5 stamps, root `2fde727b…`, signed by `BVT1PcgV…` |
| Rows, through the fee payer | `tutoring/seller` through the voucher door with the voucher `sponsor/1`, 651 bytes, charged nothing; `tutoring/buyer` through the at-cost door, 795 bytes, charged 1.77276 test dollars; the seller's second `tutoring/seller`, against the ID list, through the voucher door with `sponsor/10`, 651 bytes, charged nothing. The seller held no SOL and paid no dollar for either |
| Keys handed to the key holder | The seller's app: a write key `4cCF8hKx…` (offers and reviews), a message key `5nvaxUm1…` and the read key its card lists, each on its permissions list and handed over as a grant; the buyer's app: a write key `DRbQpHu3…`. Each connection's grant went through once the host showed its keys listed |
| Records | The seller's offer `offer/maths`, posted by its assistant through the key holder, signed by the write key, and its photo, 79 bytes, on the host, its bytes in the host's bucket; two reviews, one by each assistant |
| The inbox | The buyer's message, 4,639 bytes, sealed to the seller's inbox key and the read key in one envelope, taken by the seller's host; a second refused (`once`); the seller pulled one message and opened it with its inbox key |
| The seller's assistant | Through the key holder's tools: `pull_inbox` pulled one message with the message key and opened it with the read key; `send_message` replied, 2,695 bytes, signed by the message key for the seller and naming the seller's host, taken by the buyer's host, and the buyer opened it and saw the message key sent it; `request_payment` put `{ request: "pay", amount: "1", to: <the buyer>, note }` in the seller's own inbox, which the seller's app pulled and opened. Revoked: the assistant's pull refused at once (`permission`); 71 seconds later its second reply refused (`permission`) |
| The deal | Escrow `92nMqPUQi6rA7ohD36G7U5UvxSHaAGcGdUM3MkVSXMCh`, one tap, 715 bytes, charged 3.69808 test dollars |
| The index | The seller's rows counted under "Forest issuer (devnet)" and "Forest issuer, ID (devnet)", its page showing it ID-checked; the buyer's under "Forest issuer (devnet)"; the offer listed with its photo from the host; the deal released to the seller; both reviews counted (`oneSidedConfirmed`, weight 1); no message and no payment request anywhere. Seller and buyer each rating 10 |
| The proof | The seller's leaf found by its market stamp `1b764776…` among the index's 6 leaves, scored 100 tenths from one review; proven on the device against root `03a2e9b1…`, signed by "Forest index (devnet)" (`8117HhEb…`), and put on its card. The index checked it and the seller's page says "Rated 10.0 of 10 in Tutoring (per Forest index (devnet), 6 Oct 2026)" |

Open them: [the seller](https://index-production-1b6e.up.railway.app/profiles/Fns43wUgK9em76tPfZL5yw9zM4JpbHQwKuCztWNnYSM6),
[the buyer](https://index-production-1b6e.up.railway.app/profiles/GfdksNkRzWUV7Mq8MSE9HB5a9xMiAwLTDc3aEtPt1V5r),
[the deal](https://index-production-1b6e.up.railway.app/deals/92nMqPUQi6rA7ohD36G7U5UvxSHaAGcGdUM3MkVSXMCh).

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
- **Runs before forest's scoped permissions no longer count in full.** Their permissions records
  are in the older shape (`until`, no `scope`), which forest's view reads as listing no write key,
  and no app can sign them again: each run forgot its people's words. So the index no longer counts
  what their assistants wrote, their offers and reviews, though the host keeps them.
- **Both checks are the stand-in,** so a run says nothing about Didit; and the ID check is free on
  devnet, so a run says nothing about its payment.
- **One market, one test dollar, one tap.** It does not pay in the Open-USD-shaped test dollar
  (the fee payer's test does, on a local validator, and its README says why a one tap in it fails
  through Kora), and it does not test a refund.
- **One inbox rule and one photo.** It tests inboxes open to one issuer's rows, with and without
  one message from each sender, not `anyone` or `maxBytes`; and a photo on an offer, not a
  profile's photo or a video.
- **One door, one host.** The assistants use the key holder's MCP door; its HTTP door is tested
  on loopback only. A host other than the foundation's, or a seller and buyer on different hosts,
  is not tested.
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

**Why keep every run's record in the repo?**
So anyone can check, on devnet itself, what the latest run did: every address and signature in it
is public.
