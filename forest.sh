#!/usr/bin/env bash
# Fetches foundationforest/forest at the commit in FOREST into forest/ (not committed), then runs
# `npm ci` in each forest package named on the command line. The services use forest's pieces from
# there, unchanged, by relative path: forest/records, forest/registry/client and both escrow
# clients in code; forest's programs and proving files in the slow tests. Moving the
# pin is a one-line change to FOREST. Needs git and the network.
#
#   ./forest.sh                                          forest at the pinned commit
#   ./forest.sh registry/client records                  and `npm ci` in those packages
set -euo pipefail
cd "$(dirname "$0")"

FOREST_REPO="${FOREST_REPO:-https://github.com/foundationforest/forest}"
FOREST_COMMIT="$(tr -d '[:space:]' < FOREST)"

if [ ! -d forest/.git ]; then
  git init -q forest
  git -C forest remote add origin "$FOREST_REPO"
fi
if [ "$(git -C forest rev-parse -q --verify HEAD || true)" != "$FOREST_COMMIT" ]; then
  git -C forest fetch -q --depth 1 origin "$FOREST_COMMIT"
  git -C forest checkout -q --detach "$FOREST_COMMIT"
fi
echo "forest at $FOREST_COMMIT"

for dir in "$@"; do
  (cd "forest/$dir" && npm ci --no-audit --no-fund)
done
