FROM node:22-bookworm

RUN corepack enable

WORKDIR /app

# Avoid downloading large test browser bundles during image builds.
# (The Control UI has Playwright as a devDependency; browsers are not needed at runtime.)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Avoid a late `chown -R` over a huge tree (expensive and increases layer size).
# Make /app owned by the `node` user early, then copy files with --chown.
RUN chown -R node:node /app
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Reduce final image size: drop devDependencies and caches after building.
# The runtime uses dist/ + production dependencies only.
RUN CI=true pnpm prune --prod
RUN pnpm store prune || true
RUN rm -rf /home/node/.cache /home/node/.npm /home/node/.local/share/pnpm/store /home/node/.pnpm-store /ms-playwright || true

ENV NODE_ENV=production

USER root

# Start gateway server (optionally bootstrapping config for VPS/PaaS platforms).
#
# The bootstrap script is idempotent and only writes a minimal, secure baseline
# config when needed (and can enforce model defaults). It does not print secrets.
#
# Railway volumes at /data can be root-owned on first boot. We fix perms as root,
# then drop privileges for the actual Gateway process.
CMD ["bash", "-lc", "set -euo pipefail; if [ -d /data ]; then mkdir -p /data/.openclaw /data/workspace; chown -R node:node /data/.openclaw /data/workspace || true; fi; exec su -p -s /bin/bash node -c \"node ops/railway/bootstrap-config.mjs || true; node openclaw.mjs gateway --allow-unconfigured\""]
