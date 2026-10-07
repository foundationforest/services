#!/usr/bin/env bash
# Starts the issuer (issuer/, unchanged, with `npm start`). With no DIDIT_API_KEY it first starts the
# stand-in Didit (fake-didit.ts) on 127.0.0.1, points the issuer at it for both checks with the
# stand-in embedding (FACE_MODEL=stand-in), and says so. Setting DIDIT_API_KEY, DIDIT_WORKFLOW_ID and
# DIDIT_ID_WORKFLOW_ID (sealed) and redeploying puts the real checks, and the face models, in their
# place.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DIDIT_API_KEY:-}" ]; then
  export FAKE_DIDIT_PORT="${FAKE_DIDIT_PORT:-8090}"
  FAKE_DIDIT_WORKFLOW_ID="00000000-0000-4000-8000-00000000f0ce"
  export FAKE_DIDIT_ID_WORKFLOW_ID="00000000-0000-4000-8000-0000000001d0"
  node deploy/fake-didit.ts &
  for _ in $(seq 1 50); do
    (echo > "/dev/tcp/127.0.0.1/$FAKE_DIDIT_PORT") 2>/dev/null && break
    sleep 0.2
  done
  export DIDIT_API_KEY="fake-didit" DIDIT_WORKFLOW_ID="$FAKE_DIDIT_WORKFLOW_ID" DIDIT_ID_WORKFLOW_ID="$FAKE_DIDIT_ID_WORKFLOW_ID" \
    DIDIT_BASE_URL="http://127.0.0.1:$FAKE_DIDIT_PORT" FACE_MODEL="stand-in"
  echo "issuer: no DIDIT_API_KEY, so both checks are the stand-in (issuer/deploy/fake-didit.ts): every session passes, with one embedding for everyone"
fi

exec npm start
