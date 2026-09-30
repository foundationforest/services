# The relayer (relayer/): Kora 2.0.5, unchanged, from Kora's own published image, pinned by digest,
# started by relayer/run.sh with relayer/signers.toml. Its rules are relayer/kora.toml with the
# devnet lines relayer/deploy/devnet-config.sh changes, and no others. The build context is the repo
# root. The key comes from the sealed variable FOREST_RELAYER_KEY, as the JSON array itself.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b
WORKDIR /forest
COPY relayer/KORA relayer/kora.toml relayer/signers.toml relayer/run.sh relayer/
COPY relayer/deploy/devnet-config.sh relayer/deploy/
RUN kora --version | grep -qF "$(cat relayer/KORA)" \
  && bash relayer/deploy/devnet-config.sh relayer/kora.toml > relayer/kora.devnet.toml
ENV KORA_BIN=/usr/local/bin/kora KORA_CONFIG=kora.devnet.toml
EXPOSE 8080
CMD ["bash", "relayer/run.sh"]
