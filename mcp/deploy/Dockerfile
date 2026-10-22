# The foundation's hosted copy of forest's MCP door (mcp/): `forest mcp --http`, from this directory.
# The build context is the repo root; standard.sh fetches the standard at the commit in STANDARD,
# installs and builds it, and fetches the markets at the commit in MARKETS, which forest reads its
# markets from; it needs git.
#
# It serves Streamable HTTP at its root and at /mcp, and the icon at /favicon.ico and /icon.svg, on
# the port Railway gives (PORT), on every address, with the foundation's index as its index. No key
# is set: forest refuses to start a hosted copy with one, since every caller would act as that
# person. The host it looks for a profile's hosts record on first is forest's default, the
# foundation's host.
# Node's official image from Google's Docker Hub mirror: Docker Hub's pull limit failed our builds.
FROM mirror.gcr.io/library/node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD MARKETS standard.sh ./
RUN ./standard.sh
COPY mcp/package.json mcp/package-lock.json mcp/
RUN cd mcp && npm ci --no-audit --no-fund --omit=dev
COPY mcp/src mcp/src
WORKDIR /services/mcp
CMD ["sh", "-c", "exec node src/main.ts mcp --http 0.0.0.0:${PORT:-8080} --index https://index.forest.foundation"]
