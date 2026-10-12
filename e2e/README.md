# e2e

Part of Forest's services: [the top README](../README.md).

The loop, end to end on devnet: two new people do everything a person does on Forest, against the
host, the registry payer and the fee payer this repo deploys, and the run checks that an index shows
the result.

It is not a service: the Open Forest Foundation runs it by hand, with the devnet phrase. It runs its
own issuer and its own index on the machine it runs on, since the deployed issuer is real and a
script has no face ([FAQ](#faq)); everything else is deployed. Anyone running their own can point
`devnet.json` at theirs. It runs on Solana's devnet, with test dollars.

The host it writes to: [`host/`](../host/README.md).

## How it works

`e2e.ts` is the whole run; `loop.ts` starts its own issuer and index; `devnet.json` names what it runs
against; each run's record goes to `runs/`. Next to them, `credits/client.ts` is the buyer's side of
credits, the prepaid units the host and the registry payer sell
([host](../host/README.md#credits), [registry payer](../fee-payer/registry/README.md#credits)): what
an app does to buy and spend them, on the one wire format both keep. The run buys with it, and so do
the host's, the registry payer's and the issuer's tests.

- `serviceOf`: a service, from its directory: its key, where a buy goes, its unit, address, mint and
  price;
- `buy`: a buy of `n` credits, blinded, with its reference (a code that names the buy, not its
  credits) and its pay link, and what the app keeps in the vault to finish it;
- `finish`: the credits, from the service's answer, each checked against the service's key;
- `authorization` and `creditList`: one credit shown in an `Authorization` header, or several in a
  request's body.

It talks to no network of its own: the caller collects the buy, with a payment's signature or a
sponsor's ticket in the `Forest-Payment` header (`PAYMENT_HEADER`), and spends the credits.
`test/credits.test.ts` runs it against a stand-in service made of Cloudflare's own Privacy Pass
issuer and origin: a service read from its directory, a buy and its pay link, the credits finished
and shown, a buy finished later from what the vault keeps, and every answer that must finish
nothing.

### What it proves

That a person's app, with the standard's pieces and the credits client alone, takes a new person
from 24 words to a profile an index counts as one real person, rated and ID-checked: the issuer's
code doing both checks, with a stand-in for Didit, and the index's code reading what the deployed
services wrote; credits (prepaid units of a service) bought on Solana with test dollars; a row (the
registry's public entry that says a profile holds a note) through the registry payer with a credit
and one through the fee payer; records, a photo and messages on the host paid for in credits; an
assistant acting through mcp ([`mcp/`](../mcp/README.md)) with access keys only; a payment through
the escrow; reviews; and a rating proven on the device. Each person pays in test dollars and
credits only. Every step checks what it did, and the run passes only if every step does.

### The steps

First the deployed issuer and index each answer, and the issuer's `/issuer.json` shows its name and
a key. Then the loop starts, on this machine (`loop.ts`):

- **The loop issuer:** the issuer's code (`issuer/src/main.ts`) with the stand-in Didit its tests
  run (`issuer/test/fake-didit.ts`), which passes every session, and the stand-in face model, one
  embedding for everyone. It makes its key at its first start, in a directory of its own, and gives
  no welcome gift: the deployed host and registry payer take only the deployed issuer's tickets.
- **The loop index:** the index's code (`index/src/main.ts`) in a fresh database on `DATABASE_URL`,
  reading the deployed host and the chain, trusting the loop issuer's key (weights 0.7 and 0.9 for
  its tiers, as the devnet index weighs the foundation's), and showing its own reputation proofs.

Both stop, and the database goes, when the run ends, passed or not. Then two people, a seller and a
buyer, in the market `tutoring`, each the way their app would do it:

1. **Keys.** A seed from 24 words, and from it the main key, the inbox key, and the person's secret
   and note number for the loop issuer (a note is the issuer's signed statement that the person was
   checked), mixed under the name it publishes at `/issuer.json` (the standard's keys).
2. **Setup.** A test-dollar account each and some test dollars, paid by the devnet deploy key; and
   for each, an address of its own apart from its profile, as a wallet app holds one, with a dollar
   and a little SOL. Nothing a profile does after this needs anything but test dollars and credits,
   and the seller's row not even dollars.
3. **The face check, then credits.** A session at the loop issuer, the check (its stand-in passes
   it), the note number sent, and a tier 1 note back. The run checks the issuer's signature on it,
   its key, the note number and the tier. Then each buys credits on Solana: a plain transfer from
   its own address to the service's, naming the buy's reference, not through the fee payer; once it
   is finalized, the app collects the buy with the transaction's signature and finishes it (each
   credit unblinded and checked against the service's key). The seller buys 20 host credits and one
   registry payer credit; the buyer 20 host credits.
4. **A row each,** from a person proof made from the note. The seller's goes through the registry
   payer, which signs and sends it itself, with the seller's credit; the run reads the row's account
   on chain, checks the seller still holds no SOL and paid no dollar from its profile, that the same
   row shown again is refused as `row_exists`, and that the credit, shown with another row, is
   refused as spent once the row landed. The buyer's goes through the fee payer, paid in test
   dollars. The run reads each row back (the profile, the issuer's key, the key that paid as payer,
   when the program wrote it), and checks that the proof shows tier 1 against it.
5. **Cards.** Each app sends the profile's hosts record and card to the host, which takes the hosts
   record free and refuses the card (`refused`): the folder holds no credits there. The app spends the
   host credits it holds into the folder's balance and sends the card again. The card has its inbox
   key and an inbox for senders holding a row from the loop issuer, named by its key. The seller's
   takes one message from each sender, and lists among its readers a read key its app made at random
   for its assistant; the buyer's takes as many as come.
6. **Keys for an assistant.** Each app makes its assistant's access keys at random and lists them in
   the profile's permissions record: the seller's a write key (offers and reviews), a message key
   and the read key; the buyer's a write key. The assistants are mcp (`mcp/`), given the profile,
   the host and those keys. The seller's posts an offer with a photo (`post-offer`), signed by the
   write key; the seller's app then puts the photo's bytes on the host, which takes them because the
   offer names them and the folder pays for them.
7. **The inbox.** The buyer's app puts a message in one envelope only the seller's inbox key and the
   read key open, signs it and delivers it to the seller's host, which checks that the buyer holds a
   row from the loop issuer. A second message is refused (`once`). The seller's app pulls its inbox
   with its main key and opens the message.
8. **The seller's assistant,** through mcp: `inbox` pulls with the message key and opens the
   message with the read key; `send` replies, signed by the message key for the seller, which the
   buyer's host takes after reading the seller's permissions, and the buyer sees the message key
   sent it; `request` asks the seller, through the seller's own inbox, to post an offer the
   assistant drafted, which the seller's app pulls and opens, and `inbox` marks as a request. Then
   the seller makes the message key past and deletes the read key, from its permissions record and
   its inbox's readers. mcp refuses both keys; the host refuses the past key's pull at once
   (`permission`), and a message the past key signed (`permission`) once the host's cache time
   (`senderCacheSeconds` in `devnet.json`) and ten seconds more have passed.
9. **The deal.** The buyer pays through the escrow in one tap, pay and release in one transaction,
   through the fee payer's at-cost door (the Kora that charges what it costs). The run checks that
   the escrow's address comes from its terms, and that its rent goes back to the fee payer, which
   paid it.
10. **Reviews.** Each assistant reviews the other through mcp (`post-review`), naming the deal.
11. **The loop index shows it:** both profiles with their rows counted under the loop issuer's key,
    and the seller's page naming the issuer; the offer with its photo shown from the host; the deal
    released to the seller; both reviews counted at full weight. Not the messages, nor the request.
12. **The rating, proven.** The seller's app finds its own leaf among the loop index's reputation
    leaves by the stamp (the number a person has for one label at one issuer) its secret gives under
    its label, scored 10 from one review. It proves that rating in its market on the device, with
    the standard's reputation circuit, for its own profile: the proof shows the stamp of the
    seller's row, so it lands on that profile alone. It puts the proof on its card and publishes the
    card again. The index checks the proof and the row at its stamp, and the seller's page says
    "Rated 10.0 of 10 in Tutoring (per e2e loop index (loopback), …)".
13. **The ID check.** The seller's app opens a session on the loop issuer's document check (its
    stand-in passes it; free) and sends its tier 1 note; the issuer signs the same note at tier 2,
    and the run checks it. The app proves its tier on the device at the stamp of the row it already
    holds, checks the proof against the row as a reader does, and puts it on its card beside the
    rating's proof. The index shows the row at tier 2, "ID-checked", uniqueness 0.9, and the
    rating's proof still.

Every address, signature and charge goes to `runs/<time>.json`, with the credits each folder spent
and had left, never a credit itself; the run exits 0 only if every step passed.

### Run it

Node 22.18 or later, with the standard fetched at the commit in `STANDARD`, the reputation circuit's
proving files (the person circuit's are in the standard), and a Postgres where the run may make and
drop a database (the loop index's):

```sh
./standard.sh keys records registry/client escrow/client reputation/client
(cd standard/reputation/circuit && npm run fetch)
(cd mcp && npm ci) && (cd issuer && npm ci) && (cd index && npm ci)
cd e2e && npm ci
npm run check                      # type-check
npm test                           # the credits client
DATABASE_URL=postgres://… FOREST_DEVNET_SEED='<the devnet phrase>' npm run e2e
```

- **`FOREST_DEVNET_SEED`** (required): the devnet phrase. Its `deploy` key pays the setup; its
  `test-dollar-authority` key (the key allowed to make test dollars) mints them. Never in this repo,
  and never passed to the loop issuer or index.
- **`DATABASE_URL`** (required): a Postgres the run connects to, to make the loop index's own
  database and drop it at the end.
- **`HELIUS_API_KEY`** (optional): read and send through Helius's devnet RPC instead of
  `api.devnet.solana.com`, the loop index too. The key never goes into a run's record or the log.

Run it against the services as deployed from `main`; the host and the registry payer are paid in
the classic test dollar.

### The latest run

2026-10-12, 22:56 to 22:59 UTC, with this branch's code (standard at `40d736b`) against the host,
registry payer and fee payer as deployed from `main` at `4594bf1`, so with the host's price before
this branch (a credit a write): **passed** in 171 seconds. Its record is
[`runs/2026-10-12T22-56-35-556Z.json`](runs/2026-10-12T22-56-35-556Z.json).

- **Deployed, answering:** the issuer, `/issuer.json` naming `issuer.devnet.forest.foundation` and
  the key `2185f564…`, and the index.
- **The loop:** its issuer `issuer.e2e-loop.invalid`, key `2c59c34b…`, made at its first start; its
  index, signing key `CtEZ2JE4…`, in a database of its own, dropped at the end.
- **People:** seller `BkPyYdAziiMHuT8LzPtrZdpi35KVSihbRw3QvnTYZqU4`, buyer
  `HDscUgqZreekeXbyEo5ysSQ7bax7qtBgWsE7WMfak991`.
- **Setup:** each profile's test-dollar account, 5.00 and 10.00 test dollars; each one's own
  address, `CQ1oX8MW…` and `ExBBvraB…`, with 1.00 test dollar and 0.01 SOL.
- **Notes:** a tier 1 note each from the loop issuer's face check, model `stand-in`.
- **Credits, bought on Solana:** the seller paid the host 0.20 test dollars for 20 credits and the
  registry payer 0.50 for one; the buyer paid the host 0.20 for 20. Each a plain transfer naming its
  buy's reference, collected with the transaction's signature and finished.
- **Rows:** `tutoring/seller` through the registry payer with the seller's credit, 619 bytes, the
  row `BrmoGgxQ…` read on chain; the same row again refused as `row_exists`; the credit, shown with
  another row, refused as `spent`. The seller's profile held no SOL and paid no dollar.
  `tutoring/buyer` through the fee payer, 763 bytes, charged 1.64576 test dollars. Each read back
  naming its profile, the loop issuer's key and the key that paid for it, and each proof showed
  tier 1.
- **The host:** each folder's card was refused (`refused`) while it held no credits; then each
  spent its 20 credits in one request. At the end the seller's folder held 11 and the buyer's 17:
  every write here cost one credit, the host's price before this branch.
- **Records:** the offer `offer/maths`, posted through mcp and signed by the write key `6C8i8825…`,
  and its photo, 79 bytes, paid from the seller's folder; two reviews, one by each assistant.
- **The inbox:** the buyer's message, 4,639 bytes, sealed to the seller's inbox key and the read
  key, taken; a second refused (`once`); the seller pulled and opened it.
- **The assistant:** `inbox` opened the message with the message key `GmcBRbKv…` and the read key;
  `send` replied, 2,681 bytes; `request` reached the seller's app. Then the seller made the message
  key past and deleted the read key; mcp refused both; the host refused the past key's pull at once
  (`permission`), and 71 seconds later a message it signed (`permission`).
- **The deal:** escrow `8778cGmN…`, one tap, 715 bytes, charged 3.69808 test dollars; its rent goes
  back to the fee payer `9CKUm2s7…`.
- **The loop index:** both rows counted under "e2e loop issuer (loopback)", weight 0.7; the offer
  with its photo from `host.devnet.forest.foundation`; the deal released to the seller; both reviews
  counted. The seller rated 10.
- **The proof:** the seller's leaf found by its stamp `25106b6c…` among 2 leaves, 100 tenths,
  proven against root `26ad1505…`, signed by "e2e loop index (loopback)", and put on its card; the
  index shows it.
- **The ID check:** the seller's note signed again at tier 2; its tier proven at its row's stamp and
  put on its card beside the rating's proof. The index: the row at tier 2, "ID-checked", weight 0.9,
  uniqueness 0.9.

The loop index stopped with the run, so its pages are gone; what it read is on devnet: [the
seller][s], [the buyer][b], [the deal][d], on Solana's explorer.

[s]: https://explorer.solana.com/address/BkPyYdAziiMHuT8LzPtrZdpi35KVSihbRw3QvnTYZqU4?cluster=devnet
[b]: https://explorer.solana.com/address/HDscUgqZreekeXbyEo5ysSQ7bax7qtBgWsE7WMfak991?cluster=devnet
[d]: https://explorer.solana.com/address/8778cGmNTE7K7cswEX6NxMP5Y7eqYxz1nqts7agcwwgm?cluster=devnet

## Promises

- **No key, phrase or keyed URL (a web address with a key inside) in this directory.** The devnet
  phrase comes from the environment, and a run's record holds addresses, signatures and charges
  only.
- **It does what an app would,** with the standard's own pieces and the credits client: keys,
  records, the registry and escrow clients, and the reputation circuit's client. Nothing in it
  reaches around a service.
- **No credit in a run's record.** A credit is a bearer credit; the record holds how many were
  bought and spent, and the buys' references.
- **A run passes only if every step passed.** A failed run's record holds the steps it finished
  and the error.

## Limits

- **CI does not run it,** since it needs the devnet phrase, the deployed services and a Postgres;
  CI type-checks it and tests the credits client. It runs by hand, and its records in `runs/` say
  when it last passed.
- **Every run leaves its people on devnet for good:** their rows, under that run's loop issuer's
  key, and their deal. Their records stay on the host until it is wiped.
- **The checks are the stand-in,** with one embedding for everyone, so a run says nothing about
  Didit or the face model; of the deployed issuer and index it checks only that they answer. Only
  the seller takes the ID check, after its row is written.
- **No welcome gift.** The deployed host and registry payer take only the deployed issuer's
  tickets, so the loop pays for every credit with test dollars; the gift's tickets are taken in the
  issuer's own tests, by the host's and the registry payer's own sellers.
- **One market, one test dollar, one tap.** It pays in the classic test dollar, not the
  Open-USD-shaped one, and does not test a refund.
- **One inbox rule and one photo.** It tests inboxes open to one issuer's rows, with and without
  one message from each sender, not `anyone` or `maxBytes`; and a photo on an offer, not a
  profile's photo or a video.
- **mcp's actions, called in process; one host.** The assistants call mcp's actions inside the
  run's own process, the way its typed commands call them, not by starting `forest` or through its
  MCP tools. A host other than the
  foundation's, or a seller and buyer on different hosts, is not tested.
- **One proof:** the seller's own rating in its own market, from one profile. It does not prove
  across several profiles or hide the market.
- **Each wait on the index is up to 15 minutes:** the index step's, the proof step's two (for the
  seller's leaf, then for the proof to show), and the ID check's. A slower devnet fails the run.
- **The loop index reads the deployed host from its start,** each run, and logs each record that
  does not check as it passes it.

## Who decides what

- **The standard:** what each step makes and checks: keys, records, messages, rows, the
  escrow and the proofs.
- **Each service, by its own choice:** what it takes and what it charges; the run checks it as
  deployed.
- **The foundation:** when to run it, what `devnet.json` points at, and what the loop issuer and
  index are set to (`loop.ts`).

## FAQ

**Why does the loop run its own issuer and index, and the rest deployed?**
The deployed issuer is real: every note it signs needs a face that passed Didit, and a script has
none. Its key also stays for mainnet, so it must never sign for a script. So the loop runs the
issuer's own code with a stand-in Didit and a key of its own, on this machine. The deployed index
trusts only the deployed issuer, so the loop runs the index's own code too, trusting the loop
issuer. Everything else a person's app talks to, the host, the registry payer, the fee payer, the
programs on chain, takes any issuer's rows and any buyer's test dollars, so the loop uses them as
deployed.

**Why on devnet, against the deployed services, and not on a local validator?**
The local tests (the index's `e2e.test.ts`, the fee payer's test) already run every piece on
loopback. This run checks the pieces as they are deployed: the real programs, Kora, the hosting,
and the services talking to each other over the internet.

**Why does the deploy key pay the setup?**
A new person has no test dollars. On mainnet they would come in at a ramp; on devnet the deploy key
makes the accounts and the test dollar's own authority mints them. Nothing a profile does after
setup touches SOL; each person's own address pays its own fee for its transfers to the host and the
registry payer, as a wallet app would.

**Why keep every run's record in the repo?**
So anyone can check, on devnet itself, what a run did: every address and signature in it is public.
