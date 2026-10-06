# The foundation's host (host/): forest's reference host with this service's policy. The build
# context is the repo root, because the host imports forest's records and registry client by
# relative path; forest.sh fetches forest into forest/ at the commit in FOREST, and needs git.
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY FOREST forest.sh ./
RUN ./forest.sh records registry/client
COPY host/ host/
RUN cd host && npm ci --no-audit --no-fund
WORKDIR /services/host
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
