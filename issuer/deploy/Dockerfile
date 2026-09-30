# The issuer (issuer/), started by `npm start` as its README says. The build context is the repo
# root, because the issuer imports registry/client by relative path. deploy/issuer/start.sh runs the
# stand-in Didit first when no Didit key is set.
FROM node:22.22.2-bookworm-slim
WORKDIR /forest
COPY registry/client/ registry/client/
COPY issuer/ issuer/
COPY deploy/issuer/ deploy/issuer/
RUN (cd registry/client && npm ci --no-audit --no-fund) \
  && (cd issuer && npm ci --no-audit --no-fund)
CMD ["bash", "deploy/issuer/start.sh"]
