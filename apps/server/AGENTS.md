# Vivid application server

The server owns all product logic and persistence. Clients use `VividRpc` over `/api/live` (WebSocket) or `/api/rpc` (HTTP). Plain HTTP adapters serve Better Auth, the conversation gateway, Integration sign-in returns, Library bytes, the Computer screen, the mobile app's over-the-air updates (`updates/`), and health.

## Layout

- `main.ts`: compose Layers and launch only.
- `config.ts`: Effect Config; secrets stay `Redacted`.
- `observability/`: an infrastructure adapter. `export.ts` installs the OTLP trace and log exporters, `failure.ts` records a failure at the boundary that answers it (`observeFailures`), and `refusal.ts` is the one vocabulary and recorder for refusals (`recordRefusal`).
- `database/`, `auth/`, `http/`, `rpc/`, `runtime/`, `live/`: thin infrastructure adapters. `auth/access.ts` turns a call into an `Actor` and supplies the ownership conditions every query uses; `live/` is the change bus and the live-query helper every `Watch…` handler is built from.
- Domain directories own product rules, persistence, handlers, and behavior tests. Most persisted domains have `tables.ts`, `store.ts`, and `handlers.ts`; provider and projection domains need only their actual concerns. `people/`, `rooms/`, and `runs/` contain reservation READMEs today.

## Dependency rules

- Handlers decode, call services, and encode. No SQL or business rules.
- Stores contain queries and domain rules. No HTTP or RPC types.
- Code calls service relationships `Connection`; every string a Person reads says **Integration**. Executor owns Integration credentials; memory uses HelixDB and the Computer provider is Boat. All three are required: the server does not start without their settings, and none has a local stand-in.
- A domain depends on another domain's exported service, never its store internals.
- Shared infrastructure does not import domains, except `database/schema.ts` and `database/product.ts` (the Drizzle barrels), and `auth/session.ts`, which asks `threads/access.ts` whether the Person the runtime names may see the Thread it names.
- Every product row has an owner (`database/owner.ts`). Every read and write is scoped with `inWorkspace`/`ownedHere` or `requireThread`; a record outside the Actor's reach is `NotFound`.
- After a write, say whose data moved (`changed(actor)`); a `Watch…` handler is `live(loader)` over the same loader its `List…` handler calls.
- A Run starts only through `Conversation` (`deliver`, or `admit` for a Person's message through the gateway), both of which reserve it with `Runs.start`. An action Vivid proposes happens only after `Gate.check`. The one exception is Vivid's own shell and files on its Computer (`ComputerShell`, `ComputerFileRead`, `ComputerFileWrite`): the Person decided on 5 October 2026 that nothing on Vivid's Computer is asked about or banned once it is allowed.
- Use `Context.Service`, named `Effect.fn` methods, and flat Layer composition.
- Use Effect Drizzle only: no Promise driver, `async`, or `await` in server domain code.
- Expected failures are typed `Schema.TaggedError`s declared in shared contracts. Each RPC in `packages/contracts/src/rpc.ts` declares its error schema: the shared `RpcFailure` union, plus that call's own refusals where it has them (`AcceptInvitation` adds `MailboxUnconfirmed`). A handler maps its domain's errors to a declared member before returning; clients branch on `_tag`, never on a message.
- Schedulers are scoped fibers driven by `Clock` and `Schedule`; claim due work transactionally with `FOR UPDATE SKIP LOCKED`.
- Keep filenames one word. Do not add `utils.ts`, `helpers.ts`, or `common.ts`.
