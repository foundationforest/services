# The index (index/): its readers and its pages. The build context is the repo root, because the
# index imports shapes/, registry/client and escrow/client by relative path (index/HOSTING.md);
# the install line is HOSTING.md's. The devnet opinions (which issuer counts, which tokens are money)
# are deploy/index/*.devnet.json, named by the variables below.
FROM node:22.22.2-bookworm-slim
WORKDIR /forest
COPY shapes/ shapes/
COPY registry/client/ registry/client/
COPY escrow/client/ escrow/client/
COPY index/ index/
COPY deploy/index/ deploy/index/
RUN (cd shapes && npm ci --no-audit --no-fund) \
  && (cd registry/client && npm ci --no-audit --no-fund) \
  && (cd escrow/client && npm ci --no-audit --no-fund) \
  && (cd index && npm ci --no-audit --no-fund)
# Supabase's pooler presents a certificate from Supabase's own root CA, which Node does not carry.
# node-postgres verifies the server fully under sslmode=require, so the root is added here: the
# public "Supabase Root 2021 CA" (supabase-root-2021.crt, as Supabase publishes it; sha256
# 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA).
ENV NODE_EXTRA_CA_CERTS=/forest/deploy/index/supabase-root-2021.crt \
    ISSUERS_FILE=/forest/deploy/index/issuers.devnet.json \
    CURRENCIES_FILE=/forest/deploy/index/currencies.devnet.json \
    SCORING_FILE=/forest/deploy/index/scoring.devnet.json
WORKDIR /forest/index
# Readers and pages in one process: the Railway trial allows five services, and this makes five.
# Split, the readers run `node src/main.ts readers` and the pages `node src/main.ts web`.
CMD ["node", "src/main.ts"]
