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
