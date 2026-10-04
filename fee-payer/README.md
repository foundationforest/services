# fee payer

The fee payer pays Solana's costs for a person's transactions: at cost, paid back in the dollar the
person holds, or, for the person's registry rows, free against a voucher.

Soil runs this one on devnet: the general node, paid in two test dollars, and the sponsored node,
once its Railway service is created (On devnet). Anyone can run another, from this configuration or
their own: whoever signs a transaction as payer pays for it, and the programs care nothing for who
that is. Nothing is on mainnet, and nothing is shipped.

Up: [the repo](../README.md).

It is [Kora](https://github.com/solana-foundation/kora) 2.0.5, configured, in two nodes that sign
with one key. The **general node** (`general/kora.toml`) co-signs a transaction as its payer, pays the
network fee and any storage deposit, and charges the person exactly what that cost it, in the token
they pay with. The **sponsored node** (`sponsored/kora.toml`) pays for a registry row and charges
nothing; in front of it stands the pre-check (`sponsor/`), the one program of ours here, which lets a
row through only with a voucher it has not seen before. Neither holds any of the person's keys, and
neither decides anything about the person, the market or the deal.

## How it works

### The general node

The person's device:

1. builds the transaction with the fee payer as payer, plus one plain token transfer to the fee
   payer whose amount it fills in next;
2. asks Kora the price of exactly that transaction, in that token (`estimateTransactionFee`);
3. sets the transfer to that price, and signs with the main key;
4. hands it to Kora (`signAndSendTransaction`).

Kora simulates it, reads every program call inside it, checks it against `general/kora.toml`, checks the
transfer covers the price, adds its signature and sends it.

**The price** is the network fee (per signature, the person's included) plus every account the
fee payer funds, counted from the simulation, including accounts a program creates inside its own
call. The transfer must already be in the transaction when the device asks: without it, Kora adds a
fixed 50 lamports for the payment it expects and misses that payment's signature, so the quote
falls 5,000 lamports short and Kora refuses the transaction it quoted.

**A registry row** takes two signatures: the fee payer's, which pays the network fee and the row's
deposit and is recorded in the row as its payer, and the main key's, which signs the row and the
payment. The proof names the profile and the label, so nothing the fee payer sees lets it take the
row.

### What the general node allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the registry and the escrow at their devnet addresses, SPL Token, Token-2022, Associated Token Account, System | Kora checks every program a transaction calls, inner calls included |
| No compute budget program | | So no priority fee: the fee payer never pays one it did not agree to |
| `max_allowed_lamports` | 0.01 SOL | Deposits per transaction; an escrow's creation takes about 0.0037 |
| `max_signatures` | 3 | The fee payer, and an escrow's two parties when both sign a split |
| `price` | margin 0 | The charge is the cost |
| `price_source` | `Jupiter` (needs `JUPITER_API_KEY`) | Jupiter prices mainnet only; devnet uses Kora's mock |
| `rate_limit` | 100 a second, across all callers | Kora's own limiter |
| `payment_address` | unset | Payments go to token accounts the fee payer's own key owns |
| `fee_payer_policy` | only `allow_create_account` | The fee payer's key may fund a new account it is paid for, and nothing else: no transfer, assign, allocate or nonce use, and no SPL Token or Token-2022 instruction as owner or authority |
| No API key or HMAC | | A page in a browser cannot keep a secret, and every transaction pays its way |

The programs: the registry `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC` and the escrow
`FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`, as forest records them on devnet. The tokens it is
paid in, in `general/kora.toml`, are mainnet's: **USDC, USDT, Open USD and EURC**, each its maker's
own mint. `deploy/devnet-config.sh` prints a node's `kora.toml` with exactly three lines changed, and
stops if any is not there exactly once: the two paid-token lists (the two devnet test dollars in place of the
four mainnet tokens), and `price_source = "Mock"`. Kora's mock values the test dollars at 0.001 SOL
a whole token: one base unit buys one lamport.

| Token (mainnet) | Mint | Program |
|---|---|---|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL Token |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | SPL Token |
| Open USD | `ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB` | Token-2022, eight extensions, no transfer fee |
| EURC | `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | SPL Token; a euro |

All four have six decimals and no transfer fee, so each quote holds. Kora's Jupiter price source
prices each in dollars against SOL, so the charge is the same SOL cost in whichever is paid, EURC
at the euro's rate. In Kora 2.0.5, `allowed_tokens` gates only Kora's own `transferTransaction`
helper; an escrow in another token still passes. `allowed_spl_paid_tokens` is the list it is paid
in.

Refused, each tested with nothing landing: a program not on the list (`… is not in the allowed
list`); a priority fee; the fee payer's SOL sent anywhere (`Fee payer cannot be used for 'System
Transfer'`); the payment taken back out of the fee payer's account (`… 'SPL Token Transfer'`); no
payment, or one short of the deposits (`Insufficient token payment. Required … lamports`).

### What comes back, and to whom

The fee payer charges what it spends. What comes back later goes where each program sends it:

- **An escrow's deposit address:** its rent goes back to the person who created the escrow, at
  every ending.
- **An escrow never funded, closed:** both rents go back to the person.
- **What Solana's storage price cuts free** on an account the fee payer funded goes to the fee
  payer, which keeps it: a registry row's (`refund`, to the payer the row records) and an escrow
  receipt's (`sweep_rent`, to the payer it records).

Anyone may send `refund` or `sweep_rent`. A row never grows after `register`, so nothing a row needs
later asks the fee payer for SOL.

### Measured, on a local validator

`test/fee-payer.test.ts`, both programs built as SBPF v3, rent at the validator's default (6,960
lamports a byte), Kora's mock price (one base unit of the test dollar buys one lamport). All amounts
in lamports. Charged equals spent in every row; the network fee was 10,000 each time: two
signatures, no priority fee.

| Transaction | Size | Charged | Of which deposits |
|---|---|---|---|
| Registry row, a 20-byte label | 767 bytes | 2,466,880 | the row, 2,456,880 |
| Escrow, pay (deposit address, create, money in) | 663 | 5,062,960 | escrow 3,013,680, deposit address 2,039,280 |
| Escrow, release | 521 | 10,000 | none |
| Escrow, one tap | 713 | 5,062,960 | the same two |
| Escrow in Open USD, pay | 727 | 5,160,400 | escrow 3,013,680, deposit address 2,136,720 |
| Escrow in Open USD, release | 553 | 10,000 | none |

### The sponsored node

The person's device:

1. makes a voucher: a second proof from its stamp on Soil's issuer's list, under the label
   `sponsor/1`, `sponsor/2` or `sponsor/3`, naming the main key the row is for (forest's
   `proveStamp`, against the issuer's newest snapshot);
2. builds the row's transaction with the fee payer as payer (the general node's `getPayerSigner`
   names it: both nodes sign with one key), and signs it with the main key;
3. sends both to the pre-check, `POST /sponsor`, as `{ transaction, voucher: { proof, root,
   issuerSignature, label, marketStamp } }`: the transaction in base64, the proof as `proveStamp`'s
   `raw`, and the root, the issuer's signature on it and the market stamp in hex, as the issuer's
   `list.json` writes a root.

The pre-check checks, in this order, and refuses by name at the first that fails:

| Check | Refusal |
|---|---|
| The request has both parts, in their shapes | `bad_request` (400) |
| The transaction decodes, whole, with nothing after it | `bad_transaction` (400) |
| It is one instruction, `register`, to the registry, with its four accounts (the row, the main key, the payer, System), no address lookup table and no other account | `not_one_registration` (400) |
| The main key it names signed it | `not_signed_by_main_key` (400) |
| The voucher's label is `sponsor/1`, `sponsor/2` or `sponsor/3` | `not_a_voucher_label` (400) |
| Soil's issuer signed the voucher's root (forest's `issuerSigned`) | `not_signed_by_issuer` (400) |
| The voucher's proof holds for that root, market stamp, label and main key (forest's `verifyStamp`) | `voucher_does_not_hold` (400) |
| Its market stamp is not in the used set; it goes in now, spent | `voucher_used` (409) |

Then it hands the transaction, unchanged, to Kora's `signAndSendTransaction` and answers
`{ signature }`, or `fee_payer_refused` (502) with Kora's reason; the voucher stays spent either way.
Kora checks the transaction against `sponsored/kora.toml`, adds its signature and sends it: the fee
payer pays the network fee and the row's deposit, and is recorded in the row as its payer.

**A voucher** is the stamp's market stamp under a `sponsor/` label: the same every time for one
stamp and one label, so each stamp has three, and nobody can tell from one whose stamp it is. Its
proof names the main key, so a voucher seen in flight sponsors that main key's row and no other. The
row itself may be under any issuer and any label.

### What the sponsored node allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the registry at its devnet address, System | The registry creates the row with System, inside its own call |
| `max_allowed_lamports` | 0.0024 SOL | The largest row (a 128-byte label, 333 bytes) takes 0.00234188 at today's rent, 5,080 lamports a byte on devnet and mainnet |
| `max_signatures` | 2 | The fee payer and the main key |
| `price` | free | Nothing is charged |
| `rate_limit` | 1 a second, across all callers | Kora's own limiter. It holds a request over the limit until the next second rather than refusing it, so it never costs a spent voucher |
| `fee_payer_policy` | only `allow_create_account` | As in the general node: its key may fund a new account, the row, and nothing else. Kora warns about it at start, and runs |
| `allowed_tokens`, `allowed_spl_paid_tokens`, `price_source` | the general node's | Never used when free (FAQ) |
| `KORA_API_KEY` | made at each start, given to the pre-check alone | Kora listens on every interface (FAQ) |

Refused by Kora, tested on devnet with nothing landing: a row larger than the cap (`Total transfer
amount 2341880 exceeds maximum allowed 2341879`, the cap lowered for the test), and a call without
the key (401). Refused by the pre-check, each in `sponsor/test/sponsor.test.ts` with nothing reaching
Kora: every refusal above, a voucher replayed, and a voucher sent with another main key's row.

### Measured, on devnet

2026-10-04, against the devnet registry, each row from a main key that never held a lamport: one
through a local Kora on `sponsored/kora.toml`, one through the built container, pre-check and all.
All amounts in lamports; the network fee was 10,000 each time.

| Transaction | Size | Fee payer spent | Of which the row |
|---|---|---|---|
| Registry row, a 128-byte label, the largest ([`ovwU6qU…`](https://explorer.solana.com/tx/ovwU6qUPBFsMUo6a2AkdAEWHWXJHsVEPMJcrkZ2XGSdauFQDiQ1d5s6k9MGMm5znU3hKJcRW77hPHWb2jY587Vf?cluster=devnet)) | 764 bytes | 2,351,880 | 2,341,880 |
| Registry row, `tutoring/seller`, through the container ([`3PFYJih…`](https://explorer.solana.com/tx/3PFYJih4HUY7niLjmoA7TVJWhv2kge76i7htPWPiWnRSe29GDKsXDTmu5LmB8z5JzU9hKzDkSBcsGFswHGiEk4jv?cluster=devnet)) | 651 | 1,777,840 | 1,767,840 |

### Settings

Both nodes, `run.sh`:

| Variable | What |
|---|---|
| `FOREST_FEE_PAYER_KEY` | The fee payer's key: a path to a keypair file (the Solana CLI's JSON form) outside this repo, or, where a hosting platform has no files, the key itself, as that JSON array or base58. Kora 2.0.5 built `--locked` uses solana-keychain 0.1.0, which reads a path first and otherwise takes the key itself. If it is unset, `run.sh` takes it from `FOREST_RELAYER_KEY`, because Railway still holds the key under that old name and sealed values cannot be moved |
| `RPC_URL` | The Solana RPC Kora simulates and sends through. Required. It must return inner instructions from `simulateTransaction` |
| `JUPITER_API_KEY` | For `price_source = "Jupiter"` |
| `PORT` | Default `8080` |
| `KORA_CONFIG` | Default `general/kora.toml`; the sponsored node's image sets `sponsored/kora.devnet.toml` |
| `KORA_BIN` | Default `.kora/bin/kora` |
| `RUST_LOG` | Kora's log filter. Unset, Kora logs at `info`, which writes the body of every request: each transaction it is asked to price or sign. `warn` writes no request |

`run.sh` refuses a key file inside this repo.

The pre-check, `sponsor/`:

| Variable | Required | Default | What |
|---|---|---|---|
| `VOUCHER_ISSUER` | yes | | The issuer whose list vouchers are proven against: Soil's |
| `REGISTRY_PROGRAM` | yes | | The registry a row is written by: the one `sponsored/kora.toml` allows |
| `KORA_URL`, `KORA_API_KEY` | yes | | The sponsored Kora and its key; `sponsor/deploy/start.sh` sets both |
| `DATABASE_PATH` | no | `./data/sponsor.sqlite` | The used set's one file |
| `PORT` | no | `8080` | |

`sponsor/deploy/start.sh` starts Kora (`run.sh`, on port 8081) and the pre-check in one container,
and stops the container when either stops.

### Run it

```
./build.sh          # Kora 2.0.5 into .kora/ (cargo install kora-cli --locked; Rust, 6 to 12 minutes)
FOREST_FEE_PAYER_KEY=/outside/repo/fee-payer.json RPC_URL=https://… JUPITER_API_KEY=… ./run.sh   # :8080
```

Checks:

```
./forest.sh registry/client registry/artifacts escrow/client       # from the repo root
(cd forest/registry/artifacts && npm run fetch)                     # the proving files, for the pre-check's tests
cd fee-payer && npm ci && npm run check                             # type-check the local run
bash deploy/devnet-config.sh general/kora.toml > /dev/null          # the devnet configs still apply
bash deploy/devnet-config.sh sponsored/kora.toml > /dev/null
(cd sponsor && npm ci && npm run check && npm test)                 # the pre-check, a stand-in Kora, real proofs; seconds
npm run test:local                                                  # the local run, about 30 seconds
```

**The local run** starts a validator with the two programs at the ids in their source (as a local
build has them), a six-decimal test dollar planted at USDC's address and Open USD planted from its
mainnet account, and Kora through `run.sh` on a copy of `general/kora.toml` with exactly three lines changed:
the two programs' devnet ids to their source ids, and `price_source = "Mock"`. A main key that
never held a lamport then writes a registry row, pays escrows (one in Open USD), closes one never
funded, and provokes every refusal above; every balance is checked. It needs `solana-test-validator`
(Solana CLI 4.2.2), the two programs built (`cargo build-sbf --arch v3` in
`forest/registry/program` and `forest/escrow/program`), the proving files (`npm run fetch` in
`forest/registry/artifacts`) and `./build.sh`. It skips, saying which, if one is missing. Not in CI.
It runs the general node only; the sponsored node was run on devnet (above).

### On devnet

The general node: Kora's own published image, `ghcr.io/solana-foundation/kora:v2.0.5`, pinned by
digest, with `general/kora.toml`, `signers.toml` and `run.sh`. `deploy/Dockerfile` checks the image
is the version in `KORA` and writes the devnet config with `deploy/devnet-config.sh`. Before the first transaction,
the key needs SOL for the deposits it funds, and a token account for each token it is paid in. It
is paid back in tokens; turning them back into SOL is an operations loop, not code.

Soil's devnet general node runs that image on Railway, project `forest-devnet`, service `relayer`,
at https://relayer-production-8d40.up.railway.app (Kora's JSON-RPC at `/`, POST; `GET /liveness`):

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=fee-payer/deploy/Dockerfile`.
- **One replica,** health check `GET /liveness`, a public domain to port 8080, no volume.
- **Signs as** `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd`, the devnet `payer` key, which is also
  the Open-USD-shaped test dollar's mint authority.
- **Paid in** the classic test dollar `J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa` and the
  Open-USD-shaped one `g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz`.

| Variable | On devnet | Sealed |
|---|---|---|
| `FOREST_RELAYER_KEY` | the `payer` key, as its JSON array; `run.sh` passes it to Kora as `FOREST_FEE_PAYER_KEY` | yes |
| `RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `RUST_LOG` | `warn` | no |
| `PORT` | `8080` | no |

With `RUST_LOG=warn`, Kora logs no request. It still logs errors: a token instruction type it
cannot read, by its type alone, and an instruction with too few accounts, whole.

The sponsored node: `sponsor/deploy/Dockerfile` builds one container from Node's image, Kora's binary
copied from the same pinned image (and checked against `KORA`), `sponsored/kora.toml` with the devnet
lines, and the pre-check, with `RUST_LOG=warn` set in the image. Soil's runs on Railway, project
`forest-devnet`, service `sponsor`, which is not created yet; its address goes in
[`../e2e/devnet.json`](../e2e/devnet.json) once it is (`POST /sponsor`):

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=fee-payer/sponsor/deploy/Dockerfile`.
- **One replica,** a public domain to port 8080, a volume at `/data` for the used set, no health
  check.
- **Signs as** the general node's key, `9CKUm2s7nwT7HrCpjtaffNH3PnUUVyQr2gELjHrWYBUd`.
- **Vouchers from** Soil's issuer, `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7`.

| Variable | On devnet | Sealed |
|---|---|---|
| `FOREST_FEE_PAYER_KEY` | the `payer` key, as its JSON array | yes |
| `RPC_URL` | `https://api.devnet.solana.com`, which returns inner instructions from `simulateTransaction` | no |
| `VOUCHER_ISSUER` | `7zPD6AZc7RJv4Z15AoHvzJ2ZMCTW57XZTJanMZYsU7U7` | no |
| `REGISTRY_PROGRAM` | `5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC` | no |
| `DATABASE_PATH` | `/data/sponsor.sqlite` | no |
| `PORT` | `8080` | no |

## Policy

- **Kora,** 2.0.5, in two nodes that sign with one key: the general node configured by
  `general/kora.toml`, the sponsored node by `sponsored/kora.toml`, with no code of ours inside
  either. The sponsored node has one program of ours in front of it: the pre-check.
- **The general node, at cost:** the charge is the network fee and every storage deposit it puts
  down, with a margin of 0. It pays for no one: a transaction that does not pay its cost is refused.
- **Paid in four tokens on mainnet:** USDC, USDT, Open USD and EURC, each its maker's own mint, the
  makers' freeze and Open USD's permanent delegate accepted. On devnet, the two test dollars.
- **What its key may do:** fund a new account (in the general node one it is paid for, in the
  sponsored node a row), and nothing else; no priority fee.
- **The sponsored node, rows only:** one `register` in a transaction and nothing else, the row under
  any issuer and any label; at most 0.0024 SOL a row beyond the network fee; two signatures.
- **Three vouchers per stamp, from Soil's issuer:** `sponsor/1`, `sponsor/2` and `sponsor/3`, each
  spent once, the moment the pre-check forwards it to Kora.
- **The float:** the SOL in the one key, which both nodes spend. Nothing refills it but a person;
  when it runs out, both nodes refuse.
- **The rate limit:** the sponsored node signs at most one transaction a second, across all callers;
  the rest wait their turn. The general node: 100 a second.
- **No request logs:** both nodes run Kora at `RUST_LOG=warn`, which writes no request. The
  pre-check writes nothing but the used set: each spent voucher's market stamp, with no time and no
  main key.

## Promises

- **The general node charges what a transaction costs it,** the network fee and every storage
  deposit it puts down, in the token the person pays with, with no margin.
- **The general node pays for no one:** a transaction that does not pay its cost is refused. **The
  sponsored node pays only for registry rows:** one per voucher, three vouchers per stamp on Soil's
  issuer's list.
- **It holds no key of the person's.** The person signs on their own device; the fee payer adds only
  its own signature as payer.
- **Its key can do one thing in a transaction:** fund a new account; in the general node one it is
  paid for, in the sponsored node a registry row.
- **No code of ours runs inside Kora:** both nodes are Kora, configured; the sponsored node's one
  program of ours, the pre-check, runs in front of it.

## Limits

- **Vouchers are sound only once `FOREST` moves to forest's fixed membership circuit.** At the
  current pin, a Semaphore 4.0.0 membership proof can be forged; forest is moving the registry to a
  fixed circuit, with a new verifying key. The pre-check checks every voucher with forest's own
  `verifyStamp`, so moving the pin is the whole change it needs. Until then, whoever can forge a
  proof can make vouchers with no stamp, and only the rate limit and the float bound what the
  sponsored node pays.
- **Why the sponsored node is not a faucet, and what bounds it.** A node that pays for anyone is a
  faucet: whoever can make it pay takes the SOL. This one pays only for a registry row, and a row's
  deposit stays in the row, which never closes; nobody can move it out but `refund`, which sends only
  what Solana's storage price cuts free, and only to the fee payer. So nobody takes SOL out of it;
  they can only make it lock SOL up in rows. Each row needs a voucher, three per stamp on Soil's
  list, and Soil's issuer puts one stamp on its list per face. What the sponsored node can spend is
  at most faces × 3 × (a row's deposit and its network fee): 2,351,880 lamports for the largest row
  today, about 0.00706 SOL a face.
- **On devnet the face check is the stand-in,** which passes everyone, so stamps, and vouchers, are
  unlimited. There only the rate limit bounds it: one row a second, at most about 8.5 SOL an hour,
  until the float is empty.
- **The float is shared.** The sponsored node spends from the general node's key, so emptying it
  stops both.
- **A voucher is spent when it is forwarded,** whatever Kora answers: a transaction Kora refuses (an
  old blockhash, a row that already exists, Kora down) costs the person that voucher.
- **The pre-check has no limit of its own.** Every request it checks costs it a proof's
  verification; Kora's limiter counts only what reaches Kora.
- **A one tap in a Token-2022 dollar is refused** by Kora 2.0.5 (FAQ): two transactions instead.
- **Mainnet is not deployed,** and Jupiter's price was never called. No test pays the fee payer in
  USDT or EURC; Kora handles them as it handles USDC.
- **No priority fee,** so under congestion a transaction may land late.
- **It trusts its RPC's simulation** of each transaction, for what it calls and what it costs, and
  Jupiter's price for each paid token against SOL, with nothing for that price's error.
- **What it collects sits under its signing key,** in the key's own token accounts; nothing moves
  it but someone holding the key.
- **What comes back to a person arrives as SOL** in a key that otherwise holds none.
- **Each dollar's maker can freeze the fee payer's account in it,** and Open USD's maker holds a
  permanent delegate that can take back what the fee payer collected in it.
- **Kora 2.2** hardens a fee payer against being drained and no longer reads the key from a path;
  it is not stable, and not taken.
- **Address logs.** The pre-check keeps no network address and logs nothing, and Kora 2.0.5 logs
  no network address. At its default level Kora logs the body of every request; `RUST_LOG=warn`
  stops that, and both devnet nodes set it. A hosting provider's own request logs are the operator's choice; on
  Railway they exist, with each request's client address and path.

## Who decides what

- **The standard (forest):** nothing here. The registry and the escrow take no fee and care nothing
  for who pays.
- **This fee payer, by its policy:** which programs and transactions it pays for, which tokens it is
  paid in, and its price; which issuer's stamps earn vouchers, and how many.
- **An app, with the person:** which fee payer to use, or none, which token to pay in, and when to
  spend a voucher.

## FAQ

**Why Kora 2.0.5, configured only?**
No custom code inside Kora, and the 2.2 betas are not stable. What Kora cannot check, a voucher, the
pre-check checks in front of it.

**Why may its key only fund new accounts?**
So no transaction can make it move its own SOL or tokens.

**Why is a voucher a stamp, and not a ticket?**
A ticket, a code or a signed note handed to someone, ties whoever hands it out to whoever spends it:
the issuer would know whose face it checked, and the fee payer which row the ticket paid for, and
the two together would link a person to a profile. A voucher is a proof the person makes on their
own device from the stamp they already hold. It says "a stamp on Soil's list, under `sponsor/1`, for
this main key" without saying which stamp, and needs nothing new from the issuer. Its market stamp
is the same every time for one stamp and one label, so the fee payer can spend it once without
knowing whose it is.

**Why does the pre-check allow only one instruction, when Kora allows System?**
Kora sees System inside `register`, where the registry creates the row with it. At the top of a
transaction, a System instruction the fee payer funds could hand its SOL to the person: on devnet,
Kora on `sponsored/kora.toml` signed a row with a `CreateAccountWithSeed` beside it, which put 660,000
of the fee payer's lamports in an account the main key can empty. So the pre-check lets through the
one `register` and nothing beside it.

**Why a key between the pre-check and Kora, and not localhost?**
Kora 2.0.5 always listens on every interface (`kora-lib`, `src/rpc_server/server.rs`); nothing in it
changes that. Railway's public address reaches only the pre-check's port, but other services in the
same project could reach Kora's over the private network. So Kora asks every caller for a key
(`KORA_API_KEY`) that `sponsor/deploy/start.sh` makes at each start and gives only to the pre-check.

**Why does `sponsored/kora.toml` list tokens it is never paid in, and a price source?**
Kora 2.0.5 refuses to start without an allowed token, even when it charges nothing. They are
`general/kora.toml`'s own three lines, so `deploy/devnet-config.sh` changes both files the same way.
On mainnet, `price_source = "Jupiter"` would still need `JUPITER_API_KEY` to start.

**Why is a voucher spent when it is forwarded, and not when the row lands?**
So two copies of one voucher can never both reach Kora: the check and the spending are one
statement, before anything is forwarded. The cost is that a forward Kora refuses loses the voucher.

**Why paid in USDC, USDT, Open USD or EURC on mainnet, the makers' freeze and Open USD's permanent
delegate accepted?**
People pay in what they hold (the founder's choice, 2026-10-01).

**Why no API key for callers?**
A page in a browser cannot keep a secret. The general node is paid for every transaction, and the
sponsored node pays only against a voucher.

**Why do both devnet nodes run Kora at `RUST_LOG=warn`?**
At its default level Kora logs every request's body, and nothing server-side should hold a person's
transactions next to the hosting provider's record of their address.

**Why does every payment that creates its deposit address do so at the top of the transaction?**
Kora 2.0.5 accepts a transfer to an account that does not exist yet only when the same transaction
creates it with a top-level associated-token-account instruction; an account a program creates
inside its own call is invisible to it. The escrow client puts `CreateIdempotent` for the deposit
address first in every builder that pays in the same transaction.

**Why does a one tap in Open USD fail through this fee payer?**
In a one tap (deposit address, create, pay and release in one transaction), the escrow's payout to
the seller is a Token-2022 transfer out of the deposit address the same transaction creates.
Kora 2.0.5 (`kora-lib`, `src/token/token.rs`, `verify_token_payment`) runs its Token-2022 extension
check on every transfer whose destination exists, which fetches the transfer's source by RPC, before
it checks whether the transfer pays Kora at all; the source is not on chain yet, so it refuses with
`Account … not found`. Paying, then releasing, in two transactions passes; so does a one tap in a
classic dollar. The fix for 2.0.x is to check the destination is Kora's payment address before the
extension check; `2.2.0-beta.8` appears to fix it, untried. An app paying in Open USD through this
fee payer sends two transactions from one approval, the second once the first is confirmed.

**Why does what Solana's rent cuts free go to the fee payer?**
The programs send it to whoever fronted the deposit, and the fee payer fronted it and charged only
the cost.

**Could someone rebuild this fee payer from public data?**
It is Kora's published image and this configuration; anyone can run the same with their own key.

**Why is the general node's address `relayer-production-8d40…`, and its Railway service `relayer`?**
It is the name the service had before forest's 3 October words. Renaming the service would leave the
address as it is, and apps that already name it keep working.
