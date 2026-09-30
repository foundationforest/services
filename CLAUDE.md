This repo is `services`: the services the Forest Foundation runs as one operator among many, the index, the issuer and the relayer; connections later. The standard they serve is `forest` (github.com/foundationforest/forest). Read this file, then forest's `CLAUDE.md` and `docs/handoff.md` (in `forest/` after `./forest.sh`, at the commit in `FOREST`), before any task. Work in plan mode. One task per session. Open a pull request; never push to main.

Forest: a person owns their profile, offers and reputation, and transacts with strangers with no platform in between. One human, one face check, one badge per market. Profiles are free folders. A market is a name. Any AI reads the records. Global from day one.

Rules Claude Code does not change (Carlos changes them, in a chat, then here):
- Forest's rules bind here. The ones these services meet:
  - Keys never leave the user's device. Nothing anywhere has user accounts; there are keys, folders, and badges.
  - Issuers, indexes, evidence types and apps are open slots: the foundation runs the first of each; anyone may run another.
  - Use existing pieces unchanged: Kora as the relayer, with no custom code inside it (it co-signs a person's transaction and charges the network fee and any storage deposit it puts down in their dollar token; no sponsorship built in); Didit for the face check; AT Protocol for records. Write only what does not exist.
  - No mixers, no custody, no arbitration by Forest.
  - Fees exist only at ramp in and out. Nothing inside charges anything except the sealed registry fee.
  - Reputation is computed per profile. Profiles link only when the user chooses. Never build a per-human score that links profiles by itself.
  - No address logs. Nothing server-side ever holds a person next to a profile.
  - Anyone can make any market: a market is a name, and the registry accepts any name. The `markets` repo is the foundation's directory of recommended spellings; the foundation excludes, prohibits and approves nothing.
  - Crypto is invisible in anything a user reads: no "wallet", "USDC", "chain", "gas" in copy.
  - Never state design as shipped. Nothing is shipped.
- Forest's pieces are used from `forest/`, at the commit in `FOREST`, unchanged: the record shapes, the keys library, both clients, the programs. A change one needs is made in forest first; then `FOREST` moves, in its own pull request.

Four record shapes: profile, post, review, credential. Market files add fields, never new shapes.

Out of scope for v1: the cross-profile zero-knowledge proof, issuer-assisted recovery, chain posts, video hosting, arbiter as default, an entity, a ramp partnership.

When the plan is silent, choose the option that adds no rule and no text a person reads; log it as chosen. Ask only when the choice changes a sealed program or spends money. At the end of every session append to `docs/changes.md`: built, learned, open. A session running in parallel writes to its own `docs/changes/<topic>.md` instead.
