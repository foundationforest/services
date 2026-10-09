# The foundation's hosted copy of the CLI's MCP door (mcp/): `forest mcp --http`, from this
# directory. The build context is the repo root; standard.sh fetches the standard into standard/ at the
# commit in STANDARD and installs records' library, which the CLI runs on, and needs git.
#
# It serves Streamable HTTP at /mcp on the port Railway gives (PORT), on every address, with the
# foundation's devnet index as its index. No key is set: the CLI refuses to start a hosted copy with
# one, since every caller would act as that person. The hosts it starts from are the CLI's default,
# the public list in index/lists/hosts.json on this repo's main.
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD standard.sh ./
RUN ./standard.sh records
COPY mcp/package.json mcp/package-lock.json mcp/
RUN cd mcp && npm ci --no-audit --no-fund --omit=dev
COPY mcp/src mcp/src
WORKDIR /services/mcp
CMD ["sh", "-c", "exec node src/main.ts mcp --http 0.0.0.0:${PORT:-8080} --index https://index.devnet.forest.foundation"]
