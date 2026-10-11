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
- `src/db.ts` — Flue's database composition root: configuration and pool construction.
- `src/storage.ts` — pure `flueStorage(pool)`, the production PostgreSQL runner; Flue owns pool close.
- `tests/schema.ts` — a disposable schema on explicit test authority, with a separate surviving cleanup connection.
- `tests/routes.ts` — production Hono/Flue route fixture using public start/stop and a controlled faux provider.
- `tests/setup.ts` — Vitest worker authority, settled before any import because Effect copies the environment once: only the explicit test URL reaches runtime tests and unconfigured workers have no `DATABASE_URL`; no inherited `VIVID_SERVER_URL`; a worker-owned `VIVID_RUNTIME_TOKEN`.
- `src/providers/` — model-provider registration and adapter setup.
- `src/tools/` — model tools. Each is a thin, typed call to `VividRpc` through `asActing`; they do
  not own server stores, schedulers, credentials, or product routes, and they never decide whether
  an action is allowed.

## Commands

- `pnpm exec flue run src/agents/vivid.ts --message "Hi"` — run without HTTP.
- `pnpm dev` — start the Vite/Flue server.
- `pnpm build && pnpm start` — build and run `dist/server.mjs`.
- `pnpm check:types` — typecheck this package.
- `pnpm lint` — run type-aware lint on the whole package, including tests and scripts.
- `pnpm docs` — list the bundled Flue documentation.
- `pnpm exec flue docs search <query>` — search version-matched docs.
- `pnpm exec flue docs read <path>` — read a complete documentation page.

## Patched Flue

`patches/@flue__runtime@2.2.2.patch` changes one constant in Flue's conversation writer
(`src/conversation-writer.ts`, shipped as `dist/sql-agent-execution-store-*.mjs`):
`CANONICAL_FLUSH_DELAY_MS` from 1,000 to 100.

- **Why.** Every word a client sees is first appended to Flue's durable stream, and the writer
  holds streamed text for that long before each append. At one second a reply reached the screen
  in lumps a second apart (measured on production, 11 October 2026: 158 text updates delivered in
  four lumps). Flue 2.2.2 has no setting for it.
- **Cost.** About ten appends a second for each reply being written, where there was one, and so
  ten times the batches in a conversation's stream.
- **Removing it.** When Flue makes the delay a setting, set it there and delete the patch and its
  `patchedDependencies` line. The file name carries a build hash, so a Flue upgrade fails the
  install until the patch is made again or dropped.

## Runtime contract

- The application server is the only caller. It holds the runtime token and forwards a Person's
  message, or delivers a signal, to `/agents/vivid/:threadId` after checking who they are and that
  they may see the Thread. Nothing else reaches Flue.
- Delivery authority arrives as typed server metadata, outside the model-visible message. A signal
  carries a speaker name and turn number; `delivery.ts` caches its acting scope and recovers an
  evicted scope from the persisted Run. A plain user turn happens only in a private Thread, whose
  creator is recorded as initial data. `actingFor` reads prepared authority; tools resolve it
  before calling the server with the Thread and Person, whose access is checked again.
- Product calls use the generated `/api/rpc` contract through `VividRpcClient`.
- The default model is `explabs/glm-5.3-flash`, served by the Experiential Labs gateway
  (`src/providers/explabs.ts`, key `EXPLABS_API_KEY`). `VIVID_MODEL` may select another model that
  file declares. A model is declared there, with its limits, before it is named in `VIVID_MODEL`.
  Do not add a retry, fallback or stream-wrapping layer around the provider: the gateway fails
  over between upstream providers and Flue retries transient errors.
- Pictures currently belong only to private Threads, whose deliveries are ordinary Flue user
  messages. Shared Threads use attributed signals; Flue 2.2.2 accepts and persists attachments
  only on user messages. The gateway refuses shared pictures before reserving a Run. Closing
  this gap requires Flue to support signal attachments through validation, durable storage,
  conversation projection and model input, while preserving signal attribution.

The opt-in rehearsal model uses pi’s faux provider to exercise real Vivid tools and display cards without a model provider key. It reconstructs deterministic scenes from conversation context and reports real tool receipts and failures; it is for product rehearsal and is never a default. Set `VIVID_MODEL=rehearsal/script` before starting the runtime to register it, then send a supported phrase such as “show a table” or “run a program”; an unrecognized message lists all phrases. The date-based reminder scene schedules tomorrow at 09:00 in the context’s timezone using the real one-off Routine tool. It fires once and retains its Occurrence and Thread.
