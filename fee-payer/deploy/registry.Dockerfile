# The registry payer (fee-payer/, registry/), in one container behind one address: Kora 2.0.5,
# unchanged, its binary taken from Kora's own published image (pinned by digest), run by
# fee-payer/run.sh with fee-payer/signers.toml on fee-payer/registry/kora.toml, with the devnet lines
# fee-payer/deploy/devnet-config.sh changes and no others; and the front (fee-payer/registry/) before
# it. fee-payer/deploy/registry.sh starts both. The build context is the repo root, because the
# front imports forest's registry client and credits by relative path; standard.sh fetches them into
# standard/ at the commit in STANDARD, and needs git. The spent list lives on a volume
# (DATABASE_PATH). Kora runs at RUST_LOG=warn, which writes no request.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b AS kora

FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kora /usr/local/bin/kora /usr/local/bin/kora
WORKDIR /services
COPY STANDARD standard.sh ./
RUN ./standard.sh registry/client credits
COPY fee-payer/KORA fee-payer/signers.toml fee-payer/run.sh fee-payer/
COPY fee-payer/registry/kora.toml fee-payer/registry/
COPY fee-payer/deploy/devnet-config.sh fee-payer/deploy/registry.sh fee-payer/deploy/
RUN kora --version | grep -qF "$(cat fee-payer/KORA)" \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/registry/kora.toml > fee-payer/registry/kora.devnet.toml
COPY fee-payer/registry/ fee-payer/registry/
RUN cd fee-payer/registry && npm ci --no-audit --no-fund --omit=dev
ENV KORA_BIN=/usr/local/bin/kora RUST_LOG=warn
EXPOSE 8080
CMD ["bash", "fee-payer/deploy/registry.sh"]
