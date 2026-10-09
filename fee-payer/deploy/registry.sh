#!/usr/bin/env bash
# Starts the registry payer in one container, behind one address: its Kora (fee-payer/run.sh, on
# registry/kora.devnet.toml, port 8082, with a key) and the front in front of it on PORT
# (registry/src/main.ts: its credits, `POST /register`, and Kora's getPayerSigner and liveness).
#
# Kora 2.0.5 listens on every interface and cannot be told otherwise, so the Kora asks every caller
# for a key, made here at each start and handed to the front alone: anything else that reaches its
# port, from this project's private network, is refused (401). When either stops, the container
# stops.
#
#   FOREST_FEE_PAYER_KEY  the registry payer's key, for its Kora (fee-payer/run.sh)
#   RPC_URL               the Solana RPC its Kora sends through, and the front finds payments and
#                         watches rows through
#   PUBLIC_ORIGIN, CREDIT_KEY, CREDIT_ADDRESS, CREDIT_MINT, CREDIT_PRICE, REGISTRY_PROGRAM,
#   DATABASE_PATH, PORT   the front's (fee-payer/README.md)
set -euo pipefail
cd "$(dirname "$0")/.."

KORA_PORT=8082
export KORA_API_KEY="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"

PORT="$KORA_PORT" KORA_CONFIG=registry/kora.devnet.toml bash run.sh &
for _ in $(seq 1 100); do
  (echo > "/dev/tcp/127.0.0.1/$KORA_PORT") 2>/dev/null && break
  sleep 0.2
done
KORA_URL="http://127.0.0.1:$KORA_PORT" node --disable-warning=ExperimentalWarning registry/src/main.ts &

trap 'kill $(jobs -p) 2>/dev/null' TERM INT
wait -n
exit 1
