# services

The services the Forest Foundation runs, as one operator among many. Anyone may run their own from
this code, open under Apache 2.0.

The standard they serve is [foundationforest/forest](https://github.com/foundationforest/forest):
the record shapes, the keys recipe, the registry and escrow programs, the host, the carrier, and the
plan. Boards live in forest's `records/` and are run by apps, not by these services.

Nothing is shipped. Read [CLAUDE.md](CLAUDE.md) before any task.

| Folder | What |
|---|---|
| [`index/`](index/) | The foundation's index: reads records and the programs' events, scores every profile, serves pages for people and for machines. It still reads the old data layer |
| [`issuer/`](issuer/) | The foundation's issuer: turns a passed face check into a person's place on its list in the registry |
| [`relayer/`](relayer/) | The relayer: Kora, configured. Co-signs a person's transaction and charges what it costs, in their dollar token |
| `connections/` | Not here yet. It comes once forest publishes `records/` |
| [`docs/`](docs/) | This repo's session log |

Each service's `deploy/` is its own setup: its Dockerfile, its devnet settings, and how it runs on
Railway.

## Forest, pinned

The services use forest's pieces unchanged, by relative path. `FOREST` holds one forest commit;
`./forest.sh` fetches forest at that commit into `forest/`, which is not committed, and runs
`npm ci` in each forest package named after it. Every `forest/…` path in this repo means forest at
that commit.

```
./forest.sh shapes keys registry/client escrow/client   # the index
./forest.sh registry/client                             # the issuer
./forest.sh registry/client escrow/client               # the relayer's type-check
```

Moving the pin is a one-line change to `FOREST`, in its own pull request.

## Checks

`.github/workflows/checks.yml` runs, on every pull request and on `main`, each service's type-check
and its tests that need no chain, from a clean install. Each service's README says how to run its
slower tests.
