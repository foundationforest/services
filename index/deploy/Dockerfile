# The index (index/), started by `npm start` as its README says. The build context is the repo root:
# the index depends on the standard's packages through file: links into standard/, and reads the
# markets from markets/; standard.sh fetches both at the commits in STANDARD and MARKETS, installs and
# builds the standard, and needs git. The lists and the config are in the image; its seed and its
# one file are on the volume at DATA_DIR. One replica: the file is SQLite.
# Node's official image from Google's Docker Hub mirror: Docker Hub's pull limit failed our builds.
FROM mirror.gcr.io/library/node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /services
COPY STANDARD MARKETS standard.sh ./
RUN ./standard.sh
COPY index/ index/
RUN cd index && npm ci --no-audit --no-fund
WORKDIR /services/index
CMD ["npm", "start"]
