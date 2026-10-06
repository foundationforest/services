# The key holder (keyholder/), started as its README says. The build context is the repo root,
# because the service imports forest's records by relative path; forest.sh fetches it into forest/
# at the commit in FOREST, and needs git. Its one file lives on a volume (DATABASE_PATH).
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY FOREST forest.sh ./
RUN ./forest.sh records
COPY keyholder/ keyholder/
RUN cd keyholder && npm ci --no-audit --no-fund --omit=dev
WORKDIR /services/keyholder
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
