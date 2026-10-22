#!/usr/bin/env bash
# Fetches foundationforest/standard at the commit in STANDARD into standard/ (not committed), then
# installs and builds it at its root: the standard is one npm workspace, and `npm run build` there
# builds each of its packages to its dist/. A service depends on a standard package by the name in
# that package's package.json, through a file: link into standard/. Moving the pin is a one-line
# change to STANDARD. Needs git and the network.
set -euo pipefail
cd "$(dirname "$0")"

STANDARD_REPO="${STANDARD_REPO:-https://github.com/foundationforest/standard}"
STANDARD_COMMIT="$(tr -d '[:space:]' < STANDARD)"

if [ ! -d standard/.git ]; then
  git init -q standard
  git -C standard remote add origin "$STANDARD_REPO"
fi
if [ "$(git -C standard rev-parse -q --verify HEAD || true)" != "$STANDARD_COMMIT" ]; then
  git -C standard fetch -q --depth 1 origin "$STANDARD_COMMIT"
  git -C standard checkout -q --detach "$STANDARD_COMMIT"
fi
echo "standard at $STANDARD_COMMIT"

(cd standard && npm ci --no-audit --no-fund && npm run build)
