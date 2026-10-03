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
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/client/rpc/package.json packages/client/rpc/package.json
COPY packages/computer/state/package.json packages/computer/state/package.json
COPY packages/client/state/package.json packages/client/state/package.json
COPY packages/design/marks/package.json packages/design/marks/package.json
COPY packages/design/tokens/package.json packages/design/tokens/package.json
COPY packages/agent/runtime/package.json packages/agent/runtime/package.json
COPY patches patches
RUN pnpm install --frozen-lockfile --filter @vivid/workspace --filter @vivid/agent-runtime...
COPY tsconfig.base.json ./
COPY packages packages
# @flue/vite/dist/index.mjs:flue uses getUserExternals from
# dist/markdown-import-plugin-D-fQ3auE.mjs to externalize direct workspace dependencies.
# Their TypeScript exports contain .js specifiers that plain Node cannot resolve to .ts files.
# vite/dist/node/index.d.ts:Plugin.config permits this public post-config mutation; bundle only
# Vivid workspace sources for the image, retaining Flue's external third-party dependencies.
RUN pnpm --filter @vivid/agent-runtime exec node --input-type=module <<'JS'
import { build } from 'vite'

await build({
  plugins: [{
    name: 'vivid-workspace',
    enforce: 'post',
    config(config) {
      const options = config.build.rolldownOptions
      options.external = options.external.filter((name) => !name.startsWith('@vivid/'))
      return { ssr: { noExternal: [/^@vivid\//] } }
    },
  }],
})
JS

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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "packages/agent/runtime/dist/server.mjs"]
