# Backend stack reference: Effect 4 + Better Auth + Drizzle + Alchemy

2026-10-03: Historical versioned research; `pnpm-workspace.yaml`, separate server auth/product migration chains, and `VividRpc` supersede the pin and API recommendations here; current implementation is documented in the server README, [Infrastructure](19-infrastructure.md), and [docs/14](14-product-feature-set-and-grok-bot-parity.md).

**Audit basis:** installed packages and source under `~/agency/vivid`, the local Effect checkout, `effect-solutions list/show`, and the linked published documentation. This is a versioned research snapshot, not an implementation. Every source below was checked without installing or changing dependencies.

## Decisions for the implementation lane

1. **Use one `@effect/sql-pg` `PgClient` layer as the application PostgreSQL connection owner, and use Drizzle's Effect driver on top of it.** Do **not** pass that Effect-native Drizzle database to Better Auth's `Drizzle` layer: Better Auth's adapter awaits promise-returning Drizzle builders, while `effect-postgres` returns Effects. Use the Alchemy Better Auth `Postgres` layer for the auth boundary unless we build a custom adapter; this is a deliberate two-adapter trade-off, not a claim that the pools are shared. Sources: `~/agency/vivid/apps/server/node_modules/@effect/sql-pg/src/PgClient.ts:79-149,275-344,790-829`; `~/agency/vivid/apps/server/node_modules/drizzle-orm/effect-postgres/driver.d.ts:13-52`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Drizzle.ts:33-80`; `~/agency/vivid/apps/server/node_modules/@better-auth/drizzle-adapter/dist/index.mjs:78-107`.
2. **Use `HttpApi` for the typed application HTTP API, and mount Better Auth as a raw route.** Better Auth's routes are not an `HttpApi` contract. Its Alchemy bridge is an Effect `HttpEffect`, so the bridge belongs at the router boundary. Sources: `~/agency/vivid/apps/server/node_modules/effect/src/unstable/httpapi/HttpApiBuilder.ts:63-179`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/BetterAuth.ts:81-142,145-263`.
3. **Browser: cookies. Native clients: bearer tokens in secure platform storage.** Use device authorization only when the client needs a browser-mediated login with no reliable callback listener (CLI/Electron bootstrap), not as the normal browser session mechanism. Sources: [Better Auth session management](https://better-auth.com/docs/concepts/session-management), [cookies](https://better-auth.com/docs/concepts/cookies), [bearer](https://better-auth.com/docs/plugins/bearer), [device authorization](https://better-auth.com/docs/plugins/device-authorization).
4. **Let Drizzle Kit own the combined application + Better Auth schema migration.** Set Alchemy Better Auth `migrate: false` when using its `Drizzle` layer; the installed Alchemy source says that layer has no automatic migration support. Sources: `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Drizzle.ts:33-57`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Database.ts:51-86`; [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle).

## Version and disk audit

| Package                    |               Target |    Installed on disk | Result                                                                                                                                  |
| -------------------------- | -------------------: | -------------------: | --------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                   |       `4.0.0-rc.112` |       `4.0.0-rc.112` | exact; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/package.json:1-5`                                     |
| `@effect/sql-pg`           |       `4.0.0-rc.112` |       `4.0.0-rc.112` | exact; `~/agency/vivid/node_modules/.pnpm/@effect+sql-pg@4.0.0-rc.112_effect@4.0.0-rc.112/node_modules/@effect/sql-pg/package.json:1-5` |
| `@effect/platform-node`    |       `4.0.0-rc.112` |       `4.0.0-rc.112` | exact; Node `>=18.0.0`; `~/agency/vivid/apps/server/node_modules/@effect/platform-node/package.json:1-5,28-32`                          |
| `drizzle-orm`              | `1.0.0-rc.5-ab785fc` | `1.0.0-rc.5-ab785fc` | exact; `~/agency/vivid/apps/server/node_modules/drizzle-orm/package.json:1-6`                                                           |
| `drizzle-kit`              | `1.0.0-rc.5-ab785fc` | `1.0.0-rc.5-ab785fc` | exact; `~/agency/vivid/apps/server/node_modules/drizzle-kit/package.json:1-4`                                                           |
| `better-auth`              |              `1.7.3` |              `1.7.3` | exact, ESM; `~/agency/vivid/apps/server/node_modules/better-auth/package.json:1-8`                                                      |
| `alchemy`                  |      `2.0.0-beta.76` |      `2.0.0-beta.76` | exact, ESM; `~/agency/vivid/apps/server/node_modules/alchemy/package.json:1-4`                                                          |
| `@alchemy.run/better-auth` |      `2.0.0-beta.76` |      `2.0.0-beta.76` | exact, ESM; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/package.json:1-4`                                         |

The `apps/server` importer in the lockfile propagates these exact pins, including the mandatory Drizzle rc.5 hash pin: `~/agency/vivid/pnpm-lock.yaml:126-167`. The package manifest and lockfile were already modified in the working tree before this audit; they were not changed here.

### Published/on-disk discrepancies that matter

- The checked-out `~/effect-smol` is **Effect `4.0.0-beta.84`**, not rc.112: `~/effect-smol/packages/effect/package.json:1-5`. Its Schema and migration docs still say `TaggedErrorClass` (`~/effect-smol/packages/effect/src/Schema.ts:12437-12633`; `~/effect-smol/migration/schema.md:28-34`). The installed rc.112 source exports `Schema.TaggedError` at line 15207 and has zero `TaggedErrorClass` occurrences: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/Schema.ts:15192-15217`. **Do not use the checkout's old name.**
- `effect-solutions show error-handling` also emitted examples using `Schema.TaggedErrorClass`; the installed rc.112 `AGENTS.md` and `ai-docs` use `Schema.TaggedError`: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/AGENTS.md` and `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/ai-docs/src/01_effect/04_errors/01_error-handling.ts:1-25`. Treat the CLI guidance as stale for this rc.
- The installed Alchemy Better Auth README says “every SQL layer” migrates automatically, but its `Drizzle` implementation has no `migrate` member and explicitly says schema management is external: `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/README.md:263-275`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Drizzle.ts:33-57`. The specific Drizzle exception wins.
- Better Auth's current adapter docs say `pnpm dlx auth@latest generate`, while the installed Alchemy wrapper comments say `pnpm dlx @better-auth/cli generate`: [adapter docs](https://better-auth.com/docs/adapters/drizzle); `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Drizzle.ts:13-18`. No Better Auth CLI package is a direct server dependency here. **Verify the chosen CLI in the implementation lane; this document does not claim the two commands are interchangeable.**

## Effect 4 HTTP

### Import surface

The real rc.112 exports are:

```ts
import { Effect, Layer, Schema } from 'effect'
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
  HttpApiTest,
  OpenApi,
} from 'effect/unstable/httpapi'
import {
  FetchHttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
```

The barrel exports the requested HTTP API modules at `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/index.ts:10-70`; the portable HTTP barrel is at `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/http/index.ts:10-150`. There is no installed `@effect/platform` package; these portable modules live in `effect/unstable/httpapi` and `effect/unstable/http`. The Node implementation is separate `@effect/platform-node`: `~/agency/vivid/apps/server/node_modules/@effect/platform-node/src/index.ts:45-90`.

### Contract, handlers, OpenAPI, and a Fetch handler

`HttpApi.make` creates an API; `HttpApiGroup.make(...).add(...)` adds endpoints; endpoint constructors take an identifier, route path, and schema options; `HttpApiBuilder.group` supplies handlers; `HttpApiBuilder.layer` registers the completed API with an `HttpRouter`. Automatic codecs turn path/query/header fields into string-tree codecs and JSON bodies into JSON codecs unless `disableCodecs` is set: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiEndpoint.ts:888-979,1040-1130`; builder wiring: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiBuilder.ts:63-179`.

```ts
const User = Schema.Struct({ id: Schema.String, email: Schema.String })

const Api = HttpApi.make('vivid').add(
  HttpApiGroup.make('users').add(HttpApiEndpoint.get('me', '/me', { success: User })),
)

const UsersLive = HttpApiBuilder.group(Api, 'users', (handlers) =>
  handlers.handle('me', () => Effect.succeed({ id: 'u_1', email: 'a@example.com' })),
)

const Routes = HttpApiBuilder.layer(Api, { openapiPath: '/openapi.json' }).pipe(
  Layer.provide(UsersLive),
)

const { handler, dispose } = HttpRouter.toWebHandler(
  Routes.pipe(Layer.provide(HttpServer.layerServices)),
)
```

`HttpRouter.toWebHandler` returns `{ handler, dispose }` and converts Web `Request` to Web `Response`: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/http/HttpRouter.ts:1335-1400`. For a real Node listener, use `HttpRouter.serve(Routes)` and `NodeHttpServer.layer(createServer, { port })`, then `Layer.launch(...).pipe(NodeRuntime.runMain)`, as the installed rc.112 example does: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/ai-docs/src/51_http-server/10_basics.ts:1-58`.

`OpenApi.fromApi(Api)` creates the OpenAPI document. `HttpApiScalar.layer` or `HttpApiSwagger.layer` serves a UI; the builder's `openapiPath` serves JSON: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/OpenApi.ts:282-300`; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiBuilder.ts:63-120`.

### Raw Better Auth mounting

Better Auth is framework-agnostic and consumes standard Web `Request`/`Response` objects: [installation → mount handler](https://better-auth.com/docs/installation#mount-handler). The Alchemy wrapper converts the ambient Effect `HttpServerRequest` to a Web request, invokes `auth.handler`, and converts the result back to `HttpServerResponse`: `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/BetterAuth.ts:205-263`.

The smallest correct composition-root shape is therefore:

```ts
const App = Effect.gen(function* () {
  const auth = yield* BetterAuth({
    basePath: '/api/auth',
    emailAndPassword: { enabled: true },
  })

  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.url.startsWith('/api/auth')) return yield* auth.fetch
      return yield* HttpServerResponse.json({ ok: true })
    }),
  }
}).pipe(Effect.provide(AuthDatabaseLayer))
```

That is a raw catch-all Fetch handler, not a typed `HttpApi` endpoint. If using the router directly, a `HttpRouter.route("*", "/api/auth/*", auth.fetch)` route is the boundary; keep it before any catch-all route. `HttpRouter.route` accepts an effect or request-to-effect handler: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/http/HttpRouter.ts:671-701`.

### Auth middleware and security

Security declarations do not authenticate by themselves. `HttpApiSecurity.bearer`, `http`, `apiKey({ in: "header" | "query" | "cookie" })`, and `basic` describe credential extraction and OpenAPI; `HttpApiMiddleware.Service` supplies the implementation. Sources: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiSecurity.ts:17-205`; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiMiddleware.ts:55-131,272-380`.

```ts
class CurrentUser extends Context.Service<CurrentUser, { id: string }>()('vivid/CurrentUser') {}
class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {}) {}

class Auth extends HttpApiMiddleware.Service<Auth, { provides: CurrentUser }>()('vivid/Auth', {
  error: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

const AuthLive = Layer.succeed(Auth, {
  bearer: (effect, { credential }) =>
    Effect.provideService(
      effect,
      CurrentUser,
      { id: Redacted.value(credential) }, // replace with Better Auth lookup
    ),
})

const ProtectedApi = Api.middleware(Auth)
```

For a generated client, the client-side middleware receives `{ request, next }`; add a token with `HttpClientRequest.bearerToken`. `HttpApiMiddleware.layerClient` is the current client bridge: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiMiddleware.ts:504-538`; installed example: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/ai-docs/src/51_http-server/10_basics.ts:70-104`.

### Typed configuration

Use `Config.schema` with an Effect `Schema`, not ad-hoc `process.env` parsing. It validates and infers the value; use `Config.redacted`/`Schema.Redacted` for secrets. Sources: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/Config.ts:1103-1188,1446-1502,1788-1826`; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/ai-docs/src/01_effect/03_services/20_layer-composition.ts:1-80`.

```ts
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))

const ServerConfig = Config.schema(
  Schema.Struct({ port: Port, databaseUrl: Schema.Redacted(Schema.String) }),
  'VIVID',
)
```

A provider can be replaced in tests with `ConfigProvider.layer(...)` / a supplied `ConfigProvider` service; the v4 service is explicitly replaceable in the installed source: `~/agency/vivid/apps/server/node_modules/effect/src/ConfigProvider.ts:269-342`. The installed Effect Solutions `config` guide demonstrates the same pattern. Do not expose raw database URLs in logs.

### `HttpApiClient` and `HttpApiTest`

`HttpApiClient.make(Api, { baseUrl, transformClient })` creates a typed client. `FetchHttpClient.layer` supplies the portable transport; `transformClient` is the place for URL rewriting, retry, and client middleware. Response modes are `decoded-only`, `decoded-and-response`, and `response-only`: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiClient.ts:228-327`; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiEndpoint.ts:494-528`.

`HttpApiTest.groups(Api, ["users"])` creates an in-memory typed client with the same routing, request encoding, response encoding, and decoding path but no server or database: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/httpapi/HttpApiTest.ts:1-109`; complete installed example: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/ai-docs/src/51_http-server/20_testing.ts:1-104`.

## Effect 4 RPC and sockets

### Current imports and model

```ts
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as RpcMiddleware from 'effect/unstable/rpc/RpcMiddleware'
import * as RpcSchema from 'effect/unstable/rpc/RpcSchema'
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'
import * as Socket from 'effect/unstable/socket/Socket'
import * as SocketServer from 'effect/unstable/socket/SocketServer'
```

The rc.112 barrels export these modules: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/rpc/index.ts:10-65`; sockets: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/socket/index.ts:10-15`.

`Rpc.make(tag, { payload, success, error, stream })` creates a typed procedure. `stream: true` wraps success/error in `RpcSchema.Stream`; `RpcGroup.make(...)` groups definitions and `.toLayer(...)` implements handlers: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/rpc/Rpc.ts:72-186,902-966`; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/rpc/RpcGroup.ts:35-145,402-416`.

### Streaming RPC over HTTP

```ts
const User = Schema.Struct({ id: Schema.String, name: Schema.String })
const StreamUsers = Rpc.make('StreamUsers', {
  payload: { id: Schema.String },
  success: User,
  stream: true,
})
const Users = RpcGroup.make(StreamUsers)

const UsersLive = Users.toLayer({
  StreamUsers: ({ id }) =>
    Stream.fromIterable([
      { id, name: 'first' },
      { id, name: 'second' },
    ]),
})

const RpcRoutes = RpcServer.layerHttp({
  group: Users,
  path: '/rpc',
  protocol: 'http', // default is websocket
  streamBufferSize: 16,
}).pipe(Layer.provide(UsersLive), Layer.provide(RpcSerialization.layerNdjson))
```

`RpcServer.layerHttp` defaults to WebSocket and accepts `protocol: "http"`; the HTTP protocol streams encoded responses through `HttpServerResponse.stream`. `RpcSerialization.layerNdjson` gives framed newline-delimited JSON; `layerMsgPack` is the binary alternative: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/rpc/RpcServer.ts:802-840,977-1000,1100-1190`; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/rpc/RpcSerialization.ts:55-197,645-726`.

The client counterpart is a layer around `RpcClient.make(Users)`, `RpcClient.layerProtocolHttp({ url })`, a serialization layer, and `FetchHttpClient.layer`. The generated stream method returns an Effect `Stream`, not an eagerly collected array: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/rpc/RpcClient.ts:64-221,631-706,901-1030`.

### RPC middleware

`RpcMiddleware.Service` can declare provided services, typed errors, and `requiredForClient`; `.middleware(...)` adds it to one RPC or a group, and `RpcMiddleware.layerClient(...)` supplies the client implementation: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/rpc/RpcMiddleware.ts:47-170,258-350`. This is the RPC equivalent of the HTTP API auth middleware, but it does not automatically know Better Auth sessions; bridge that lookup explicitly.

### Socket transport

`Socket.Socket` is a context service with raw/binary/string run methods and channel adapters; `SocketServer.SocketServer` accepts sockets and runs a handler: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/socket/Socket.ts:57-125,386-532`; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/socket/SocketServer.ts:24-29,119-160`. For WebSockets, use `Socket.makeWebSocket`/`layerWebSocket` on the client and `RpcServer.layerProtocolWebsocket` or `layerProtocolSocketServer` on the server: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/socket/Socket.ts:558-805`; `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/rpc/RpcServer.ts:883-977`.

## PostgreSQL: Effect SQL versus Drizzle

### `@effect/sql-pg@4.0.0-rc.112`

`PgClient` is an Effect service extending `SqlClient`. It provides tagged-template SQL, JSON fragments, `listen`, and `notify`. `PgClient.make` creates a scoped managed `pg.Pool`; `layer`, `layerConfig`, and `layerFrom` provide both `PgClient` and `SqlClient`: `~/agency/vivid/node_modules/.pnpm/@effect+sql-pg@4.0.0-rc.112_effect@4.0.0-rc.112/node_modules/@effect/sql-pg/src/PgClient.ts:63-149,275-344,790-829`.

`SqlClient.withTransaction(effect)` reserves a transaction connection, issues begin/commit/rollback/savepoint commands, and returns typed `SqlError` failures. The SQL client also exposes `reserve`, reactive queries, and `transactionService`: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/unstable/sql/SqlClient.ts:35-108,144-200`.

```ts
const PgLive = PgClient.layer({
  url: Redacted.make(process.env.DATABASE_URL!),
  maxConnections: 10,
})

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`insert into audit_log (message) values (${'started'})`
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`update accounts set seen_at = now()`
    }),
  )
})
```

### Drizzle's Effect-native driver

The installed rc.5 `drizzle-orm/effect-postgres` exports `EffectPgDatabase`, `make`, `makeWithDefaults`, session/transaction types, and codecs: `~/agency/vivid/apps/server/node_modules/drizzle-orm/effect-postgres/index.d.ts:1-4`; `~/agency/vivid/apps/server/node_modules/drizzle-orm/effect-postgres/driver.d.ts:13-52`. `make` requires `PgClient`, `EffectLogger`, and `EffectCache`; `makeWithDefaults` supplies no-op logger/cache defaults. Its session's transaction method uses the same `PgClient.withTransaction`: `~/agency/vivid/apps/server/node_modules/drizzle-orm/effect-postgres/driver.d.ts:18-52`; `~/agency/vivid/apps/server/node_modules/drizzle-orm/effect-postgres/session.d.ts:22-46`.

**Recommendation:** let `PgClient.layer` own the application pool and let `PgDrizzle.makeWithDefaults({ relations })` expose the Effect-native Drizzle object. Use its `$client`/Effect SQL for low-level operations. Do not pass this object to Better Auth's `Drizzle` adapter: the installed adapter calls promise methods such as `await db.select(...).execute()` (`@better-auth/drizzle-adapter/dist/index.mjs:78-107,384-471`), whereas `effect-postgres` query methods are Effects. For Better Auth, use `@alchemy.run/better-auth/Postgres` (a separate scoped auth pool) or write a deliberate custom bridge over a promise-based Drizzle instance; the former is the recommendation because it preserves the native Effect app path and the supported Better Auth layer.

## Drizzle rc.5

### Export surface checked on disk

All requested rc.5 surfaces exist under the `apps/server` symlink:

- `drizzle-orm/effect-postgres` → `make`, `makeWithDefaults`, `EffectPgDatabase`, codecs and session types: `~/agency/vivid/apps/server/node_modules/drizzle-orm/effect-postgres/index.d.ts:1-4`.
- `drizzle-orm/pg-core/effect/*` → effect database/builders/sessions/transactions/`withReplicas`: `~/agency/vivid/apps/server/node_modules/drizzle-orm/pg-core/effect/index.d.ts:1-11`.
- `drizzle-orm/effect-core/errors` → `EffectDrizzleError`, `EffectDrizzleQueryError`, `EffectTransactionRollbackError`, `MigratorInitError`: `~/agency/vivid/apps/server/node_modules/drizzle-orm/effect-core/errors.d.ts:1-35`.
- `drizzle-orm/effect-schema` → `createInsertSchema`, `createSelectSchema`, `createUpdateSchema`: `~/agency/vivid/apps/server/node_modules/drizzle-orm/effect-schema/index.d.ts:1-5`.
- `drizzle-orm/up-migrations/effect-pg` → `upgradeIfNeeded`, which upgrades migration-table version 0 (`id`, `hash`, `created_at`) to version 1 with `name` and `applied_at`: `~/agency/vivid/apps/server/node_modules/drizzle-orm/up-migrations/effect-pg.d.ts:1-16`.

The rc.5 package uses a wildcard import/require export map with separate ESM/CJS type files, so these are package subpaths, not deep imports into `src`: `~/agency/vivid/apps/server/node_modules/drizzle-orm/package.json:9-32`.

### Schema, relations, migrations, and contracts

```ts
import { defineRelations } from 'drizzle-orm'
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
})
export const projects = pgTable('projects', {
  id: uuid().primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
})
export const relations = defineRelations({ users, projects }, (t) => ({
  users: { projects: t.many.projects() },
  projects: { owner: t.one.users({ from: t.projects.ownerId, to: t.users.id }) },
}))
```

`defineRelations`/`t.one`/`t.many` is the relation shape used in the current Alchemy Postgres guide: [Alchemy Postgres](https://alchemy.run/sql/drizzle/postgres). If Better Auth's Drizzle adapter joins are enabled, pass the complete relation object and generated auth relations too; the adapter docs warn that relations must be present and passed to the adapter: [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle).

Use one `drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema/**/*.ts', './src/auth/auth-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

The installed rc-era Kit type says `dialect` is mandatory, `schema` can be a glob/string array, `out` is the migration output, and `dbCredentials` supplies the database connection: `~/agency/vivid/apps/server/node_modules/drizzle-kit/index.d.ts:17-63,102-168,330-332`. The published config guide has the same `defineConfig({ dialect: "postgresql", schema, out })` shape and documents `dbCredentials.url`: [Drizzle Kit config](https://orm.drizzle.team/docs/drizzle-config-file).

Recommended flow:

```text
pnpm dlx auth@latest generate                 # generate Better Auth/organization Drizzle schema
pnpm exec drizzle-kit generate --config drizzle.config.ts
pnpm exec drizzle-kit migrate --config drizzle.config.ts
```

The first command follows Better Auth's current adapter docs; the Alchemy wrapper's alternate CLI spelling is flagged above. `drizzle-kit generate` creates SQL from the TypeScript schema; `migrate` applies it and records rows in the configured migrations table/schema: [Better Auth installation](https://better-auth.com/docs/installation), [Drizzle Kit config → migrations](https://orm.drizzle.team/docs/drizzle-config-file).

`effect-schema` can prevent hand-writing the basic insert/select/update contracts twice:

```ts
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-orm/effect-schema'

export const UserInsert = createInsertSchema(users)
export const UserSelect = createSelectSchema(users)
export const UserUpdate = createUpdateSchema(users)
```

These are Effect `Schema` values usable with `Schema.decodeUnknownEffect`; field refinements/overrides can be supplied to `create*Schema`: [Drizzle effect-schema](https://orm.drizzle.team/docs/effect-schema). **Recommendation:** use these generated schemas as the baseline for `packages/contracts`, then add API-specific brands, redaction, and server-owned-field omissions around them. They do not replace Better Auth's generated auth schema or organization plugin types, and they do not express authorization rules merely because a table has a foreign key.

### rc.4 → rc.5 differences

The official rc.5 PR records these relevant changes: `where` filters now reject `undefined` and use explicit `EmptyFilter` for intentional absence; `Relation.isReversed` became `isFilterReversed`; `db.execute` gained/adjusted `objects`/`arrays` modes; and relational query/mapper fixes landed. Source: [Drizzle PR #5966](https://github.com/drizzle-team/drizzle-orm/pull/5966). This is why code copied from rc.4 must be rechecked rather than type-fixed blindly.

The exact `effect` peer floor also changed in the installed rc.5 package from the rc.4-era range: rc.5 requires `effect >=4.0.0-beta.105` (or a stable v4), matching the `Schema.TaggedError` rename: `~/agency/vivid/apps/server/node_modules/drizzle-orm/package.json:43-96`; the installed rc.112 Effect source has `TaggedError` at `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/src/Schema.ts:15207`.

## Better Auth 1.7.3 and the Alchemy bridge

### What is Effect-native

Core Better Auth remains a Promise/Web API framework: `betterAuth({...})` creates the auth instance, plugins are ordinary Better Auth plugin values, and hooks such as `sendVerificationEmail`/`sendResetPassword` are async functions. Better Auth supports any framework with standard `Request`/`Response`: [Better Auth installation](https://better-auth.com/docs/installation).

`@alchemy.run/better-auth@2.0.0-beta.76` is the Effect-native layer. It provides a `Database` `Context.Service` and layers (`Postgres`, `Drizzle`, `Neon`, `AuroraDataApi`, `CloudflareD1`, `CloudflareHyperdrive`, `MySQL`, `SQLite`, `Memory`, plus secondary storage), while `BetterAuth(options)` returns Effect-native `auth.fetch`, `auth.api.*`, `auth.getSession`, and raw `auth.auth`: `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/index.ts:1-34`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Database.ts:9-103`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/BetterAuth.ts:81-142,145-263`.

**Answer to the critical open question:** the database backend and the wrapper's handler/API/session bridge are Effect-native; the Better Auth plugin implementation and its hook callback surface are not rewritten into Effect. Pass async Better Auth hooks as documented. Use `Effect.promise` only at the bridge when calling raw Better Auth APIs; use `auth.api.*` when the wrapper exposes the endpoint.

The wrapper's `Drizzle` layer accepts either a plain Drizzle instance or an Effect that resolves to one, calls Better Auth's official `drizzleAdapter`, and exposes no migration support: `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Drizzle.ts:33-80`. “Plain” is important: Better Auth's installed adapter awaits Drizzle query promises (`@better-auth/drizzle-adapter/dist/index.mjs:78-107,384-471`), so the Effect-native `drizzle-orm/effect-postgres` database is **not** a drop-in value for this layer. Its `Postgres` layer opens a scoped `pg` pool per execution and supports a separate deploy-resolvable migration source: `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Postgres.ts:26-111`.

### Email/password, verification, reset, and Google

```ts
const authOptions = {
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      void sendEmail({ to: user.email, subject: 'Reset password', url })
    },
    onPasswordReset: async ({ user }) => {
      await auditPasswordReset(user.id)
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      void sendEmail({ to: user.email, subject: 'Verify email', url })
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      scope: ['openid', 'email', 'profile'],
      redirectURI: 'https://app.example.com/api/auth/callback/google',
      requireEmailVerification: true,
      disableImplicitSignUp: true,
    },
  },
} satisfies BetterAuthProps
```

`emailAndPassword.enabled` enables sign-up/sign-in; `emailVerification.sendVerificationEmail` receives `{ user, url, token }`; `requireEmailVerification` gates password sign-in; `sendResetPassword`, `onPasswordReset`, and client `resetPassword` implement reset: [email/password](https://better-auth.com/docs/authentication/email-password). Avoid awaiting mail dispatch where the docs warn about timing; use the platform's background-task/wait-until facility.

Google is configured under `socialProviders.google` with client ID/secret. The default callback is `/api/auth/callback/google`; a custom `redirectURI` must exactly match the Google Cloud authorized redirect URI. Scopes can be set explicitly. Sources: [OAuth](https://better-auth.com/docs/concepts/oauth), [Google provider](https://better-auth.com/docs/authentication/google).

For a user who already signed up with email/password, use an authenticated explicit link flow:

```ts
await authClient.linkSocial({ provider: 'google' })
```

Server-side equivalent: `auth.api.linkSocialAccount({ body: { provider: "google" }, headers })`. Do not rely on an email-address match as an authorization decision; the documented linking operation is the safe, explicit path: [OAuth → link account](https://better-auth.com/docs/concepts/oauth#link-account). With `disableImplicitSignUp: true`, a new Google account must explicitly request sign-up, which prevents an accidental second user: [OAuth → disableImplicitSignUp](https://better-auth.com/docs/concepts/oauth#disableimplicitsignup).

### Sessions: browser, Electron, Expo

- **Browser:** default cookie session. Keep auth and app same-origin where possible, or use a reverse proxy/shared parent domain and `credentials: "include"`. The primary `session_token` remains an opaque session identifier; `session.cookieCache` is a separate optional cache cookie: [session management](https://better-auth.com/docs/concepts/session-management), [cookies](https://better-auth.com/docs/concepts/cookies).
- **Electron:** use bearer after login, storing the token in the OS credential store, not `localStorage`. If the app cannot safely receive an OAuth callback, use Device Authorization to open the browser, have the user approve, then poll `/device/token`; add the bearer plugin so later API calls can use `Authorization: Bearer ...`: [bearer](https://better-auth.com/docs/plugins/bearer), [device authorization](https://better-auth.com/docs/plugins/device-authorization).
- **Expo:** use bearer with Expo SecureStore (or an equivalent platform secure store), because native cookie persistence/cross-domain behavior is not the browser default. Device Authorization is optional for a browser handoff, not required for ordinary native OAuth: [bearer](https://better-auth.com/docs/plugins/bearer).

The bearer plugin is imported from `better-auth/plugins/bearer` in the installed export map: `~/agency/vivid/apps/server/node_modules/better-auth/package.json:209-224`. Device Authorization is imported from `better-auth/plugins/device-authorization`, creates a `deviceCode` table, and exposes `/device/code`, `/device/token`, `/device`, `/device/approve`, and `/device/deny`: `~/agency/vivid/apps/server/node_modules/better-auth/package.json:289-306`; [device authorization](https://better-auth.com/docs/plugins/device-authorization).

### Organization plugin and scoping

Server and client setup:

```ts
import { organization } from 'better-auth/plugins'
import { organizationClient } from 'better-auth/client/plugins'

const auth = betterAuth({
  plugins: [
    organization({
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail: async (data) => sendInvite(data),
    }),
  ],
})

const authClient = createAuthClient({
  plugins: [organizationClient()],
})
```

The plugin supplies organizations, members, roles, invitations, active organization, and optional teams. The required database shape is `organization`, `member`, `invitation`, plus `session.activeOrganizationId`; enabling teams adds `team`, `teamMember`, and invitation/session fields; dynamic access control adds `organizationRole`: [organization schema](https://better-auth.com/docs/plugins/organization#database-schema). The installed plugin exports the server/client organization and access modules: `~/agency/vivid/apps/server/node_modules/better-auth/package.json:259-278,438-450`.

Important operations include `organization.create`, `list`, `getFullOrganization`, `setActive`, `inviteMember`, `acceptInvitation`, `listMembers`, `removeMember`, `updateMemberRole`, `getActiveMember`, and `leave`. An active organization is stored in the session by default; it can also be managed client-side when tabs need independent selection: [active organization](https://better-auth.com/docs/plugins/organization#active-organization).

Default roles are `owner`, `admin`, and `member`. The default resources/actions cover organization update/delete, member create/update/delete, and invitation create/cancel. Use `createAccessControl` from `better-auth/plugins/access`, define statements, create roles, and pass `ac` + `roles` to both server and client organization plugins. Use `auth.api.hasPermission` for a server check and `organization.checkRolePermission` only for synchronous client-side predefined-role checks: [organization roles and permissions](https://better-auth.com/docs/plugins/organization#roles), [access control](https://better-auth.com/docs/plugins/organization#custom-permissions).

For Vivid's app data, put `organizationId` on every organization-owned table and `userId` on user-owned settings. Treat the session's `activeOrganizationId` as a selection, not proof of membership: load the session, verify membership/role with Better Auth or the organization API, then query using the verified organization ID. Keep sensitive server-owned fields out of Better Auth client input (`input: false`) and use an application `user_settings` table rather than turning arbitrary settings into identity fields: [organization active organization](https://better-auth.com/docs/plugins/organization#use-active-organization), [OAuth server-owned fields](https://better-auth.com/docs/concepts/oauth#server-owned-fields-and-authorization-claims), [session update](https://better-auth.com/docs/concepts/session-management#update-session).

Invitation email delivery is not automatic: provide `sendInvitationEmail`, construct a link containing the invitation ID, and call `acceptInvitation` after login. Enabling `requireEmailVerificationOnInvitation: true` is the recommended stricter posture for sensitive org membership: [organization invitations](https://better-auth.com/docs/plugins/organization#setup-invitation-email), [email verification requirement](https://better-auth.com/docs/plugins/organization#email-verification-requirement).

### Better Auth schema and migrations

Better Auth's Drizzle adapter uses `@better-auth/drizzle-adapter` and its CLI can generate ORM schema/migrations from configured plugins. For organization, generated schema must include the plugin's org tables/fields. When Drizzle joins are enabled, pass relations to the adapter: [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle), [organization migration/schema](https://better-auth.com/docs/plugins/organization#migrate-the-database).

For this stack, use the generated auth schema as an input to the same Drizzle Kit config as application tables. Do not run Alchemy's Kysely-style automatic migration and Drizzle Kit against the same auth tables. The installed Alchemy wrapper supports automatic deploy-time migration for `Postgres`/`Neon`, but not `Drizzle`: `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Postgres.ts:81-111`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/Drizzle.ts:33-57`.

## Alchemy `2.0.0-beta.76` provisioning

### Stack shape

A Stack is an Effect that groups resources, providers, and state; the provider layers must be registered and the generator's return value becomes stack output: [Alchemy Stacks](https://alchemy.run/infrastructure-as-code/stack/).

```ts
import * as Alchemy from 'alchemy'
import * as Neon from 'alchemy/Neon'
import * as Layer from 'effect/Layer'
import * as Effect from 'effect/Effect'

export default Alchemy.Stack(
  'Vivid',
  { providers: Neon.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const db = yield* Neon.Project('vivid-db', { region: 'aws-us-east-1' })
    const branch = yield* Neon.Branch('vivid-stage', { project: db })
    return { database: branch.connectionUri }
  }),
)
```

The installed package exports `Neon`, `Docker`, `Cloudflare`, `Fly`, and `Railway` subpaths: `~/agency/vivid/apps/server/node_modules/alchemy/package.json:105-230`. Use `Layer.mergeAll(...)` when a stack has multiple providers: [multiple providers](https://alchemy.run/infrastructure-as-code/stack/#multiple-providers).

### Resources relevant here

- **Neon/Postgres:** `Neon.Project` creates a project with default branch/role/database/compute endpoint; `Neon.Branch` is copy-on-write and has its own connection URI. Branch `migrations` can apply ordered SQL on deploy: [Neon](https://alchemy.run/neon/).
- **Docker/local Postgres:** `Docker.RemoteImage`, `Docker.Network`, `Docker.Volume`, and `Docker.Container` compose a Postgres service with a named volume, network alias, published port, and healthcheck. Docker shells out to the active Docker CLI context: [Docker](https://alchemy.run/docker/), [local Postgres](https://alchemy.run/docker/local-services/).
- **Fly:** installed resources include `Fly.Postgres`, `Fly.PostgresMigrations`, `Fly.Service`, `Fly.Machine`, `Fly.Volume`, and `Fly.ConnectPostgres`; use the Postgres resource/migration prop and connect binding for a Fly-hosted service: `~/agency/vivid/apps/server/node_modules/alchemy/src/Fly/Postgres.ts`; `~/agency/vivid/apps/server/node_modules/alchemy/src/Fly/ConnectPostgres.ts`; [Alchemy Postgres](https://alchemy.run/sql/drizzle/postgres).
- **Railway:** installed resources include `Railway.Project`, `Railway.Postgres`, `Railway.Service`, `Railway.Volume`, and `Railway.ConnectPostgres`; this is the practical path for a Railway project/service/database and a connection binding: `~/agency/vivid/apps/server/node_modules/alchemy/src/Railway/Project.ts`; `~/agency/vivid/apps/server/node_modules/alchemy/src/Railway/Postgres.ts`; `~/agency/vivid/apps/server/node_modules/alchemy/src/Railway/ConnectPostgres.ts`. The exact beta.76 Railway Postgres migration page was not retrievable in this audit; treat the resource names as disk-verified but detailed migration semantics as **unverified**.
- **Cloudflare:** D1 is a native serverless SQLite binding; Hyperdrive fronts external Postgres/MySQL and should receive a direct origin because it does the pooling. The Better Auth wrapper has `CloudflareD1` and `CloudflareHyperdrive`: [Hyperdrive](https://alchemy.run/cloudflare/data/hyperdrive); `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/src/index.ts:30-34`.

### Local versus remote

`alchemy dev` runs resources with local implementations locally, runs compute locally, and hot reloads; `Alchemy.remote()` forces a resource live in dev. A move between local and live is a replacement, not an in-place conversion: [local development](https://alchemy.run/environments/local-development/). Docker resources are local when using the Docker provider. Neon/Fly/Railway resources generally require their provider credentials and should be treated as live unless their provider-specific local implementation is explicitly verified; do not assume a Neon branch is local.

For stages, use separate stage names (`dev_$USER`, preview, production). Alchemy namespaces state and physical names by stage: [Stacks → stages](https://alchemy.run/infrastructure-as-code/stack/). This aligns with Neon branch-per-preview, but the database branch and the Better Auth session secret must be kept in the same stage graph.

## Traps and rename sweep

### Node, module, and pin traps

- `@effect/platform-node@rc.112` has a Node `>=18.0.0` floor: `~/agency/vivid/apps/server/node_modules/@effect/platform-node/package.json:28-32`. The checked environment is Node 24.20.0. Do not infer that all optional provider packages share this exact floor.
- Effect, Better Auth, Alchemy, and Drizzle ORM are ESM packages. Drizzle ORM publishes both import and require branches; `@alchemy.run/better-auth` publishes an import branch and has no CJS condition in its package exports: `~/agency/vivid/apps/server/node_modules/effect/package.json:1-4`; `~/agency/vivid/apps/server/node_modules/better-auth/package.json:1-8`; `~/agency/vivid/apps/server/node_modules/alchemy/package.json:1-4,33-48`; `~/agency/vivid/apps/server/node_modules/drizzle-orm/package.json:1-32`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/package.json:1-42`. Keep `apps/server` ESM and do not deep-import package internals.
- `@effect/platform-node` and `@effect/sql-pg` must use the same rc.112 Effect peer. Drizzle rc.5 requires Effect `>=4.0.0-beta.105`; Alchemy Better Auth beta.76 pins/peers Drizzle rc.5 and Effect rc.112: `~/agency/vivid/apps/server/node_modules/@effect/platform-node/package.json:61-65`; `~/agency/vivid/apps/server/node_modules/@effect/sql-pg/package.json:63-66`; `~/agency/vivid/apps/server/node_modules/drizzle-orm/package.json:43-96`; `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/package.json:43-53`. Propagate exact versions through every workspace importer; do not let a caret range select another rc.
- `drizzle-kit` v1-style config makes `dialect` mandatory and uses `dbCredentials`; old `driver` examples are only for exceptional drivers such as PGLite/AWS Data API. The installed rc.5 type and current docs agree on this: `~/agency/vivid/apps/server/node_modules/drizzle-kit/index.d.ts:17-63,102-168`; [config reference](https://orm.drizzle.team/docs/drizzle-config-file).
- Effect HTTP/RPC/Socket APIs are explicitly under `unstable`; expect rc churn and keep imports centralized in the server/contracts packages. The installed package export map lists only `effect/unstable/*` for these areas: `~/agency/vivid/node_modules/.pnpm/effect@4.0.0-rc.112/node_modules/effect/package.json:14-32`.
- Do not use `Schema.TaggedErrorClass` with rc.112. Also do not copy the beta.84 checkout's old `Effect.catchSome -> Effect.catchIf` mapping: installed rc.112 exports `Effect.catchFilter` and `Effect.catchCauseFilter`: `~/agency/vivid/apps/server/node_modules/effect/src/Effect.ts:5812-6077`; the stale checkout mapping is `~/effect-smol/migration/v3-to-v4.md:368-410`, while its focused guide says `catchSome -> catchFilter` at `~/effect-smol/migration/error-handling.md:1-17`.

### High-signal v3 → v4 rename/import sweep

The checkout's migration map reports 290 import mappings, 43 no-counterpart modules, and 53 API renames: `~/effect-smol/migration/v3-to-v4.md:1-10`. The following are the ones most likely to break this backend:

| v3                                                                  | Effect 4 / current rc.112                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@effect/platform/HttpApi*`, `OpenApi`                              | `effect/unstable/httpapi/*`                                                                  |
| `@effect/platform/HttpRouter`, `HttpServer*`, `HttpClient*`         | `effect/unstable/http/*`                                                                     |
| `@effect/platform/Socket*`                                          | `effect/unstable/socket/*`                                                                   |
| `@effect/rpc/*`                                                     | `effect/unstable/rpc/*`                                                                      |
| `@effect/sql/*`                                                     | `effect/unstable/sql/*`                                                                      |
| `@effect/platform/FileSystem`, `Path`, `Error`                      | `effect/FileSystem`, `effect/Path`, `effect/PlatformError`                                   |
| `Context.Tag`, `Context.GenericTag`, `Effect.Tag`, `Effect.Service` | `Context.Service` (type parameters first, ID second)                                         |
| `Schema.TaggedErrorClass`                                           | `Schema.TaggedError` (the beta.105 rename; verified on rc.112)                               |
| `Effect.async`                                                      | `Effect.callback`                                                                            |
| `Effect.zipRight`, `zipLeft`, `either`                              | `Effect.andThen`, `Effect.tap`, `Effect.result`                                              |
| `Effect.catchAll`, `catchAllCause`, `catchAllDefect`                | `Effect.catch`, `catchCause`, `catchDefect`                                                  |
| `Effect.catchSome`, `catchSomeCause`                                | `Effect.catchFilter`, `catchCauseFilter` (verified against rc.112; the beta.84 map is stale) |
| `Effect.optionFromOptional`, `tapErrorCause`, `ignoreLogged`        | `Effect.catchNoSuchElement`, `tapCause`, `ignore`                                            |
| `Layer.scoped`, `Layer.scopedDiscard`                               | `Layer.effect`, `Layer.effectDiscard`                                                        |
| `Either`, `Either.right`, `Either.left`                             | `Result`, `Result.succeed`, `Result.fail`                                                    |
| `Stream.async*`, `Stream.repeatEffect`, `fromChunk`, `mapChunks`    | `Stream.callback`, `fromEffectRepeat`, `fromArray`, `mapArray`                               |
| `DurationInput`                                                     | `Duration.Input`                                                                             |
| `Schema.parseJson(schema)`                                          | `Schema.fromJsonString(schema)`                                                              |
| `Schema.decodeUnknown`, `decode`, `encode`                          | `decodeUnknownEffect`, `decodeEffect`, `encodeEffect`                                        |
| `Schema.Literal("a", "b")`, `Union(A, B)`, `Tuple(A, B)`            | `Schema.Literals(["a", "b"])`, `Union([A, B])`, `Tuple([A, B])`                              |
| `Schema.filter` / `filterEffect`                                    | `check(makeFilter(...))` / `decode` with `SchemaGetter.checkEffect`                          |
| `Schema.Record({ key, value })`                                     | `Schema.Record(key, value)`                                                                  |
| `Schema.validate*`, `Schema.Data`                                   | removed; use decode/toType and ordinary structural equality                                  |
| `Runtime<R>`                                                        | removed; use `Context` and `Effect.runForkWith` where a captured service context is required |

Import mappings: `~/effect-smol/migration/v3-to-v4.md:12-357`; API mappings: `~/effect-smol/migration/v3-to-v4.md:360-410`; Schema mappings: `~/effect-smol/migration/schema.md:8-108`; services: `~/effect-smol/migration/services.md:1-18,228-233`; runtime: `~/effect-smol/migration/runtime.md:1-18,20-78`.

## Evidence index

Published documentation used:

- Effect: [HTTP API](https://effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiBuilder), [HTTP schema](https://effect.website/docs/v4/api/effect/unstable/httpapi/HttpApiSchema), [RPC server](https://effect.website/docs/v4/api/effect/unstable/rpc/RpcServer), [Effect 4 migration checkout](https://github.com/Effect-TS/effect-smol/blob/main/migration/v3-to-v4.md).
- Drizzle: [Effect Postgres](https://orm.drizzle.team/docs/connect-effect-postgres), [effect-schema](https://orm.drizzle.team/docs/effect-schema), [relations](https://orm.drizzle.team/docs/relations), [config](https://orm.drizzle.team/docs/drizzle-config-file), [rc.5 PR](https://github.com/drizzle-team/drizzle-orm/pull/5966).
- Better Auth: [installation](https://better-auth.com/docs/installation), [email/password](https://better-auth.com/docs/authentication/email-password), [OAuth](https://better-auth.com/docs/concepts/oauth), [sessions](https://better-auth.com/docs/concepts/session-management), [cookies](https://better-auth.com/docs/concepts/cookies), [organization](https://better-auth.com/docs/plugins/organization), [bearer](https://better-auth.com/docs/plugins/bearer), [device authorization](https://better-auth.com/docs/plugins/device-authorization), [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle).
- Alchemy: [Stacks](https://alchemy.run/infrastructure-as-code/stack/), [local development](https://alchemy.run/environments/local-development/), [Docker](https://alchemy.run/docker/), [Neon](https://alchemy.run/neon/), [Hyperdrive](https://alchemy.run/cloudflare/data/hyperdrive), [Drizzle/Postgres](https://alchemy.run/sql/drizzle/postgres), and the installed versioned package README `~/agency/vivid/apps/server/node_modules/@alchemy.run/better-auth/README.md`.

**Unverified items:** exact beta.76 Railway migration semantics; whether the two Better Auth CLI package names will converge; and any future API changes after the installed rc.112/beta.76 packages. These are intentionally marked rather than inferred.
