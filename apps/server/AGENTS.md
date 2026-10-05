# Vivid application server

The server owns all product logic and persistence. Clients use `VividRpc` over `/api/live` (WebSocket) or `/api/rpc` (HTTP). Plain HTTP adapters serve Better Auth, the Flue conversation gateway, Integration sign-in returns, Routine webhooks, Library bytes, the Computer screen, the mobile app's over-the-air updates (`updates/`), and health.

## Layout

- `main.ts`: compose Layers and launch only.
- `config.ts`: Effect Config; secrets stay `Redacted`.
- `observability/`: an infrastructure adapter. `export.ts` installs the OTLP trace and log exporters, `failure.ts` records a failure at the boundary that answers it (`observeFailures`), and `refusal.ts` is the one vocabulary and recorder for refusals (`recordRefusal`).
- `database/`, `auth/`, `http/`, `rpc/`, `runtime/`: thin infrastructure adapters.
- Domain directories own product rules, persistence, handlers, and behavior tests. Most persisted domains have `tables.ts`, `store.ts`, and `handlers.ts`; provider and projection domains need only their actual concerns. `people/`, `rooms/`, and `runs/` contain reservation READMEs today.

## Dependency rules

- Handlers decode, call services, and encode. No SQL or business rules.
- Stores contain queries and domain rules. No HTTP or RPC types.
- Code calls service relationships `Connection`; every string a Person reads says **Integration**. Executor owns Integration credentials; memory uses HelixDB and the Computer provider is Boat. All three are required: the server does not start without their settings, and none has a local stand-in.
- A domain depends on another domain's exported service, never its store internals.
- Shared infrastructure does not import domains, except `database/schema.ts`, the required Drizzle barrel.
- Use `Context.Service`, named `Effect.fn` methods, and flat Layer composition.
- Use Effect Drizzle only: no Promise driver, `async`, or `await` in server domain code.
- Expected failures are typed `Schema.TaggedError`s declared in shared contracts; each RPC declares its error schemas in `packages/contracts/src/rpc.ts`. There is no catch-all `RpcFailure` mapper.
- Schedulers are scoped fibers driven by `Clock` and `Schedule`; claim due work transactionally with `FOR UPDATE SKIP LOCKED`.
- Keep filenames one word. Do not add `utils.ts`, `helpers.ts`, or `common.ts`.
