This repo is `services`: the foundation's copy of each service Forest's standard needs
(github.com/foundationforest/standard, used here at the commit in `STANDARD`, with the markets,
github.com/foundationforest/markets, at the commit in `MARKETS`), and the loop that tests them
together (`e2e/`). Read `README.md` and the README of the directory you work in before any task.

## Words

Use these words: seed (the secret on your device), the seed's number, main key, access key, note,
profile, profile entry, entry, post, address, label, scope, verifier, verified, stamp, stamp number,
facts, verification, reputation proof, check, folder, file, host, service key, connection,
connector, private, envelope, encrypted (an envelope), locked, message, inbox, pay address, pay key,
escrow, schedule, window, stop, payer, recipient, sponsor, receipt, deal, credit, credits, wallet, ticket,
review, evidence, index, app, market, role, ramp. Plain words, no em-dashes.

- A verifier is anyone who signs stamps; a person it signed a stamp to is verified, never "verified
  once". A stamp is what
  a verifier signs to a person's seed: their stamp number and its facts. A verification is what a
  profile shows: the proof that its seed holds a stamp from that verifier.
- The verifier has two keys: its face key, which signs the face check's stamps, and its ID key,
  which signs the ID check's.
- An access key is a key a profile hands out, to an AI app, a service or another person: its profile
  entry lists each one with what it can do (`read`, `read-inbox`, `write`, `message`), and every
  host and reader checks that. The seed and the main keys stay on the person's devices. A note is
  an access key's private note, as the standard names it: the entry at `key/<id>`, locked to the
  main key alone, saying who holds the key, since when, and whatever the app keeps; never anything
  else.
- A profile entry is the entry at `profile`, never a card: it holds the folder's hosts, its open key
  and its access keys. A pay address is one of a profile's `pay` addresses, `{ solana, evm }`, each
  from its pay key.
- Check, never verify: a reader checks a proof or a signature. Main key, never profile key;
  address, never wallet, for a key ("a wallet app" is fine). The wallet is an app's Profiles
  folder's balance at a host: gifts and buys land there, and the app funds each folder from it.
- Never: record, signer, permission, inbox key, blob, pull, tag, stamp proof, issuer, attributes,
  sealed, write key, read key, account (but in "no account"), card, registry, row, tier, standing,
  policy,
  seed scalar, keyed path, a signature's prefix. A string baked into a recipe, a circuit or a key's
  text keeps its bytes even when its words grow old (the standard's three texts, `forest/profile/`,
  `forest/verifier/` and `forest/pay/`, the circuits' signal names and files, the verifier's `face`,
  `id`, `fingerprint` and `sponsor` texts): rename the code around it, never the string, and say
  why in a comment beside it. Other projects' own words stay too (Privacy Pass's `issuer_name`,
  snarkjs's verifier).
- encrypted is for an envelope: what is locked to a key's open key. Locked, never sealed.
- A sponsor pays for someone else's credit buy with a ticket, or fronts an escrow's rent.
- Whoever makes a token is "the dollar's maker", never its issuer.
- A folder is a profile's entries on a host, signed by its main key or an access key its profile
  entry lists; this repo's folders are directories.
- The foundation runs every service here, never Soil; the app is the Forest app. In prose it is the
  Forest Foundation; its registered name, the Open Forest Foundation, is only in legal text: the
  verifier's consent screen and its data-law line.
- The mcp is introduced once in each README that names it, as "a connector, over MCP".
- No timing refs: no other repo's open issue or pull request, no date on a price, nothing true only
  for a while.
- Every use case is "anyone can; the main way is X", never "X is one option" and never "X is the
  rule".
- devnet, devnet USDC and mainnet are named only where something is configured for them: in a
  README's How we run it, and as a setting of the service configured for them. Every intro says what
  its service does, chain-free. A name is a name: a file's path, here or in the standard.
- Never "replace every app".

## How to work in this repo

- Work in plan mode. One task per session.
- One branch per piece. When a change spans pieces, each piece's branch goes into one integration
  branch, which goes into `main` once every piece is in. Open a pull request; never push to `main`.
- The promises in each README change only when Carlos says so in a chat.
- One README per level: the repo's, and one in each directory; each starts with what it is and how
  it works.
- Each level explains at its own altitude, and a fact lives once, at the lowest level that explains
  it. Who decides what is only in the repo README, which ends Who decides what, FAQ.
- A question lives at the lowest level whose README explains the thing it is about.
- A FAQ is only for what a newcomer would ask that the explanation cannot carry; when a question
  shows the explanation is missing something, the explanation changes.
- Each piece's README (each service's, and `e2e/`'s), technical and precise, every term defined once
  in plain words, in this order:
  - what it is: one paragraph, in the repo README's words for it: who runs it, that anyone can run
    another, and what it keeps;
  - How it works: the substance, in tables and short lists wherever they carry the same as prose;
  - Its API: one table;
  - How we run it: our own choices, prices, settings, the image and the commands, in one place, and
    one line on what `test/` covers, never test by test;
  - Promises: at most five, the ones a stranger can check;
  - Limits: only what is real today, one line each;
  - FAQ.

  The README is the directory's only doc.
- Use existing pieces unchanged, and write only what does not exist. A change one of the standard's
  pieces needs is made in the standard first; then `STANDARD` moves, in a pull request of its own
  that fixes every service the move touches. `MARKETS` moves the same way.
- Keep the docs true in the same pull request: a change that makes a README wrong fixes it. A README
  says only what the code does today; never state anything as shipped.
- When the plan is silent, choose the option that adds no rule and no text a person reads. Write
  its reason down: as a question in the FAQ of the directory it belongs to (the top README's for the
  whole repo) if it shapes these services, otherwise in a comment beside the code. Ask only when the
  choice spends money.
- No private key, no phrase and no keyed URL ever goes in the repo.
- Run what `.github/workflows/checks.yml` runs before you push (Node 22.18 or later). A test that
  skips fails CI: the summary must say `# skipped 0`. The slower check, mcp's smoke test against
  the deployed copy, is in its README.
