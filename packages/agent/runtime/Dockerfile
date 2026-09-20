FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/agent/runtime/package.json packages/agent/runtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm --filter @vivid/agent-runtime build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5173

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/agent/runtime/package.json packages/agent/runtime/package.json
COPY --from=build /app/packages/agent/runtime/dist packages/agent/runtime/dist

EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5173/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/agent/runtime/dist/server.mjs"]
