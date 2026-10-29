# e2e

Part of Forest's services: [the top README](../README.md).

The loop: Forest end to end, two people doing what a person does, each with their app (on a device
of their own, holding their seed) and an AI acting for them, with every service this repo runs.

It is not a service. The foundation runs it by hand, and anyone can; the main way is
`npm run e2e` with the phrase that funds it. Each run writes its result to `runs/`.

## How it works

### Who is who

- **Each person's device** is the reference app, [`mcp/test/app.ts`](../mcp/test/app.ts),
  unchanged. It holds the seed and the person's stamp (the verifier's signature that it checked the
  person), keeps the person's Profiles folder (the folder, locked to a key only the seed gives, that
  lists their profiles and stamps), makes each profile with a verification (the proof, made on the
  device, that its seed holds a stamp), signs with each profile's main key, writes straight to the
  host, and, at the connect page, hands the mcp an access key for the profile ticked. What it has no
  method for, the device does in `e2e.ts`, with the standard's pieces:
  - the stamp, asked of the verifier, which the device hands its app to keep;
  - the payment, a plain transfer from the profile's pay key;
  - the reputation proof, made on the device.
- **Each person's AI** is the MCP SDK's own client, through mcp's own test helpers (`aiApp`,
  `logIn`, in [`mcp/test/setup.ts`](../mcp/test/setup.ts)). It logs in as an AI app does, and calls
  the mcp's tools as a chat calls them, over MCP (the Model Context Protocol, the way AI apps call
  outside tools). It holds no key and is told no address of its own person's.
- **The connect page** is the loop's stand-in for the Forest app's, in `e2e.ts`: the person whose
  turn it is ticks the profile their AI acts in, and their app hands back the pack.

### What one run does

Two people, a tutor who sells and a student who buys, each from a seed of their own, in the market
`tutoring`. Every step checks what it did, and the run passes only if every step does.

1. **Keys.** From each seed:
   - the profile `tutoring/tutor` or `tutoring/student`: its address, and its pay addresses,
     `{ solana, evm }`;
   - the stamp number at the loop verifier's name.

   From the tutor's seed, a second profile too: `sports-coaching/coach`.
2. **Funding.** The phrase's `deploy` key makes a USDC account for both Solana pay addresses and for
   each person's wallet app (an address of its own, apart from any profile), and sends each wallet
   0.01 SOL (the chain's own coin) for its fees. From its own USDC it sends 3 to the student's pay
   address and 1 to each wallet: 5 in all, by plain transfers; nothing is minted. The student's 3
   cover its payment of 2 and the fee payer's charge for it, 0.10 at Kora's mock price, ten base
   units a lamport, a billionth of a SOL ([fee-payer](../fee-payer/README.md)). When the fee payer
   is the loop's own, it gets 0.05 SOL and its USDC account, where it is paid. A deploy key holding
   less than 5 stops the run, saying so.
3. **Stamps.** Each person takes the loop verifier's face check: its stand-in Didit passes everyone.
   Each gets a stamp for their stamp number, checked:
   - its signature;
   - the face key;
   - the stamp number.

   The device keeps the stamp. Then it asks the verifier for it again by its stamp number
   (`POST /stamp`), as a device that lost it would, and the stamp that comes back is the one signed.
4. **Credits.** Each wallet buys 10 of the host's credits (prepaid units of its writes) for USDC: a
   plain transfer of 0.10 to the host's address, naming the buy's reference, collected once the host
   finds it final, and finished with the host's credits client (`host/client/`). A host that sells
   only for its sponsors' tickets (signed by the keys it lets pay for others' buys) stops the run,
   saying so.
5. **Profiles.** Each person's device spends 2 credits into their Profiles folder, where the app
   keeps the stamp, then the rest into the profile's folder (the tutor keeps 3 for the coach
   profile), and the app adds the profile and lists it in the Profiles folder. Read back from the
   host as any reader reads it, the profile entry holds the market, the role and the profile's open
   key, so it takes messages, and the run checks:
   - its pay addresses, `pay { solana, evm }`, each signed by its pay key;
   - its verification, made on the device from the stamp it keeps and the verification circuit's
     committed proving files, which checks.
6. **Logins.** Each AI's first call to act gets the mcp's challenge. The person's browser goes
   through the connect page, where they tick their tutoring profile, and their app makes an access
   key, lists it in the profile entry with all four switches (`read-inbox`, `read`, `write`,
   `message`), writes its note, and hands the mcp the pack; the AI gets its login, and
   `my_profiles` shows that profile, by its label, with those switches. Read back from the host:
   - the profile entry lists that one access key;
   - its note, at its keyed path, is locked to one key, and opens for the main key, naming this mcp.
7. **mcp.** Every call goes through the AI's own client:
   - the tutor's AI reads the market (`markets`, `tutoring`), then writes an offer (`write`, at
     `offer/maths`): maths, 2 USD an hour, paid `direct`. On the host it is current, signed by the
     tutor's access key;
   - the student's AI finds it with `search`, the loop index's search through the mcp, and messages
     the tutor at the post's profile (`message`);
   - the tutor's AI reads its inbox (`read`, `inbox`): the message, from the student's address,
     counted (the student's profile entry lists the key that signed it with `message`), with the
     student's market, role and face check as the index shows them; and replies to the address it
     came from (`message`);
   - the student's AI reads the reply in its own inbox.
8. **The payment,** as the student's app makes it, not the AI: to the Solana pay address the tutor's
   profile entry lists, signed by its pay key, a plain transfer of 2 USDC from the student's pay
   address, through the fee payer at cost: the price asked, paid exactly in USDC, and co-signed.
9. **The review.** The student's AI writes one (`write`, at `review/maths`): it scores the tutor 10,
   names the offer, and names the payment as its evidence, `<CAIP-2 chain>:<signature>` (CAIP-2: a
   standard way to name a chain), the chain worked out from the genesis hash its RPC, the access
   point to the chain, gives. On the host it is signed by the student's access key.
10. **The index.** The loop's index shows:
    - both profiles counted under the loop verifier's face key;
    - the offer listed;
    - the review counted, with its payment;
    - what each profile shows as the index's own ranking makes it from this one review, a rating
      and its writer's word about the tutor, a vouch, with the index's numbers in
      `index/config/scoring.json`. The loop works them out with the same code: today the tutor rated
      10.0 by one rater, trust 44, the student no rating, trust 38, each uniqueness 75 and pickiness
      average. Each statement is signed by the index and checked.

    No message appears anywhere in its JSON.
11. **The trust, carried.** The tutor's device finds its own leaf among the index's leaves by its
    profile, with its trust. It checks the root the index signed, and proves its tutoring trust on
    the device onto its coach profile (the standard's reputation circuit), naming none of its
    profiles. The app adds the coach profile, paid with the tutor's last three credits, its profile
    entry carrying a verification of its own and that reputation proof. The index shows the proof on
    the coach's page, with the tutor's trust.
12. **Removed.** The tutor's app takes the access key out of the tutor's profile entry. The tutor's
    AI's next write is refused by the host, as `unlisted`, and the offer the key wrote counts for
    nothing on the host: the newest entry that still counts at its path is current, and there is
    none.
13. **A new device.** From the tutor's seed alone, the Profiles folder on the host gives its two
    profiles, `tutoring/tutor` and `sports-coaching/coach`, each with its folder there, and its
    stamp, the one signed.
14. **Addresses.** No answer either AI received holds one of its own person's addresses: each of
    their profiles, the coach's included, each pay address, and their Profiles folder. An AI reads
    the other person's addresses, as it must to message and review them.
15. **Balances.** What each folder's credits came to.

Then, passed or failed, the services stop, and when the fee payer is the loop's own, what its key
holds goes back to the deploy key, which gave it: all its USDC, its USDC account closed with that
account's rent, and all its SOL, in one transaction its key signs, as its operator's would, and the
deploy key pays for. The result says how much came back (`sweep`). A sweep that fails fails the run,
saying so.

### Two ways to run, one loop

`services.json` names what a run uses:
- each service's address (`verifier`, `host`, `feePayer`, `index`, `mcp`), where `null` means the
  loop's own copy;
- the chain's public RPC;
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
| host | `host/`'s code, as `npm start` runs it, the plug and the credits, selling credits for USDC, paid to the deploy key's address and checked through the RPC |
| fee payer | `fee-payer/run.sh`: Kora with the `kora.toml` its image runs (`deploy/devnet-config.sh`), and a new key made at its first start, which the loop funds and, when the run ends, sweeps back |
| index | `index/`'s code, with lists of its own: the host; the loop verifier's two keys in `lists/verifiers.json` (face check at confidence 0.75, ID check at 0.95, as the index's own lists give the foundation's); its own reputation proofs, against a root up to 30 days old. Its numbers, money and chains are `index/config/`'s: `config/chains.json` reads the chain above |
| mcp | `mcp/`'s code, reading the loop's index and the markets, with the loop's connect page as its `APP_URL`, and reaching hosts with a plain fetch, since the loop's host is on loopback |

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
  - what it funds, all from that key's own USDC, and what it sweeps back from its own fee payer;
  - a wallet's transfer for a credit buy;
  - a direct payment, a plain transfer;
  - a transaction sent through the fee payer at cost.
- `record.ts`: a run's result, `checkRecord` (its shape), and `holdsNone`, which refuses a result
  holding a secret.
- `runs/`: one result per run.

The loop buys its credits with the host's credits client,
[`host/client/`](../host/client/client.ts), as the verifier's tests do.

### Run it

Node 22.18 or later. From the repo root:

```sh
./standard.sh                                             # the standard and the markets, at their pins
(cd verifier && npm ci) && (cd host && npm ci) && (cd index && npm ci) && (cd mcp && npm ci)
fee-payer/build.sh                                        # Kora, for the loop's own fee payer
cd e2e && npm ci
npm run check && npm test                                 # what CI runs
FOREST_DEVNET_SEED='<the phrase>' npm run e2e             # the loop, on loopback
FOREST_DEVNET_SEED='<the phrase>' npm run e2e -- deployed.json   # against what deployed.json names
```

- **`FOREST_DEVNET_SEED`** (required): the phrase. Its `deploy` key comes by the recipe in the
  standard's `escrows/solana/devnet/deploy.sh`, and pays the setup: the accounts' rent, the SOL, and
  the 5 USDC a run moves, from its own USDC: fill it from Circle's faucet before a run. With the
  loop's own host and fee payer, 0.30 of it comes back by the run's end: the host's 0.20 for
  credits, and the sweep's 0.10. Never in this repo, and never given to a service.
- **`RPC_URL`** (optional): the RPC everything uses, in place of `services.json`'s `rpc`. It may
  hold a key, so a run's result says only `RPC_URL`. Kora needs an RPC that returns inner
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
  - every funding instruction, decoded by the token program's own decoders: with the loop's own
    fee payer, plain transfers from the deploy key's own dollars, 5 in all; with a deployed one,
    nothing for it;
  - the sweep: all the fee payer's USDC, its USDC account closed, and all its SOL, each to the
    deploy key; nothing sent when it holds nothing;
  - a wallet's transfer naming a buy's reference;
  - a direct payment: one plain transfer, and nothing else;
  - dollars as base units, and what is refused.
- `test/record.test.ts`: a passed run's and a failed run's results, what is refused, `holdsNone`,
  and every result in `runs/`.

### The latest run

2026-10-29, 05:48:10 to 05:48:51 UTC, with this repo at `4b4d717` (standard at `63e7da7`, markets at
`54fd323`), with every service the loop's own on loopback and the chain through `RPC_URL`:
**passed** in 41 seconds. Its result is
[`runs/2026-10-29T05-48-10-229Z.json`](runs/2026-10-29T05-48-10-229Z.json). The results of earlier
runs, made before access keys, are in this repo's history.

- **The services,** all the loop's own: the verifier `verifier.e2e-loop.invalid`, face key
  `BmqtnkZX…`, ID key `4QK9pAah…`; the host, paid at the deploy key; the fee payer, its new key
  `Fc6uDzaQ…`; the index `39M8gAmC…`; the mcp.
- **The dollar:** Circle's USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- **People:** tutor `8szPNUn3…`, student `84EsothK…`, and the tutor's coach profile `Hdc4rXsX…`.
- **Funding:** 3 USDC to the student's pay address; 1 USDC and 0.01 SOL to each wallet; 0.05 SOL
  to the loop's fee payer.
- **Stamps:** one each from the loop verifier's face check, model `stand-in`, kept in each Profiles
  folder, and the same asked back by its stamp number.
- **Credits:** each wallet paid the loop's host 0.10 USDC for 10 credits; the tutor spent 2 into its
  Profiles folder, 5 into its folder and 3 into the coach's, the student 2 and 8.
- **Profiles:** each with a verification that checks, and pay `{ solana, evm }`, each signed.
- **Logins:** each AI acts in its person's tutoring profile with one access key, `D312WCLu…` and
  `G87Mf6rZ…`, every switch, its note locked to the main key.
- **mcp:**
  - the offer `offer/maths`, written by the tutor's AI, signed by its access key;
  - found by the student's AI through the index's search, which messaged the tutor;
  - read by the tutor's AI, counted, with the student's market, role and face check as the index
    shows them, which replied; the student's AI read the reply.
- **The payment:** 2 USDC from the student's pay address to the tutor's, a plain transfer made by
  the student's app, charged 0.10.
- **The review:** written by the student's AI, naming the offer and the payment, signed by its
  access key.
- **The index:** the tutor rated 10.0 by one rater, trust 44, the student no rating, trust 38, each
  uniqueness 75 and pickiness average, each statement signed; the review counted with its payment.
- **The trust, carried:** the tutor's leaf found by its profile among 2 leaves, its trust 44, proven
  onto the coach profile with the tutor's last 3 credits; the index shows it.
- **Removed:** the tutor's access key taken out of its profile entry; its AI's next write refused by
  the host, "unlisted: the profile entry here lists no such key with write"; the offer it wrote
  gone from the host's view.
- **A new device:** from the tutor's seed alone, `sports-coaching/coach` and `tutoring/tutor`, and
  the stamp.
- **Addresses:** none of its own person's in any of the 6 answers to the tutor's AI or the 6 to the
  student's.
- **Balances:** the tutor's folder 4.89835 credits, the student's 7.90761, the coach's 2.95261; the
  Profiles folders 1.86551 and 1.90087.
- **The sweep:** the fee payer gave back everything it held, 0.10 USDC and 51,478,440 lamports with
  its USDC account's rent. It spent 10,000: the payment's fee.
- **What it cost the deploy key:** 4.70 USDC (5 out; 0.20 back from the host and 0.10 from the
  sweep) and 25,983,760 lamports, as its three transactions' balances on chain say.

The loop's own services stopped with the run, so their pages and the three profiles' entries are
gone. What the run did on chain is on Solana's explorer: [the payment][p] and [the sweep][s].

[p]: https://explorer.solana.com/tx/3pAozKr4psR8e454TeKJcpdKT9XbgMkVbqvwgpcBqPycLsvmiACJf51Zbuw2vd1scnjMr1wMX4p2mgTXQusRmHCo?cluster=devnet
[s]: https://explorer.solana.com/tx/4wmWFP68YpFNhWqzLwdwk1fA1MRL7N7KKGwuxFaVZYLbXTNbDmdgd9pmgAYE7qywFbjLXn6uLRgJKr8oKBFxRNfA?cluster=devnet

## Promises

- **No key, phrase or keyed URL (a web address with a key inside) in this directory.** The phrase
  and `RPC_URL` come from the environment. A run's result holds only public things: addresses,
  signatures, amounts, counts, commits, times, labels, signed statements, a root, a refusal's text,
  and the loop's own page addresses on loopback. The run will not write one that holds the phrase,
  the RPC's URL, a login, or any key or credit it made.
- **It does what a person's device and their AI would,** with stand-ins only for Didit, the face
  model and the Forest app's connect page, and with the standard's own pieces, the reference app,
  the MCP SDK's client and the credits client: keys and access keys, folders and the Profiles
  folder, the verification and the reputation proof. Nothing in it reaches around a service.
- **No credit in a run's result.** A credit is a bearer credit. The result holds how many were
  bought, spent and left, and the buys' references.
- **A run passes only if every step passed.** A failed run's result holds the steps it finished
  and the error.

## Limits

- **CI does not run it.** It needs the phrase and the chain. CI type-checks it and runs its tests.
  It runs by hand, and its results in `runs/` say when it last passed.
- **Every run leaves its people on the chain for good:** their payment, and the USDC left with them,
  about 4.70 a run (the tutor's 2, the student's 0.90 and each wallet's 0.90), since the run keeps
  no seed. On the loop's own host and index, the rest goes when the run ends. On a deployed host,
  their entries, their notes and Profiles folders among them (locked), stay until it is wiped.
- **The checks are stand-ins.** The stand-in Didit passes everyone, and the stand-in face model
  gives everyone one embedding, so a run says nothing about Didit or the face model. Only the face
  check: no one in the loop takes the ID check.
- **The connect page is a stand-in.** The loop ticks the profile for each person, with every switch,
  so a run says nothing about the Forest app's own page. Against the deployed mcp, which has none
  yet, it only checks that the mcp answers.
- **No welcome gift.** A deployed host takes only its own sponsors' tickets, so the loop pays for
  every credit in USDC. Tickets are tested in `test/credits.test.ts` and in the verifier's tests.
- **One payment, direct, and one review.** No escrow: the standard's escrow tests and the index's
  cover it. Only the student rates.
- **One host, inboxes of any size.** Both people are on the same host, so each finds the other's
  folder there.
- **The loop's own fee payer gets a new key each run,** and the sweep gives back only what that key
  still holds when the run ends. What it spent stays spent: the network fees.
- **Each wait on the index is up to 15 minutes.** The loop index reads the escrow's whole history
  from its first transaction, which a public RPC serves slowly.

## Who decides what

- **The standard:** what each step makes and checks: keys and access keys, entries, folders and the
  Profiles folder, messages, the verification and the reputation proof.
- **The markets directory, at `MARKETS`:** what the offer and the review hold, and how evidence is
  written.
- **The mcp, as this repo writes it:** its tools, the login and the pack.
- **Each service, by its own choice:** what it takes and what it charges. The loop checks it as it
  runs.
- **The index, by its own numbers:** each rating, trust, uniqueness and pickiness. The loop expects
  what those numbers make of its one review.
- **The foundation:** when to run it, what `services.json` names, what the loop's own copies are set
  to (`services.ts`), and what each person in it lets their AI do (`e2e.ts`).

## FAQ

**Why does the loop always run its own verifier, index and mcp?**
A deployed verifier is real: every stamp it signs needs a face that passed Didit, and a script has
none. A deployed index trusts only that verifier. The deployed mcp has no connect page yet, so no
AI can log in there. So the loop runs all three from this repo's code, the verifier with a stand-in
Didit and a seed of its own. The host and the fee payer take anyone's entries and anyone's USDC, so
the loop can use them as deployed.

**Why does the loop start the verifier, host, index and mcp in its own process?**
The index takes lists of its own only from its start function, not from a setting, and the mcp
reaches a loopback host only through a setting its start function takes. The others are started the
same way, each from its own folder's start function and code, unchanged, so one place starts and
stops them all.

**Why is the tutor's trust 44, and the student's 38?**
A newcomer's trust is half its uniqueness, 38: the student, whom no one rated. The student's review
is also its word about the tutor, a vouch, weighing the student's uniqueness times trust, 0.75 times
0.375; one such vouch lifts the tutor to 44. The loop works out what the index's own ranking and
numbers make of its one review, and checks the index shows exactly that.

**Why does the phrase pay for setup?**
A new person has no dollars. The phrase's `deploy` key makes the accounts and sends them USDC from
its own. After setup, a profile never touches SOL: the fee payer pays the chain's fees, and each
wallet pays its own fee for its credit buy, as a wallet app would.

**Why keep every run's result in the repo?**
So anyone can check, on the chain itself, what a run did: every address and signature in it is
public. A change to what a run does can change its result's shape; the results of earlier runs then
stay in the repo's history.
