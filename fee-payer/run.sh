#!/usr/bin/env bash
# Runs the fee payer: Kora (installed by build.sh) with a kora.toml and signers.toml.
#
#   KEY_PATH         the fee payer's keypair file (the Solana CLI's JSON form), default
#                    /data/fee-payer-keypair.json, on the volume. If it is absent, this makes it,
#                    mode 0600, and prints its address once; it never prints the key.
#   RPC_URL          the Solana RPC it simulates and sends through
#   JUPITER_API_KEY  for the dollar price, with price_source = "Jupiter"
#   PORT             default 8080
#   KORA_CONFIG      default kora.toml (the image sets its own; the local run passes its Mock copy)
#   KORA_BIN         default .kora/bin/kora
set -euo pipefail
cd "$(dirname "$0")"
here="$PWD"
root="$(cd .. && pwd)"

: "${RPC_URL:?set RPC_URL to a Solana RPC}"
kora="${KORA_BIN:-$here/.kora/bin/kora}"
[ -x "$kora" ] || { echo "no kora at $kora; run ./build.sh" >&2; exit 1; }

key="$(realpath -m "${KEY_PATH:-/data/fee-payer-keypair.json}")"
case "$key" in
  "$root"/*) echo "refusing: the fee payer's key would be inside the repo ($key)" >&2; exit 1 ;;
esac

if [ ! -e "$key" ]; then
  mkdir -p "$(dirname "$key")"
  # A fresh ed25519 key, written as the Solana CLI writes one: a JSON array of its 32-byte seed then
  # its 32-byte public key. `wx` refuses to write over a file that appeared meanwhile.
  node --input-type=module - "$key" <<'JS'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
writeFileSync(process.argv[2], JSON.stringify([...seed, ...pub]), { flag: 'wx', mode: 0o600 })
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
let n = BigInt('0x' + pub.toString('hex'))
let address = ''
while (n > 0n) { address = alphabet[Number(n % 58n)] + address; n /= 58n }
for (const byte of pub) { if (byte !== 0) break; address = '1' + address }
console.log(`fee payer address ${address}`)
JS
fi

export FOREST_FEE_PAYER_KEY="$key"
exec "$kora" --config "${KORA_CONFIG:-kora.toml}" --rpc-url "$RPC_URL" \
  rpc start --signers-config signers.toml --port "${PORT:-8080}"
