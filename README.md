# services

Part of [Forest](https://github.com/foundationforest). What the Open Forest Foundation runs on the
standard, as one operator among many: an issuer, a registry payer, a fee payer, a host, an index,
and the tools AIs use, all on devnet. Anyone can run another of each, from this code (Apache 2.0)
or their own. The foundation runs the first of each until there are others, and should want to lose
every one.

## The services

| Folder | What it is |
|---|---|
| [`issuer`](issuer/README.md) | Checks once, by face, that a person is one real human, through Didit (an outside company that runs the face and ID checks), and signs them a note (a signed statement, which the person keeps, that they passed) |
| [`fee-payer`](fee-payer/README.md) | The registry payer in `registry/`, the fee payer in `at-cost/` |
| [`host`](host/README.md) | Keeps people's signed records, messages and photos, paid for in its credits (prepaid units a person buys) |
| [`index`](index/README.md) | Reads the hosts it lists, the registry's rows (its public entries, each saying a profile holds a note) and the escrow's receipts, and scores each profile |
| [`mcp`](mcp/README.md) | The CLI: Forest's actions as typed commands and as MCP tools; hosted, for AI chats |
| [`e2e`](e2e/README.md) | The test of the whole loop |

Credits, the prepaid units the host and the registry payer sell, are explained in each of those READMEs.

On devnet:

- issuer: https://issuer.devnet.forest.foundation
- registry payer: https://registry-payer.devnet.forest.foundation
- fee payer: https://fee-payer.devnet.forest.foundation
- host: https://host.devnet.forest.foundation
- index: https://index.devnet.forest.foundation
- mcp: https://mcp.forest.foundation/mcp

None of them holds a person's main key, and nothing here has user accounts: there are keys,
records and rows.

## Who decides what

- **The standard:** what every service here must agree on, at the pinned commit.
- **Each service, as it runs it:** what its README's How we run it says; whoever runs it changes
  it.
- **An app, with the person:** which host, issuer, registry payer, fee payer and index to use.

## How it works

```
             face, then face and ID (Didit), note number, buys' references
  person's app ─────────────────────────────▶ issuer ── a note back; tickets for first credits
       │
       │ a row and a credit            registry payer ── signs, sends ─┐
       ├──────────────────────────────────▶                            ├────▶ Solana: registry
       │ a payment, paid at cost       fee payer ── co-signs, sends ───┘        rows, escrow
       └──────────────────────────────────▶                                      │ rows, receipts
  assistant (mcp) ───────────┐                                                   ▼
                             │ access keys sign                               index ──▶ pages, JSON
  person's app ──────────────┴── records, paid in credits ──▶ host ── what's new ──▶ index
```

A person's app holds their seed, and mixes from it a main key for each label, such as
`tutoring/seller`
([the standard's keys](https://github.com/foundationforest/standard/blob/main/keys/README.md)).
Then:

1. **A note.** The issuer checks the person's face once and signs a note for their note number, at
   tier 1; a document check later signs the same note at tier 2. The first note comes with a
   welcome gift: the person's first credits, a few registrations at the registry payer and writes
   at the host, paid for by the issuer as their sponsor (someone who pays for another person's
   buy). The app makes each buy and sends the issuer its reference (a code that names the buy, not
   the credits in it). For each, the issuer signs a ticket (a signed promise to pay for that buy),
   and each service bills the issuer. The issuer holds no money.
2. **A row.** From the note, the app makes a person proof on the device and writes one row in the
   registry
   ([the standard's registry](https://github.com/foundationforest/standard/blob/main/registry/README.md)),
   through the registry payer with one of its credits, or through the fee payer, paid in a dollar.
3. **Records.** The app signs the profile's records with the main key and posts them to the hosts
   its hosts record names; the host takes each write's price from the folder's balance of credits.
   It makes access keys for the person's AI assistant and lists them in the profile's permissions
   record
   ([the standard's records](https://github.com/foundationforest/standard/blob/main/records/README.md#permissions));
   with them, through mcp ([`mcp/`](mcp/README.md)), the assistant posts offers and reviews,
   answers messages, and asks the person, through their own inbox, for what it holds no key for.
4. **A deal.** A buyer pays into an escrow through the fee payer, and the money moves only as the
   escrow allows
   ([the standard's escrow](https://github.com/foundationforest/standard/blob/main/escrow/README.md)).
5. **Scores.** The index reads the host, the rows of the issuers it trusts and the escrow's
   receipts, scores each profile, and serves every page as HTML and as JSON. It publishes its
   ratings as a tree; the seller's app proves its rating from it on the device and puts the proof
   on its card, and the index shows it.

Each arrow is open: an app can use another issuer, registry payer, fee payer, host or index, and
each reader decides which issuers it trusts.

### What this repo is not

- **Not the standard.** Keys, records, the registry and the escrow live in
  [foundationforest/standard](https://github.com/foundationforest/standard). This repo uses the
  standard's pieces unchanged, at one pinned commit.
- **Not an app.** Apps live in their own repos; the Forest app's is
  [foundationforest/app](https://github.com/foundationforest/app).
- **Not the market directory.** The recommended market names live in
  [foundationforest/markets](https://github.com/foundationforest/markets).

### The standard, pinned

`STANDARD` holds one commit of the standard. `./standard.sh` fetches the standard, from
[foundationforest/standard](https://github.com/foundationforest/standard), at that commit into
`standard/` (not committed), then runs `npm ci` in each of its packages named after it. Every
`standard/…` path here means the standard at that commit, and each service imports what it needs by
relative path. Each directory's README says which packages it needs.

A change one of the standard's pieces needs is made in the standard first; then `STANDARD` moves,
in a pull request here that fixes every service the move touches and keeps every README true.

### Run the checks

What [`.github/workflows/checks.yml`](.github/workflows/checks.yml) runs on every pull request and
on `main`, from a clean install. Node 22.18 or later; the index's tests need a Postgres
(`DATABASE_URL`).

```sh
./standard.sh keys records registry/client escrow/client reputation/client
(cd standard/reputation/circuit && npm run fetch)

(cd mcp         && npm ci && npm run check && npm test)
(cd index       && npm ci && npm run check && \
  node --test --test-force-exit test/markets.test.ts test/scoring.test.ts test/sign.test.ts test/server.test.ts test/pages.test.ts test/reputation.test.ts test/tiers.test.ts)
(cd e2e         && npm ci && npm run check && npm test)
(cd host        && npm ci && npm run check && npm test)
(cd fee-payer/at-cost  && npm ci && npm run check) && bash fee-payer/deploy/devnet-config.sh fee-payer/at-cost/kora.toml > /dev/null
(cd fee-payer/registry && npm ci && npm run check && npm test)
(cd issuer      && npm ci && npm run fetch && npm run check && npm test)
```

`e2e/` holds the buyer's credits client, which the host's, the registry payer's and the issuer's
tests buy with, so it is installed before them; its type-check reads mcp's actions and the
index's signing key, so they come first.

A test that cannot find what it needs skips, and the workflow fails on any skip, so a missing piece
never passes as green. Not in CI: the index's end-to-end test and the fee payer's local run, which
need the standard's programs built, its proving files, a local validator and (for the fee payer)
Kora built; the e2e run, which needs the devnet phrase and a Postgres; and the smoke run against the
deployed `mcp`.
Each directory's README says how to run them.

### On devnet

Six services on Railway, project `forest-devnet`, environment `production`. Each is one replica,
built from its directory's `deploy/Dockerfile` (the registry payer's, `fee-payer/deploy/registry.Dockerfile`)
on this repo's `main` and redeployed on every push to it; each directory's README lists its
settings and its volume. Railway's service ids: `issuer`
`9a9538d9-1a79-4860-9705-c85b8b538306`, `fee payer` `05e3d61b-7052-45cf-98f0-8928628425b7`, `host`
`6bc0708f-1171-4c93-a47e-56e5bcd82685`, `index` `37f23042-b2a0-4ff0-90c6-e0521fc811d2`, `mcp`
`34faba28-5014-491e-aa81-f4c3d1b84e98`, `registry payer` `bcca22db-92e4-41b2-ae04-f673d93c7a0b`.

| On devnet | Address |
|---|---|
| The registry | `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4` (the standard's `registry/devnet/devnet.json`) |
| The escrow | `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` (the standard's `escrow/devnet/devnet.json`) |
| The classic test dollar (six decimals) | `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` |
| The Open-USD-shaped test dollar (Token-2022 with Open USD's extensions, six decimals) | `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz` |
| The issuer's name, which each person's secret for it is mixed from | `issuer.devnet.forest.foundation` |
| The issuer's seed, which signs nothing itself | Made by the issuer on its own machine at its first start, and kept on its volume: mixed from no phrase, held by no variable |
| The issuer's note key, mixed from its seed under `issuer/notes` (Baby Jubjub, x then y) | `0a536f8d3ac40ce76c70ef8dfd2db7b6c98de273270e1e51f2651f3f0c35262717917d8df88f1712d8e9fae02c8dc575a4c3d68a71442527f23a7dd9efa1a5bf`, as [its `/issuer.json`](https://issuer.devnet.forest.foundation/issuer.json) gives it; the devnet index trusts it (`index/lists/issuers.json`) |
| Where the document check's price is paid, once one is set | A foundation address set in `ID_TIER_PAY_TO`, which the issuer's seed cannot derive; none is set on devnet |
| The issuer's sponsor key, mixed from its seed under `sponsor`, which signs the welcome gift's tickets; the registry payer and the host list it in `SPONSORS` | `FAWrifUUu84ck7tS5SVzNsQzzVamjx3JwzkDNhX3em86` |
| The registry payer's key, which its credits are paid to: a random key made for it, not mixed from the devnet phrase | `7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA` |
| The fee payer's key, the devnet `payer` key | `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd` |
| The address the host's credits are paid to, the devnet `host` key's; the host never signs with it | `2JuNCurwpbDj4YDaMEPQprnGod5cAJFZrAdqHVQogyr9` |
| The deploy key, which pays e2e's setup | `2mz33wBK7FKRXoAi7LptGGTwVQJDbrSyrVwbYRCqwP3A` |

Every key but the registry payer's and the issuer's seed is derived from the devnet phrase by the
recipe in the standard's `devnet/deploy.sh` scripts; those two are random, and the issuer's note key
and sponsor key are mixed from its seed, by the standard's `hkdf` and `mainKey`. None is in this repo. Open in a browser:
[the index](https://index.devnet.forest.foundation/) and
[who the issuer is](https://issuer.devnet.forest.foundation/issuer.json); the latest e2e run's
seller and deal are in [`e2e/`](e2e/README.md).

## Promises

The standard's own [promises](https://github.com/foundationforest/standard/blob/main/README.md#promises)
hold here, and what never goes on chain is in its
[privacy](https://github.com/foundationforest/standard/blob/main/README.md#privacy) section. Each
README holds its service's own promises. One holds for all of them:

- **Everything here competes.** Anyone can run another of each; prices and margins are each
  service's own choice, written in its README under How we run it.

## Limits

- **Devnet only.** Nothing is on mainnet, and nothing is shipped. The issuer's checks are real
  (Didit, one note number a face) and, with its key, carry over to mainnet; registry rows do not.
  The dollars are test dollars, which the dollar's maker mints at will, so credits bought with them
  are unlimited; every service is one replica on Railway.
- **One foundation runs the issuer, the registry payer and the host.** Credits are signed blind (a
  service signs each credit without seeing it), so no service can tell from a credit which buy it
  came from; whoever runs all three could still match a buy to a spend by the network address both
  came from ([host, Limits](host/README.md#limits)).
- **The services trust what they read:** the index its lists, the issuer Didit and its RPC, the
  host its RPC and, for a message key's message, the sender's host. Each README says how.

## FAQ

**What of what the foundation runs is public?**
Everything but its secrets and what it keeps private for people:

- **Public:** this code and every setting these READMEs list; the issuer's name and note key;
  every record on the host (a private record as an envelope only its readers open); the
  registry's rows and the escrow's receipts, on chain; the index's pages, JSON and reputation tree;
  and each e2e run's record.
- **Secret:** the signing keys (the registry payer's, the fee payer's, the issuer's, the index's),
  the credit keys (the registry payer's, the host's), the devnet phrase, the API keys and keyed URLs
  (web addresses with a key inside: Didit's, the RPC's), and the keys to the host's bucket (the
  online storage that holds its photos and videos).
- **Private by design:** what the issuer keeps ([issuer](issuer/README.md#what-it-keeps-and-why)),
  and the messages in an inbox, which only the recipient's main key, or a message key it lists,
  pulls, and only its inbox key and the read keys it lists open.
- **Kept, not published:** the registry payer's and the host's spent lists (the id of each credit
  already spent, so none is spent twice) and the proofs each took (with the buy's reference each
  paid for), the host's balance of each folder and the id of each write it took a price for, the
  issuer's list of note numbers given a gift, each with a hash of its buys, and Railway's own
  request logs.

**Why is the standard pinned by `standard.sh`, and not a submodule or a copy?**
Railway builds every image from the repo root, and a copy would drift from the standard. One commit in
one file is the whole pin, and moving it is a one-line change plus whatever it touches.

**Why one repo for six services?**
They share one pin of the standard, one CI and one devnet. Each directory stands alone: its own package, its
own Dockerfile, its own README.
