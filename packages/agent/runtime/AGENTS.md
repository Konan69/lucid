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
- `src/index.ts` — what another package may import by name (`@vivid/agent-runtime`, plus
  `@vivid/agent-runtime/sandbox`, `@vivid/agent-runtime/scope` and `@vivid/agent-runtime/signins`): only the server's and the desktop app's tests read it. Nothing outside this package reaches a file here by path.
- `tests/schema.ts` — a disposable schema on explicit test authority, with a separate surviving cleanup connection, and `testDatabaseConfigured` for gating suites; the runtime never imports the server's test database.
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

`patches/@flue__runtime@2.2.2.patch` holds three independent fixes. When upgrading Flue or
removing any fix, read [Live reply reconciliation](README.md#live-reply-reconciliation).

- **Flush cadence.** The conversation writer's `CANONICAL_FLUSH_DELAY_MS` changes from 1,000
  to 100. Production measured 158 text updates arriving in four lumps on 11 October 2026.
  The lower delay costs about ten durable append batches per second of streaming, instead of one.
  When Flue exposes the delay as a setting, configure it and remove only the writer hunk.
- **Settled replies.** The dispatch projector replaces the response through the SDK's
  `message-appended` upsert before its first resolved settlement. This repairs text parts split
  by interleaved thinking while preserving distinct canonical blocks. Each response is projected
  and sent once, including its tool outputs. Joined deliveries resolve to the host response, so their later
  settlements do not resend it. Untracked steps reconcile at completion because they have no
  settlement or accumulated response. Remove these dispatch hunks only when Flue preserves live
  block identity or reconciles settlement itself, and the runtime transport tests still pass.
- **Cancelled partial replies.** The model recovery loop checks its halt condition before returning
  a completed turn. A provider can close normally after its request was aborted; returning first
  made the coordinator settle that partial reply as completed. Remove this hunk when upstream
  propagates cancellation on that path and the partial-reply abort test still passes.

The dist filenames carry build hashes, so an upgrade fails installation until the patch is
updated. Delete the patch file and its `patchedDependencies` entry only after all three fixes have
upstream replacements.

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
- The default model is `opencode-go/glm-5.3-flash`, served by OpenCode Go
  (`src/providers/opencode.ts`, key `OPENCODE_API_KEY`). The Experiential Labs gateway stays
  declared (`src/providers/explabs.ts`, key `EXPLABS_API_KEY`). `VIVID_MODEL` may select another model that
  file declares. A model is declared there, with its limits, before it is named in `VIVID_MODEL`.
  Do not add a retry, fallback or stream-wrapping layer around the provider: the gateway fails
  over between upstream providers and Flue retries transient errors.
- Pictures currently belong only to private Threads, whose deliveries are ordinary Flue user
  messages. Shared Threads use attributed signals; Flue 2.2.2 accepts and persists attachments
  only on user messages. The gateway refuses shared pictures before reserving a Run. Closing
  this gap requires Flue to support signal attachments through validation, durable storage,
  conversation projection and model input, while preserving signal attribution.

The opt-in rehearsal model uses pi’s faux provider to exercise real Vivid tools and display cards without a model provider key. It reconstructs deterministic scenes from conversation context and reports real tool receipts and failures; it is for product rehearsal and is never a default. Set `VIVID_MODEL=rehearsal/script` before starting the runtime to register it, then send a supported phrase such as “show a table” or “run a program”; an unrecognized message lists all phrases.
