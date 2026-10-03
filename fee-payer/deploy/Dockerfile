# The fee payer (fee-payer/): Kora 2.0.5, unchanged, from Kora's own published image, pinned by
# digest, started by fee-payer/run.sh with fee-payer/signers.toml. Its rules are fee-payer/kora.toml
# with the devnet lines fee-payer/deploy/devnet-config.sh changes, and no others. The build context
# is the repo root. The key comes from the sealed variable FOREST_FEE_PAYER_KEY, as the JSON array
# itself.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b
WORKDIR /forest
COPY fee-payer/KORA fee-payer/kora.toml fee-payer/signers.toml fee-payer/run.sh fee-payer/
COPY fee-payer/deploy/devnet-config.sh fee-payer/deploy/
RUN kora --version | grep -qF "$(cat fee-payer/KORA)" \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/kora.toml > fee-payer/kora.devnet.toml
ENV KORA_BIN=/usr/local/bin/kora KORA_CONFIG=kora.devnet.toml
EXPOSE 8080
CMD ["bash", "fee-payer/run.sh"]
