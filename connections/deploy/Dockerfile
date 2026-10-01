# The connections service (connections/), started as its README says. The build context is the repo
# root, because the service imports forest's records by relative path; forest.sh fetches it into
# forest/ at the commit in FOREST, and needs git. Forest's approval page is built here by its own
# web/build.ts, unchanged, and the service serves it at /approve.
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY FOREST forest.sh ./
RUN ./forest.sh records && cd forest/records && node web/build.ts
COPY connections/ connections/
RUN cd connections && npm ci --no-audit --no-fund
WORKDIR /services/connections
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
