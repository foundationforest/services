#!/usr/bin/env bash
# Starts the fee payer's sponsored node in one container: Kora (fee-payer/run.sh) on the sponsored
# config, and the pre-check in front of it on PORT.
#
# Kora 2.0.5 listens on every interface and cannot be told otherwise, so it asks every caller for a
# key, made here at each start and handed to the pre-check alone: anything else that reaches Kora's
# port, from this project's private network, is refused (401). When either stops, the container
# stops.
#
#   FOREST_FEE_PAYER_KEY  the fee payer's key, as for the general node (fee-payer/run.sh)
#   RPC_URL               the Solana RPC Kora simulates and sends through
#   VOUCHER_ISSUERS, REGISTRY_PROGRAM, DATABASE_PATH, PORT   the pre-check's (fee-payer/README.md)
set -euo pipefail
cd "$(dirname "$0")/../.."

KORA_PORT=8081
KORA_API_KEY="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export KORA_API_KEY

PORT="$KORA_PORT" bash run.sh &
for _ in $(seq 1 100); do
  (echo > "/dev/tcp/127.0.0.1/$KORA_PORT") 2>/dev/null && break
  sleep 0.2
done
KORA_URL="http://127.0.0.1:$KORA_PORT" node --disable-warning=ExperimentalWarning sponsor/src/main.ts &

trap 'kill $(jobs -p) 2>/dev/null' TERM INT
wait -n
exit 1
