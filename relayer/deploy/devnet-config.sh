#!/usr/bin/env bash
# Prints the devnet relayer's kora.toml: relayer/kora.toml with exactly these lines changed, and
# nothing else. Each old line must appear exactly once, or it stops.
#
#   the registry's id    -> devnet's (forest/registry/devnet/devnet.json)
#   escrow v1's id       -> devnet's (forest/docs/devnet.md)
#   escrow v2's id       -> devnet's (forest/escrow/v2/devnet/devnet.json)
#   the four paid tokens -> the USDC-shaped test dollar the devnet run mints (forest/docs/devnet.md)
#   (USDC, USDT, Open USD,  and the Open-USD-shaped one (forest/escrow/v2/devnet/devnet.json):
#   EURC)                   devnet's relayer is paid in those two only
#   Jupiter's price      -> Kora's mock, since Jupiter prices mainnet only (relayer/README.md). The
#                           mock values the test dollar at 0.001 SOL a whole token: one base unit
#                           buys one lamport.
set -euo pipefail
src="${1:?usage: devnet-config.sh path/to/kora.toml}"

REGISTRY_DEVNET=Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf
ESCROW_DEVNET=3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR
ESCROW_V2_DEVNET=FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8
TEST_DOLLAR=J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa
OPEN_USD_SHAPED=g55mjY4swDAFt16TZds3tsmoK55qkdhDLn4kb32RGZz
USDC=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
USDT=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
OPEN_USD=ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB
EURC=HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr
MAINNET_PAID="\"$USDC\", \"$USDT\", \"$OPEN_USD\", \"$EURC\""
DEVNET_PAID="\"$TEST_DOLLAR\", \"$OPEN_USD_SHAPED\""

out="$(cat "$src")"
swap() {
  local old="$1" new="$2" n
  n="$(grep -cxF -- "$old" <<< "$out" || true)"
  [ "$n" = 1 ] || { echo "devnet-config: expected exactly one line '$old' in $src, found $n" >&2; exit 1; }
  out="$(awk -v old="$old" -v new="$new" '$0 == old { print new; next } { print }' <<< "$out")"
}
swap '  "FoRBadgeLineFreeNoFeeNoAdmin1111111111111111", # the Forest registry' "  \"$REGISTRY_DEVNET\", # the Forest registry (devnet)"
swap '  "FoRE4JYRAxFpqRoPBzuPZZ9Yfn6ovtkBfUggynex3MKT", # the Forest escrow, v1' "  \"$ESCROW_DEVNET\", # the Forest escrow, v1 (devnet)"
swap '  "FoRE2EscrowV2objectsTimerFundedAtPayer222222", # the Forest escrow, v2' "  \"$ESCROW_V2_DEVNET\", # the Forest escrow, v2 (devnet)"
swap "allowed_tokens = [$MAINNET_PAID]" "allowed_tokens = [$DEVNET_PAID]"
swap "allowed_spl_paid_tokens = [$MAINNET_PAID]" "allowed_spl_paid_tokens = [$DEVNET_PAID]"
swap 'price_source = "Jupiter"' 'price_source = "Mock"'
printf '%s\n' "$out"
