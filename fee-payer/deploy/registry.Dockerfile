# The registry payer (fee-payer/registry/): one program, with its own key, signing and sending each
# row it pays for. The build context is the repo root, because it imports standard's registry client
# by relative path, and the credits/ next to it; standard.sh fetches the client into standard/ at the
# commit in STANDARD, and needs git. Its seller's file lives on a volume (DATABASE_PATH).
# Node's official image from Google's Docker Hub mirror: Docker Hub's pull limit failed our builds.
FROM mirror.gcr.io/library/node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD standard.sh ./
RUN ./standard.sh registry/client
COPY credits/ credits/
RUN cd credits && npm ci --no-audit --no-fund --omit=dev
COPY fee-payer/registry/ fee-payer/registry/
RUN cd fee-payer/registry && npm ci --no-audit --no-fund --omit=dev
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "fee-payer/registry/src/main.ts"]
