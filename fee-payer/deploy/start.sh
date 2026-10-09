#!/usr/bin/env bash
# Starts the fee payer in one container, behind one address: two Koras (fee-payer/run.sh) that sign
# with one key, and the voucher check in front of both on PORT.
#
#   the at-cost Kora   at-cost/kora.devnet.toml, on 8081
#   the free Kora      registry/kora.devnet.toml, on 8082, with a key
#   the voucher check  on PORT: `POST /vouchers` to the free Kora once a voucher holds, every other
#                      request to the at-cost Kora unchanged
#
# Kora 2.0.5 listens on every interface and cannot be told otherwise, so the free Kora asks every
# caller for a key, made here at each start and handed to the voucher check alone: anything else
# that reaches its port, from this project's private network, is refused (401). The at-cost Kora
# asks for none: whatever reaches it pays its way, as it does through the front. When any of the
# three stops, the container stops.
#
#   FOREST_FEE_PAYER_KEY  the fee payer's key, for both Koras (fee-payer/run.sh)
#   RPC_URL               the Solana RPC both Koras simulate and send through
#   FEE_PAYER_NAME, VOUCHER_ISSUERS, REGISTRY_PROGRAM, DATABASE_PATH, PORT
#                         the voucher check's (fee-payer/README.md)
set -euo pipefail
cd "$(dirname "$0")/.."

AT_COST_PORT=8081
FREE_PORT=8082
FREE_KORA_API_KEY="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"

PORT="$AT_COST_PORT" KORA_CONFIG=at-cost/kora.devnet.toml bash run.sh &
PORT="$FREE_PORT" KORA_CONFIG=registry/kora.devnet.toml KORA_API_KEY="$FREE_KORA_API_KEY" bash run.sh &
for port in "$AT_COST_PORT" "$FREE_PORT"; do
  for _ in $(seq 1 100); do
    (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null && break
    sleep 0.2
  done
done
AT_COST_KORA_URL="http://127.0.0.1:$AT_COST_PORT" FREE_KORA_URL="http://127.0.0.1:$FREE_PORT" \
  FREE_KORA_API_KEY="$FREE_KORA_API_KEY" node --disable-warning=ExperimentalWarning registry/src/main.ts &

trap 'kill $(jobs -p) 2>/dev/null' TERM INT
wait -n
exit 1
