This repo is `services`: the first services on Forest's open standard, `forest`
(github.com/foundationforest/forest), used here at the commit in `FOREST`. Soil runs the host, the
issuer, the fee payer and connections; the Forest Foundation runs the index. Read `README.md` and
the README of the directory you work in before any task.

## Words

Use these words: seed, main key, profile, address, label, stamp, issuer, list, registry, row,
record, folder, host, access key, permissions, private, envelope, reading key, inbox, blob, escrow,
receipt, deal, index, fee payer, connections, app, market, role, ramp, and sealed (for programs
only). Plain words, no em-dashes.

- issuer, never keeper; access key, never writer key; fee payer, never relayer; main key, never
  profile key; address, never wallet, for a key ("a wallet app" is fine).
- A token's issuer is "the dollar's maker".
- A folder is what one main key signs on a host; this repo's folders are directories.
- Never "replace every app"; never "the foundation runs none".

## How to work in this repo

- Work in plan mode. One task per session. Open a pull request; never push to main.
- The promises in each README change only when Carlos says so in a chat.
- One README per level: the repo's, and one in each directory; each starts with what it is and how
  it works.
- Each piece's README ends Promises, Limits, Who decides what, FAQ; the repo README has Who decides
  what after the sort.
- A question lives at the lowest level whose README explains the thing it is about.
- A FAQ is only for what the explanation does not answer; when a question shows the explanation is
  missing something, the explanation changes.
- Each service's README, in this order: what it is, in one plain sentence; who runs it, and that
  anyone can run another; How it works; Policy, every number and choice the service makes, in plain
  words; Promises; Limits; Who decides what; FAQ. The README is the directory's only doc.
- Use existing pieces unchanged, and write only what does not exist. A change one of forest's
  pieces needs is made in forest first; then `FOREST` moves, in its own pull request.
- Keep the docs true in the same pull request: a change that makes a README wrong fixes it. A README
  says only what the code does today. Say "on devnet" for what runs; never state anything as
  shipped.
- When the plan is silent, choose the option that adds no rule and no text a person reads. Write
  its reason down: as a question in the FAQ of the directory it belongs to (the top README's for the
  whole repo) if it shapes these services, otherwise in a comment beside the code. Ask only when the
  choice changes a sealed program or spends money.
- No private key, no phrase and no keyed URL ever goes in the repo. Devnet keys come from the devnet
  phrase by the recipe in forest's `devnet/deploy.sh` scripts.
- Run what `.github/workflows/checks.yml` runs before you push (Node 22.18 or later, Postgres for the
  index). A test that skips fails CI: the summary must say `# skipped 0`. The slower checks (the
  index's end-to-end test, the fee payer's local run, e2e on devnet) are in each directory's README.
