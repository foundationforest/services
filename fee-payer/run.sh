#!/usr/bin/env bash
# Runs one of the fee payer's Koras: Kora (installed by build.sh) with a kora.toml and signers.toml.
#
#   FOREST_FEE_PAYER_KEY path to the fee payer's keypair file, outside this repo (or, where a host
#                        has no files, the key itself; see README.md)
#   RPC_URL              the Solana RPC it simulates and sends through
#   JUPITER_API_KEY      for the dollar price, with price_source = "Jupiter"
#   PORT                 default 8080
#   KORA_CONFIG          default at-cost/kora.toml (the at-cost image sets its devnet config,
#                        deploy/registry.sh passes the registry's; the local run passes its Mock copy)
set -euo pipefail
cd "$(dirname "$0")"
here="$PWD"
root="$(cd .. && pwd)"

# Railway still holds the key under its old name; sealed values cannot be moved.
if [ -z "${FOREST_FEE_PAYER_KEY:-}" ] && [ -n "${FOREST_RELAYER_KEY:-}" ]; then export FOREST_FEE_PAYER_KEY="$FOREST_RELAYER_KEY"; fi
: "${FOREST_FEE_PAYER_KEY:?set FOREST_FEE_PAYER_KEY to the path of its keypair file}"
: "${RPC_URL:?set RPC_URL to a Solana RPC}"
if [ -f "$FOREST_FEE_PAYER_KEY" ]; then
  key="$(cd "$(dirname "$FOREST_FEE_PAYER_KEY")" && pwd)/$(basename "$FOREST_FEE_PAYER_KEY")"
  case "$key" in
    "$root"/*) echo "refusing: the fee payer's key is inside the repo ($key)" >&2; exit 1 ;;
  esac
fi

kora="${KORA_BIN:-$here/.kora/bin/kora}"
[ -x "$kora" ] || { echo "no kora at $kora; run ./build.sh" >&2; exit 1; }

exec "$kora" --config "${KORA_CONFIG:-at-cost/kora.toml}" --rpc-url "$RPC_URL" \
  rpc start --signers-config signers.toml --port "${PORT:-8080}"
