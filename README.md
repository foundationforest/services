# services

Part of [Forest](https://github.com/foundationforest). What the Open Forest Foundation runs: one
copy of each service Forest's standard needs, and the loop that tests them together. Anyone can run
another of each; the main way is this code (Apache 2.0), and their own is as good. None of them
owns anything of the person's: no seed, no main key, no permission, no money, and no sign-up. Each
one's prices and choices are its own, in its README's How we run it.

## How it works

### What Forest is, and what each service does for it

Forest is one seed and its profiles, verified once, with offers and reviews in public that indexes
rank. The person holds the seed on their own devices, their signers, and everything that acts for
them asks a signer, which acts by the person's permissions; no key is ever handed out. Each service
here helps with one part, and holds none of it for the person:

| The part | What the person holds | How anyone checks it | The service that helps |
|---|---|---|---|
| One seed and its profiles | A main key from the seed for each label, the records it signs, and each profile's rules: who may ask their signers to act as it, encrypted to its own inbox key | Each record's signature, against the profile's address | The **host** keeps each profile's folder, its rules among its records, and its inbox, and serves the records to anyone |
| Verified once | A stamp a verifier signed to their seed, which any of their profiles shows as a stamp proof | The proof, against the verifier's key | The **verifier** checks one real person and signs them a stamp |
| Offers and reviews in public | The offers and reviews each profile signs, each review naming its evidence: a payment or an escrow's receipt | Each record's signature; each review's evidence, on chain | The **host** keeps them; the **fee payer** pays the chain's fees for the payment a review names, for a person who holds dollars and no SOL |
| Indexes rank them | A rating, and a reputation proof that carries it to another of their profiles without linking them | Each rating and tree root, against the index's key; the proof, against the root | The **index** reads the hosts and the chain, rates each profile, and signs what it says |

**The mcp** is the AI's door to all of it: it reads what hosts and indexes say, and carries what an
AI app asks to the person's signer, and the answer back.

The escrow, version 4, and every payment here run on the chain the escrow runs on today, Solana's
devnet, in Circle's USDC on that chain, which anyone gets from
[Circle's faucet](https://faucet.circle.com).

### The sort

- **[standard](https://github.com/foundationforest/standard):** what two strangers' programs must
  agree on. That means formats, recipes and checks: keys, the stamp and reputation proofs, records
  and each profile's rules, and the escrow. Every service here uses its pieces unchanged.
- **[markets](https://github.com/foundationforest/markets):** what a post and a review hold, one
  market at a time.
- **services, this repo:** the foundation's copy of each service, and the loop.
- **[app](https://github.com/foundationforest/app):** the Forest app, a signer: it holds the
  person's seed and uses any copy of any service.

### The services

| Folder | What it is | The foundation's copy |
|---|---|---|
| [`verifier`](verifier/README.md) | Checks that you are one real person, by face, through Didit, and signs you a stamp with its face key; its ID check, once it has a price, signs with its ID key | https://verifier.forest.foundation |
| [`host`](host/README.md) | Keeps profiles' signed records, their inboxes and photos, serves the records to anyone, and takes each write's price in its credits | https://host.forest.foundation |
| [`index`](index/README.md) | Reads the hosts it lists and the chains it lists, rates each profile whose stamp proof checks, and serves it all as pages and JSON, signed | https://index.forest.foundation |
| [`fee-payer`](fee-payer/README.md) | Pays the chain's fees for a person's transaction, and charges them what that cost in the dollar they pay with | https://fee-payer.forest.foundation |
| [`mcp`](mcp/README.md) | The AI's door: reads markets, profiles and indexes, and passes what an AI app asks to the person's signer, and the answer back | https://mcp.forest.foundation |
| [`e2e`](e2e/README.md) | The loop: two people through all five, each with a signer and an AI, end to end. Not a service | |

## Run a copy

Anyone can run another copy of any of them; the main way is its folder's `deploy/Dockerfile`, built
with this repo's root as the build context. Each folder's README says its settings, what it keeps
and where, and How we run it. On a machine of your own, Node 22.18 or later:

```sh
./standard.sh                      # the standard and the markets, at their pins
cd host && npm ci && npm start     # or verifier, index, mcp; each README lists its settings
fee-payer/build.sh && fee-payer/run.sh   # the fee payer: Kora, built, then run
```

What [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs on every pull request and
on `main`, from a clean install, six jobs:

```sh
./standard.sh
(cd standard/proofs/reputation/circuit && npm run fetch)   # for the index's tests

(cd verifier && npm ci && npm run fetch && npm run check && npm test)   # needs e2e and host installed
(cd index && npm ci && npm run check && npm test)
(cd fee-payer && npm ci && npm run check) && bash fee-payer/deploy/devnet-config.sh fee-payer/kora.toml > /dev/null
(cd host && npm ci && npm run check && npm test)
(cd e2e && npm ci && npm run check && npm test)        # needs verifier, host, index and mcp installed
(cd mcp && npm ci && npm run check && npm test)
```

A test that cannot find what it needs skips, and CI fails on any skip: each summary must say
`# skipped 0`. CI does not run the slower checks, and each folder's README says how to run them:
- the fee payer's local run, which needs a local validator and Kora built;
- the loop, which needs the phrase and the chain;
- mcp's smoke test against the deployed copy.

## The pins

- `STANDARD` holds one commit of the standard, and `MARKETS` one commit of the markets.
- `./standard.sh` fetches each at its commit into `standard/` and `markets/` (neither committed),
  then installs and builds the standard's packages.
- Each service depends on the standard's packages by name, through `file:` links into `standard/`,
  and reads the markets from `markets/`, never over the network while it runs.
- Moving a pin is a one-line change, in a pull request of its own that fixes every service the move
  touches and keeps every README true. A change one of the standard's pieces needs is made in the
  standard first.

## Who decides what

- **The standard, at `STANDARD`:** what every service here must agree on with every other copy.
- **The markets directory, at `MARKETS`:** each market's roles, posts and reviews.
- **Each service, as it is run:** what its README's How we run it says. Whoever runs a copy chooses
  its own.
- **An app, with the person:** which verifier, host, fee payer, index and mcp to use.
- **The person:** their seed and profiles; which AI apps and which people may ask their signers to
  act, for what, on which profiles and within which limits; and which proofs to show.

## FAQ

**What of what the foundation runs is public?**
Everything but its secrets and what it keeps private for people:

- **Public:**
  - this code and every setting these READMEs list;
  - the verifier's name and its two keys;
  - every record on the host (a private record, a profile's rules among them, as an envelope only
    its readers open);
  - every payment and escrow receipt, on chain;
  - the index's pages, JSON, signed ratings and reputation tree;
  - each run of the loop's record.
- **Secret:**
  - the seeds and keys each service makes for itself: the verifier's seed, the index's seed, the fee
    payer's key, the host's credit key, and the mcp's key, which signs its logins;
  - the phrase that funds the loop;
  - the API keys and keyed URLs (web addresses with a key inside): Didit's, and the RPC's;
  - the keys to the host's bucket.
- **Private by design:**
  - what the verifier keeps ([verifier](verifier/README.md#what-it-keeps));
  - the messages in an inbox, which only the profile's main key pulls, and only its inbox key
    opens;
  - each profile's rules, which only its own inbox key opens, and so only the person's seed;
  - what an AI asks through the mcp, which it carries and never writes down.
- **Kept, not published:**
  - the host's spent list, the proofs it took, its sponsors' bill, each folder's balance, and the id
    of each record and message it took a price for;
  - the verifier's list of stamp numbers given a gift;
  - the hosting provider's own request logs.

**Why is the standard pinned by `standard.sh`, and not a submodule or a copy?**
Each image is built from the repo root, and a copy would drift from the standard. One commit in one
file is the whole pin, and moving it is a one-line change plus whatever it touches.

**Why one repo for five services?**
They share one pin of the standard, one CI, and one loop that tests them together. Each directory
stands alone: its own package, its own image, its own README.
