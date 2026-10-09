#!/usr/bin/env bash
# Fetches foundationforest/standard at the commit in STANDARD into standard/ (not committed), then
# runs `npm ci` in each standard package named on the command line. The services use standard's
# pieces from there, unchanged, by relative path: standard/keys, standard/records,
# standard/registry/client and standard/escrow/client in code; standard's programs and proving files
# in the slow tests. Moving the pin is a one-line change to STANDARD. Needs git and the network.
#
#   ./standard.sh                                        standard at the pinned commit
#   ./standard.sh registry/client records                and `npm ci` in those packages
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

for dir in "$@"; do
  (cd "standard/$dir" && npm ci --no-audit --no-fund)
done
