# The index (index/): its readers and its pages. The build context is the repo root, because the
# index imports forest's records, registry client, escrow client and reputation client (its
# verification key module; no proving file) by relative path; standard.sh fetches them into
# standard/ at the commit in STANDARD, and needs git. What it reads is its four lists
# in index/lists/, and its opinions are index/config/: both are in the image.
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD standard.sh ./
RUN ./standard.sh records registry/client escrow/client reputation/client
COPY index/ index/
RUN cd index && npm ci --no-audit --no-fund
# Supabase's pooler presents a certificate from Supabase's own root CA, which Node does not carry.
# node-postgres verifies the server fully under sslmode=require, so the root is added here: the
# public "Supabase Root 2021 CA" (supabase-root-2021.crt, as Supabase publishes it; sha256
# 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA).
ENV NODE_EXTRA_CA_CERTS=/services/index/deploy/supabase-root-2021.crt
WORKDIR /services/index
# Readers and pages in one process. Split, the readers run `node src/main.ts readers` and the
# pages `node src/main.ts web`.
CMD ["node", "src/main.ts"]
