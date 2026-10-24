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
COPY packages/client/state/package.json packages/client/state/package.json
COPY packages/design/marks/package.json packages/design/marks/package.json
COPY packages/design/tokens/package.json packages/design/tokens/package.json
COPY packages/agent/runtime/package.json packages/agent/runtime/package.json
COPY packages/agent/skills/package.json packages/agent/skills/package.json
COPY patches patches
COPY packages/compiler packages/compiler
RUN pnpm install --frozen-lockfile --filter @vivid/workspace --filter @vivid/agent-runtime...
# Vite follows shared packages' root Hermes profile while bundling their source.
COPY tsconfig.base.json tsconfig.hermes.json hermes.d.ts ./
COPY packages packages
# Gate and image use the same workspace bundling and bare-Node output checks.
RUN pnpm --filter @vivid/agent-runtime build

FROM base AS production
ENV NODE_ENV=production
ENV PORT=5173
COPY --from=build --chown=node:node /opt/corepack /opt/corepack
COPY --from=build --chmod=0644 /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules node_modules
# Includes runtime node_modules and every workspace dependency its symlinks point to.
COPY --from=build --chown=node:node /app/packages packages
USER node
EXPOSE 5173
# Docker's named health settings apply only to observations, never the lifetime of a Run.
# --interval=30s paces local /health observations. Source: unmeasured.
# --timeout=5s bounds one unresponsive local probe; expiry records a failed probe. Source: unmeasured.
# --start-period=20s ignores failures while Node starts. Source: unmeasured.
# --retries=3 marks the container unhealthy after consecutive failures. Source: unmeasured.
# Docker requires literal durations in these instruction options; they cannot reference ENV/ARG.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "packages/agent/runtime/dist/server.mjs"]
