# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data (eufy session + push registration)
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
#
# eufy-sdk needs Node >= 24.5.0 (the OpenSSL 3.5.1 it bundles decodes the
# end-to-end encrypted camera data): keep the base image on a 24.5+ release.
# -----------------------------------------------------------------------------

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache).
# `npm ci` only, with no `npm install` fallback: a lockfile that no longer
# matches package.json must fail the build, not silently resolve to something
# else. `--ignore-scripts` closes an install-time supply-chain hole (no
# dependency here needs a build step).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The package managers only serve the install above: drop them from the runtime
# image. Less attack surface, and their own bundled dependencies (npm's tar,
# brace-expansion, ...) no longer fail the Trivy scan of code that never runs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

# The only writable location allowed at runtime. Created and handed to `node`
# BEFORE the VOLUME line: a fresh volume copies this ownership, so the
# unprivileged process can write the eufy session there.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production
# Gladys caps the container at 256 MB; without this Node sizes its heap from the
# HOST memory and gets OOM-killed before it ever bothers to collect garbage.
ENV NODE_OPTIONS=--max-old-space-size=192
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
