# e2e

The loop, end to end on devnet: two new people do everything a person does on Forest, against the
services this repo deploys, and the run checks that the index shows the result.

It is not a service: the foundation runs it by hand, with the devnet phrase, against its host,
issuer, fee payer and index. Anyone running their own can point `devnet.json` at theirs. It runs on
Solana's devnet, with test dollars and the stand-in for the issuer's checks.

Up: [the repo](../README.md). The host it writes to: [`host/`](../host/README.md).

## How it works

`e2e.ts` is the whole run; `devnet.json` names what it runs against; each run's record goes to
`runs/`.

### What it proves

That a person's app, with forest's pieces alone, takes a new person from 24 words to a profile the
index counts as one real person, rated and ID-checked, through these services as deployed: the
issuer's two checks, a row through each of the fee payer's doors, records, a photo and messages on
the host, an assistant acting through the CLI ([`mcp/`](../mcp/README.md)) with access keys only,
a payment through the escrow, reviews, and a rating proven on the device. The seller pays nothing;
the buyer pays only in test dollars. Every step checks what it did, and the run passes only if every
step does.

### The steps

Two people, a seller and a buyer, in the market `tutoring`, each the way their app would do it:

1. **Keys.** A seed from 24 words, and from it the main key, the inbox key, and the person's secret
   and note number for the issuer, mixed under the name the issuer publishes at `/issuer.json`
   (forest's keys). The run checks that the key published there is the one in `devnet.json`.
2. **Setup.** A test-dollar account each and some test dollars, paid by the devnet deploy key.
   Nothing after this needs anything but test dollars, and the seller's row not even those.
3. **The face check.** A session at the issuer, the check (the stand-in passes it, with one
   embedding for everyone), the note number sent, and a tier 1 note back. The run checks the
   issuer's signature on it, its key, the note number and the tier.
4. **A row each,** from a person proof made from the note. The seller's goes through the fee payer's
   voucher door with a voucher (a second person proof from the same note, under
   `voucher/fee-payer.devnet.forest.foundation/1`), free; the buyer's through its at-cost door, paid
   in test dollars. The run reads each row back (the profile, the issuer's key, the fee payer as
   payer, when the program wrote it), and checks that the proof shows tier 1 against it.
5. **Cards.** Each app publishes the profile's hosts record and card on the host, with its inbox
   key and an inbox for senders holding a row from the issuer, named by its key. The seller's takes
   one message from each sender, and lists among its readers a read key its app made at random for
   its assistant; the buyer's takes as many as come.
6. **Keys for an assistant.** Each app makes its assistant's access keys at random and lists them in
   the profile's permissions record: the seller's a write key (offers and reviews), a message key
   and the read key; the buyer's a write key. The assistants are the CLI (`mcp/`), given the profile,
   the host and those keys. The seller's posts an offer with a photo (`post-offer`), signed by the
   write key; the seller's app then puts the photo's bytes on the host, which takes them because the
   offer names them.
7. **The inbox.** The buyer's app puts a message in one envelope only the seller's inbox key and the
   read key open, signs it and delivers it to the seller's host, which checks that the buyer holds a
   row from the issuer. A second message is refused (`once`). The seller's app pulls its inbox with
   its main key and opens the message.
8. **The seller's assistant,** through the CLI: `inbox` pulls with the message key and opens the
   message with the read key; `send` replies, signed by the message key for the seller, which the
   buyer's host takes after reading the seller's permissions, and the buyer sees the message key
   sent it; `request` asks the seller, through the seller's own inbox, to post an offer the
   assistant drafted, which the seller's app pulls and opens, and `inbox` marks as a request. Then
   the seller makes the message key past and deletes the read key, from its permissions record and
   its inbox's readers. The CLI refuses both keys; the host refuses the past key's pull at once
   (`permission`), and a message the past key signed (`permission`) once the host's cache time
   (`senderCacheSeconds` in `devnet.json`) and ten seconds more have passed.
9. **The deal.** The buyer pays through the escrow in one tap, pay and release in one transaction,
   through the fee payer's at-cost door. The run checks that the escrow's address comes from its
   terms, and that its rent goes back to the fee payer, which paid it.
10. **Reviews.** Each assistant reviews the other through the CLI (`post-review`), naming the deal.
11. **The index shows it:** both profiles with their rows counted under the issuer's key, and the
    seller's page naming the issuer; the offer with its photo shown from the host; the deal released
    to the seller; both reviews counted at full weight. Not the messages, nor the request.
12. **The rating, proven.** The seller's app finds its own leaf among the index's reputation leaves
    by the stamp its secret gives under its label, scored 10 from one review. It proves that rating
    in its market on the device, with forest's circuits, puts the proof on its card and publishes
    the card again. The index checks the proof, and the seller's page says "Rated 10.0 of 10 in
    Tutoring (per Forest index (devnet), …)".
13. **The ID check.** The seller's app opens a session on the issuer's document check (the stand-in
    passes it; free on devnet) and sends its tier 1 note; the issuer signs the same note at tier 2,
    and the run checks it. The app proves its tier on the device at the stamp of the row it already
    holds, checks the proof against the row as a reader does, and puts it on its card beside the
    rating's proof. The index shows the row at tier 2, "ID-checked", uniqueness 0.9, and the
    rating's proof still.

Every address, signature and charge goes to `runs/<time>.json`, and the run exits 0 only if every
step passed.

### Run it

Node 22.18 or later, with standard fetched at the commit in `STANDARD`, and the reputation circuit's
proving files (the person circuit's are in forest):

```sh
./standard.sh keys records registry/client escrow/client circuits/reputation
(cd mcp && npm ci)
(cd standard/circuits/reputation && npm run fetch)
cd e2e && npm ci
FOREST_DEVNET_SEED='<the devnet phrase>' npm run e2e
```

- **`FOREST_DEVNET_SEED`** (required): the devnet phrase. Its `deploy` key pays the setup; its
  `test-dollar-authority` key mints the test dollars. Never in this repo.
- **`HELIUS_API_KEY`** (optional): read and send through Helius's devnet RPC instead of
  `api.devnet.solana.com`. The key never goes into a run's record.

Run it against the services as deployed from `main`. The voucher step needs the fee payer with the
issuer's key at tier 1 in `VOUCHER_ISSUERS`, and its `FEE_PAYER_NAME` the `feePayerName` in
`devnet.json`.

### The latest run

2026-10-08, 05:29 to 05:31 UTC, against the five services as deployed from `main` at `6063c57`
(forest at `f067dbf`): **passed** in 148 seconds, most of it waiting out the host's cache time. Its
record is [`runs/2026-10-08T05-29-17-320Z.json`](runs/2026-10-08T05-29-17-320Z.json).

- **People:** seller `7n5TZ128dxgVSTDqbdafGRK7KskWXkGi3dBeYu2jBKc2`, buyer
  `AsBRf636E4Kh5MzXVbGNJ6yn1mFemMurKGnHZs5LXfdG`, each with its secret for
  `issuer.devnet.forest.foundation`, whose `/issuer.json` named the key in `devnet.json`.
- **Notes:** a tier 1 note each from the face check, model `stand-in`, signed by the issuer's key
  `2185f564…`.
- **Rows:** `tutoring/seller` through the voucher door with the voucher
  `voucher/fee-payer.devnet.forest.foundation/1`, 619 bytes, charged nothing; `tutoring/buyer`
  through the at-cost door, 763 bytes, charged 1.64576 test dollars. Each read back at the registry
  `J4ES…` naming its profile, the issuer's key and the fee payer, and each proof showed tier 1. The
  seller held no SOL and paid no dollar.
- **Keys:** the seller's app made a write key `FQDhXTTV…`, a message key `2une86Gh…` and the read
  key; the buyer's app a write key `5YyqpHSG…`.
- **Records:** the offer `offer/maths`, posted through the CLI and signed by the write key, and its
  photo, 79 bytes, taken by the host's photo rule; two reviews, one by each assistant.
- **The inbox:** the buyer's message, 4,639 bytes, encrypted to the seller's inbox key and the
  read key, taken; a second refused (`once`); the seller pulled and opened it.
- **The assistant:** `inbox` pulled and opened the message; `send` replied, 2,681 bytes, taken by
  the buyer's host after reading the seller's permissions, and the buyer saw the message key sent
  it; `request` put `{ request: "post-offer", offer, id: "physics" }` in the seller's inbox, which
  the seller's app opened and `inbox` marked. Then the seller listed the message key as past
  (`{ key, was: "message" }`) and deleted the read key; the CLI refused `send` ("this key is past")
  and `private` ("not listed"); the host refused the past key's pull at once (`permission`), and
  71 seconds later a message it signed (`permission`).
- **The deal:** escrow `6pmjdPijG4JJu18Jq5uBq9zJrkVTBUxEwEih67kYT3bS`, its address its terms', one
  tap, 715 bytes, charged 3.69808 test dollars; its rent goes back to the fee payer `9CKUm2s7…`.
- **The index:** both rows counted under "Forest issuer (devnet)", weight 0.7; the offer with its
  photo from `host.devnet.forest.foundation`; the deal released to the seller; both reviews counted
  (`oneSidedConfirmed`, weight 1); no message and no request anywhere. Each rated 10.
- **The proof:** the seller's leaf found by its stamp `2ff4f5e5…` among 8 leaves, 100 tenths from
  one review; proven against root `1cd0c08e…`, signed by "Forest index (devnet)" (`8117HhEb…`), and
  put on its card. The page says "Rated 10.0 of 10 in Tutoring (per Forest index (devnet), …)".
- **The ID check:** the seller's note signed again at tier 2, the same note number, embedding and
  model; its tier proven at its row's stamp and held against the row `AAp5gacP…` (`verifyTier`),
  and put on its card beside the rating's proof. The index: the row at tier 2, "ID-checked", weight
  0.9, uniqueness 0.9; the page says "Verified real person, one per market · ID-checked", and the
  rating's proof still shows.

Open them: [the seller][s], [the buyer][b], [the deal][d].

[s]: https://index.devnet.forest.foundation/profiles/7n5TZ128dxgVSTDqbdafGRK7KskWXkGi3dBeYu2jBKc2
[b]: https://index.devnet.forest.foundation/profiles/AsBRf636E4Kh5MzXVbGNJ6yn1mFemMurKGnHZs5LXfdG
[d]: https://index.devnet.forest.foundation/deals/6pmjdPijG4JJu18Jq5uBq9zJrkVTBUxEwEih67kYT3bS

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
- **The checks are the stand-in,** with one embedding for everyone, so a run says nothing about
  Didit or the face model. Only the seller takes the ID check, after its row is written, so no
  tier 2 vouchers.
- **One market, one test dollar, one tap.** It pays in the classic test dollar, not the
  Open-USD-shaped one, and does not test a refund.
- **One inbox rule and one photo.** It tests inboxes open to one issuer's rows, with and without
  one message from each sender, not `anyone` or `maxBytes`; and a photo on an offer, not a
  profile's photo or a video.
- **The CLI's actions, called in process; one host.** The assistants run the CLI's actions as
  its typed door runs them, not through `forest` itself or its MCP door. A host other than the
  foundation's, or a seller and buyer on different hosts, is not tested.
- **One proof:** the seller's own rating in its own market, from one profile. It does not prove
  across several profiles or hide the market.
- **Each wait on the index is up to 15 minutes:** the index step's, the proof step's two (for the
  seller's leaf, then for the proof to show), and the ID check's. A slower devnet fails the run.

## Who decides what

- **The standard (forest):** what each step makes and checks: keys, records, messages, rows, the
  escrow and the proofs.
- **Each service, by its policy:** what it takes and what it charges; the run checks it as
  deployed.
- **The foundation:** when to run it, and what `devnet.json` points at.

## FAQ

**Why on devnet, against the deployed services, and not on a local validator?**
The local tests (the index's `e2e.test.ts`, the fee payer's test) already run every piece on
loopback. This run checks the pieces as they are deployed: the real programs, Kora, the hosting,
and the services talking to each other over the internet.

**Why does the deploy key pay the setup?**
A new person has no test dollars. On mainnet they would come in at a ramp; on devnet the deploy key
makes the accounts and the test dollar's own authority mints them. Nothing after setup touches SOL.

**Why keep every run's record in the repo?**
So anyone can check, on devnet itself, what a run did: every address and signature in it is public.
