#!/usr/bin/env bash
# Installs Kora, unchanged, at the version in KORA, into feepayer/.kora (not committed). Needs
# Rust (cargo) and the network for crates.io. `--locked` takes the dependency versions Kora
# published with, which is what makes the key's environment variable accept a file path
# (solana-keychain 0.1.0; see README.md).
set -euo pipefail
cd "$(dirname "$0")"
version="$(tr -d '[:space:]' < KORA)"
cargo install kora-cli --version "$version" --locked --root .kora
./.kora/bin/kora --version
