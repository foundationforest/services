#!/usr/bin/env bash
# Runs the fee payer: Kora (installed by build.sh) with kora.toml and signers.toml.
#
#   FOREST_FEEPAYER_KEY  path to the fee payer's keypair file, outside this repo (or, where a host
#                        has no files, the key itself; see README.md)
#   RPC_URL              the Solana RPC it simulates and sends through
#   JUPITER_API_KEY      for the dollar price, with price_source = "Jupiter"
#   PORT                 default 8080
#   KORA_CONFIG          default kora.toml (the local run passes its Mock copy)
set -euo pipefail
cd "$(dirname "$0")"
here="$PWD"
root="$(cd .. && pwd)"

: "${FOREST_FEEPAYER_KEY:?set FOREST_FEEPAYER_KEY to the path of the fee payer key file}"
: "${RPC_URL:?set RPC_URL to a Solana RPC}"
if [ -f "$FOREST_FEEPAYER_KEY" ]; then
  key="$(cd "$(dirname "$FOREST_FEEPAYER_KEY")" && pwd)/$(basename "$FOREST_FEEPAYER_KEY")"
  case "$key" in
    "$root"/*) echo "refusing: the fee payer key is inside the repo ($key); keep it outside" >&2; exit 1 ;;
  esac
fi

kora="${KORA_BIN:-$here/.kora/bin/kora}"
[ -x "$kora" ] || { echo "no kora at $kora; run ./build.sh" >&2; exit 1; }

exec "$kora" --config "${KORA_CONFIG:-kora.toml}" --rpc-url "$RPC_URL" \
  rpc start --signers-config signers.toml --port "${PORT:-8080}"
