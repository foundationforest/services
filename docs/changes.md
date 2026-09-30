# Changes

What each session built, learned and left open, oldest first. Forest's log, for everything before
this repo, is `forest/docs/changes.md`.

## 2026-09-30: the repo, from forest f0a87e5

**Built.**
- `index/` and `issuer/`, copied from forest at `f0a87e5ca57f6c76ebff3e9a1c0fc317d1369ab9`.
- `relayer/`, copied from forest's `feepayer/` and renamed in code, docs and config: the package
  `@forest/relayer`, the key variable `FOREST_RELAYER_KEY`, Kora's signer `forest_relayer`,
  `test/relayer.test.ts`. Kora's own names keep "fee payer" (`fee_payer_policy`, its messages), and
  so does Solana's `feePayer` field.
- Each service's part of forest's `deploy/`, moved into its own `deploy/`: its Dockerfile, its
  devnet files, and a README with its Railway settings and variables as forest's
  `deploy/railway.ts` sets them (and for the index, Supabase as `deploy/supabase.ts` sets it up).
- `FOREST` and `forest.sh`: forest at one commit, in `forest/`. Every import of forest's shapes,
  keys library and both clients goes through it, and so do the slow tests' paths to its programs,
  proving files and host.
- A type-check for the relayer (`tsconfig.json`, `npm run check`). Forest checked nothing there.
- The index's links to its own rules and source (`llms.txt`, `skill.md`, every page's source link,
  the JSON-LD notes) point at this repo, where its `SCORING.md` and `PAYLINK.md` now are.
- `.github/workflows/checks.yml`; `LICENSE`, `README.md`, `CLAUDE.md`, this file.

**Chosen, where the plan was silent.**
1. Forest by a pinned commit that a script fetches, as forest pins Bluesky's code (`host/UPSTREAM`).
   Not a git submodule: Railway's documents say nothing of submodules, and the images must build
   there. Not a copy of forest's pieces: it would drift.
2. The index's and issuer's images install git, for `forest.sh`. The relayer's needs no forest.
3. Forest's deploy scripts are not copied. `railway.ts`, `supabase.ts`, `fund.ts`, `e2e.ts`,
   `lib/` and `services.json` drive all five services, the host and carrier included, through one
   secrets folder and one public record. Each service's settings are written in its
   `deploy/README.md` instead.
4. CI runs what passes from a clean install. The slow tests are not in it.

**Learned.**
- Railway's Config as Code (`railway.json`, `railway.toml`) is deprecated: new services cannot opt
  in, and existing files stop working on 2026-12-01. Infrastructure as Code (`.railway/railway.ts`)
  replaces it. Forest's settings through the API stand.
- All three images build from the repo root, and start: the index migrates and serves its pages,
  the issuer starts the stand-in Didit from its new path, and Kora validates the devnet config and
  answers `/liveness` with its key in `FOREST_RELAYER_KEY`. Built and run on one machine, not on
  Railway.

**Open.**
- The devnet services still build from forest's `deploy/`, on forest's `main`. Moving one here:
  point its Railway service at this repo with `RAILWAY_DOCKERFILE_PATH=<service>/deploy/Dockerfile`;
  for the relayer, also set `FOREST_RELAYER_KEY` (sealed) where `FOREST_FEEPAYER_KEY` was.
- Forest still holds its own `index/`, `issuer/`, `feepayer/` and their `deploy/` parts. Until
  forest drops them, a change to one must be made in both, or they drift.
- The slow tests (the issuer's on a validator, the relayer's local run, the index end to end) run
  nowhere from this repo; forest runs them nightly on its own copies. A nightly job here needs
  forest's programs, proving files, host and Kora built.
- `connections/` waits for forest's `records/`.
- The repo's GitHub description names a host; this repo has none, since `host/` stays in forest.

## 2026-09-30: forest fdb16ea: the issuer publishes its list, the new programs, connections

**Built.**
- `FOREST` at `fdb16ea6e8c62fa4cd9c1f1cc7df05e588ed67e0`: `records/`, the keys with one key per
  profile, the registry as a free list of lines (devnet `GWyKGgoRg2g3kpKNgsXBWS1ayHTHHzwbtLJW4XGVP2RW`),
  escrow v2 (devnet `B3p13G8xvNvUrAnaXg9AUtwffBAUHcp6XoMwGV2jKPi7`).
- **The index's own pin** (Carlos's choice, this session): `index/FOREST` keeps forest's
  `f0a87e5`, whose `shapes/`, registry events and did:plc keys the index reads. `forest.sh` reads
  the pin file `FOREST_PIN` names; the index's Dockerfile, docs and CI job set it. Nothing else in
  `index/` changed. This bends "at the commit in `FOREST`" until the index moves to `records/`.
- `issuer/`:
  - No chain. Its list and roots live in its own file, beside the queue and the used sessions.
  - A batch (still everything waiting, hourly or at 50, shuffled) adds its commitments and one new
    root in one transaction.
  - It publishes `GET /list.json` (every commitment, in order) and `GET /roots.json` (every root
    with its size and time, signed with the issuer's key). The formats are in `issuer/README.md`,
    "The two files".
  - The Didit flow, the request limit and the privacy rules are unchanged.
  - Removed: every insert, `SOLANA_RPC_URL`, `REGISTRY_PROGRAM_ID`, `LIST_INDEX`, `@solana/web3.js`,
    the validator test.
  - 22 tests. They include the raw file holding each listed commitment once, and both files
    checked as a reader checks them: canonical text, the signature, every root against forest's
    `listRoot`.
- `relayer/`:
  - `kora.toml` allows the new registry, escrow v1 and escrow v2, and drops the earlier registry.
  - `devnet-config.sh` swaps all three to their devnet ids.
  - The README says it charges what it spends and keeps what the rent cuts free on deposits it
    fronted (escrow v2's decision 5).
  - The local run is rewritten and was run here: a line, v1 and v2 escrows, a line's refund and a
    v2 sweep to the relayer, a v1 sweep to the person, and every refusal.
- `connections/`, new:
  - forest's `records/src/connections.ts`, unchanged, with a front that passes requests through,
    since `Connections.listen` answers on loopback only;
  - its tests: forest's reference host, the service, and an MCP client;
  - `deploy/` with a Dockerfile and its Railway settings.
- CI: the issuer installs `records`; the relayer, the v2 client; the index uses its own pin; a
  `connections` job.

**Chosen, where the plan was silent.**
1. The two files are served by the issuer itself, at `/list.json` and `/roots.json`.
2. Both files are RFC 8785 canonical text.
   - The issuer is named by the did:key of its key.
   - The roots file is signed as a records entry is, over `0xff` ‖
     `forest.foundation/issuer/roots/v1\n` ‖ the canonical text without `sig`.
   - A root's time is milliseconds since 1970.
   - The list file is unsigned: the roots file covers it.
3. One root per batch; a batch with nothing new adds none.
4. The list and roots in the issuer's SQLite file, so a batch is one transaction. The `list` table
   has no unique index, so each commitment's bytes appear in the file once.
5. The issuer keeps Semaphore's `Group` (4.12.1, the registry client's version) in memory and grows
   it per batch. It does not call `listRoot` per batch, because `listRoot` rebuilds the whole tree.
6. The issuer's key keeps its `solana-keygen` form and signs nothing but the roots file.
7. The relayer's `max_signatures` stays 3, now for an escrow split's two parties and the relayer.
8. Connections: a pass-through front rather than a copy of forest's HTTP handling; `HOSTS`
   required; no health check route.

**Learned.**
- `listRoot` takes about 0.4 s for 1,000 members and 27 s for 100,000 here, all of it blocking. So
  the issuer builds the tree once at start and grows it per batch.
- Kora 2.0.5 refuses `add_proof` through the relayer: `Fee payer cannot be used for 'System
  Transfer'`. Anchor pays a line's 32-byte growth with a System transfer from the payer inside the
  program, and `kora.toml` forbids the relayer's key any transfer. A line through the relayer holds
  one issuer's root.
- The device must ask Kora's price with its payment transfer already in the transaction.
  - Without it, Kora adds 50 lamports for the payment it expects.
  - Its price also misses the person's signature, which on a registry line is the only one. The
    quote falls 5,000 lamports short and Kora refuses the transaction it quoted.
  - With the transfer in place, the price is exactly what the relayer spends.
- On a local validator (6,960 lamports a byte), Kora 2.0.5, the programs as SBPF v3:
  - a line with a 20-byte label: 702 bytes, 121,083 units, charged 2,104,960;
  - escrow v2 pay: 661 bytes, 35,958 units, charged 5,062,960;
  - escrow v2 one tap: 710 bytes, 60,910 units.
- Built here with Solana CLI 4.2.2: the registry at 188,680 bytes and escrow v2 at 291,568, as
  forest records them.
- The relayer's test holds its own `@solana/web3.js`, so the registry client's `instanceof
  PublicKey` fails on its keys. It passes the profile as bytes, which the client also takes.
- In this sandbox a container trusts neither the proxy's CA nor plain-HTTP apt. The images were
  built with three extra lines for that, the Dockerfiles otherwise as committed.

**Open.**
- **A second issuer's root through the relayer** (needs Carlos). Kora refuses `add_proof`. The
  options:
  - another payer;
  - letting the relayer's key transfer SOL, which opens it to being drained;
  - a registry change: a sealed program.
- **The index moves to `records/`**, lines and the issuers' roots files (mechanical, next); then
  `index/FOREST` and `FOREST_PIN` go.
- **The devnet services.**
  - The issuer and relayer on Railway still run the earlier versions. They were built from
    forest's `deploy/`, which forest's `main` no longer has.
  - Pointed at this repo, the issuer starts with an empty list. List 0's three members are not
    carried over, and a face Didit already holds cannot join again under the same Didit
    application (needs Carlos).
  - The relayer drops `FOREST_FEEPAYER_KEY` for `FOREST_RELAYER_KEY`, as before.
- **Where the two files live beyond the issuer's own address** (needs Carlos).
  - Every reader's address lands in Railway's logs, like every request's.
  - `list.json` grows by about 80 bytes a member: about 80 MB at a million. It may later need
    paging or a mirror.
- **Rotating the issuer's key renames the issuer.** Readers trust the did:key, and no signed
  handover exists (needs Carlos).
- **The issuer's start-up at scale** (mechanical): building the tree takes about 27 s per 100,000
  members, before it listens.
- **Connections runs nowhere.** It needs a records host and the approval page served. A `hostname`
  option on forest's `Connections.listen` would remove the front (a change in forest first).
- **This repo's `CLAUDE.md` is behind forest's** (needs Carlos). It still names AT Protocol, the
  shapes post and credential, and "the sealed registry fee". Forest's now names `records/SPEC.md`,
  offer and proof, and a free registry.
- Importing the registry client's `proof.ts` prints Node's `punycode` deprecation warning at the
  issuer's start, from a dependency (cosmetic).

## 2026-09-30: forest b2e838f: the index on records, lines and roots, trusted badges only; Token-2022 through the relayer

**Built.**
- `FOREST` at `b2e838f6bd1e64f3c43d93eb91ae8edc1c1d6bdc` (forest's main, with #42): the registry's
  fixed line (one root, no `add_proof`), membership records, and escrow v2 taking Token-2022
  dollars. `index/FOREST` and `FOREST_PIN` are gone; every service uses forest at the one commit in
  `FOREST`.
- `index/`, only the sources changed; the scoring rules did not (`compute.ts` is the same but for
  a rename, `listOwner` → `issuer`):
  - **Records from hosts** (`src/records/hosts.ts`, which replaces `firehose.ts`), read with
    forest's own `readPage`, which checks each entry's canonical text and signature. The three
    filters: every feed read since its cursor (kept in Postgres); the hosts in `HOSTS` in full,
    every other host a folder names for badged profiles only; a profile read by `profile` when it
    first shows up badged, and when it comes to hold a trusted line. Each profile is merged with
    forest's `viewProfile`, and what it holds now replaces what the index held
    (`src/records/store.ts`), each body checked against `forest/records/schemas/` with ajv.
    `HOSTS` replaces `FIREHOSE_URL` and `PLC_URL`; `@atproto/*` and `ws` are gone.
  - **Only trusted badges count, show or are kept.** A badge is a line a trusted issuer vouches for:
    its root is in that issuer's published roots, or a membership for it checks. A line with
    neither is not "verified", not counted, and its profile is not shown. Entries are dropped on
    arrival unless their profile holds such a line; a profile holding another line keeps its proof
    records only, since a membership may earn it trust. When a profile comes to hold a trusted
    line, what was dropped is read again by profile from every followed host and the hosts its
    folder names; when it stops, all but its proofs goes. A host's badged flag is only a hint.
  - **Lines.** At every start every line is read from the registry's own accounts (`fetchLines`:
    `getProgramAccounts` with the line discriminator); then only transactions after the newest one
    at that moment, for new lines. No old history is needed. Table `lines`; `badges` is dropped.
  - **Issuers' roots** (`src/issuers.ts`): `config/issuers.json` is keyed by the issuer's did:key,
    with `roots`, the address of its signed roots file. Each file is checked (canonical text, the
    configured issuer, the signature over the issuer's own prefix) and its roots kept
    (`issuer_roots`), at most once a minute.
  - **Memberships**: a `proof/<id>` membership adds its issuer to the line once `verifyMembership`
    passes against the line, that issuer's kept roots and `forest/registry/artifacts/semaphore-32.json`.
    It waits (pending, with why) while the issuer, line or root is unknown; a proof that fails is
    invalid for that version of the record.
  - **Receipts from escrow v1 and v2** (`src/chain/escrow.ts`), v2 in any dollar it takes, Open USD
    included. v2's `Ended.fundedAt` fills `funded_at` when nobody marked it; v2's `Objected` is
    stored (`objected_by`, `objected_at`) and shown on the deal page ("Objection") and on a
    profile's reviews that name the deal. Scoring does not read it.
  - Migration `006_records_lines.sql`: drops what the firehose and the earlier registry stored, adds
    `host_entries`, `kept`, `lines`, `issuer_roots`, `memberships`, the objection columns.
  - Pages and twins: a badge is one line with `issuers` (`via`: line or membership), `line`, `code`,
    `root`; `listIndex`, `listOwner` and `transaction` are gone. Photos and media by `sha256`. A
    record is addressed `<did>/<path>`; its `cid` is its entry's id. The deal page's "Payment
    marked" reads "Paid", since v2 records when the money was there even unmarked.
  - `POLL_MS` replaces `CHAIN_POLL_MS`; `ESCROW_V2_PROGRAM_ID` added. Devnet: registry `Hyh5…`,
    escrow v1 `3vAV…`, v2 `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8`; the devnet issuer by its
    did:key and its `/roots.json`.
  - Tests: the page fixture on did:key profiles and signed entries, taken in through the index's
    own merge; `e2e.test.ts` rewritten on real pieces (two reference hosts, a validator with the
    three programs, two issuers' roots files, real registrations, a membership that rescues a
    profile, an unvouched profile kept out, deals on v1, v2 and v2 in Open USD, an objection).
  - Docs: README, HOSTING, SCORING's badge sources, PAYLINK's `offer` and `cid`, the read skill's
    examples and badge check, deploy README.
- `relayer/`:
  - the test registers in one transaction (`buildRegistration({ commitments })`) and drops
    `add_proof`; it now also pays and releases an escrow v2 deal in Open USD, planted from forest's
    copy of its mainnet mint;
  - `kora.toml` allows the Token-2022 program; every `token_2022` flag for the relayer's own key
    stays false, so it pays for others' Token-2022 instructions and never moves a token itself;
  - `deploy/devnet-config.sh` names the registry `Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf`
    and escrow v2 `FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8` (`B3p13…` dropped);
  - README: "A line never grows" replaces the `add_proof` section; a Token-2022 section; the Open
    USD rows.
- CI: the index job installs `records registry/client escrow/client escrow/v2/client`.

**Chosen, where the plan was silent.**
1. "Boards" are forest's hosts; the code says host, as forest's does.
2. Crawling: hosts named in folders are followed, badged only; one on loopback only when `HOSTS`
   has one (a local run). A host still answering after 60 s is skipped until it finishes.
3. The index reads an issuer's roots file only, not `list.json`: it needs the roots, not the list.
4. A profile holding an unvouched line keeps its `proof/` records in the index (not shown), so a
   membership can earn it trust without waiting for a host to send them again.
5. A closed folder (`null`) leaves nothing of that profile in the index.
6. The Pay link keeps its parameter names; `offer` is `<did>/offer/<id>` and `cid` the entry's id.
7. Forest has no market-file validator any more (`shapes/` went); the index checks only the fields
   it reads, and derives roles from sides.
8. The issuers file names each issuer's roots address; the default file keeps the placeholder key,
   as a did:key, with no address (the foundation's issuer has none yet).
9. The relayer is still paid in USDC only; Open USD is not added to `allowed_spl_paid_tokens`
   (Learned, below).

**Learned.**
- Built here with Solana CLI 4.2.2 at `b2e838f`: the registry at 165,320 bytes and escrow v2 at
  315,104, as forest records them; escrow v1 at 282,888.
- Kora 2.0.5, on a local validator (6,960 lamports a byte), `kora.toml` as committed but the mock
  price: a line with a 20-byte label is 702 bytes and 123,921 units, charged 2,077,120. An Open USD
  pay is 727 bytes, charged 5,160,400 (its deposit address is 2,136,720, larger than a classic
  one's, for its extensions); its release 10,000.
- **A one tap in a Token-2022 dollar does not pass Kora 2.0.5.** Kora reads the source of every
  Token-2022 transfer whose destination exists, the escrow's own payout included; in a one tap that
  source is the deposit address the same transaction makes, so Kora refuses (`Account … not
  found`). Pay, then release, passes.
- **Kora can charge its fee in a Token-2022 dollar** (a scratch run, not kept): a plain one and
  Open USD's mainnet mint are quoted, co-signed and charged exactly; one unit short is refused. A
  dollar with a transfer fee needs its quote asked again until it holds (three rounds at 1%), and
  the relayer still nets less than it spent (9,999 of 10,000). Without the Token-2022 program in
  `allowed_programs`, every Token-2022 payment is refused.
- Blocking the permanent-delegate extension in Kora (`[validation.token_2022]`) would also refuse
  every Open USD escrow payout, since Kora applies it to every Token-2022 transfer it reads.
- The index's end-to-end test once failed at the membership step, about one run in ten (a
  recompute during the test's deleted-lines window); fixed in the test. Green in every run since.
- All four images build from the repo root and the index's starts and migrates, with this
  sandbox's proxy lines added to throwaway copies of the Dockerfiles only. Its one error there: the
  devnet issuer has no `/roots.json` yet.

**Open.**
- **The devnet services** (mechanical, then Railway): the index and the relayer here are not
  deployed. The devnet index needs a records host on devnet (`HOSTS`) and the devnet issuer
  redeployed from this repo (`/roots.json`); until then it reads lines and receipts only, and with
  no roots it trusts no line, so it shows no one.
- **The foundation's issuer on mainnet has no did:key or roots address yet**: `config/issuers.json`
  holds a placeholder, so the mainnet index trusts no line until it does.
- **One tap in Open USD** (needs Carlos, or Kora): an app must pay, then release, in two
  transactions, until Kora reads a source made in the same transaction.
- **Paying the relayer in Open USD** (needs Carlos): one line, not taken, since Open USD's issuer
  holds a permanent delegate that can take back what the relayer collected.
- **A badged feed trusts its host's word** (needs Carlos): a crawled host decides who is badged in
  what it serves. The index checks lines itself and keeps nothing unvouched but proofs, yet a host
  can still make it read and drop junk.
- **Crawling grows with whatever folders name** (needs Carlos): any profile on a followed host can
  name eight hosts. A list of hosts the index follows, or a cap, is a rule to choose.
- **`readPage` has no size limit** (mechanical, forest): a host can send an endless page; the
  index waits 60 s per round but reads what arrives. A limit belongs in forest's client.
- **The market-file validator's home** (mechanical, forest or markets): the index's check reads
  fields, not the format.
- **This repo's `CLAUDE.md` is behind forest's** (needs Carlos), as the last session said.
