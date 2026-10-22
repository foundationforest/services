#!/usr/bin/env bash
# Prints the kora.toml the fee payer runs on the chain the escrow runs on today: fee-payer/kora.toml
# with exactly these lines changed, and nothing else. Each old line must appear exactly once, or it
# stops. The escrow's address is already that chain's, in the file itself.
#
#   the four paid tokens -> the classic test dollar (e2e/services.json: testDollar) and the one
#   (USDC, USDT, Open USD,  shaped like Open USD (standard/escrows/solana/devnet/devnet.json:
#   EURC)                   openUsdShaped): it is paid in those two only
#   Jupiter's price      -> Kora's mock, since Jupiter prices real dollars only (fee-payer/README.md).
#                           The mock values the test dollar at 0.001 SOL a whole token: one base unit
#                           buys one lamport.
set -euo pipefail
src="${1:?usage: devnet-config.sh path/to/kora.toml}"

TEST_DOLLAR=537LFFpTfrbvopMQwi8wSTc767PsWjqwptNmBtUGj7bt
OPEN_USD_SHAPED=g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz
USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
USDT=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
OPEN_USD=ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB
EURC=HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr
PAID="\"$USDC\", \"$USDT\", \"$OPEN_USD\", \"$EURC\""
TEST_PAID="\"$TEST_DOLLAR\", \"$OPEN_USD_SHAPED\""

out="$(cat "$src")"
swap() {
  local old="$1" new="$2" n
  n="$(grep -cxF -- "$old" <<< "$out" || true)"
  [ "$n" = 1 ] || { echo "devnet-config: expected exactly one line '$old' in $src, found $n" >&2; exit 1; }
  out="$(awk -v old="$old" -v new="$new" '$0 == old { print new; next } { print }' <<< "$out")"
}
swap "allowed_tokens = [$PAID]" "allowed_tokens = [$TEST_PAID]"
swap "allowed_spl_paid_tokens = [$PAID]" "allowed_spl_paid_tokens = [$TEST_PAID]"
swap 'price_source = "Jupiter"' 'price_source = "Mock"'
printf '%s\n' "$out"
