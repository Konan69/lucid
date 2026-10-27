---
name: runtime-integration-testing
description: Use when testing Vivid across real PostgreSQL, the Effect RPC server and HTTP routes, mounted Better Auth, the Flue runtime boundary, Integrations transport, schedulers, restart recovery, or model behavior where a pure unit test cannot prove the production contract.
---

# Runtime Integration Testing

## Core principle

Test the smallest **real runtime seam** that contains the production failure. Do not replace PostgreSQL, the RPC server, Better Auth session lookup, Flue persistence, or Integration transport with a mock and then claim the integration works.

Keep pure state-machine and domain tests fast. A test of an Effect combinator, a schema literal, or a fake's configured return value is not evidence that Vivid's runtime contract works.

**Use the seams that exist.** Everything below names a file on disk. Before adding a harness, factory, or `make…Target` helper, read those files; a second database bootstrap or server factory is almost always a duplicate. Where a capability is missing, this skill says so under "Missing capabilities" — do not paper over it with a sketch.

Re-verify against installed source when a pin moves. Pinned now: Effect, `@effect/platform-node`, `@effect/sql-pg`, `@effect/vitest` `4.0.2`; the Effect seams below were verified on `4.0.0-rc.116` and are not yet re-read on `4.0.2`. Verified here: Vitest `5.0.1`; Better Auth `1.7.5`; Flue `2.2.2`; pi-ai `0.87.1`; Drizzle `1.0.0-rc.5-ab785fc`.

## Database boundary (non-negotiable)

- PostgreSQL is the integration database. Its URL is read only from `VIVID_TEST_DATABASE_URL`. Never fall back to `DATABASE_URL`, an app env file, the developer database on port 55433, or a remote database.
- With the variable absent, database suites **skip**: `testDatabaseConfigured` (`apps/server/src/database/testdb.ts`) gates them with `describe.skipIf(!testDatabaseConfigured)`. Nothing substitutes another URL. The runtime project rejects a set-but-empty variable during worker setup rather than skipping.
- **Server project:** the supplied URL is used as an **administration connection only**. The template and the per-file clones are separate databases on that server; no server migration and no server fixture writes to the database the URL names. It must still be a disposable instance: the role needs `CREATE DATABASE`, and the harness creates and force-drops databases on that server.
- **Runtime project:** `packages/agent/runtime/tests/database.ts` migrates a template through the Pi storage owner and clones a database per scoped case. It uses only `VIVID_TEST_DATABASE_URL` for administration, registers cleanup before creation and refuses port 55433. Production storage remains in `packages/agent/runtime/src/storage/`.
- Migrations run through the production path. `apps/server/tests/template.ts` (Vitest `globalSetup`) creates `vivid_test_<uuid>` from `template0` and runs `pnpm exec drizzle-kit migrate` for `drizzle.config.ts` then `product-drizzle.config.ts`, the same order as root `scripts/migrate.mjs`. Never use `push` or hand-written schema SQL.
- **`DATABASE_URL` is an output of the test variable, never an input.** Production code reads `DATABASE_URL`, so three existing adapters derive it from `VIVID_TEST_DATABASE_URL`, each in one direction only:
  - `tests/template.ts` sets it to the template's URL in the Drizzle Kit child's environment, and nowhere else.
  - `packages/agent/runtime/tests/setup.ts`, registered with Vitest `setupFiles`, derives it for each runtime worker before test imports, because `src/db.ts` reads `DATABASE_URL` at import. It removes inherited `DATABASE_URL` when the test variable is absent and refuses an empty test URL.
  - `testConfigLayer` (`database/testdb.ts`) puts the file's clone into the `ServerConfig` value. This one is a context value, not process environment.

  Do not add a fourth, and do not make any of them read `DATABASE_URL`. None is a fallback: when the test variable is absent the template setup returns early, `testConfigLayer` fails, and the runtime setup removes inherited `DATABASE_URL`, so importing `db.ts` fails at its config read.

- Cleanup is defined before creation in both server files. `template.ts` returns a teardown that drops every `<template>_*` database it can still find (Vitest skips `afterAll` for wholly skipped files and failed collection) and then the template. `tests/setup.ts` registers `afterAll` before `CREATE DATABASE`.

### What isolation you actually get

This is **per-file database isolation plus per-case row cleanup**. It is not per-test isolation, and no doc or test comment may call it that.

| Level                 | Mechanism                                                                                                                 | Owner                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Per Vitest invocation | One migrated, empty template database                                                                                     | `apps/server/tests/template.ts`            |
| Per test **file**     | `CREATE DATABASE … TEMPLATE <template>`; `VIVID_TEST_DATABASE_URL` is rewritten to the clone before any store is imported | `apps/server/tests/setup.ts`               |
| Per test **case**     | Rows the case inserts, removed by a finalizer registered before the first write                                           | the case's fixture (`Effect.addFinalizer`) |

Consequences:

- Cases in one file share one database. Global scans (scheduler claims, replay sweeps, pending-work queries) see every row the file has left behind, so each fixture uses fresh UUIDs and removes its rows, and a case that asserts on a global scan checks for older obligations first (`pendingWork` in `apps/server/src/library/fixtures.ts`).
- A fixture's cleanup failure must fail the test, not log: see `cleanupFailed` in `apps/server/src/drafts/testing.ts`.
- `layer(testLayer)` from `@effect/vitest` builds its Layer once per `describe` block. The SQL pool is shared by that block's cases and closed by the Layer scope before `afterAll` drops the clone.
- The server project runs with `maxWorkers: 2` (`apps/server/vitest.config.ts`); files are parallel, cases inside a file are not isolated from each other.

If a claim truly needs a database per case, that is a missing capability; state it, do not imply the current harness provides it.

### The test database Layer

`testDatabaseLayer` (`database/testdb.ts`) is the **production** `databaseLayer` from `database/client.ts`, provided with `testConfigLayer`. It is not a second adapter and not a hard-provided singleton: `databaseLayer` requires `ServerConfig`, and the test composition supplies a `ServerConfig` whose `DATABASE_URL` is the file's clone. A store that opens its own connection therefore still cannot reach developer data.

`testDatabaseLayer` also pins the real `Clock` **inside the SQL adapter only**, so advancing `TestClock` cannot expire a real socket handshake or pool idle timer. Stores, schedulers, session expiry and persisted timestamps still read the test's clock. Do not move that provision outward.

Compose the store under test over it, flat:

```ts
// apps/server/src/threads/runs.test.ts
const testLayer = runStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))
```

## Pick the seam first

| Production claim or bug                                                                 | Smallest truthful seam                                                                                | Example on disk                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| SQL constraints, atomicity, status-qualified updates, idempotency                       | Real store Layer over `testDatabaseLayer`                                                             | `companies/store.test.ts`, `library/store.test.ts`                                |
| Handler decode/authorize/encode over a real store                                       | The exported handler with a real `AuthContext` value                                                  | `memory/handlers.test.ts`, `connections/handlers.test.ts`                         |
| RPC middleware, request scope, error encoding                                           | `RpcTest.makeClient` over the real `RpcServer` machinery                                              | `auth/middleware.test.ts`                                                         |
| One HTTP route's status, headers, body                                                  | `HttpRouter.toHttpEffect(routes)` with `HttpServerRequest.fromWeb`                                    | `library/bytes.test.ts`, `connections/return.test.ts`, `threads/gateway.test.ts`  |
| Node-level HTTP behavior a Fetch adapter hides (multipart limits, chunking, truncation) | `NodeHttpServer.layerTest` + `HttpRouter.serve(routes)`                                               | `http/upload.test.ts`                                                             |
| Session lookup for a Person                                                             | Real Better Auth via the bearer plugin against a session row                                          | `auth/middleware.test.ts`, `library/fixtures.ts`                                  |
| Scheduler admission, due time, expiry                                                   | The real store/scheduler with `TestClock`                                                             | `routines/store.test.ts`, `connections/transport.test.ts`                         |
| Durable replay after a failure                                                          | Real PostgreSQL with explicit failure injection                                                       | `inputs/replay.test.ts`, `approvals/replay.test.ts`, `library/durability.test.ts` |
| Integration transport: mapping, retries, cursors, caches                                | Real transport code against a local `NodeHttpServer.layer(…, { port: 0 })` standing in for the remote | `connections/transport.test.ts`                                                   |
| Runtime tool behavior                                                                   | The real Flue runtime and an HTTP RPC server                          | `packages/agent/runtime/src/routes.test.ts`, `src/tools/scope.test.ts`              |
| Signup, cookies, gateway, a real Run end to end                                         | The **running** stack on a disposable database                                                        | `runtime/chains.ts` + `*/thread.live.test.ts`                                     |
| Model quality or tool choice                                                            | Gated `.live.test.ts`                                                                                 | `memory/*.live.test.ts`                                                           |

## Server: Effect RPC and HTTP routes

There is no `HttpApi` in this repository. Product calls are `VividRpc` (`packages/contracts/src/rpc.ts`), served by `rpc/server.ts` as `RpcServer.layerHttp` twice: `/api/live` (WebSocket, JSON) and `/api/rpc` (HTTP, NDJSON). `http/router.ts` exports `routerLayer`, which merges those with plain HTTP routes: `/api/auth/*`, the closed `/api/auth/organization/*`, the conversation gateway, Library bytes, Integration returns, Routine webhooks, the Computer screen and `/health`. `main.ts` adds update and static routes and the background fibers.

- **Do not import `main.ts` in a test.** It calls `NodeRuntime.runMain` at module evaluation, reads the process `DATABASE_URL` through `loadServerConfig`, and starts schedulers.
- **Test a route group, not a rebuilt app.** Each group is an exported Layer (`bytesRoutes`, `gatewayRoutes`, `connectionReturnRoutes`, …). Provide the stores it needs over `testDatabaseLayer`, plus `testConfigLayer`, and choose one of:
  - `HttpRouter.toHttpEffect(routes)` — an in-memory handler; give it a request with `HttpServerRequest.fromWeb(new Request(…))`. Enough for status, headers and bodies.
  - `NodeHttpServer.layerTest` — a real listener on an ephemeral port plus a Fetch-backed `HttpClient` already pointed at it. Use it when the claim depends on Node's HTTP parser. Build it with `Layer.build` inside the scoped fixture, then `HttpRouter.serve(routes, { disableLogger: true })` over it (`http/upload.test.ts`).
- **RPC contract tests** use `RpcTest.makeClient(group)` (`effect/unstable/rpc/RpcTest`), which runs the real `RpcServer` request path without a socket. Provide the real `rpcAuthMiddlewareLayer`; do not replace it with a stub that injects `AuthContext`.
- **Handler tests** call the exported handler and provide a real `AuthContext` built from fixture rows (`AuthState.Person`, …). That proves the handler and store, not authentication.
- Change notices: provide `silentChangesLayer` (`live/changes.ts`) when the claim is not about announcements; use the real `changesLayer` when it is (`library/announcements.test.ts`, `live/changes.test.ts`).
- `@effect/vitest` only: `it.effect`, `it.live`, `layer(…)`. Never start an Effect runtime by hand to run the program under test or an application Layer, and no `node:test` for app or package suites. The lint rule `vivid/no-manual-effect-runtime-in-tests` reports `Effect.runPromise`, `runSync` and `runFork` in Vitest files. One call site is exempt, by a rule-named `oxlint-disable-next-line` on that line: see "Promise callbacks owned by an SDK" below. Pass `{ excludeTestServices: true }` to `layer` when the cases must run on the real clock (Better Auth's Promise adapter cannot be cancelled mid-query; see the note in `library/bytes.test.ts`).

## Better Auth

`auth/provider.ts` exports `authEffect`. It reads `ServerConfig` from context and opens Better Auth over `config.DATABASE_URL` with `migrate: false`, base path `/api/auth`, and the Company/Membership model map. Under `testConfigLayer` it therefore uses the file's clone and a test-only `AUTH_SECRET`. Migrations stay with Drizzle Kit.

Two different claims, two seams:

1. **"This session is this Person."** Insert a Person and a session row, register their deletion first, and send `authorization: Bearer <token>`. The real bearer plugin and `auth/session.ts` resolve it. This is what the existing fixtures do. It proves session lookup and nothing about signup, sign-in or cookie flags. Never stub `authenticate`, `auth.api.getSession`, or the middleware.
2. **"Signup or sign-in works and sets the right cookies."** POST to the mounted `/api/auth/sign-up/email` or `/api/auth/sign-in/email` and carry the returned cookies. Today this is proven only against the running stack (`runtime/chains.ts`), where the request must also carry an `origin` header equal to `PUBLIC_URL`, because `trustedOrigins` is `[PUBLIC_URL]`.

Better Auth's organization routes are deliberately answered 404 (`closedRoute`); Companies and People are managed through `VividRpc` only.

## Runtime: Pi boundary

The runtime runs on Pi Durable 1.2.0. Its installed README and package source define the SDK API. The production routes and Persons Layers are exercised through `packages/agent/runtime/tests/process.ts`, with the production PostgreSQL storage and migration owner. Only model responses and the remote product server are controlled fixture boundaries. Runtime setup removes inherited deployment configuration; each case supplies typed settings and its own database.

`src/routes.test.ts`, `src/state/link.test.ts` and `src/flue/carry.test.ts` prove admission, projection, restart recovery and historical import. Tool tests use a real Pi Harness via `src/tools/tests/harness.ts`. Database-backed suites belong on a devbox with a disposable administration URL. The server's `Runtime` service reads typed ConversationState and ConversationFrame contracts, not Flue history.

## Time

Use `effect/testing/TestClock` (`TestClock.adjust`, `TestClock.setTime`) under `it.effect`, and wait on an observable receipt: a `Queue.take`, a `Deferred`, a `Stream.runHead` on the first matching state. Never sleep, never poll, never raise a timeout to make a test pass. `it.live` is for cases that need real time because a real socket or SDK promise is in play; it still waits on a receipt.

## Durability and failure cases

Assert observable outcomes, not calls:

- A crash between accepting work and recording its receipt: restart from the durable row and prove one effect.
- A timeout, reset or 5xx after a write is **outcome unknown**: reconcile by stable id or idempotency key before retrying.
- Duplicate requests produce one durable effect.
- "Restart" in the current suites means building a fresh Layer over the same clone and reading what the first one left (`routines/store.test.ts`, `library/durability.test.ts`). It is not a new OS process; say "new Layer over the same database", not "process restart".
- Tests do start real OS processes. `library/extraction.test.ts` (E8) launches the production `tsx` command for `library/fixtures/process/main.ts` through `ChildProcess.make`, and waits on stdout EOF and exit code 0. That proves one process's lifecycle and resource release. It does not prove recovery of owed work by a second process.

On Linux, inspect `/proc/sys/kernel/core_pattern` before deliberate abort or heap-exhaustion cases.
A pipe collector ignores a zero `RLIMIT_CORE` and can hold a dying process while collecting its
memory. [Linux 6.6 `do_coredump`](https://github.com/torvalds/linux/blob/v6.6/fs/coredump.c#L559)
skips that collector when the limit is exactly one byte. Run only the owned test command under
`prlimit --core=1:1 -- pnpm …` on such a host; never change the global core pattern or another
process's limits. This was needed for `library/extraction/process.test.ts` on the local WSL host:
the four native lifecycle cases passed without changing their timeout. It disables kernel core
collection for that command, not Node's private diagnostic report. It does not establish the
production deployment's core-dump policy.

## The running stack

Some claims need every process: browser cookies, the conversation gateway, a real Run. `runtime/chains.ts` is the fixture for those. It works against an **already running** stack and refuses to write unless the stack's `DATABASE_URL` and `VIVID_TEST_DATABASE_URL` name the same host and database; it registers the Person's deletion before signup. The config is `apps/server/src/runtime/vitest.ts` (`pnpm exec vitest run --config src/runtime/vitest.ts` from `apps/server`), serial, each scenario gated by its own `VIVID_LIVE_THREAD_*` flag.

`pnpm infra:dev` is the developer stack: Alchemy local stage, PostgreSQL on port 55433 with a persistent volume. It is **not** disposable. Read from it; never point a test, fixture, migration or cleanup at it. A stack used for proofs must be started against a separate disposable database. Agents other than the primary never start servers.

## Integrations transport

Fake only the remote network edge. `connections/transport.test.ts` runs the real transport against a local `NodeHttpServer` on port 0 that plays the remote, and drives cache expiry with `TestClock`. Cover refusal retention, cursor paging and repeated cursors, install races, and that results pass through unaltered. Recordings and assertions contain no credentials; Executor owns Integration credentials.

## Live tests

`*.live.test.ts` call a real model or provider. Vitest's `include` (`src/**/*.test.ts`) matches them, so the **only** gate is the `describe.skipIf` on an explicit flag in each file (`VIVID_LIVE_*`, `VIVID_TEST_BOAT_LIVE`, `VIVID_TEST_DOCKER`). Every new live file needs its own flag and credential check; a filename is not a gate. One file per behavioral claim; assert structured behavior, not prompt wording. A live test is never the only proof of persistence, authorization or idempotency.

`vitest-evals` is not a workspace dependency. Do not name its imports.

## Commands

All exist today. This skill's author did not run them while writing it.

- `pnpm test` — `turbo run test`; passes `VIVID_TEST_DATABASE_URL` through.
- `pnpm --filter @vivid/server test` — `vitest run` for the server project.
- `pnpm --filter @vivid/agent-runtime test` — `vitest run` for the runtime project.
- `pnpm exec vitest run --project @vivid/server <path>` from the root — one file.
- `pnpm test:tooling` — `node --test` suites under `scripts/`.

Database suites skip silently when `VIVID_TEST_DATABASE_URL` is unset; a green run without it has not proven persistence. Say which it was.

## Missing capabilities

State these when they block a claim. Do not sketch a harness for them in a test file.

- **No in-process composed server.** Nothing exports the full Layer graph of `main.ts`, and no test builds `routerLayer` whole. A claim about the complete router, the WebSocket `/api/live` endpoint, or background fibers running together is proven only against the running stack.
- **No in-process signup/cookie test.** Mounted `/api/auth/*` signup is exercised only by `runtime/chains.ts`.
- **No per-case database.** See "What isolation you actually get".

- **No OS-process restart recovery proof for owed work.** No test stops a process that holds accepted work and shows a new process finishing it. Restart recovery is proven with a fresh Layer over the same database; the OS-process tests that exist prove launch and exit only (see "Durability and failure cases").

Closing one of these is a design task for the owner of that boundary: extend the existing seam (`testdb.ts`, `tests/setup.ts`, `routerLayer`), do not add a parallel factory.

## Do not write these tests

- A mock database for a SQL constraint, transaction or replay claim.
- A stubbed session or injected `AuthContext` presented as authentication coverage.
- A mocked Flue conversation store presented as durability coverage.
- A test that only proves `Effect.retry`, a Schema literal, or a fake's return value.
- A test that sleeps, polls, or needs a longer timeout.
- Cases that share fixed ids, or assert on a global scan without accounting for the file's other rows.
- A transport test that mocks the transport instead of the remote HTTP.
- A model eval used to prove deterministic authorization or persistence.
- A new `makeTest…` database or server factory beside `testdb.ts` and `tests/setup.ts`.

## Completion checklist

- [ ] The seam is the smallest real boundary containing the failure, and it is one named above.
- [ ] Only `VIVID_TEST_DATABASE_URL` is read as input; `DATABASE_URL` appears only as an output of the three existing adapters; nothing can reach port 55433 or a remote database.
- [ ] Every fixture registers its row cleanup before its first write, and cleanup failure fails the test.
- [ ] Isolation is described as per-file clone plus per-case cleanup, not per-test.
- [ ] `testDatabaseLayer` is composed, not re-implemented; no production Layer was hard-provided.
- [ ] No sleeps, polling, shared ids, secrets in output, or unbounded retries.
- [ ] `@effect/vitest` runs every Effect program under test; any `Effect.runPromise` is a proven SDK Promise callback with its rule-named disable, not a runtime for the test.
- [ ] Whether the database suites ran or skipped is reported.
- [ ] Any claim that rests on a missing capability is reported as unproven.
