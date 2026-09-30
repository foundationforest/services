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
