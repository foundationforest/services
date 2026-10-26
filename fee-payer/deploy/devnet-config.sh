#!/usr/bin/env bash
# Prints the kora.toml the fee payer runs on the chain the escrow runs on today: fee-payer/kora.toml
# with exactly these lines changed, and nothing else. Each old line must appear exactly once, or it
# stops. The escrow's address is already that chain's, in the file itself.
#
#   the four paid tokens -> Circle's USDC on that chain, the one dollar it is paid in there; anyone
#   (USDC, USDT, Open USD,  gets it from Circle's faucet (fee-payer/README.md)
#   EURC)
#   Jupiter's price      -> Kora's mock, since Jupiter prices real dollars only (fee-payer/README.md).
#                           The mock values that USDC at 0.0001 SOL a whole token, by its address
#                           (Kora 2.0.5's oracle/utils.rs): ten base units buy one lamport.
set -euo pipefail
src="${1:?usage: devnet-config.sh path/to/kora.toml}"

DEVNET_USDC=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
USDT=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
OPEN_USD=ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB
EURC=HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr
PAID="\"$USDC\", \"$USDT\", \"$OPEN_USD\", \"$EURC\""
DEVNET_PAID="\"$DEVNET_USDC\""

out="$(cat "$src")"
swap() {
  local old="$1" new="$2" n
  n="$(grep -cxF -- "$old" <<< "$out" || true)"
  [ "$n" = 1 ] || { echo "devnet-config: expected exactly one line '$old' in $src, found $n" >&2; exit 1; }
  out="$(awk -v old="$old" -v new="$new" '$0 == old { print new; next } { print }' <<< "$out")"
}
swap "allowed_tokens = [$PAID]" "allowed_tokens = [$DEVNET_PAID]"
swap "allowed_spl_paid_tokens = [$PAID]" "allowed_spl_paid_tokens = [$DEVNET_PAID]"
swap 'price_source = "Jupiter"' 'price_source = "Mock"'
printf '%s\n' "$out"
