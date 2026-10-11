# The issuer (issuer/), started by `npm start` as its README says. The build context is the repo
# root, because the issuer imports forest's registry/client, records and keys by relative path, and the credits/ next to
# it; standard.sh fetches forest's into standard/ at the commit in STANDARD, and needs git. `npm run fetch` puts the face
# models in the image, each checked by SHA-256, so the real checks need only their variables.
# issuer/deploy/start.sh runs the stand-in Didit first when no Didit key is set.
# Node's official image from Google's Docker Hub mirror: Docker Hub's pull limit failed our builds.
FROM mirror.gcr.io/library/node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD standard.sh ./
RUN ./standard.sh registry/client records keys
COPY credits/ credits/
RUN cd credits && npm ci --no-audit --no-fund
COPY issuer/ issuer/
RUN cd issuer && npm ci --no-audit --no-fund && npm run fetch -- models
CMD ["bash", "issuer/deploy/start.sh"]
