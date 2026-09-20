# Vivid Flue runtime

This package owns Vivid's [Flue](https://flueframework.com) runtime boundary. Flue provides
conversation transport, durable conversation history, the model adapter, and runtime lifecycle.
Product state and persistence remain in `apps/server`; runtime tools call that server through the
schema-derived `VividRpcClient`.

## Layout

- `src/agents/` — Flue `'use agent'` modules and the Vivid model instructions.
- `src/app.ts` — Hono transport routes for health, Flue agent transport, and the one server-only
  `/internal/runs` endpoint.
- `src/client.ts` — Effect Layer configuring the server URL, runtime token, and `VividRpcClient`
  over Node HTTP.
- `src/db.ts` — Flue's PostgreSQL conversation and runtime storage adapter.
- `src/providers/` — model-provider registration and adapter setup.
- `src/tools/` — model tools. They receive Flue-decoded inputs and call product behavior over
  `VividRpcClient`; they do not own server stores, schedulers, credentials, or product routes.

## Commands

- `pnpm exec flue run src/agents/vivid.ts --message "Hi"` — run without HTTP.
- `pnpm dev` — start the Vite/Flue server.
- `pnpm build && pnpm start` — build and run `dist/server.mjs`.
- `pnpm check:types` — typecheck this package.
- `pnpm lint` — run type-aware lint on `src`.
- `pnpm docs` — list the bundled Flue documentation.
- `pnpm exec flue docs search <query>` — search version-matched docs.
- `pnpm exec flue docs read <path>` — read a complete documentation page.

## Runtime contract

- The application server starts work with `POST /internal/runs` and the shared runtime token.
- The runtime validates that request, dispatches one signal into the Flue conversation identified by
  the Thread id, and returns Flue's submission receipt.
- Both `/agents/vivid/*` and `/internal/runs` require the runtime token. The token and server URL
  come from Effect Config; secrets never enter model context.
- Product RPC traffic uses the generated `/api/rpc` contract through `VividRpcClient`.
- The default model is `openrouter/z-ai/glm-5.3-flash`; `VIVID_MODEL` may select another adapter.
