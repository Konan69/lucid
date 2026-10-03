# Vivid application server

The server owns all product logic and persistence. Clients use `VividRpc` (`/api/live` over one WebSocket for live queries and writes, `/api/rpc` over HTTP for one-shot callers); plain HTTP is only for Better Auth, the conversation gateway (`/api/vivid/*`), a provider's sign-in return, Routine webhooks, Library bytes, the Computer's screen, and the mobile app's over-the-air updates (`/api/updates/*`).

## Layout

- `main.ts`: compose Layers and launch only.
- `config.ts`: Effect Config; secrets stay `Redacted`.
- `database/`, `auth/`, `http/`, `rpc/`, `runtime/`, `live/`: thin infrastructure adapters. `auth/access.ts` turns a call into an `Actor` and supplies the ownership conditions every query uses; `live/` is the change bus and the live-query helper every `Watch…` handler is built from.
- Domain directories (`companies/`, `projects/`, `settings/`, `threads/`, `routines/`, `library/`, `connections/`, `notifications/`, `approvals/`, `inputs/`, `rules/`, `audit/`, `memory/`, `skills/`, `computers/`, `search/`) own `tables.ts`, `store.ts`, `handlers.ts`, and behavior tests.

## Dependency rules

- Handlers decode, call services, and encode. No SQL or business rules.
- Stores contain queries and domain rules. No HTTP or RPC types.
- A domain depends on another domain's exported service, never its store internals.
- Shared infrastructure does not import domains, except `database/schema.ts` and `database/product.ts` (the Drizzle barrels), and `auth/session.ts`, which asks `threads/access.ts` whether the Person the runtime names may see the Thread it names.
- Every product row has an owner (`database/owner.ts`). Every read and write is scoped with `inWorkspace`/`ownedHere` or `requireThread`; a record outside the Actor's reach is `NotFound`.
- After a write, say whose data moved (`changed(actor)`); a `Watch…` handler is `live(loader)` over the same loader its `List…` handler calls.
- A Run starts only through `Conversation.deliver`. An action Vivid proposes happens only after `Gate.check`.
- Use `Context.Service`, named `Effect.fn` methods, and flat Layer composition.
- Use Effect Drizzle only: no Promise driver, `async`, or `await` in server domain code.
- Expected failures are typed `Schema.TaggedError`s; a handler maps its domain's own errors to an `RpcFailure` member before returning.
- Schedulers are scoped fibers driven by `Clock` and `Schedule`; claim due work transactionally with `FOR UPDATE SKIP LOCKED`.
- Keep filenames one word. Do not add `utils.ts`, `helpers.ts`, or `common.ts`.
