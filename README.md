# services

The Forest Foundation runs one copy of each service so Forest works from day one. Each is open source, so anyone can run another. None of them owns anything of yours: no seed, no main key, no money, no account.

## What we run

| Service | What it does for you | Address |
|---|---|---|
| [verifier](verifier/README.md) | Checks that you are one real person, by your face or your ID, and signs a stamp to your seed. Your profiles then prove they're verified without saying who you are. | verifier.forest.foundation |
| [host](host/README.md) | Keeps your profiles' folders (posts, reviews, photos, inbox) and serves them to anyone. A small write costs a fraction of a cent, paid in credits. Your first credits are a gift from the verifier. | host.forest.foundation |
| [index](index/README.md) | Reads the hosts, counts verified profiles only, and ranks them by reputation in each market. Pages for people, JSON for programs. Free. | index.forest.foundation |
| [mcp](mcp/README.md) | Lets your AI app (Claude, ChatGPT) act for you: find people, post, review, message, within the access keys you give it. It keeps nothing of yours. Until the Forest app's connect page is up, it only reads. | mcp.forest.foundation |

The loop ([`e2e/`](e2e/README.md)) runs two people through all four, end to end, on every change. None of the services touches a chain: payments come later, with the standard's escrow.

## Run a copy

Each service's folder has its own `deploy/Dockerfile`, built from the repo root, and a README listing its settings. On your own machine, with Node 22.18 or later, `./standard.sh` fetches [the standard](https://github.com/foundationforest/standard) and [the markets](https://github.com/foundationforest/markets) at their pins, then `npm ci && npm start` in any service's folder; the verifier first fetches its face models (`npm run fetch -- models`).

## The pins

`STANDARD` and `MARKETS` each hold one commit. Every service uses exactly those, so a change upstream reaches the services only when a pin moves, in a pull request of its own.

## Who decides what

- **Each service, as it runs:** its prices and choices, in its README's How we run it.
- **An app, with the person:** which services to use.
- **The person:** their seed and profiles, and which keys go to whom.

## FAQ

**Why one repo for four services?** They share one pin of the standard, one CI and one loop. Each folder still stands alone, with its own package, image and README.
