#!/usr/bin/env bash
# Fetches foundationforest/standard at the commit in STANDARD into standard/ (not committed), then
# installs and builds it at its root: the standard is one npm workspace, and `npm run build` there
# builds each of its packages to its dist/. The circuits' setup files, the proving keys among them,
# are committed there and pinned by SHA-256, so they come with it and nothing else downloads them.
# A service depends on a standard package by the name in
# that package's package.json, through a file: link into standard/. Then, when MARKETS is beside
# it, fetches foundationforest/markets at that commit into markets/ (not committed), the same way,
# and installs and builds its package, markets/build: a service reads the markets through it, from
# there, never over the network at run time. An image that copies no MARKETS reads no markets, so it
# skips them. Moving a pin is a one-line change to STANDARD or MARKETS. Needs git and the network.
set -euo pipefail
cd "$(dirname "$0")"

# The repo at a commit into a directory: fetched once, moved when the commit changes.
pinned() {
  local dir="$1" repo="$2" commit="$3"
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "$repo"
  fi
  if [ "$(git -C "$dir" rev-parse -q --verify HEAD || true)" != "$commit" ]; then
    git -C "$dir" fetch -q --depth 1 origin "$commit"
    git -C "$dir" checkout -q --detach "$commit"
  fi
  echo "$dir at $commit"
}

pinned standard "${STANDARD_REPO:-https://github.com/foundationforest/standard}" "$(tr -d '[:space:]' < STANDARD)"
(cd standard && npm ci --no-audit --no-fund && npm run build)

if [ -f MARKETS ]; then
  pinned markets "${MARKETS_REPO:-https://github.com/foundationforest/markets}" "$(tr -d '[:space:]' < MARKETS)"
  (cd markets/build && npm ci --no-audit --no-fund && npm run build)
fi
