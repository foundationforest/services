# The devnet test host (e2e/host/): forest's reference host, for devnet testing only. The build
# context is the repo root, because the host imports forest's records by relative path; forest.sh
# fetches it into forest/ at the commit in FOREST, and needs git.
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY FOREST forest.sh ./
RUN ./forest.sh records
COPY e2e/host/ e2e/host/
RUN cd e2e/host && npm ci --no-audit --no-fund
WORKDIR /services/e2e/host
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
