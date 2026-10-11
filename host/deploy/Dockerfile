# The foundation's host (host/): forest's reference host with this service's policy. The build
# context is the repo root, because the host imports forest's records and registry client by
# relative path, and the credits/ next to it; standard.sh fetches standard into standard/ at the commit
# in STANDARD, and needs git.
# Node's official image from Google's Docker Hub mirror: Docker Hub's pull limit failed our builds.
FROM mirror.gcr.io/library/node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD standard.sh ./
RUN ./standard.sh records registry/client
COPY credits/ credits/
RUN cd credits && npm ci --no-audit --no-fund
COPY host/ host/
RUN cd host && npm ci --no-audit --no-fund
WORKDIR /services/host
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
