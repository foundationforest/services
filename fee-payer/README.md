# fee payer

The fee payer pays Solana's costs for a person's transactions: their registry row free, against a
voucher, and anything else at cost, paid back in the dollar they hold.

The foundation runs this one, on devnet. Anyone can run another, from Kora's published binary,
this configuration and the voucher check's code, or from their own: whoever signs a transaction as
payer pays for it, and the programs care nothing for who that is
([forest](https://github.com/foundationforest/forest/blob/main/README.md#for-builders)).

Up: [the repo](../README.md).

## How it works

### One service, two doors

The fee payer is one address. Behind it, in one container, run two copies of
[Kora](https://github.com/solana-foundation/kora) 2.0.5, the Solana Foundation's open fee payer,
configured and nothing else, and one program of ours in front of them, the voucher check
(`vouchers/`):

```
                     POST /vouchers   the voucher check: one row,       the free Kora
  app ──▶ the fee ─────────────────▶ a voucher not seen before ───▶ (free/kora.toml) ───┐
          payer's                                                                       ├─▶ Solana
          address ──────────────────────────── unchanged ─────────▶ the at-cost Kora ───┘
                     anything else                                  (at-cost/kora.toml)
```

- **The voucher door,** `POST /vouchers`, pays for a person's registry row, free. The app sends the
  row's transaction and a voucher; the voucher check lets the row through to the free Kora only
  with a voucher it has not seen before, and the free Kora pays the network fee and the row's
  deposit ([Rent](#rent)).
- **The at-cost door** is every other request to the address, passed unchanged to the at-cost
  Kora: Kora's own JSON-RPC. It co-signs any transaction its rules allow, pays the network fee and
  any deposit, and charges the person exactly what that cost it, in the dollar they pay with. A
  request whose URL cannot be read (`//`) gets 400 and reaches neither Kora.

An app names one fee payer and finds its voucher door from it: the address plus `/vouchers`. Both
Koras sign with one key, so both doors spend one float. Inside a transaction that key may do one
thing, fund a new account, and Kora refuses any transfer of its SOL or tokens. Through the at-cost
door the person pays for every account it funds; through the voucher door the voucher check lets
the row through and nothing beside it ([FAQ](#faq)). Neither door holds a key of the person's, and
neither decides anything about the person, the market or the deal.

### Vouchers and their labels

A voucher is a person proof
([registry](https://github.com/foundationforest/forest/blob/main/registry/README.md#the-note-and-the-person-proof))
that the person's device makes from the note it already holds, under one of this fee payer's
voucher labels, `voucher/<this fee payer's name>/<n>`, for the main key the row is for. n runs from
1 to the count its issuer and tier earn here ([Policy](#policy)).

- **Its stamp is what is spent.** A stamp is the same every time for one person, one issuer and one
  label, so a person has exactly that many vouchers, each spent once, and nobody can tell from one
  whose it is. A stamp does not depend on the tier, so a tier 2 note's first three vouchers are a
  tier 1 note's three.
- **The label names this fee payer,** so another fee payer's vouchers are other stamps. Under one
  shared label a person's voucher would be the same stamp at every fee payer, and two fee payers
  comparing what they spent could tell which rows one person paid for.
- **A proof, not a ticket.** A ticket the issuer handed out would tie the issuer, which knows whose
  face it checked, to the fee payer, which knows which row the ticket paid for: together they would
  link a person to a profile. A voucher needs nothing new from the issuer, and says only "a note
  from this issuer, at this tier, under this label, for this main key".
- **It names the main key,** so a voucher seen in flight pays for that main key's row and no other.
  The row itself may be under any issuer and any label.

### The voucher door

The person's device:

1. makes a voucher for the main key the row is for;
2. builds the row's transaction with the fee payer as payer (the at-cost door's `getPayerSigner`
   names it: both Koras sign with one key), and signs it with the main key;
3. sends both to `POST /vouchers`, as `{ transaction, voucher: { proof, issuer, tier, label, stamp }
   }`: the transaction in base64, the proof as snarkjs writes it, the issuer's key as 128 hex
   characters (x then y, as a row holds it), the tier as decimal text, and the stamp as 64 hex.

The voucher check checks, in this order, and refuses by name at the first that fails:

| Check | Refusal |
|---|---|
| The request has both parts, in their shapes | `bad_request` (400) |
| The transaction decodes, whole, with nothing after it | `bad_transaction` (400) |
| It is one instruction, `register`, to the registry, with its four accounts (the row, the main key, the payer, System), no address lookup table and no other account | `not_one_registration` (400) |
| The main key it names signed it | `not_signed_by_main_key` (400) |
| Its issuer's key and tier are ones it takes (`VOUCHER_ISSUERS`) | `not_a_trusted_issuer` (400) |
| The voucher's label is `voucher/<FEE_PAYER_NAME>/1` to `/n`, n that issuer's count for the tier | `not_a_voucher_label` (400) |
| The voucher's proof holds for that issuer, tier, label, stamp and main key (forest's `verifyPerson`) | `voucher_does_not_hold` (400) |
| Its stamp is not in the used set; it goes in now, spent | `voucher_used` (409) |

Then it hands the transaction, unchanged, to the free Kora's `signAndSendTransaction` and answers
`{ signature }`, or `fee_payer_refused` (502) with Kora's reason; the voucher stays spent either
way. The free Kora checks the transaction against `free/kora.toml`, adds its signature and sends
it: the fee payer pays the network fee and the row's deposit, and is recorded in the row as its
payer. `vouchers/test/vouchers.test.ts` checks every refusal above with nothing reaching either
Kora, and a voucher replayed, and a voucher sent with another main key's row.

### What the free Kora allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the registry at its devnet address, System | The registry creates the row with System, inside its own call |
| `max_allowed_lamports` | 0.0024 SOL | The largest row (a 128-byte label, 308 bytes) takes 2,214,880 lamports at today's rent of 5,080 lamports a byte, on devnet and mainnet |
| `max_signatures` | 2 | The fee payer and the main key |
| `price` | free | Nothing is charged |
| `rate_limit` | 1 a second, across all callers | Kora's own limiter. It holds a request over the limit until the next second rather than refusing it, so it never costs a spent voucher |
| `fee_payer_policy` | only `allow_create_account` | As in the at-cost Kora: its key may fund a new account, the row, and nothing else. Kora warns about it at start, and runs |
| `allowed_tokens`, `allowed_spl_paid_tokens`, `price_source` | the at-cost Kora's | Never used when free ([FAQ](#faq)) |
| `KORA_API_KEY` | made at each start, given to the voucher check alone; a call without it gets 401 | Kora listens on every interface ([FAQ](#faq)) |

### The at-cost door

The person's device:

1. builds the transaction with the fee payer as payer, plus one plain token transfer to the fee
   payer whose amount it fills in next;
2. asks Kora the price of exactly that transaction, in that token (`estimateTransactionFee`);
3. sets the transfer to that price, and signs with the main key;
4. hands it to Kora (`signAndSendTransaction`).

The at-cost Kora simulates it, reads every program call inside it, checks it against
`at-cost/kora.toml`, checks the transfer covers the price, adds its signature and sends it.

**The price** is the network fee (per signature, the person's included) plus every account the
fee payer funds, counted from the simulation, including accounts a program creates inside its own
call. The transfer must already be in the transaction when the device asks: without it, Kora adds a
fixed 50 lamports for the payment it expects and misses that payment's signature, so the quote
falls 5,000 lamports short and Kora refuses the transaction it quoted.

**A registry row** through this door takes two signatures: the fee payer's, which pays the network
fee and the row's deposit and is recorded in the row as its payer, and the main key's, which signs
the row and the payment. The proof names the profile and the label, so nothing the fee payer sees
lets it take the row.

### What the at-cost Kora allows

| Setting | Value | Why |
|---|---|---|
| `allowed_programs` | the registry and the escrow at their devnet addresses, SPL Token, Token-2022, Associated Token Account, System | Kora checks every program a transaction calls, inner calls included |
| No compute budget program | | So no priority fee: the fee payer never pays one it did not agree to |
| `max_allowed_lamports` | 0.01 SOL | Deposits per transaction; an escrow's creation takes about 0.0037 |
| `max_signatures` | 3 | The fee payer, and an escrow's two parties when both sign a split |
| `price` | margin 0 | The charge is the cost |
| `price_source` | `Jupiter` (needs `JUPITER_API_KEY`) | Jupiter prices mainnet only; devnet uses Kora's mock |
| `rate_limit` | 100 a second, across all callers | Kora's own limiter, at Kora's example value |
| `payment_address` | unset | Payments go to token accounts the fee payer's own key owns |
| `fee_payer_policy` | only `allow_create_account` | The fee payer's key may fund a new account it is paid for, and nothing else: no transfer, assign, allocate or nonce use, and no SPL Token or Token-2022 instruction as owner or authority |
| No API key or HMAC | | A page in a browser cannot keep a secret, and every transaction pays its way |

The programs are the registry `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4` and the escrow
`FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`, as forest records them on devnet. The tokens it is
paid in, in `at-cost/kora.toml`, are mainnet's, each its maker's own mint:

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
in. `deploy/devnet-config.sh` prints a Kora's `kora.toml` with exactly three lines changed, and
stops if any is not there exactly once: the two paid-token lists (the two devnet test dollars in
place of the four mainnet tokens), and `price_source = "Mock"`. Kora's mock values the test dollars
at 0.001 SOL a whole token: one base unit buys one lamport.

Refused, each checked by the local run ([Run it](#run-it)) with nothing landing: a program not on
the list (`… is not in the allowed list`); a priority fee; the fee payer's SOL sent anywhere
(`Fee payer cannot be used for 'System Transfer'`); the payment taken back out of the fee payer's
account; no payment, or one short of the deposits (`Insufficient token payment. Required …
lamports`).

### Rent

Every account on Solana holds a deposit, its rent, and gives it back when the account closes. A
cut in Solana's rent frees part of it, which only the program that owns the account can send on
([forest's escrow, Rent](https://github.com/foundationforest/forest/blob/main/escrow/README.md#rent)).
The registry and the escrow send every rent back to whoever fronted it, which through either door
is the fee payer:

- **An escrow's deposit address:** its rent goes back to the escrow's payer, the fee payer, at
  every ending. The person was charged for it when the escrow opened, so through the at-cost door
  the person pays an escrow's deposits and does not get them back; the fee payer keeps them.
- **An escrow never funded, closed:** both rents go back to the fee payer.
- **What a cut in Solana's rent frees** on an account the fee payer funded goes to the fee payer,
  which keeps it: a registry row's (`refund`, to the payer the row records) and an escrow
  receipt's (`sweep_rent`, to the payer it records). Anyone may send either.

The fee payer fronted those deposits and charged only their cost, so it keeps what comes back. A
row never grows after `register`, so nothing a row needs later asks the fee payer for SOL.

What a row costs is in forest's
[registry](https://github.com/foundationforest/forest/blob/main/registry/README.md#what-one-row-costs),
and an escrow's in forest's
[escrow](https://github.com/foundationforest/forest/blob/main/escrow/README.md#run-it-and-what-one-escrow-costs).
The local run checks, for every transaction it sends, that the charge is exactly what the fee payer
spent.

### Settings

Both Koras, `run.sh`:

| Variable | What |
|---|---|
| `FOREST_FEE_PAYER_KEY` | The fee payer's key: a path to a keypair file (the Solana CLI's JSON form) outside this repo, or, where a hosting platform has no files, the key itself, as that JSON array or base58. Kora 2.0.5 built `--locked` uses solana-keychain 0.1.0, which reads a path first and otherwise takes the key itself. If it is unset, `run.sh` takes the key from `FOREST_RELAYER_KEY`, the name the devnet service holds it under |
| `RPC_URL` | The Solana RPC Kora simulates and sends through. Required. It must return inner instructions from `simulateTransaction` |
| `JUPITER_API_KEY` | For `price_source = "Jupiter"` |
| `PORT` | Default `8080` |
| `KORA_CONFIG` | Default `at-cost/kora.toml`; `deploy/start.sh` passes each Kora its devnet config |
| `KORA_BIN` | Default `.kora/bin/kora` |
| `RUST_LOG` | Kora's log filter. Unset, Kora logs at `info`, which writes the body of every request: each transaction it is asked to price or sign. `warn` writes no request |

`run.sh` refuses a key file inside this repo.

The voucher check, `vouchers/`:

| Variable | Required | Default | What |
|---|---|---|---|
| `FEE_PAYER_NAME` | yes | | This fee payer's name, in every voucher's label: `voucher/<name>/<n>`. No slash, at most 100 bytes |
| `VOUCHER_ISSUERS` | yes | | The issuers whose notes earn vouchers, each tier with how many: `<key>:<tier>:<count>`, comma-separated, the key as 128 lowercase hex (x then y, as a row holds it) |
| `REGISTRY_PROGRAM` | yes | | The registry a row is written by: the one `free/kora.toml` allows |
| `FREE_KORA_URL`, `FREE_KORA_API_KEY` | yes | | The free Kora and its key; `deploy/start.sh` sets both |
| `AT_COST_KORA_URL` | yes | | The at-cost Kora, which gets every request but `/vouchers`; `deploy/start.sh` sets it |
| `DATABASE_PATH` | no | `./data/vouchers.sqlite` | The used set's one file |
| `PORT` | no | `8080` | The fee payer's one address |

`deploy/start.sh` starts, in one container, the at-cost Kora (`run.sh`, on port 8081), the free
Kora (on port 8082, with a key made at each start) and the voucher check in front of both on
`PORT`, and stops the container when any of them stops.

### Run it

```
./build.sh          # Kora 2.0.5 into .kora/ (cargo install kora-cli --locked; Rust, 6 to 12 minutes)
FOREST_FEE_PAYER_KEY=/outside/repo/fee-payer.json RPC_URL=https://… JUPITER_API_KEY=… ./run.sh   # the at-cost Kora alone, :8080
```

Checks:

```
./forest.sh registry/client escrow/client                           # from the repo root; the person circuit's files come with forest
cd fee-payer && npm ci && npm run check                             # type-check the local run
bash deploy/devnet-config.sh at-cost/kora.toml > /dev/null          # the devnet configs still apply
bash deploy/devnet-config.sh free/kora.toml > /dev/null
(cd vouchers && npm ci && npm run check && npm test)                # both doors, stand-in Koras, real person proofs; seconds
npm run test:local                                                  # the local run, about 30 seconds
```

**The local run** starts a validator with the two programs at the ids in their source (as a local
build has them), a six-decimal test dollar planted at USDC's address and Open USD planted from its
mainnet account, and Kora through `run.sh` on a copy of `at-cost/kora.toml` with exactly three lines
changed: the two programs' devnet ids to their source ids, and `price_source = "Mock"`. A main key
that never held a lamport then writes a registry row, from a note a test issuer signs, pays escrows
(one in Open USD), closes one never funded, and provokes every refusal above; every balance is
checked. It needs `solana-test-validator` (Solana CLI 4.2.2), the two programs built
(`cargo build-sbf --arch v3` in `forest/registry/program` and `forest/escrow/program`) and
`./build.sh`. It skips, saying which, if one is missing. Not in CI. It runs the at-cost Kora only.

### On devnet

`deploy/Dockerfile` builds one image from Node's image: Kora's binary, copied from Kora's own
published image `ghcr.io/solana-foundation/kora:v2.0.5`, pinned by digest, and checked against
`KORA`; `at-cost/kora.toml` and `free/kora.toml` with the devnet lines `deploy/devnet-config.sh`
changes; `signers.toml`, `run.sh` and `deploy/start.sh`; and the voucher check, with `RUST_LOG=warn`
set in the image. Before the first transaction, the key needs SOL for the deposits it funds, and a
token account for each token it is paid in.

The foundation's fee payer runs that image on Railway, service `fee payer`, at
https://fee-payer.devnet.forest.foundation, the address [`../e2e/devnet.json`](../e2e/devnet.json)
names: Kora's JSON-RPC at `/` (POST), `GET /liveness`, and the voucher door at `/vouchers` (POST).

- **Source:** this repo, branch `main`; `RAILWAY_DOCKERFILE_PATH=fee-payer/deploy/Dockerfile`.
- **One replica,** health check `GET /liveness` (the at-cost Kora's, through the front), a public
  domain to port 8080, a volume at `/data` for the used set.
- **Signs as** the devnet `payer` key, which is also the Open-USD-shaped test dollar's mint
  authority; **paid in** the two test dollars. Both are in
  [the repo's devnet facts](../README.md#on-devnet).
- **Vouchers from** the foundation's devnet issuer's notes: three with a tier 1 note, ten with a
  tier 2 note.

| Variable | On devnet | Secret |
|---|---|---|
| `FOREST_RELAYER_KEY` | the `payer` key, as its JSON array; `run.sh` passes it to both Koras as `FOREST_FEE_PAYER_KEY` | yes |
| `RPC_URL` | Helius's devnet RPC; its URL holds the key | yes |
| `FEE_PAYER_NAME` | `fee-payer.devnet.forest.foundation` | no |
| `VOUCHER_ISSUERS` | `2185f564303f0c1cd8efdb1e35e59cc128f388f1da07511a412c186b6bb5b4bf186ac19097701f2619d447c5cd68484674e48194dd7ed4d025b20ea9d063a549:1:3,2185f564303f0c1cd8efdb1e35e59cc128f388f1da07511a412c186b6bb5b4bf186ac19097701f2619d447c5cd68484674e48194dd7ed4d025b20ea9d063a549:2:10` | no |
| `REGISTRY_PROGRAM` | `J4ES52YohsZhknYbsgmZwHpyNw14EjrrGZxHpcmcBmq4` | no |
| `DATABASE_PATH` | `/data/vouchers.sqlite` | no |
| `RUST_LOG` | `warn`, as the image sets it | no |
| `PORT` | `8080` | no |

## Policy

- **Kora,** 2.0.5, run twice with one key: the at-cost Kora configured by `at-cost/kora.toml`, the
  free Kora by `free/kora.toml`, with no code of ours inside either. The one program of ours, the
  voucher check, stands in front of both.
- **The voucher door, rows only:** one `register` in a transaction and nothing else, the row under
  any issuer and any label; at most 0.0024 SOL a row beyond the network fee; two signatures.
- **Vouchers per person, by tier:** three with a tier 1 note from the foundation's issuer
  (`voucher/<name>/1` to `/3`), ten with a tier 2 note (`/1` to `/10`). Each is spent once, the
  moment the voucher check forwards it to the free Kora.
- **Voucher labels name this fee payer** (`FEE_PAYER_NAME`), so two fee payers cannot link
  vouchers.
- **The at-cost door, at cost:** the charge is the network fee and every deposit it puts down. It
  pays for no one: a transaction that does not pay its cost is refused.
- **Rent it fronts and later gets back stays with it:** an escrow's deposits, and what a cut in
  Solana's rent frees on a row or a receipt ([Rent](#rent)).
- **Paid in four tokens on mainnet's configuration:** USDC, USDT, Open USD and EURC, each its
  maker's own mint, since people pay in what they hold. The makers' freeze and Open USD's permanent
  delegate are accepted. On devnet, the two test dollars.
- **Prices:** Jupiter's, on mainnet's configuration; on devnet, Kora's mock.
- **What its key may do:** fund a new account (through the at-cost door one it is paid for, through
  the voucher door a row), and nothing else; no priority fee.
- **The float:** the SOL in the one key, which both doors spend. Nothing refills it but a person;
  when it runs out, both doors refuse. It is paid back in tokens; turning them back into SOL is done
  by hand, not by code.
- **The rate limit:** the free Kora signs at most one transaction a second, across all callers; the
  rest wait their turn. The at-cost Kora: 100 a second.
- **No API key for callers.** A page in a browser cannot keep a secret; the at-cost door is paid for
  every transaction, and the voucher door pays only against a voucher.
- **No request logs:** both Koras run at `RUST_LOG=warn`, which writes no request, since at its
  default level Kora logs every request's body, and nothing server-side should hold a person's
  transactions next to the hosting provider's record of their address. Kora still logs errors: a
  token instruction type it cannot read, by its type alone, and an instruction with too few
  accounts, whole. The voucher check logs nothing.
- **What it keeps:** the used set, for as long as it runs: each spent voucher's stamp, with no time
  and no main key.
- **Where it runs:** Railway, one container, one replica; Helius's devnet RPC.

## Promises

- **The voucher door pays only for registry rows:** one per voucher, three vouchers per person with
  a tier 1 note from the foundation's issuer and ten with a tier 2 note.
- **It holds no key of the person's.** The person signs on their own device; the fee payer adds only
  its own signature as payer.
- **Its key can do one thing in a transaction:** fund a new account; through the at-cost door one
  it is paid for, through the voucher door a registry row.
- **No code of ours runs inside Kora:** both Koras are Kora, configured; the one program of ours,
  the voucher check, runs in front of them.
- **No accounts.**
- **It keeps no network address.** The voucher check logs nothing, and both Koras run at a level
  that writes no request.
- **Nothing it keeps ties a voucher to a row.** The used set holds each spent voucher's stamp, with
  no main key and no time.

## Limits

- **What bounds the voucher door.** A door that pays for anyone is a faucet: whoever can make it pay
  takes the SOL. This one pays only for a registry row, and a row's deposit stays in the row, which
  never closes; nobody can move it out but `refund`, which sends only what a cut in Solana's rent
  frees, and only to the fee payer. So nobody takes SOL out of it; they can only make it lock SOL
  up in rows. Each row needs a voucher: three per person with a tier 1 note from the foundation's
  issuer, which signs one note number per face, and ten with a tier 2 note, which it signs once per
  person after a document check. What the voucher door can spend is at most (tier 1 people × 3 +
  tier 2 people × 7 more) × (a row's deposit and its network fee): 2,224,880 lamports for the
  largest row today, about 0.00667 SOL a tier 1 person and 0.0222 SOL a tier 2 person.
- **On devnet both of the issuer's checks are the stand-in,** which passes everyone, so notes, and
  vouchers, are unlimited. There only the rate limit bounds it: one row a second, about 8 SOL an
  hour of the largest rows, until the float is empty.
- **The float is shared.** Both doors spend one key, so emptying it through either stops both.
- **One container.** When the at-cost Kora, the free Kora or the voucher check stops, the container
  stops, and both doors with it, until the hosting platform starts it again.
- **A voucher is spent when it is forwarded,** whatever Kora answers: a transaction Kora refuses (an
  old blockhash, a row that already exists, Kora down) costs the person that voucher.
- **The voucher check has no limit of its own.** Every request to `/vouchers` costs it a proof's
  verification; Kora's limiter counts only what reaches Kora.
- **The free Kora has no local test.** The voucher check's tests use stand-in Koras, and the local
  run starts the at-cost Kora only; only [`e2e/`](../e2e/README.md)'s devnet run sends a row
  through it.
- **A one tap in a Token-2022 dollar is refused** by Kora 2.0.5 ([FAQ](#faq)): two transactions
  instead.
- **Mainnet is not deployed,** and Jupiter's price was never called. No test pays the fee payer in
  USDT or EURC; Kora handles them as it handles USDC.
- **No priority fee,** so under congestion a transaction may land late.
- **It trusts its RPC's simulation** of each transaction, for what it calls and what it costs, and
  Jupiter's price for each paid token against SOL, with nothing for that price's error.
- **What it collects sits under its signing key,** in the key's own token accounts; nothing moves
  it but someone holding the key.
- **Each dollar's maker can freeze the fee payer's account in it,** and Open USD's maker holds a
  permanent delegate that can take back what the fee payer collected in it.
- **Address logs.** A hosting provider's own request logs are the operator's choice; on Railway
  they exist, with each request's client address and path.

## Who decides what

- **The standard (forest):** nothing about the price. The registry and the escrow take no fee and
  care nothing for who pays; every rent goes back to whoever fronted it.
- **This fee payer, by its policy:** which programs and transactions each door pays for, which
  tokens it is paid in, and its price; whose notes earn vouchers, how many at each tier, and its
  name in their labels.
- **An app, with the person:** which fee payer to use, or none, which token to pay in, and when to
  spend a voucher.

## FAQ

**Why Kora 2.0.5, configured only?**
No custom code inside Kora. The 2.2 betas are not stable, and no longer read the key from a path,
which `FOREST_FEE_PAYER_KEY` allows. What Kora cannot check, a voucher, the voucher check checks in
front of it.

**Why does the voucher check allow only one instruction, when the free Kora allows System?**
Kora sees System inside `register`, where the registry creates the row with it. At the top of a
transaction, a System instruction the fee payer funds could hand its SOL to the person: on devnet,
Kora on `free/kora.toml` signed a row with a `CreateAccountWithSeed` beside it, which put 660,000 of
the fee payer's lamports in an account the main key can empty. So the voucher check lets through the
one `register` and nothing beside it.

**Why a key between the voucher check and the free Kora, and none on the at-cost Kora?**
Kora 2.0.5 always listens on every interface (`kora-lib`, `src/rpc_server/server.rs`); nothing in it
changes that. Railway's public address reaches only the voucher check's port, but other services in
the same project could reach both Koras' over the private network. So the free Kora asks every
caller for a key (`KORA_API_KEY`) that `deploy/start.sh` makes at each start and gives only to the
voucher check. The at-cost Kora needs none: whatever reaches it pays its way, as through the front.

**Why does `free/kora.toml` list tokens it is never paid in, and a price source?**
Kora 2.0.5 refuses to start without an allowed token, even when it charges nothing. They are
`at-cost/kora.toml`'s own three lines, so `deploy/devnet-config.sh` changes both files the same way.
On mainnet, `price_source = "Jupiter"` would still need `JUPITER_API_KEY` to start.

**Why is a voucher spent when it is forwarded, and not when the row lands?**
So two copies of one voucher can never both reach Kora: the check and the spending are one
statement, before anything is forwarded. The cost is that a forward Kora refuses loses the voucher.

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
classic dollar. An app paying in Open USD through this fee payer sends two transactions from one
approval, the second once the first is confirmed.
