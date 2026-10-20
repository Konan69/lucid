# Build from the repository root; workspace symlinks keep their installed layout.
FROM node:24-bookworm-slim AS base
WORKDIR /app
# Keep the pinned pnpm installation readable by the non-root runtime user.
ENV COREPACK_HOME=/opt/corepack
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
# The phone app's Markdown renderer is a packed tarball beside its package.json (`file:deps/...`);
# an install that reads the lockfile needs it there before any of `apps/mobile` is copied.
COPY apps/mobile/deps apps/mobile/deps
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/client/rpc/package.json packages/client/rpc/package.json
COPY packages/computer/state/package.json packages/computer/state/package.json
COPY packages/client/state/package.json packages/client/state/package.json
COPY packages/design/marks/package.json packages/design/marks/package.json
COPY packages/design/tokens/package.json packages/design/tokens/package.json
COPY packages/agent/runtime/package.json packages/agent/runtime/package.json
COPY packages/agent/skills/package.json packages/agent/skills/package.json
COPY patches patches
# Web typechecking imports the desktop bridge types, but needs no Electron binary.
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --filter @vivid/workspace --filter @vivid/server... --filter @vivid/web...
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
COPY apps/desktop/src/shared apps/desktop/src/shared
# Which commit this build is, for Settings and error reports (`@vivid/contracts` build.ts). Railway
# names the commit to a build started by a push; a build it did not start from one is unnamed.
# Declared here, after the slow steps, because its value changes with every commit.
ARG RAILWAY_GIT_COMMIT_SHA=""
RUN VIVID_COMMIT="$RAILWAY_GIT_COMMIT_SHA" pnpm --filter @vivid/web build

# The mobile app's JavaScript, exported as an over-the-air update beside the web build, so every
# deploy carries the app that matches its contracts (`apps/server/src/updates`). A stage of its
# own: React Native's dependencies stay here and only the exported files reach the image below.
FROM build AS updates
ENV CI=1
ENV EXPO_NO_TELEMETRY=1
RUN pnpm install --frozen-lockfile --filter @vivid/mobile...
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
COPY --from=build --chmod=0644 /app/tsconfig.base.json ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/packages packages
COPY --from=build --chown=node:node /app/apps/server apps/server
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --from=updates --chown=node:node /app/apps/mobile/updates apps/mobile/updates
# Preserve the existing ordered migration entry for deployment pre-start jobs.
COPY --chown=node:node scripts/migrate.mjs scripts/migrate.mjs
# The server names the same commit as the page it serves (`apps/server/src/config.ts` `BUILD`),
# under a name the host does not set at run time, so the image's own value is the one read.
ARG RAILWAY_GIT_COMMIT_SHA=""
ENV VIVID_BUILD_COMMIT=$RAILWAY_GIT_COMMIT_SHA
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["pnpm", "--filter", "@vivid/server", "start"]
