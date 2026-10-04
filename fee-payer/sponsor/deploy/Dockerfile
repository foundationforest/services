# The fee payer's sponsored node (fee-payer/), in one container: Kora 2.0.5, unchanged, its binary
# taken from Kora's own published image (pinned by digest, the general node's), with
# fee-payer/sponsored/kora.toml and the devnet lines fee-payer/deploy/devnet-config.sh changes; and the
# pre-check (fee-payer/sponsor/) in front of it. fee-payer/sponsor/deploy/start.sh starts both. The
# build context is the repo root, because the pre-check imports forest's registry/client by relative
# path; forest.sh fetches it into forest/ at the commit in FOREST, and needs git. The used set lives
# on a volume (DATABASE_PATH). Kora runs at RUST_LOG=warn, which writes no request.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b AS kora

FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kora /usr/local/bin/kora /usr/local/bin/kora
WORKDIR /services
COPY FOREST forest.sh ./
RUN ./forest.sh registry/client
COPY fee-payer/KORA fee-payer/signers.toml fee-payer/run.sh fee-payer/
COPY fee-payer/sponsored/kora.toml fee-payer/sponsored/
COPY fee-payer/deploy/devnet-config.sh fee-payer/deploy/
RUN kora --version | grep -qF "$(cat fee-payer/KORA)" \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/sponsored/kora.toml > fee-payer/sponsored/kora.devnet.toml
COPY fee-payer/sponsor/ fee-payer/sponsor/
RUN cd fee-payer/sponsor && npm ci --no-audit --no-fund --omit=dev
ENV KORA_BIN=/usr/local/bin/kora KORA_CONFIG=sponsored/kora.devnet.toml RUST_LOG=warn
CMD ["bash", "fee-payer/sponsor/deploy/start.sh"]
