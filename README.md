# services

Part of [Forest](https://github.com/foundationforest). What the Open Forest Foundation runs: one
copy of each service Forest's standard needs, and the loop that tests them together. Anyone can run
another of each; the main way is this code (Apache 2.0), and their own is as good. None of them
owns anything of the person's: no seed (the secret, kept on their own devices, that all their keys
come from), no key made from it, no money, and no sign-up. Each one's prices and choices are its
own, in its README's How we run it.

## How it works

### What Forest is, and what each service does for it

Forest is one seed and its profiles, verified once, with offers and reviews in public that indexes
rank. A profile is one of the person's identities, one for each market and role, such as a tutor in
tutoring. The person holds the seed on their own devices, in their app, and the main key of each
profile never leaves them. What acts for the person holds an access key their app hands it: each
profile's profile entry lists the access keys it hands out and what each can do, and every host and
reader checks that. Each service here helps with one part, and holds none of it for the person:

| The part | What the person holds | How anyone checks it | The service that helps |
|---|---|---|---|
| One seed and its profiles | A main key from the seed for each profile's label (its market and role, such as `tutoring/tutor`), the entries signed for it, and the access keys its profile entry lists | Each entry's signature, against the profile's address or an access key its profile entry lists | The **host** keeps each profile's folder (its profile entry, every entry signed for it there, the files they name, and its inbox), and serves the entries to anyone |
| Verified once | A stamp, a verifier's signature to their seed saying it checked them, which any of their profiles shows as a verification | The verification, against the verifier's key | The **verifier** checks one real person and signs them a stamp |
| Offers and reviews in public | The offers and reviews each profile signs, each review naming its evidence: a payment, or the receipt of an escrow (money held on the chain by a program, and paid out as the deal says) | Each entry's signature; each review's evidence, on chain | The **host** keeps them; the **fee payer** pays the chain's fees for the payment a review names, for a person who holds dollars and none of the chain's own coin |
| Indexes rank them | Ratings and a trust, and a reputation proof that carries the trust to another of their profiles without linking them | Each signed statement, and the root of the index's tree (one number that stands for all its trusts), against the index's key; the proof, against the root | The **index** reads the hosts and the chain, ranks each profile, and signs what it says |

**The mcp** is the AI's door to all of it, over MCP (the Model Context Protocol, the way AI apps
call outside tools): it passes on what indexes say and what the markets hold, and carries what an
AI app asks to the person's app, and the answer back.

### The sort

- **[standard](https://github.com/foundationforest/standard):** what two strangers' programs must
  agree on. That means formats, recipes and checks: keys, access keys among them, the verification
  and the reputation proof, folders and the plug every host fits, and the escrow. Every service here
  uses its pieces unchanged.
- **[markets](https://github.com/foundationforest/markets):** what a post, a review, a vouch and a
  report hold, one market at a time.
- **services, this repo:** the foundation's copy of each service, and the loop.
- **[app](https://github.com/foundationforest/app):** the Forest app: it holds the person's seed,
  hands out access keys, and uses any copy of any service.

### The services

| Folder | What it is | The foundation's copy |
|---|---|---|
| [`verifier`](verifier/README.md) | Checks that you are one real person, by face, through Didit, and signs you a stamp with its face key; its ID check, once it has a price, signs with its ID key | https://verifier.forest.foundation |
| [`host`](host/README.md) | Keeps profiles' folders, their entries, inboxes and photos, serves the entries and photos to anyone, and takes each write's price in its credits, prepaid units of its writes | https://host.forest.foundation |
| [`index`](index/README.md) | Reads the hosts it lists and the chains it lists, ranks each profile whose verification checks, and serves it all as pages and JSON, signed | https://index.forest.foundation |
| [`fee-payer`](fee-payer/README.md) | Pays the chain's fees for a person's transaction, and charges them what that cost in the dollar they pay with | https://fee-payer.forest.foundation |
| [`mcp`](mcp/README.md) | The AI's door: reads the markets and passes on what indexes say, and carries what an AI app asks to the person's app, and the answer back | https://mcp.forest.foundation |
| [`e2e`](e2e/README.md) | The loop: two people through all five, each with a stand-in for their app and an AI, end to end. Not a service | |

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

(cd verifier && npm ci && npm run fetch && npm run check && npm test)   # needs host installed
(cd index && npm ci && npm run check && npm test)       # needs host installed
(cd fee-payer && npm ci && npm run check) && bash fee-payer/deploy/devnet-config.sh fee-payer/kora.toml > /dev/null
(cd host && npm ci && npm run check && npm test)
(cd e2e && npm ci && npm run check && npm test)        # needs verifier, host, index and mcp installed
(cd mcp && npm ci && npm run check && npm test)        # needs host installed
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
- Each service depends on the standard's packages by name, through `file:` links into `standard/`.
  The index and the mcp read the markets from `markets/`, never over the network while they run.
- Moving a pin is a one-line change, in a pull request of its own that fixes every service the move
  touches and keeps every README true. A change one of the standard's pieces needs is made in the
  standard first.

## Who decides what

- **The standard, at `STANDARD`:** what every service here must agree on with every other copy.
- **The markets directory, at `MARKETS`:** each market's roles, posts and reviews.
- **Each service, as it is run:** what its README's How we run it says. Whoever runs a copy chooses
  its own.
- **An app, with the person:** which verifier, host, fee payer, index and mcp to use.
- **The person:** their seed and profiles; which AI apps, services and people hold an access key for
  which profile, and what each can do; and which proofs to show.

## FAQ

**What of what the foundation runs is public?**
Everything but its secrets and what it keeps private for people:

- **Public:**
  - this code and every setting these READMEs list;
  - the verifier's name and its two keys;
  - every entry on the host (a locked entry as an envelope only the keys it was locked to open);
  - every payment and escrow receipt, on chain;
  - the index's pages, JSON, signed ratings and reputation tree;
  - what each run of the loop did, in `e2e/runs/`.
- **Secret:**
  - the seeds and keys each service makes for itself: the verifier's seed, the index's seed, the fee
    payer's key, the host's credit key, and the mcp's key, which signs its logins;
  - the phrase that funds the loop;
  - the API keys and keyed URLs (web addresses with a key inside): Didit's, and the RPC's (the
    access point the services reach the chain through);
  - the keys to the host's bucket, the storage its photos and videos live in.
- **Private by design:**
  - what the verifier keeps ([verifier](verifier/README.md#what-it-keeps));
  - the inbox entries, which anyone can list, and only the keys they were locked to open: the
    profile's main key's opening half, and each access key its profile entry lists with
    `read-inbox`;
  - what an AI asks through the mcp, which it carries and never writes down.
- **Kept, not published:**
  - the host's list of spent credits, the payment proofs it took, the bill for its sponsors (the
    keys whose tickets pay for someone's credits), each folder's balance, and the id of each entry it
    took a price for;
  - the verifier's list of stamp numbers given a gift;
  - the hosting provider's own request logs.

**Why is the standard pinned by `standard.sh`, and not a submodule or a copy?**
Each image is built from the repo root, and a copy would drift from the standard. One commit in one
file is the whole pin, and moving it is a one-line change plus whatever it touches.

**Why one repo for five services?**
They share one pin of the standard, one CI, and one loop that tests them together. Each directory
stands alone: its own package, its own image, its own README.
