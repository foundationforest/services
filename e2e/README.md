# e2e

The loop: two new people do everything a person does on Forest, on devnet, against the services
this repo deploys, and the run checks that the index shows the result.

It is not a service: the foundation runs it by hand, with the devnet phrase. It tests the
foundation's host, issuer, fee payer and index; anyone running their own can point `devnet.json` at
theirs. It runs on Solana's devnet, with test dollars and the stand-in for the issuer's face check.
Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md). The host it writes to: [`host/`](../host/README.md).

## How it works

`e2e.ts` is the whole run; `devnet.json` names what it runs against; each run's record goes to
`runs/`. Two people, a seller and a buyer, in the market `tutoring`, each the way their app would do
it:

1. **A seed from 24 words,** and from it the main key, the inbox key, and the person's secret and
   note number for the issuer, mixed under the name the issuer publishes at `/issuer.json`
   (forest's keys). The run checks that the key published there is the one in `devnet.json`.
2. **Setup:** each gets a test-dollar account and some test dollars, paid by the devnet deploy key.
   Nothing a person does after this needs anything but test dollars, and the seller's row not even
   those.
3. **The face check:** a session at the issuer, the check (the devnet stand-in passes it, with one
   embedding for everyone), then the person's note number sent, and a tier 1 note back. The run
   checks the issuer's signature on it, its key, the note number and the tier.
4. **A row each in the registry,** from a person proof made from the note. The seller's goes through
   the fee payer's voucher door with a voucher (a second person proof from the same note, under
   `voucher/fee-payer.devnet.forest.foundation/1`) and costs the seller nothing; the buyer's goes
   through its at-cost door, paid in test dollars. The run reads each row back (the profile, the
   issuer's key, the fee payer as its payer, and when the program wrote it) and checks that the
   proof shows tier 1 against it, as a reader checks a tier a profile shows.
5. **Each app publishes** the profile's hosts record and its profile record on the host, with its
   inbox key. Each declares an inbox for senders holding a row from the issuer, named by its key.
   The seller's takes one message from each, and lists among its readers a read key the seller's
   app made at random for its assistant; the buyer's takes as many as come, so the seller's replies
   can reach it.
6. **Keys for an assistant:** each app makes its assistant's keys at random and lists them in the
   profile's permissions record: the seller's app a write key (offers and reviews), a message key
   and the read key its card lists; the buyer's a write key. The assistants are forest's CLI, given
   the profile, the host and those keys. The seller's posts an offer with a photo (`post-offer`),
   signed by the write key; the seller's app then puts the photo's bytes on the host, which takes
   them because the offer names them.
7. **The inbox:** the buyer's app reads the seller's card, puts a message in one envelope only the
   seller's inbox key and the read key open, signs it and delivers it to the seller's host, which
   checks that the buyer holds a row from the issuer. A second message is refused (`once`). The
   seller's app pulls its inbox with a pull its main key signs, and opens the one message.
8. **The seller's assistant, through the CLI:** `inbox` pulls the seller's inbox with the message
   key and opens the buyer's message with the read key; `send` replies to the buyer, signed by the
   message key for the seller and naming the seller's host, where the buyer's host reads the
   seller's permissions, and the buyer's app pulls the reply, opens it and sees the message key sent
   it; `request` asks the seller to post an offer the assistant drafted, a message to the seller's
   own inbox, which the seller's app pulls with its main key and opens, and which `inbox` marks as a
   request. Then the seller makes the message key past (scope `past`), deletes the read key's entry,
   and drops the read key from its inbox's readers. The CLI refuses both keys. Without the CLI, the
   host refuses the past key's pull at once (`permission`), and after the host's cache time
   (`senderCacheSeconds` in `devnet.json`, 60 seconds) and ten more, a message the past key signed
   (`permission`).
9. **The buyer pays through the escrow** in one tap: pay and release in one transaction, through
   the fee payer, paid in test dollars. The run checks that the escrow's address comes from its
   terms, and that its rent goes back to the fee payer, which paid it.
10. **Each assistant posts a review** of the other through the CLI (`post-review`), naming the deal.
11. **The index shows it:** both profiles with their rows counted under the issuer's key, and the
    seller's page naming the issuer; the offer with its photo shown from the host, the deal released
    to the seller, and both reviews counted at full weight. Not the messages, nor the request.
12. **The loop proves:** the seller's app finds its own leaf among the index's reputation leaves
    (`/v1/reputation/leaves`), by the stamp its secret for the issuer gives under its label, scored
    10 from one review. It proves that rating in its market on the device, with forest's circuits
    (one profile, its market shown), puts the proof on its card and publishes the card again. The
    index checks the proof and the seller's page says "Rated 10.0 of 10 in Tutoring (per Forest
    index (devnet), …)".

Every address, signature and charge goes to `runs/<time>.json`, and the run exits 0 only if every
step passed.

### Run it

Node 22.18 or later, with forest fetched at the commit in `FOREST`, and the reputation circuit's
proving files (the person circuit's are in forest):

```sh
./forest.sh keys records registry/client escrow/client circuits/reputation cli
(cd forest/circuits/reputation && npm run fetch)
cd e2e && npm ci
FOREST_DEVNET_SEED='<the devnet phrase>' npm run e2e
```

| Variable | Required | What |
|---|---|---|
| `FOREST_DEVNET_SEED` | yes | The devnet phrase. Its `deploy` key pays the setup; its `test-dollar-authority` key mints the test dollars. Never in this repo |
| `HELIUS_API_KEY` | no | Reads and sends through Helius's devnet RPC instead of `api.devnet.solana.com`; the key never goes into a run's record |

Run it against the services as deployed from `main`: the index step waits for the deployed index
to show the offer's photo and both rows, and the proof step for its reputation tree. The voucher
step needs the fee payer with the issuer's key at tier 1 in `VOUCHER_ISSUERS`, and its
`FEE_PAYER_NAME` the `feePayerName` in `devnet.json`.

### The latest run

2026-10-07, 17:42 to 17:45 UTC, against the five services as deployed from `main` at `6aeb857`
(forest at `93ec55a`): **passed** in 130 seconds, most of it waiting out the host's cache time. Its
record is [`runs/2026-10-07T17-42-52-358Z.json`](runs/2026-10-07T17-42-52-358Z.json). It is the
first run at the services' own names (`devnet.json`), and the index read the host under its new
name.

| Step | What happened |
|---|---|
| People | Seller `swxCTAeMdyzoN2wLS2zYS8MgHphKwL39poUqnmiTd7v`, buyer `3pwPbaLSrUSQ6hVe2yyXozMuSXvfUe7qLopYZdi2jESt`, each with its secret for `issuer.devnet.forest.foundation`, whose `/issuer.json` named the key in `devnet.json` |
| Notes | A tier 1 note each from the face check, model `stand-in`, signed by the issuer's key `2185f564…` |
| Rows, through the fee payer | `tutoring/seller` through the voucher door with the voucher `voucher/fee-payer.devnet.forest.foundation/1`, 619 bytes, charged nothing; `tutoring/buyer` through the at-cost door, 763 bytes, charged 1.64576 test dollars. Each row read back at the registry `J4ES…` naming its profile, the issuer's key and the fee payer as payer, and each proof showed tier 1 against its row. The seller held no SOL and paid no dollar |
| Keys for the assistants | The seller's app: a write key `13mz6gPB…` (offers and reviews), a message key `CmJhj7kv…` and the read key its card lists, each on its permissions list; the buyer's app: a write key `Bnit9DtM…` |
| Records | The seller's offer `offer/maths`, posted through the CLI (`post-offer`), signed by the write key, and its photo, 79 bytes, on the host; two reviews, one by each assistant (`post-review`) |
| The inbox | The buyer's message, 4,638 bytes, sealed to the seller's inbox key and the read key in one envelope, taken by the seller's host; a second refused (`once`); the seller pulled one message and opened it with its inbox key |
| The seller's assistant | Through the CLI: `inbox` pulled one message with the message key and opened it with the read key; `send` replied, 2,680 bytes, signed by the message key for the seller, and the buyer opened it and saw the message key sent it; `request` put `{ request: "post-offer", offer, id: "physics" }` in the seller's own inbox, which the seller's app pulled and opened, and `inbox` marked as a request. Then the message key past and the read key deleted: the CLI refused `send` ("listed as a past key") and `private` ("not listed"); the host refused the past key's pull at once (`permission`), and 71 seconds later a message it signed (`permission`) |
| The deal | Escrow `31QrpGSyo4WUsz1Sca5ycMpp1urDo8tPhq4G95PjWxEo`, its address its terms', one tap, 715 bytes, charged 3.69808 test dollars; its rent goes back to the fee payer `9CKUm2s7…` |
| The index | Both rows counted under "Forest issuer (devnet)", weight 0.7; the offer listed with its photo from `host.devnet.forest.foundation`; the deal released to the seller; both reviews counted (`oneSidedConfirmed`, weight 1); no message and no request anywhere. Seller and buyer each rating 10 |
| The proof | The seller's leaf found by its stamp `26f179eb…` among the index's 4 leaves, scored 100 tenths from one review; proven on the device against root `29541b5b…`, signed by "Forest index (devnet)" (`8117HhEb…`), and put on its card. The index checked it and the seller's page says "Rated 10.0 of 10 in Tutoring (per Forest index (devnet), …)" |

Open them: [the seller](https://index.devnet.forest.foundation/profiles/swxCTAeMdyzoN2wLS2zYS8MgHphKwL39poUqnmiTd7v),
[the buyer](https://index.devnet.forest.foundation/profiles/3pwPbaLSrUSQ6hVe2yyXozMuSXvfUe7qLopYZdi2jESt),
[the deal](https://index.devnet.forest.foundation/deals/31QrpGSyo4WUsz1Sca5ycMpp1urDo8tPhq4G95PjWxEo).

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
- **Every run leaves its people on devnet for good:** their rows and their deal, and at the issuer,
  which session gave which note number. Their records stay on the host until it is wiped.
- **Runs before notes no longer show:** their rows are in the registry before the person proof,
  which the index no longer reads, so their profiles are gone from it.
- **Runs before forest's scoped permissions no longer count in full.** Their permissions records
  are in the older shape (`until`, no `scope`), which forest's view reads as listing no write key,
  and no app can sign them again: each run forgot its people's words. So the index no longer counts
  what their assistants wrote, their offers and reviews, though the host keeps them.
- **The face check is the stand-in,** with one embedding for everyone, so a run says nothing about
  Didit or the face model. It does not take the ID check, so no tier 2 note and no tier 2
  vouchers.
- **One market, one test dollar, one tap.** It does not pay in the Open-USD-shaped test dollar
  (the fee payer's test does, on a local validator, and its README says why a one tap in it fails
  through Kora), and it does not test a refund.
- **One inbox rule and one photo.** It tests inboxes open to one issuer's rows, with and without
  one message from each sender, not `anyone` or `maxBytes`; and a photo on an offer, not a
  profile's photo or a video.
- **The CLI's actions, called in process; one host.** The assistants run forest's CLI actions as
  its typed door runs them, not through `forest` itself or its MCP door. A host other than the
  foundation's, or a seller and buyer on different hosts, is not tested.
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
