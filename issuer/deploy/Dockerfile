# The issuer (issuer/), started by `npm start` as its README says. The build context is the repo
# root, because the issuer imports forest's registry/client, records and keys by relative path; standard.sh
# fetches them into standard/ at the commit in STANDARD, and needs git. `npm run fetch` puts the face
# models in the image, each checked by SHA-256, so the real checks need only their variables.
# issuer/deploy/start.sh runs the stand-in Didit first when no Didit key is set.
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD standard.sh ./
RUN ./standard.sh registry/client records keys
COPY issuer/ issuer/
RUN cd issuer && npm ci --no-audit --no-fund && npm run fetch -- models
CMD ["bash", "issuer/deploy/start.sh"]
