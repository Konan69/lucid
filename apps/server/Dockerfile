# Build from the repository root; workspace symlinks keep their installed layout.
FROM node:24-bookworm-slim AS base
WORKDIR /app
# Keep the pinned pnpm installation readable by the non-root runtime user.
ENV COREPACK_HOME=/opt/corepack
COPY package.json ./
RUN corepack enable && corepack install
# The server publishes the matching Worker in its pre-deploy step with celld. The binary comes from
# celld's published image, pinned by digest (v0.6.2), rather than its curl installer, which fetched an
# unverified release asset from GitHub on every build and failed the 8 Nov 2026 deploy when GitHub's
# release downloads timed out. celld calls Cloudflare over TLS, so the system CA bundle stays.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/denoland/celld:v0.6.2@sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a /usr/local/bin/celld /usr/local/bin/celld
RUN celld --version

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/cells/package.json apps/cells/package.json
COPY apps/mobile/package.json apps/mobile/package.json
# The phone app's Markdown renderer is a packed tarball beside its package.json (`file:deps/...`);
# an install that reads the lockfile needs it there before any of `apps/mobile` is copied.
COPY apps/mobile/deps apps/mobile/deps
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/client/rpc/package.json packages/client/rpc/package.json
COPY packages/client/state/package.json packages/client/state/package.json
COPY packages/design/marks/package.json packages/design/marks/package.json
COPY packages/design/tokens/package.json packages/design/tokens/package.json
COPY packages/agent/runtime/package.json packages/agent/runtime/package.json
COPY packages/agent/skills/package.json packages/agent/skills/package.json
COPY patches patches
COPY packages/compiler packages/compiler
# Web typechecking imports the desktop bridge types, but needs no Electron binary.
# The cells closure includes the runtime and esbuild needed to publish the Worker.
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --filter @vivid/workspace --filter @vivid/server... --filter @vivid/cells... --filter @vivid/web...
# Shared phone packages extend the root Hermes profile; Vite and tsx resolve it too.
COPY tsconfig.base.json tsconfig.hermes.json hermes.d.ts ./
COPY packages packages
COPY apps/server apps/server
COPY apps/cells apps/cells
COPY apps/web apps/web
COPY apps/desktop/src/shared apps/desktop/src/shared
# Which commit this build is, for Settings and error reports (`@vivid/contracts` build.ts). Railway
# names the commit to a build started by a push; a build it did not start from one is unnamed.
# Declared here, after the slow steps, because its value changes with every commit.
ARG RAILWAY_GIT_COMMIT_SHA=""
RUN VIVID_COMMIT="$RAILWAY_GIT_COMMIT_SHA" pnpm --filter @vivid/web build
# Stamp Sentry debug IDs into the web bundles and their maps here, at build time: the pre-deploy
# step uploads these maps (`infra/predeploy.mjs`), but anything it writes is gone when it ends, and
# the bundles this image serves must carry the same IDs as the maps it uploads. Needs no token.
RUN node_modules/.bin/sentry-cli sourcemaps inject --ext js --ext mjs --ext map apps/web/dist

# The mobile app's JavaScript, exported as an over-the-air update beside the web build, so every
# deploy carries the app that matches its contracts (`apps/server/src/updates`). A stage of its
# own: React Native's dependencies stay here and only the exported files reach the image below.
FROM build AS updates
ENV CI=1
ENV EXPO_NO_TELEMETRY=1
# `--ignore-scripts`: an export needs only JavaScript, and the Markdown renderer's install step
# downloads its syntax grammars and maths renderer (about 170 MB) for native builds alone.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @vivid/mobile...
COPY apps/mobile apps/mobile
COPY scripts/sentry-upload.mjs scripts/sentry-upload.mjs
RUN pnpm --filter @vivid/mobile run updates /app/apps/mobile/updates

FROM base AS production
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV VIVID_WEB_DIST=/app/apps/web/dist
ENV VIVID_MOBILE_UPDATES=/app/apps/mobile/updates
# pnpm/bin/pnpm.mjs:nativeBinary downloads beside its Corepack wrapper on first use.
# Carry the warmed cache so the non-root entry needs no download or write to that directory.
COPY --from=build --chown=node:node /opt/corepack /opt/corepack
# Retain pnpm's virtual store and package-local symlinks, including tsx and contract sources.
COPY --from=build --chmod=0644 /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chmod=0644 /app/tsconfig.base.json /app/tsconfig.hermes.json /app/hermes.d.ts ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/packages packages
COPY --from=build --chown=node:node /app/apps/server apps/server
COPY --from=build --chown=node:node /app/apps/cells apps/cells
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --from=updates --chown=node:node /app/apps/mobile/updates apps/mobile/updates
# Preserve the existing ordered migration entry for deployment pre-start jobs.
COPY --chown=node:node scripts/migrate.mjs scripts/migrate.mjs
COPY --chown=node:node scripts/sentry-upload.mjs scripts/sentry-upload.mjs
COPY --chown=node:node infra/cli.mjs infra/cli.mjs
# The pre-deploy program (`preDeploy.command` in `infra/railway.ts`) and the fleet pointer reader.
COPY --chown=node:node infra/predeploy.mjs infra/predeploy.mjs
COPY --chown=node:node infra/pointer.mjs infra/pointer.mjs
# The server names the same commit as the page it serves (`apps/server/src/config.ts` `BUILD`),
# under a name the host does not set at run time, so the image's own value is the one read.
ARG RAILWAY_GIT_COMMIT_SHA=""
ENV VIVID_BUILD_COMMIT=$RAILWAY_GIT_COMMIT_SHA
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["env", "-u", "SENTRY_AUTH_TOKEN", "pnpm", "--filter", "@vivid/server", "start"]
