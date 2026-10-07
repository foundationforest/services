# The foundation's hosted copy of forest's CLI MCP door (mcp/): `forest mcp --http`, unchanged, at
# the commit in FOREST. The build context is the repo root; forest.sh fetches forest into forest/ and
# installs records' library and the CLI, and needs git. Nothing of this repo runs in the image.
#
# It serves Streamable HTTP at /mcp on the port Railway gives (PORT), on every address, with the
# foundation's devnet index as its index. No key is set: forest's CLI refuses to start a hosted copy
# with one, since every caller would act as that person. The hosts it starts from are forest's
# default, the public list in index/lists/hosts.json on this repo's main.
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY FOREST forest.sh ./
RUN ./forest.sh records cli
WORKDIR /services/forest/cli
CMD ["sh", "-c", "exec node src/main.ts mcp --http 0.0.0.0:${PORT:-8080} --index https://index.devnet.forest.foundation"]
