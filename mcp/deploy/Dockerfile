# The foundation's hosted copy of the mcp (mcp/): node src/main.ts, from this directory. The build
# context is the repo root; standard.sh fetches the standard at the commit in STANDARD, installs and
# builds it, and fetches the markets at the commit in MARKETS, which the mcp reads its markets from;
# it needs git.
#
# It serves the MCP door at its root and at /mcp, the login, its open key at /open-key, and the icon
# at /favicon.ico and /icon.svg, on the port Railway gives (PORT), on every address. Its two keys are
# kept in DATA_DIR, a volume. It reads the foundation's index, its default, and the folders each
# login acts in, on public hosts; APP_URL, the Forest app's connect page, is a variable of the
# deploy, and until it is set, logins wait.
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
ENV DATA_DIR=/data BIND=0.0.0.0
CMD ["node", "src/main.ts"]
