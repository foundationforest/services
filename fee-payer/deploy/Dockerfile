# The fee payer (fee-payer/), in one container behind one address: Kora 2.0.5, unchanged, its binary
# taken from Kora's own published image (pinned by digest), run twice by fee-payer/run.sh with
# fee-payer/signers.toml: the at-cost Kora on fee-payer/at-cost/kora.toml and the free Kora on
# fee-payer/free/kora.toml, each with the devnet lines fee-payer/deploy/devnet-config.sh changes and
# no others; and the voucher check (fee-payer/vouchers/) in front of both. fee-payer/deploy/start.sh
# starts all three. The build context is the repo root, because the voucher check imports forest's
# registry/client by relative path; forest.sh fetches it into forest/ at the commit in FOREST, and
# needs git. The used set lives on a volume (DATABASE_PATH). Both Koras run at RUST_LOG=warn, which
# writes no request.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b AS kora

FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kora /usr/local/bin/kora /usr/local/bin/kora
WORKDIR /services
COPY FOREST forest.sh ./
RUN ./forest.sh registry/client
COPY fee-payer/KORA fee-payer/signers.toml fee-payer/run.sh fee-payer/
COPY fee-payer/at-cost/kora.toml fee-payer/at-cost/
COPY fee-payer/free/kora.toml fee-payer/free/
COPY fee-payer/deploy/devnet-config.sh fee-payer/deploy/start.sh fee-payer/deploy/
RUN kora --version | grep -qF "$(cat fee-payer/KORA)" \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/at-cost/kora.toml > fee-payer/at-cost/kora.devnet.toml \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/free/kora.toml > fee-payer/free/kora.devnet.toml
COPY fee-payer/vouchers/ fee-payer/vouchers/
RUN cd fee-payer/vouchers && npm ci --no-audit --no-fund --omit=dev
ENV KORA_BIN=/usr/local/bin/kora RUST_LOG=warn
EXPOSE 8080
CMD ["bash", "fee-payer/deploy/start.sh"]
