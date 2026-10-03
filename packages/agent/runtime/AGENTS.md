# Vivid Flue runtime

This package owns Vivid's [Flue](https://flueframework.com) runtime boundary. Flue provides
conversation transport, durable conversation history, the model adapter, and runtime lifecycle.
Product state and persistence remain in `apps/server`; runtime tools call that server through the
schema-derived `VividRpcClient`.

## Layout

- `src/agents/` — Flue `'use agent'` modules and Vivid's instructions.
- `src/app.ts` — Hono transport: health, and the Flue routes behind the runtime token. It loads the
  acting Person's context before Flue renders a response.
- `src/client.ts` — who Vivid is acting for (`Acting`, `actingFor`) and the product client that
  makes every call as that Person (`asActing`).
- `src/context.ts` — what Vivid is told at the start of a response: the Person's memory brief, the
  skills it can use, their time zone.
- `src/db.ts` — Flue's PostgreSQL conversation and runtime storage adapter.
- `src/providers/` — model-provider registration and adapter setup.
- `src/tools/` — model tools. Each is a thin, typed call to `VividRpc` through `asActing`; they do
  not own server stores, schedulers, credentials, or product routes, and they never decide whether
  an action is allowed.

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

- The application server is the only caller. It holds the runtime token and forwards a Person's
  message, or delivers a signal, to `/agents/vivid/:threadId` after checking who they are and that
  they may see the Thread. Nothing else reaches Flue.
- Every delivery says who it is for: a signal carries `person` and `from` attributes; a plain user
  turn happens only in a private Thread, whose creator is recorded as the conversation's initial
  data. `actingFor` reads exactly that, and every tool call carries the Thread and the Person to
  the server, which checks them again.
- Product calls use the generated `/api/rpc` contract through `VividRpcClient`.
- The default model is `openrouter/z-ai/glm-5.3-flash`; `VIVID_MODEL` may select another.
- Pictures currently belong only to private Threads, whose deliveries are ordinary Flue user
  messages. Shared Threads use attributed signals; Flue 2.1.0 accepts and persists attachments
  only on user messages. The gateway refuses shared pictures before reserving a Run. Closing
  this gap requires Flue to support signal attachments through validation, durable storage,
  conversation projection and model input, while preserving signal attribution.

The opt-in rehearsal model uses pi’s faux provider to exercise real Vivid tools and display cards without a model provider key. It reconstructs deterministic scenes from conversation context and reports real tool receipts and failures; it is for product rehearsal and is never a default. Set `VIVID_MODEL=rehearsal/script` before starting the runtime to register it, then send a supported phrase such as “show a table” or “run a program”; an unrecognized message lists all phrases. The date-based reminder scene schedules tomorrow at 09:00 in the context’s timezone using the real cron Routine tool, so that schedule repeats yearly until removed.
