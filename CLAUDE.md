This repo is `services`: the foundation's copy of each service Forest's standard needs
(github.com/foundationforest/standard, used here at the commit in `STANDARD`, with the markets,
github.com/foundationforest/markets, at the commit in `MARKETS`), and the loop that tests them
together (`e2e/`). Read `README.md` and the README of the directory you work in before any task.

## Words

Use these words: seed, main key, profile, profile record, address, label, stamp, issuer, note,
note number, attributes, note proof, reputation proof, record, folder, host, access key, write key,
read key, permissions, private, envelope, sealed (an envelope), inbox key, inbox, blob, pay address,
escrow, schedule, window, stop, payer, recipient, sponsor, receipt, deal, credit, ticket, check,
review, evidence, index, fee payer, app, market, role, ramp. Plain words, no em-dashes.

- A stamp is the number an index's tree knows one profile by, at one issuer: the standard's
  `keys/`, Stamps.
- The issuer has two keys: its face key, which signs the face check's notes, and its ID key, which
  signs the ID check's.
- A profile record is the record at `profile`, never a card. A write key and a read key are the two
  access keys, never a message key or a writer key. A pay address is a profile's Solana address,
  from its pay key.
- issuer, never keeper; fee payer, never relayer; main key, never profile key; checked, never
  verified; address, never wallet, for a key ("a wallet app" is fine). Never registry, row, tier,
  standing, rules or policy.
- sealed is only for an envelope: what is sealed to an inbox key or a read key.
- A sponsor pays for someone else's credit buy with a ticket, or fronts an escrow's rent. The fee
  payer pays the chain's fees, at cost: Kora, configured.
- A token's issuer is "the dollar's maker".
- A folder is what one main key signs on a host; this repo's folders are directories.
- The foundation runs every service here, never Soil; the app is the Forest app.
- Every use case is "anyone can; the main way is X", never "X is one option" and never "X is the
  rule".
- devnet and mainnet appear in no README, but in one line in each README where it matters, naming
  the chain the escrow runs on today. A name we do not own (`FOREST_DEVNET_SEED`, a path in the
  standard) is a name.
- Never "replace every app".

## How to work in this repo

- Work in plan mode. One task per session.
- One branch per piece. When a change spans pieces, each piece's branch goes into one integration
  branch, which goes into `main` once every piece is in. Open a pull request; never push to `main`.
- The promises in each README change only when Carlos says so in a chat.
- One README per level: the repo's, and one in each directory; each starts with what it is and how
  it works.
- Each piece's README ends Promises, Limits, Who decides what, FAQ; the repo README ends Who
  decides what, FAQ.
- A question lives at the lowest level whose README explains the thing it is about.
- A FAQ is only for what the explanation does not answer; when a question shows the explanation is
  missing something, the explanation changes.
- Each service's README, in this order: what it is, in one plain sentence; who runs it, and that
  anyone can run another; How it works; How we run it, every number and choice the service makes,
  in plain words; Promises; Limits; Who decides what; FAQ. The README is the directory's only doc.
- Use existing pieces unchanged, and write only what does not exist. A change one of the standard's
  pieces needs is made in the standard first; then `STANDARD` moves, in a pull request of its own
  that fixes every service the move touches. `MARKETS` moves the same way.
- Keep the docs true in the same pull request: a change that makes a README wrong fixes it. A README
  says only what the code does today; never state anything as shipped.
- When the plan is silent, choose the option that adds no rule and no text a person reads. Write
  its reason down: as a question in the FAQ of the directory it belongs to (the top README's for the
  whole repo) if it shapes these services, otherwise in a comment beside the code. Ask only when the
  choice spends money.
- No private key, no phrase and no keyed URL ever goes in the repo. The loop's keys come from the
  phrase by the recipe in the standard's `escrows/solana/devnet/deploy.sh`.
- Run what `.github/workflows/checks.yml` runs before you push (Node 22.18 or later). A test that
  skips fails CI: the summary must say `# skipped 0`. The slower checks (the fee payer's local run,
  the loop, mcp's smoke test against the deployed copy) are in each directory's README.
