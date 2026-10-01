# services

The services the Forest Foundation runs, as one operator among many. Anyone may run their own from
this code, open under Apache 2.0.

The standard they serve is [foundationforest/forest](https://github.com/foundationforest/forest):
`records/` (the data protocol, its library, reference host and approval page, and the record
shapes), the keys recipe, the registry and escrow programs, and the plan. Boards live in forest's
`records/` and are run by apps, not by these services.

Nothing is shipped. Read [CLAUDE.md](CLAUDE.md) before any task.

| Folder | What |
|---|---|
| [`index/`](index/) | The foundation's index: reads records from hosts, the registry's lines, the issuers' signed roots and both escrows' events, scores every profile, serves pages for people and for machines |
| [`issuer/`](issuer/) | The foundation's issuer: turns a passed face check into a person's place on its list, publishes the list and its signed roots as two files, and writes each root on chain in a memo its key signs |
| [`relayer/`](relayer/) | The relayer: Kora, configured. Co-signs a person's transaction and charges what it spends, in their dollar token (USDC or Open USD). When Solana cuts its storage price, part of a deposit it put down is freed, and it keeps that refund |
| [`connections/`](connections/) | Forest's MCP server for assistants, run as a service: reads public notes, drafts, returns approval links, and serves the approval page they open. It holds no keys, no grants and no drafts |
| [`loop/`](loop/) | Forest end to end on devnet against these services, with the stand-in face check; and [`loop/board/`](loop/board/), a board for devnet testing only |
| [`docs/`](docs/) | This repo's session log; [`devnet.md`](docs/devnet.md), what runs on devnet and what to open; [`kora-issue.md`](docs/kora-issue.md), an issue drafted for Kora |

Each service's `deploy/` is its own setup: its Dockerfile, its devnet settings, and how it runs on
Railway.

## Forest, pinned

The services use forest's pieces unchanged, by relative path. `FOREST` holds one forest commit;
`./forest.sh` fetches forest at that commit into `forest/`, which is not committed, and runs
`npm ci` in each forest package named after it. Every `forest/…` path in this repo means forest at
that commit.

```
./forest.sh registry/client records                                 # the issuer
./forest.sh registry/client escrow/client escrow/v2/client          # the relayer's type-check
./forest.sh records                                                 # connections, the test board
./forest.sh records registry/client escrow/client escrow/v2/client  # the index
./forest.sh records keys registry/client registry/artifacts escrow/v2/client   # the loop
```

Moving the pin is a one-line change to `FOREST`, in its own pull request.

## Checks

`.github/workflows/checks.yml` runs, on every pull request and on `main`, each service's type-check
and its tests that need no chain, from a clean install. Each service's README says how to run its
slower tests.
