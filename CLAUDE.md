This repo is `services`: the services the Forest Foundation runs on Forest's open standard, `forest`
(github.com/foundationforest/forest), used here at the commit in `FOREST`. Read `README.md` and the
README of the folder you work in before any task.

## Words

Use these words: seed, profile, label, stamp, keeper, list, registry, row, record, folder, host,
writer key, permissions, private, reading key, escrow, receipt, deal, index, issuer, relayer, app,
market, role, ramp, and sealed (for programs only). Plain words, no em-dashes.

## How to work in this repo

- Work in plan mode. One task per session. Open a pull request; never push to main.
- The promises in each README change only when Carlos says so in a chat.
- Each folder has one README: what it is, how it works, promises, limits, FAQ last. Each says it is
  the foundation's first one, and that anyone can run another. The README is the folder's only doc.
- Use existing pieces unchanged, and write only what does not exist. A change one of forest's
  pieces needs is made in forest first; then `FOREST` moves, in its own pull request.
- Keep the docs true in the same pull request: a change that makes a README wrong fixes it. A README
  says only what the code does today. Say "on devnet" for what runs; never state anything as
  shipped.
- When the plan is silent, choose the option that adds no rule and no text a person reads. Write
  its reason down: as a question in the FAQ of the folder it belongs to (the top README's for the
  whole repo) if it shapes these services, otherwise in a comment beside the code. Ask only when the
  choice changes a sealed program or spends money.
- No private key, no phrase and no keyed URL ever goes in the repo. Devnet keys come from the devnet
  phrase by the recipe in forest's `devnet/deploy.sh` scripts.
- Run what `.github/workflows/checks.yml` runs before you push (Node 22.18 or later, Postgres for the
  index). A test that skips fails CI: the summary must say `# skipped 0`. The slower checks (the
  index's end-to-end test, the relayer's local run, e2e on devnet) are in each folder's README.
