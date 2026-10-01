This repo is `services`: the services the Forest Foundation runs on Forest's open standard, as one operator among many: the index, the issuer, the relayer and connections. The standard is `forest` (github.com/foundationforest/forest), used here at the commit in `FOREST`. Read this file, then `README.md` and the README of the folder you work in, before any task. Work in plan mode. One task per session. Open a pull request; never push to main.

Devnet only: nothing here runs on mainnet, and nothing is shipped. Never state design as shipped.

Rules Claude Code does not change (Carlos changes them, in a chat, then here):
- A profile is one ed25519 key: its did:key is its name, it signs the profile's records, and it is the profile's Solana wallet. Records follow forest's `records/SPEC.md`. Four record shapes: profile, offer, review, proof. A market adds fields, never new shapes.
- Keys never leave the person's device. No service here holds, asks for or signs with a person's key. Nothing anywhere has user accounts: there are keys, records and badges.
- Boards (record hosts) are run by apps. The foundation runs no board; `loop/board/` is for devnet testing only.
- Anyone may run another index, issuer, relayer or connections service, from this code or their own. Each reader decides which issuers it trusts; an index's weights and settings are its own opinion, never a rule.
- Use existing pieces unchanged, and write only what does not exist: Kora as the relayer, configured, with no custom code inside it; Didit for the face check; forest's pieces (records, keys, the registry and escrow clients, the programs) at the commit in `FOREST`. A change one of them needs is made in forest first; then `FOREST` moves, in its own pull request.
- The relayer co-signs a person's transaction and charges what that transaction costs it (the network fee and every storage deposit it puts down) in the token the person pays with, with no margin. It pays for no one; sponsorship is never built in.
- No mixers, no custody, no arbitration by Forest. Fees exist only at ramp in and out; nothing inside charges anything.
- Reputation is computed per profile. Profiles link only when the person chooses. Never build a per-human score that links profiles by itself. Nothing server-side ever holds a person next to a profile.
- No address logs: no service here writes down a network address.
- Anyone can make any market: a label is free text, and the registry accepts any. The recommended label is `market/role`. The `markets` repo is the foundation's directory of recommended names; the foundation excludes, prohibits and approves nothing.
- Crypto is invisible in anything a person reads: no "wallet", "USDC", "chain", "gas" in copy.
- Out of scope until decided otherwise: issuer-assisted recovery, a cross-profile zero-knowledge proof, video hosting, an arbiter by default.

How a session works:
- When the plan is silent, choose the option that adds no rule and no text a person reads, and write down its reason: in `docs/decisions.md`, one line, if it shapes these services; otherwise in a comment beside the code. Ask only when the choice changes a sealed program or spends money.
- Keep the docs true in the same pull request: a change that makes a README or `docs/devnet.md` wrong fixes it. Docs say only what the code does today, plain words first, in these words: profile, record, board, badge, issuer, relayer, index, app, label.
