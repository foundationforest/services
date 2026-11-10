# services

The Forest Foundation runs one copy of each service so Forest works from day one. Each is open source ([Apache-2.0](LICENSE)), so anyone can run another. None of them holds your seed or a main key, so none can take your profiles or your money.

## What we run

| Service | What it does for you | Address |
|---|---|---|
| [verifier](verifier/README.md) | Checks that you are one real person, by your face or your ID, and signs a stamp to your seed. Your profiles then prove they're verified without saying who you are. | [verifier.forest.foundation](https://verifier.forest.foundation) |
| [host](host/README.md) | Keeps your profiles' folders (listings, reviews, photos, inbox) and serves them to anyone. Each write is paid from its folder's credits, prepaid writes at that host, a fraction of a cent for a small one; a message from its sender's folder. Your first credits are a gift from the verifier, kept in your wallet: your Profiles folder's balance at the host (the folder where your app lists your profiles). | [host.forest.foundation](https://host.forest.foundation) |
| [index](index/README.md) | Reads the hosts, counts verified profiles only, and ranks them by reputation in each market. Pages for people, JSON for programs. Free. | [index.forest.foundation](https://index.forest.foundation) |
| [MCP server](mcp/README.md) | Lets your AI app (Claude, ChatGPT) act for you through [MCP](https://modelcontextprotocol.io): find people, post, review, message, within the access keys you give it. It keeps nothing of yours. | mcp.forest.foundation |

The end-to-end test ([`e2e/`](e2e/README.md)) runs two people through all four on every change. None of the services touches a chain.

## The pins

A pin is the one commit of another repo that every service here uses: `STANDARD` holds the standard's, `MARKETS` the markets'. A change upstream reaches the services only when a pin moves, in a pull request of its own.

`MARKETS` moves by itself once a day, when the markets' main passes every check here ([`markets.yml`](.github/workflows/markets.yml)); to move it now, Run workflow on [its page](https://github.com/foundationforest/services/actions/workflows/markets.yml).

## Run a copy

Each service's directory has its own `deploy/Dockerfile`, built from the repo root, and a README that lists its settings. On your own machine, with Node 22.18 or later, `./standard.sh` fetches [the standard](https://github.com/foundationforest/standard) and [the markets](https://github.com/foundationforest/markets) at their pins, then `npm ci && npm start` in any service's directory; the verifier first fetches its face models (`npm run fetch -- models`).

## Who decides what

- **Each service, as it runs:** its prices and choices, in its README's How we run it.
- **An app, with the person:** which services to use.
- **The person:** their seed and profiles, and which keys go to whom.

## FAQ

**Why one repo for four services?** They share one pin of the standard, one CI and one end-to-end test. Each directory still stands alone, with its own package, image and README.
