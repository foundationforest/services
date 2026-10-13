# The issuer (issuer/), started by `npm start` as its README says. The build context is the repo
# root, because the issuer imports the standard's registry/client, records and keys by relative
# path; standard.sh fetches the standard into standard/ at the commit in STANDARD, and needs git.
# `npm run fetch` puts the face models in the image, each checked by SHA-256. It runs the real checks
# only: Didit and the face model, with the variables its README lists, and refuses to start without
# them.
# Node's official image from Google's Docker Hub mirror: Docker Hub's pull limit failed our builds.
FROM mirror.gcr.io/library/node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD standard.sh ./
RUN ./standard.sh registry/client records keys
COPY issuer/ issuer/
RUN cd issuer && npm ci --no-audit --no-fund && npm run fetch -- models
WORKDIR /services/issuer
CMD ["npm", "start"]
