# The place lookup (places/): its file built inside the image, so the image holds everything it
# serves and there is no volume. The build context is the repo root, as for every image here, though
# places uses neither the standard nor the markets. `npm run build` downloads GeoNames' files and
# Correos de México's postal areas at their pinned commit, about 340 MB, and checks the file before
# it keeps it: a build whose checks fail fails the image. It serves on PORT, on every address.
# Node's official image from Google's Docker Hub mirror: Docker Hub's pull limit failed our builds.
FROM mirror.gcr.io/library/node:22.22.2-bookworm-slim
WORKDIR /services/places
COPY places/package.json places/package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev
COPY places/src src
COPY places/scripts scripts
RUN node --disable-warning=ExperimentalWarning scripts/build.ts
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
