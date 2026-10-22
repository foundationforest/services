# The fee payer (fee-payer/): Kora 2.0.5, unchanged, its binary taken from Kora's own published image
# (pinned by digest), run by fee-payer/run.sh with fee-payer/signers.toml on fee-payer/kora.toml with
# the lines fee-payer/deploy/devnet-config.sh changes and no others. Nothing of ours runs in front of
# it: Kora answers on PORT itself. It runs at RUST_LOG=warn, which writes no request. run.sh makes
# the key at the first start, on the volume at /data (KEY_PATH), with Node, which this image is
# built on. The build context is the repo root.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b AS kora

# Node's official image from Google's Docker Hub mirror: Docker Hub's pull limit failed our builds.
FROM mirror.gcr.io/library/node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=kora /usr/local/bin/kora /usr/local/bin/kora
WORKDIR /services
COPY fee-payer/KORA fee-payer/signers.toml fee-payer/run.sh fee-payer/kora.toml fee-payer/
COPY fee-payer/deploy/devnet-config.sh fee-payer/deploy/
RUN kora --version | grep -qF "$(cat fee-payer/KORA)" \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/kora.toml > fee-payer/kora.devnet.toml
ENV KORA_BIN=/usr/local/bin/kora RUST_LOG=warn KORA_CONFIG=kora.devnet.toml
EXPOSE 8080
CMD ["bash", "fee-payer/run.sh"]
