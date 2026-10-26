# e2e

Part of Forest's services: [the top README](../README.md).

The loop: Forest end to end, two people doing everything a person does, each with a signer on their
own device and an AI acting for them, with every service this repo runs.

It is not a service. The foundation runs it by hand, and anyone can; the main way is
`npm run e2e` with the phrase that funds it. Each run writes one record to `runs/`.

## How it works

### Who is who

- **Each person's device** is the reference signer, [`mcp/test/signer.ts`](../mcp/test/signer.ts),
  unchanged. It holds the seed, keeps each profile's rules in that profile's folder, signs with
  each profile's main key, publishes straight to the host, and answers the mcp's relay by those
  rules. What it has no method for, the device does in `e2e.ts`, with the standard's pieces:
  - the stamp, kept on the device;
  - the stamp proof, made on the device and put on the profile record;
  - the escrow;
  - the review only the person's app can write, one naming the escrow it was paid through.
- **Each person's AI** is the MCP SDK's own client, through mcp's own test helpers (`aiApp`,
  `logIn`, in [`mcp/test/setup.ts`](../mcp/test/setup.ts)). It logs in as an AI app does, and calls
  the mcp's tools as a chat calls them. It holds no key and is told no address of its own person's.
- **The connect page** is the loop's stand-in for the Forest app's, in `e2e.ts`: the person whose
  turn it is chooses what their AI may do, and their signer makes the connection.

### What one run does

Two people, a tutor and a student, each from a seed of their own, in the market `tutoring`. Every
step checks what it did, and the run passes only if every step does.

1. **Keys.** From each seed:
   - the profile `tutoring/tutor` or `tutoring/student`: its address, and its pay addresses,
     `{ solana, evm }`;
   - the stamp number at the loop verifier's name.

   From the tutor's seed, a second profile too: `sports-coaching/coach`.
2. **Funding.** The phrase's `deploy` key makes a USDC account for both Solana pay addresses and
   for each person's wallet app (an address of its own, apart from any profile), and sends each
   wallet 0.01 SOL for its fees. From its own USDC it sends 42 to the student's pay address and 1 to
   each wallet: 44 in all, by plain transfers; nothing is minted. The student's 42 cover its two
   payments of 2 and the fee payer's charges, 37.5364 at Kora's mock price, ten base units a
   lamport ([fee-payer](../fee-payer/README.md)). When the fee payer is the loop's own, it gets
   0.05 SOL and its USDC account, where it is paid. A deploy key holding less than 44 stops the run,
   saying so.
3. **Stamps.** Each person takes the loop verifier's face check: its stand-in Didit passes everyone.
   Each gets a stamp for their stamp number, checked:
   - its signature;
   - the face key;
   - the stamp number.

   The device keeps the stamp. Then it asks the verifier for it again by its stamp number
   (`POST /stamp`), as a device that lost it would, and the stamp that comes back is the one signed.
4. **Credits.** Each wallet buys 10 of the host's credits for USDC: a plain transfer of 0.10 to the
   host's address, naming the buy's reference, collected once the host finds it final, and finished
   with the host's credits client (`host/client/`). A host that sells only for its sponsors' tickets
   stops the run, saying so.
5. **Profiles.** Each person's device spends credits into the profile's folder, then the signer adds
   the profile (its hosts record and its profile record, each pay address signed by its pay key).
   The device then writes the profile record again, with a real stamp proof made on the device from
   the stamp circuit's committed proving files. Read back from the host as any reader reads it, the
   record holds:
   - the market, the role, and `pay { solana, evm }`;
   - the inbox key and an inbox anyone may write to;
   - the stamp proof, which checks.

   The tutor keeps 4 credits for the coach profile.
6. **Logins.** Each AI's first call to act gets the mcp's challenge. The person's browser goes
   through the connect page, where their signer makes the connection and writes one rule into the
   profile's folder, with the connection's key inside, and the AI gets its login. Read back from the
   host, the folder holds that one rule, encrypted to the profile's own inbox key alone, for this
   mcp, with what the person chose, on their tutoring profile only:
   - the tutor: post, message, read and pay, up to 5 US dollars a day;
   - the student: post, message and pay, up to 5 US dollars a day.
7. **mcp.** Every call goes through the AI's own client:
   - the tutor's AI reads the market, then posts an offer (`post`): maths, 2 USD an hour, paid
     `direct` or by `session`. On the host it is signed by the tutor's main key;
   - the student's AI finds it with `search`, the loop index's search through the mcp, and messages
     the tutor at the post's profile (`message`);
   - the tutor's AI reads its inbox (`inbox`) and replies to the message by the number the inbox
     gave it (`reply`);
   - the student's AI asks to read its inbox. Reading is not in the student's rule, so the answer
     is *needs approval*, with a link for the student. The loop says yes on the student's signer,
     and the student's own answer holds the tutor's reply.
8. **The deal, paid twice.** Both go through the fee payer at cost: the price asked, paid exactly in
   USDC, and co-signed.
   - **A direct payment** of 2 USDC, which the student's AI asks for (`pay`). It is within the
     student's limit, so the signer pays at once: a plain transfer from the student's pay address to
     the tutor's. The AI's answer says only done; the signer keeps the payment, under the offer.
   - **An escrow,** version 4, on the market's `session` schedule, read from the market file at
     `MARKETS`: one window until seven days after payment, in which the student takes nothing back,
     then `pay`. The student's device opens and pays into it in one transaction, then pays it out
     early (`pay`). The run checks the receipt:
     - version 4, paid between the two pay addresses, on the schedule;
     - its rent going back to the fee payer that fronted it.
9. **Reviews.** Each names its evidence as `<CAIP-2 chain>:<id>`, the chain worked out from the
   RPC's genesis hash:
   - the student's AI posts one through mcp (`post`, kind `review`): it scores the tutor 10 and
     names the offer, and the student's signer fills in its evidence, the direct payment it made;
   - the tutor's AI tries to post one naming the escrow, and the mcp refuses it, naming `evidence`:
     evidence is never an AI's to write, and the tutor's signer paid nothing. So the tutor's app
     writes that review itself, scoring the student 9, at the address its inbox showed, naming the
     escrow it saw pay the tutor's pay address.
10. **The index.** The loop's index shows:
    - both profiles counted under the loop verifier's face key;
    - the offer listed;
    - both reviews counted, each with its payment;
    - each rating and backing as the index's own ranking makes them from these two reviews, with its
      numbers in `index/config/scoring.json` (the loop works them out with the same code: today 8.0
      for the tutor and 7.9 for the student, each backed 0.1), each from one review, each statement
      signed by the index and checked;
    - the deal paid out, with the review that names it.

    No message appears anywhere in its JSON.
11. **The rating, carried.** The tutor's device finds its own leaf among the index's leaves by its
    tag, without asking for it: its rating and its backing, each times ten. It checks the root the
    index signed, and proves its tutoring rating on the device onto its coach profile (the
    standard's reputation circuit), naming none of its profiles. The signer adds the coach profile,
    paid with the tutor's last four credits, and its profile record carries a stamp proof of its own
    and that reputation proof. The index shows the proof on the coach's page, with the tutor's
    rating.
12. **Addresses.** No answer either AI received holds one of its own person's addresses: each of
    their profiles, the coach's included, and each pay address. An AI reads the other person's
    addresses, as it must to message and review them.
13. **Balances.** What each folder's credits came to.

### Two ways to run, one loop

`services.json` names what a run uses:
- each service's address (`verifier`, `host`, `feePayer`, `index`, `mcp`), where `null` means the
  loop's own copy;
- the chain's public RPC;
- the escrow program;
- the dollar the loop pays in, `testDollar`;
- the market.

As committed, every service is `null`: the loop starts its own copy of each on loopback, from this
repo's folders (`services.ts`), and only the chain is remote. That chain is the one the escrow runs
on today, Solana's devnet, reached through `RPC_URL` or, without it, `services.json`'s `rpc`, and
the dollar is Circle's USDC there, which the deploy key holds: fill it from
[Circle's faucet](https://faucet.circle.com).

| Service | The loop's own copy |
|---|---|
| verifier | `verifier/`'s code, with the stand-in Didit its tests run (`verifier/test/fake-didit.ts`) and the stand-in face model. Its own name, `verifier.e2e-loop.invalid`, and its own seed. No welcome gift |
| host | `host/`'s code, as `npm start` runs it, selling credits for USDC, paid to the deploy key's address and checked through the RPC |
| fee payer | `fee-payer/run.sh`: Kora with the `kora.toml` its image runs (`deploy/devnet-config.sh`), and a new key made at its first start, which the loop funds |
| index | `index/`'s code, with lists of its own: the host; the loop verifier's two keys in `lists/verifiers.json` (face check 1 point, ID check 2); its own reputation proofs, against a root up to 30 days old. Its numbers, money and chains are `index/config/`'s: `config/chains.json` reads the chain above |
| mcp | `mcp/`'s code, reading the host first and the loop's index, with the loop's connect page as its `APP_URL` |

A `services.json` that names a host or a fee payer runs the same loop against it, as it is
deployed. The verifier, the index and the mcp are always the loop's own; one named is only checked
to answer:
- a deployed verifier checks real faces, and a script has none;
- a deployed index trusts only that verifier;
- the deployed mcp has no connect page (its `APP_URL` is unset), so no AI can log in there.

So against every deployed service, a copy of `services.json` names:
- `https://host.forest.foundation` and `https://fee-payer.forest.foundation`, which the loop uses;
- `https://verifier.forest.foundation`, `https://index.forest.foundation` and
  `https://mcp.forest.foundation`, which it only checks: the verifier says its name and two keys,
  the index answers, and the mcp, through the MCP SDK's client with no login, lists its tools and
  reads the markets.

The deployed host must sell its credits for USDC. The deployed fee payer must hold SOL and a USDC
account, which its operator funds, not the loop.

Each process the loop starts gets only the settings it needs, never the phrase. What any of them
prints comes to the console with `RPC_URL` taken out.

### The files

- `e2e.ts`: the run, step by step; each person's AI; the connect page.
- `services.ts`: reads `services.json`, and starts and stops the loop's own copies.
- `chain.ts`:
  - the key the loop takes from the phrase;
  - what it funds, all from that key's own USDC;
  - a wallet's transfer for a credit buy;
  - a direct payment, a plain transfer;
  - a market's schedule as the escrow takes it;
  - a transaction sent through the fee payer at cost.
- `record.ts`: a run's record, `checkRecord` (its shape), and `holdsNone`, which refuses a record
  holding a secret.
- `runs/`: one record per run.

The loop buys its credits with the host's credits client,
[`host/client/`](../host/client/client.ts), as the verifier's tests do.

### Run it

Node 22.18 or later. From the repo root:

```sh
./standard.sh                                             # the standard and the markets, at their pins
(cd standard/proofs/reputation/circuit && npm run fetch)  # the reputation circuit's proving files
(cd verifier && npm ci) && (cd host && npm ci) && (cd index && npm ci) && (cd mcp && npm ci)
fee-payer/build.sh                                        # Kora, for the loop's own fee payer
cd e2e && npm ci
npm run check && npm test                                 # what CI runs
FOREST_DEVNET_SEED='<the phrase>' npm run e2e             # the loop, on loopback
FOREST_DEVNET_SEED='<the phrase>' npm run e2e -- deployed.json   # against what deployed.json names
```

- **`FOREST_DEVNET_SEED`** (required): the phrase. Its `deploy` key comes by the recipe in the
  standard's `escrows/solana/devnet/deploy.sh`, and pays the setup: the accounts' rent, the SOL, and
  the 44 USDC a run moves, from its own USDC: fill it from Circle's faucet before a run. Never in
  this repo, and never given to a service.
- **`RPC_URL`** (optional): the RPC everything uses, in place of `services.json`'s `rpc`. It may
  hold a key, so a run's record says only `RPC_URL`. Kora needs an RPC that returns inner
  instructions from `simulateTransaction`.

The tests, which CI runs:
- `test/credits.test.ts`:
  - the host's credits client against the host's own code, on loopback, twice. First a host that
    sells only for tickets: no address and no pay link; a payment on Solana refused; a sponsor's
    ticket collected; the credits spent into a folder, and spent once. Then a host that sells for a
    dollar, its payment checked through a stand-in RPC: the pay link; a payment one unit short
    refused; a payment in full collected and spent;
  - the client alone, against Cloudflare's own Privacy Pass issuer.
- `test/chain.test.ts`:
  - the phrase's key, against PBKDF2 made by Web Crypto;
  - every funding instruction, decoded by the token program's own decoders: plain transfers from
    the deploy key's own USDC, 44 in all, with the loop's own fee payer and with a deployed one;
  - a wallet's transfer naming a buy's reference;
  - a direct payment: one plain transfer, and nothing else;
  - dollars as base units, and what is refused;
  - tutoring's `session` schedule, from the market file at `MARKETS`, as the escrow's client takes
    it, and the schedules the loop refuses.
- `test/record.test.ts`: a passed run's and a failed run's records, what is refused, `holdsNone`,
  and every record in `runs/`.

### The next run

None yet on this design: the records of earlier runs, made before each profile's rules and USDC, are
in this repo's history. The next run, by hand once this is on `main`, writes its record to `runs/`
and its summary here: what it used, what it paid, and its links on the chain.

## Promises

- **No key, phrase or keyed URL (a web address with a key inside) in this directory.** The phrase
  and `RPC_URL` come from the environment. A run's record holds addresses, signatures, amounts and
  counts only. The run will not write one that holds the phrase, the RPC's URL, a login, or any key
  or credit it made.
- **It does what a person's device and their AI would,** with the standard's own pieces, the
  reference signer, the MCP SDK's client and the credits client: keys, records and each profile's
  rules, the stamp and reputation proofs, and the escrow client. Nothing in it reaches around a
  service.
- **No credit in a run's record.** A credit is a bearer credit. The record holds how many were
  bought, spent and left, and the buys' references.
- **A run passes only if every step passed.** A failed run's record holds the steps it finished
  and the error.

## Limits

- **CI does not run it.** It needs the phrase and the chain. CI type-checks it and runs its tests.
  It runs by hand, and its records in `runs/` say when it last passed.
- **Every run leaves its people on the chain for good:** their payments and their escrow's receipt.
  On the loop's own host and index, the rest goes when the run ends. On a deployed host, their
  records, their rules among them (encrypted), stay until it is wiped.
- **The checks are stand-ins.** The stand-in Didit passes everyone, and the stand-in face model
  gives everyone one embedding, so a run says nothing about Didit or the face model. Only the face
  check: the loop verifier offers no ID check, since it sets no price.
- **The connect page is a stand-in.** The loop chooses for each person, so a run says nothing about
  the Forest app's own page. Against the deployed mcp, which has none yet, it only checks that the
  mcp answers.
- **One person's yes, given at once.** The one request outside a person's rule is approved on their
  signer right away; nothing waits as a person would.
- **No welcome gift.** A deployed host takes only its own sponsors' tickets, so the loop pays for
  every credit in USDC. Tickets are tested in `test/credits.test.ts` and in the verifier's tests.
- **One escrow, paid out early.** One schedule, the market's `session`, in USDC. No stop,
  take-back, default, split or refund: those are the standard's escrow tests.
- **One review written by an app.** The tutor's review names the escrow it was paid through, which
  no AI may name and no signer of the tutor's paid, so the loop's app writes it.
- **One host, inboxes open to anyone.** Both people are on the same host, and each inbox takes
  messages from anyone: no stamp holders only, no `maxBytes`.
- **The loop's own fee payer gets a new key each run,** and what it holds stays with that key: the
  0.05 SOL the loop gives it, and the 37.5364 USDC the student pays it.
- **Each wait on the index is up to 15 minutes.** The loop index reads the escrow's whole history
  from its first transaction, which a public RPC serves slowly.

## Who decides what

- **The standard:** what each step makes and checks: keys, records and each profile's rules,
  messages, proofs, the escrow.
- **The markets directory, at `MARKETS`:** what the offer and the reviews hold, how evidence is
  written, and the session schedule.
- **Each service, by its own choice:** what it takes and what it charges. The loop checks it as it
  runs.
- **The index, by its own numbers:** each rating and backing. The loop expects what those numbers
  make of its two reviews.
- **The foundation:** when to run it, what `services.json` names, what the loop's own copies are set
  to (`services.ts`), and what each person in it lets their AI do (`e2e.ts`).

## FAQ

**Why does the loop always run its own verifier, index and mcp?**
A deployed verifier is real: every stamp it signs needs a face that passed Didit, and a script has
none. A deployed index trusts only that verifier. The deployed mcp has no connect page yet, so no
AI can log in there. So the loop runs all three from this repo's code, the verifier with a stand-in
Didit and a seed of its own. The host and the fee payer take anyone's records and anyone's USDC, so
the loop can use them as deployed.

**Why does the loop start the verifier, host, index and mcp in its own process?**
The index takes lists of its own only from its start function, not from a setting. The others are
started the same way, each from its own folder's start function and code, unchanged, so one place
starts and stops them all.

**Why does the device write the profile record twice?**
The reference signer adds a profile with the profile record it makes itself, which carries no proof.
The stamp proof is made on the device from the stamp it keeps, so the device writes the profile
record again with it, as an app does when the person chooses to show a proof.

**Why are the ratings 8.0 and 7.9, and not the 10 and 9 the reviews give?**
The index ranks by trust: each review weighs as much as its writer is trusted, and a writer with
only a face check is trusted little, so each rating stays near the market's baseline. The loop works
out what the index's own ranking and numbers make of its two reviews, and checks the index shows
exactly that.

**Why does the phrase pay for setup?**
A new person has no dollars. The phrase's `deploy` key makes the accounts and sends them USDC from
its own. After setup, a profile never touches SOL: the fee payer pays the chain's fees, and each
wallet pays its own fee for its credit buy, as a wallet app would.

**Why keep every run's record in the repo?**
So anyone can check, on the chain itself, what a run did: every address and signature in it is
public. A change to what a run does can change its record's shape; the records of earlier runs then
stay in the repo's history.
