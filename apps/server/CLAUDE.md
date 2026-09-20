# Vivid application server

The server owns all product logic and persistence. Clients use `VividRpc`; plain HTTP is only for Better Auth, Google OAuth redirects, and Library bytes.

## Layout

- `main.ts`: compose Layers and launch only.
- `config.ts`: Effect Config; secrets stay `Redacted`.
- `database/`, `auth/`, `http/`, `rpc/`, `runtime/`: thin infrastructure adapters.
- Domain directories (`companies/`, `projects/`, `settings/`, `threads/`, `tasks/`, `routines/`, `library/`, `connections/`, `notifications/`) own `tables.ts`, `store.ts`, `handlers.ts`, and behavior tests.

## Dependency rules

- Handlers decode, call services, and encode. No SQL or business rules.
- Stores contain queries and domain rules. No HTTP or RPC types.
- A domain depends on another domain's exported service, never its store internals.
- Shared infrastructure does not import domains, except `database/schema.ts`, the required Drizzle barrel.
- Use `Context.Service`, named `Effect.fn` methods, and flat Layer composition.
- Use Effect Drizzle only: no Promise driver, `async`, or `await` in server domain code.
- Expected failures are typed `Schema.TaggedError`s and map to `RpcFailure` in `rpc/failures.ts`.
- Schedulers are scoped fibers driven by `Clock` and `Schedule`; claim due work transactionally with `FOR UPDATE SKIP LOCKED`.
- Keep filenames one word. Do not add `utils.ts`, `helpers.ts`, or `common.ts`.
