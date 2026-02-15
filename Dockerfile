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

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Reduce final image size: drop devDependencies and caches after building.
# The runtime uses dist/ + production dependencies only.
RUN pnpm prune --prod && \
    pnpm store prune || true
RUN rm -rf /root/.cache /root/.npm /root/.local/share/pnpm/store /root/.pnpm-store /ms-playwright || true

ENV NODE_ENV=production

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Start gateway server (optionally bootstrapping config for VPS/PaaS platforms).
#
# The bootstrap script is idempotent and only writes a minimal, secure baseline
# config when needed (and can enforce model defaults). It does not print secrets.
CMD ["bash", "-lc", "node ops/railway/bootstrap-config.mjs || true; node openclaw.mjs gateway --allow-unconfigured"]
