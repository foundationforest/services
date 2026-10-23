# e2e

Part of Forest's services: [the top README](../README.md).

The loop: Forest end to end, two people doing everything a person does, the way their apps would,
with every service this repo runs.

It is not a service. The foundation runs it by hand, and anyone can; the main way is
`npm run e2e` with the phrase that funds it. Each run writes one record to `runs/`.

## How it works

### What one run does

Two people, a tutor and a student, each from a seed of their own, in the market `tutoring`. Every
step checks what it did, and the run passes only if every step does.

1. **Keys.** From each seed: the main key for `tutoring/tutor` or `tutoring/student`, the inbox key,
   the pay key (the profile's pay address), and the note number at the loop issuer's name. From
   the tutor's seed, a second profile too: `sports-coaching/coach`.
2. **Funding.** The phrase's `deploy` key makes a test-dollar account for both pay addresses and for
   each person's wallet app (an address of its own, apart from any profile), and sends each wallet
   0.01 SOL for its fees. The test dollar's own authority (`test-dollar-authority`) mints 10 test
   dollars to the student's pay address and 1 to each wallet. When the fee payer is the loop's own,
   it gets 0.05 SOL and its test-dollar account, where it is paid.
3. **Notes.** Each person takes the loop issuer's face check (its stand-in Didit passes everyone)
   and gets a note for their note number. The run checks the issuer's signature, its face key, and
   the note number.
4. **Credits.** Each wallet buys 10 of the host's credits on Solana: a plain transfer of 0.10 test
   dollars to the host's address, naming the buy's reference, collected once the host finds it
   final, and finished with `credits/client.ts`. A host that sells only for its sponsors'
   tickets stops the run, saying so.
5. **Profiles.** Each app makes a write key and a read key for its assistant and lists them in the
   profile's permissions record: the write key for `offer`, `review` and `inbox`, the read key for
   `inbox` with its `sealTo`. The host takes the hosts and permissions records free, and refuses
   the profile record (`refused`) while the folder holds no credits. Once the app spends credits into
   the folder, the host takes it. The record holds:
   - the market, role and pay address;
   - the inbox key;
   - an inbox that takes messages from holders of a note from the loop issuer's face key, with the
     read key among its readers;
   - a real note proof, made on the device with the note circuit's committed proving files.
6. **mcp.** Each assistant calls mcp through its MCP door, as a chat does, with the profile and the
   keys its app made:
   - the tutor's posts an offer (`post`): maths, 2 USD an hour, paid `direct` or by `session`. The
     run checks that the write key signed it, not the main key;
   - the student's sends the tutor a message (`send`), which the host takes after checking the
     student's note proof;
   - the tutor's opens it (`inbox`) with the read key.
7. **The deal, paid two ways.** Both go through the fee payer at cost: the price asked, paid exactly
   in the test dollar, and co-signed.
   - **A direct payment** of 2 test dollars, from the student's pay address to the tutor's.
   - **An escrow** on the market's `session` schedule: one window until seven days after payment,
     in which the student takes nothing back, then `pay`. It is opened and paid into in one
     transaction, then paid out early by the student (`pay`). The run checks the receipt: paid
     between the two pay addresses, on the schedule, with its rent going back to the fee payer that
     fronted it.
8. **Reviews.** Each assistant posts one through mcp (`review`). The student's scores the tutor 10,
   names the offer, and gives the escrow as its evidence. The tutor's scores the student 9 and gives
   the direct payment's signature.
9. **The index.** The loop index shows:
   - both profiles counted under the loop issuer's face key;
   - the offer listed;
   - both reviews counted, each with its payment;
   - ratings of 10 and 9, each from one review with a payment, each statement signed by the index
     and checked;
   - the deal paid out, with the review that names it.

   No message appears anywhere in its JSON.
10. **The rating, carried.** The tutor's app finds its own leaf among the index's leaves by its
    stamp, without asking for it, and checks the root the index signed. It proves its tutoring
    rating on the device onto its coach profile (the standard's reputation circuit), naming none of
    its profiles. The coach profile record carries a note proof of its own and that reputation
    proof, paid with the tutor's last four credits. The index shows the proof on the coach's page.
11. **Balances.** What each folder's credits came to.

### Two ways to run, one loop

`services.json` names what a run uses:
- each service's address (`host`, `issuer`, `feePayer`, `index`, `mcp`), where `null` means the
  loop's own copy;
- the chain's public RPC;
- the escrow program;
- the test dollar;
- the market.

As committed, every service is `null`: the loop starts its own copy of each on loopback, from this
repo's folders (`services.ts`), and only the chain is remote. That chain is the one the escrow runs
on today, Solana's devnet, reached through `RPC_URL` or, without it, `services.json`'s `rpc`.

| Service | The loop's own copy |
|---|---|
| issuer | `issuer/`'s code, with the stand-in Didit its tests run (`issuer/test/fake-didit.ts`) and the stand-in face model. Its own name, `issuer.e2e-loop.invalid`, and its own seed. No welcome gift |
| host | `host/`'s code, started as its tests start it, so it reads a sender's records from a host on loopback. It sells credits for the test dollar, paid to the deploy key's address and checked through the RPC |
| fee payer | `fee-payer/run.sh`: Kora with the `kora.toml` its image runs (`deploy/devnet-config.sh`), and a new key made at its first start, which the loop funds |
| index | `index/`'s code, with lists of its own: the host; the loop issuer's two keys (face check 1 point, ID check 2); and its own reputation proofs. Its numbers and money are `index/config/`'s |
| mcp | `mcp/`'s MCP door over HTTP, starting from the host and reading the index |

A `services.json` that names an address runs the same loop against that service as it is deployed.
The issuer and the index are always the loop's own: a deployed issuer checks real faces, and a script
has none; a deployed index trusts only that issuer. A named issuer or index is only checked to answer.
So against every deployed service, a copy of `services.json` names:
- `https://host.forest.foundation`, `https://fee-payer.forest.foundation` and
  `https://mcp.forest.foundation`, which the loop uses;
- `https://issuer.forest.foundation` and `https://index.forest.foundation`, which it only checks.

The deployed host must sell its credits for the test dollar. The deployed fee payer must hold SOL
and a test-dollar account: its operator funds it, not the loop.

Each process the loop starts gets only the settings it needs, never the phrase. What any of them
prints comes to the console with `RPC_URL` taken out.

### The files

- `e2e.ts`: the run, step by step.
- `services.ts`: reads `services.json`, and starts and stops the loop's own copies.
- `chain.ts`:
  - the two keys the loop takes from the phrase;
  - what it funds and mints;
  - a wallet's transfer for a credit buy;
  - a transaction sent through the fee payer at cost.
- `record.ts`: a run's record, `checkRecord` (its shape), and `holdsNone`, which refuses a record
  holding a secret.
- `credits/client.ts`: the buyer's side of the host's credits ([host](../host/README.md#credits)):
  - `serviceOf`: the host, from its directory, with or without a payment on Solana;
  - `buy`: a buy, blinded, with its reference, its pay link when there is a payment to make, and
    what the app keeps in the vault to finish it;
  - `finish`: the credits, each checked against the host's key;
  - `creditList`: credits as a spend lists them.

  It talks to no network of its own. The loop buys with it, and so do the issuer's tests.
- `runs/`: one record per run.

### Run it

Node 22.18 or later. From the repo root:

```sh
./standard.sh                                             # the standard and the markets, at their pins
(cd standard/proofs/reputation/circuit && npm run fetch)  # the reputation circuit's proving files
(cd host && npm ci) && (cd issuer && npm ci) && (cd index && npm ci) && (cd mcp && npm ci)
fee-payer/build.sh                                        # Kora, for the loop's own fee payer
cd e2e && npm ci
npm run check && npm test                                 # what CI runs
FOREST_DEVNET_SEED='<the phrase>' npm run e2e             # the loop, on loopback
FOREST_DEVNET_SEED='<the phrase>' npm run e2e -- deployed.json   # against what deployed.json names
```

- **`FOREST_DEVNET_SEED`** (required): the phrase. Its keys come by the recipe in the standard's
  `escrows/solana/devnet/deploy.sh`. The `deploy` key pays the setup; the `test-dollar-authority`
  key mints the test dollar. Never in this repo, and never given to a service.
- **`RPC_URL`** (optional): the RPC everything uses, in place of `services.json`'s `rpc`. It may
  hold a key, so a run's record says only `RPC_URL`. Kora needs an RPC that returns inner
  instructions from `simulateTransaction`.

The tests, which CI runs:
- `test/credits.test.ts`:
  - the credits client against the host's own code, on loopback, twice. First a host that sells
    only for tickets: no address and no pay link; a payment on Solana refused; a sponsor's ticket
    collected; the credits spent into a folder, and spent once. Then a host that sells for a dollar,
    its payment checked through a stand-in RPC: the pay link; a payment one unit short refused; a
    payment in full collected and spent;
  - the client alone, against Cloudflare's own Privacy Pass issuer.
- `test/chain.test.ts`:
  - the phrase's keys, against PBKDF2 made by Web Crypto;
  - every funding and minting instruction, decoded by the token program's own decoders: with the
    loop's own fee payer and with a deployed one;
  - a wallet's transfer naming a buy's reference.
- `test/record.test.ts`: a passed run's and a failed run's records, what is refused, `holdsNone`,
  and every record in `runs/`.

### The latest run

2026-10-23, 00:21 to 00:22 UTC, with this repo at `597899e` (standard at `a125137`, markets at
`4a8d7bc`), against the deployed host, fee payer and mcp, with the loop's own issuer and index on
loopback and the chain through `RPC_URL`: **passed** in 49 seconds. Its record is
[`runs/2026-10-23T00-21-00-405Z.json`](runs/2026-10-23T00-21-00-405Z.json).

- **The services:** `https://host.forest.foundation`, `https://fee-payer.forest.foundation` (its
  key `F3Jjh7KG…`) and `https://mcp.forest.foundation`; the loop's issuer
  `issuer.e2e-loop.invalid`, face key `BjdTYysD…`, and its index `9V4SCFRY…`.
- **The test dollar:** `537LFFpTfrbvopMQwi8wSTc767PsWjqwptNmBtUGj7bt`.
- **People:** tutor `34C6wh2p…`, student `HBnjepLv…`, and the tutor's coach profile `7gqiyifh…`.
- **Funding:** 10 test dollars to the student's pay address; 1 test dollar and 0.01 SOL to each
  wallet. Before the run, outside the loop, the deploy key made the deployed fee payer's
  test-dollar account and sent it 0.05 SOL.
- **Notes:** one each from the loop issuer's face check, model `stand-in`.
- **Credits:** each wallet paid the deployed host 0.10 test dollars for 10 credits.
- **Profiles:** each refused (`refused`) while its folder held no credits, then taken; the tutor
  spent 6 credits into its folder, the student 10.
- **mcp:** the offer `offer/maths`, signed by the write key `57scpmDn…`; the student's message,
  taken by the host and opened by the tutor's assistant.
- **The deal:** the direct payment of 2 test dollars, charged 0.01 test dollars; the escrow
  `5G8c8E3A…`, opened and paid in, charged 3.73364, then paid out early, charged 0.01, its outcome
  `pay`, its rent back to the fee payer.
- **The index:** the tutor rated 10 and the student 9, each from one review with its payment, each
  statement signed; the deal paid, 2 test dollars, with its review.
- **The rating, carried:** the tutor's leaf found by its stamp among 2 leaves, 100 tenths, proven
  onto the coach profile with the tutor's last 4 credits; the index shows it.
- **Balances:** the tutor's folder 5.91081 credits, the student's 9.92587, the coach's 3.97474.

The loop's own issuer and index stopped with the run, so their pages are gone. The three profiles'
records stay on the deployed host, and what the run did on chain is on Solana's explorer:
[the escrow][e] and [the direct payment][p].

[e]: https://explorer.solana.com/address/5G8c8E3AoqqwptL7KVVa74og4FGmW6oqyQ4Ut1uXdygK?cluster=devnet
[p]: https://explorer.solana.com/tx/4md4NpZNSaPZsp5uMThZH8fyxL26pfHaBtaPinD94iR3KWA77URKS6D5W2E61UZSNsoS6GmCFKHF2bhfRpamNEft?cluster=devnet

## Promises

- **No key, phrase or keyed URL (a web address with a key inside) in this directory.** The phrase
  and `RPC_URL` come from the environment. A run's record holds addresses, signatures, amounts and
  counts only, and the run will not write one that holds the phrase, the RPC's URL, or any key or
  credit it made.
- **It does what an app would,** with the standard's own pieces and the credits client: keys,
  records, the note and reputation proofs, and the escrow client. Nothing in it reaches around a
  service.
- **No credit in a run's record.** A credit is a bearer credit. The record holds how many were
  bought, spent and left, and the buys' references.
- **A run passes only if every step passed.** A failed run's record holds the steps it finished
  and the error.

## Limits

- **CI does not run it.** It needs the phrase and the chain. CI type-checks it and runs its tests.
  It runs by hand, and its records in `runs/` say when it last passed.
- **Every run leaves its people on the chain for good:** their payments and their escrow's receipt.
  On the loop's own host and index, the rest goes when the run ends; on a deployed host, their
  records stay until it is wiped.
- **The checks are stand-ins.** The stand-in Didit passes everyone, and the stand-in face model
  gives everyone one embedding, so a run says nothing about Didit or the face model. Only the face
  check: the loop issuer offers no ID check, since it sets no price.
- **No welcome gift.** A deployed host takes only its own sponsors' tickets, so the loop pays for
  every credit in the test dollar. Tickets are tested in `test/credits.test.ts` and in the issuer's
  tests.
- **One escrow, paid out early.** One schedule, the market's `session`, in the classic test dollar.
  No stop, take-back, default, split or refund: those are the standard's escrow tests.
- **One host, one message.** Both people are on the same host. Their inboxes take messages only from
  holders of the loop issuer's note: not `anyone`, and no `once` or `maxBytes`.
- **The loop's own fee payer gets a new key each run,** and the 0.05 SOL the loop gives it stays
  with that key.
- **Each wait on the index is up to 15 minutes.** The loop index reads the escrow's whole history
  from its first transaction, which a public RPC serves slowly.

## Who decides what

- **The standard:** what each step makes and checks: keys, records, messages, proofs, the escrow.
- **The markets directory, at `MARKETS`:** what the offer and the reviews hold, and the session
  schedule.
- **Each service, by its own choice:** what it takes and what it charges. The loop checks it as it
  runs.
- **The foundation:** when to run it, what `services.json` names, and what the loop's own copies
  are set to (`services.ts`).

## FAQ

**Why does the loop always run its own issuer and index?**
A deployed issuer is real: every note it signs needs a face that passed Didit, and a script has
none. A deployed index trusts only that issuer. So the loop runs both from this repo's code, the
issuer with a stand-in Didit and a seed of its own. Every other service takes any issuer's note
holders and anyone's test dollars, so the loop can use them as deployed.

**Why does the loop start the host, index, issuer and mcp in its own process?**
The host reads a sender's records only at public addresses unless it is started with a plain
`fetch`, as its tests start it, and a loop on loopback has no public address. The index takes lists
of its own only when it is started that way. Each still runs its own folder's code, unchanged.

**Why does the phrase pay for setup?**
A new person has no test dollars. The phrase's `deploy` key makes the accounts, and the test
dollar's own authority mints them. After setup, a profile never touches SOL: the fee payer pays the
chain's fees, and each wallet pays its own fee for its credit buy, as a wallet app would.

**Why keep every run's record in the repo?**
So anyone can check, on the chain itself, what a run did: every address and signature in it is
public.
