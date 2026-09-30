# The fee payer (feepayer/): Kora 2.0.5, unchanged, from Kora's own published image, pinned by digest,
# started by feepayer/run.sh with feepayer/signers.toml. Its rules are feepayer/kora.toml with the
# devnet lines deploy/feepayer/devnet-config.sh changes, and no others. The build context is the repo
# root. The key comes from the sealed variable FOREST_FEEPAYER_KEY, as the JSON array itself.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b
WORKDIR /forest
COPY feepayer/KORA feepayer/kora.toml feepayer/signers.toml feepayer/run.sh feepayer/
COPY deploy/feepayer/devnet-config.sh deploy/feepayer/
RUN kora --version | grep -qF "$(cat feepayer/KORA)" \
  && bash deploy/feepayer/devnet-config.sh feepayer/kora.toml > feepayer/kora.devnet.toml
ENV KORA_BIN=/usr/local/bin/kora KORA_CONFIG=kora.devnet.toml
EXPOSE 8080
CMD ["bash", "feepayer/run.sh"]
