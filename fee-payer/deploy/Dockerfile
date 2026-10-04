# The fee payer's general node (fee-payer/): Kora 2.0.5, unchanged, from Kora's own published image,
# pinned by digest, started by fee-payer/run.sh with fee-payer/signers.toml. Its rules are
# fee-payer/general/kora.toml with the devnet lines fee-payer/deploy/devnet-config.sh changes, and no
# others. The build context is the repo root. The key comes from the sealed variable FOREST_RELAYER_KEY, its old name, as the
# JSON array itself; run.sh passes it to Kora as FOREST_FEE_PAYER_KEY.
FROM ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b
WORKDIR /forest
COPY fee-payer/KORA fee-payer/signers.toml fee-payer/run.sh fee-payer/
COPY fee-payer/general/kora.toml fee-payer/general/
COPY fee-payer/deploy/devnet-config.sh fee-payer/deploy/
RUN kora --version | grep -qF "$(cat fee-payer/KORA)" \
  && bash fee-payer/deploy/devnet-config.sh fee-payer/general/kora.toml > fee-payer/general/kora.devnet.toml
ENV KORA_BIN=/usr/local/bin/kora KORA_CONFIG=general/kora.devnet.toml
EXPOSE 8080
CMD ["bash", "fee-payer/run.sh"]
