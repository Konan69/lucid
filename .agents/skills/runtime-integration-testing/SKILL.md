---
name: runtime-integration-testing
description: Use when testing Vivid across real PostgreSQL, the Effect HTTP server, mounted Better Auth, Flue/Hono runtime, connectors, scheduler readiness, restart recovery, or model behavior where a pure unit test cannot prove the production contract.
---

# Runtime Integration Testing

## Core principle

Test the smallest **real runtime seam** that contains the production failure. Do not replace PostgreSQL, the HTTP router, Better Auth sessions, Flue persistence, or connector transport with a mock and then claim the integration works.

Keep pure state-machine and domain tests fast. A test of an Effect combinator, a schema literal, or a mock's configured return value is not evidence that Vivid's runtime contract works.

## Non-negotiable database boundary

- PostgreSQL 18 is the integration database.
- Read its URL only from `VIVID_TEST_DATABASE_URL`. Never fall back to `DATABASE_URL`, a developer database, or a shared remote database.
- Refuse to run when the URL is absent. Also reject a URL that is not explicitly identified as disposable by the owning test setup.
- Apply migrations through the real Drizzle Kit migrate path. A test migration adapter must validate `VIVID_TEST_DATABASE_URL`, remove any inherited `DATABASE_URL`, and pass the validated test URL as `DATABASE_URL` only to the migration child (`pnpm db:migrate` or the owning package's `db:migrate`). The production migration runner reads `DATABASE_URL`; that bridge is an output-only adapter, never a second test input. Never use push.
- Isolate **every test**, not merely each worker. Prefer a unique PostgreSQL schema/database per test and run migrations against its connection/search path. Transaction rollback is acceptable only when every operation—including Better Auth, Flue, and background work—shares that transaction.
- Register schema/database drop or rollback **before the first write** with the test context or `beforeEach`/`afterEach`. Close pools, listeners, schedulers, and storage even after assertion failure.

The current `routine-store.test.ts` and `task-store.test.ts` use a real database but default `DATABASE_URL`, create durable rows, and do not close their pool. The current `runtime-db.ts` also creates a module-global pool, runs a programmatic migration plus compatibility SQL at import time, and checks `public`. A truthful harness must first extract an injected database/store factory and keep that import-time production bootstrap out of tests. Then require `VIVID_TEST_DATABASE_URL`, migrate the per-test isolation target once through Drizzle Kit, register teardown before inserts, and scope fixed idempotency IDs per test.

## Pick the seam first

| Production claim or bug | Smallest truthful seam |
| --- | --- |
| SQL constraints, transaction atomicity, status-qualified updates, idempotency | Real PostgreSQL 18 through the actual store/Drizzle adapter |
| Effect endpoint encoding, middleware, status mapping, or Layer composition | Real `HttpApi` app over HTTP with the test PostgreSQL `Database`/`PgClient` Layer |
| Signup, signin, session lookup, or cookie flags | Real mounted `/api/auth/*` Better Auth handler and cookie jar |
| Hono route validation/auth plus store behavior | Real runtime route map over HTTP with real PostgreSQL |
| Flue dispatch/read recovery or conversation durability | Real Flue Postgres storage and the real route/scheduler boundary |
| Scheduler admission or due-time behavior | Real scheduler logic with a controllable clock; never sleeps |
| Provider orchestration shape | Deterministic fake provider registered only through Flue's `setProvider` seam |
| Model quality or tool-choice behavior | Gated `.live.test.ts` using the vitest-evals pi-ai harness |
| Connector request mapping, refresh, retries, replay | Real connector code with recorded/simulated HTTP only at the network edge |
| Whole local deployment wiring | `pnpm infra:dev` (`alchemy dev`, local stage), then black-box HTTP checks |
| Pure validation or state transition | Direct unit test; no runtime harness |

## Server: Effect HttpApi over HTTP

Build the same router contributions as `apps/server/src/main.ts`: the Better Auth catch-all, `/health`, and `apiLayer`. Provide a test `Database` backed by a PostgreSQL `PgClient`, provide test `ServerConfig`, start an ephemeral Node HTTP listener, and make real HTTP requests.

Do not import `main.ts` as a test harness: it launches `NodeRuntime.runMain` during module evaluation and hard-provides `databaseLayer`. Extract an app Layer factory that accepts the database and config Layers. Also refactor `authEffect`: it currently hard-provides `serverConfigLayer` and rereads ambient `DATABASE_URL`, so app extraction alone does not make authentication test-configurable. The test composition must inject database and auth construction from the same validated test config while preserving production `HttpApiBuilder.layer(api)`, middleware, and encoded tagged errors.

Dependency truth matters:

- The lock resolves every Effect, platform and sql package at `4.0.0-rc.116`, the same version the manifests pin through the workspace catalog.
- Verified in the installed rc.116 declarations (`@effect/platform-node/NodeHttpServer`, `effect/unstable/http/HttpRouter`): `NodeHttpServer.layerTest` supplies an ephemeral real listener plus Fetch-backed client, and `HttpRouter.toWebHandler` returns a Fetch handler with `dispose`. Prefer `NodeHttpServer.layerTest` when the claim requires real HTTP; `toWebHandler` is useful only when an in-memory Fetch boundary is sufficient.
- Recheck those declarations whenever the Effect pin moves; do not assume unchanged signatures.
- `@effect/vitest` `4.0.0-rc.116` is a declared workspace dependency. Effect programs under test use its `it.effect`, `it.live` and shared `layer(...)`; do not build a manual Effect runtime in a test.
- Ordinary Node test code may launch the real Layer and use standard HTTP. Keep raw Promises at this narrow test/framework adapter only.

### Target server skeleton (requires the named extraction)

```ts
// apps/server/src/api.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

// Proposed project seams: extract these from main.ts; they do not exist yet.
import { makeTestTarget, startTestServer } from "./testserver.ts";

const databaseUrl = process.env.VIVID_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("VIVID_TEST_DATABASE_URL is required");

test("health is served by the composed router", async (context) => {
  const target = makeTestTarget(databaseUrl); // chooses a unique schema; no I/O
  context.after(async () => target.closeAndDrop()); // before migration/startup writes
  const server = await startTestServer(target);

  const response = await fetch(new URL("/health", server.origin));
  assert.equal(response.status, 200);
});
```

`startTestServer` is an explicitly deferred local adapter, not an installed Effect helper. Build it from the verified rc.116 `NodeHttpServer.layerTest` surface, inject the test database/config/auth layers.

## Better Auth: mount, do not stub

Test through the mounted `* /api/auth/*` handler configured in `apps/server/src/main.ts` and `auth.ts`:

1. POST a unique email/password to the verified mounted route `/api/auth/sign-up/email`.
2. Capture every `Set-Cookie` value in a cookie jar.
3. POST `/api/auth/sign-in/email` when signup does not establish the desired session.
4. Call `/api/me` with the real session cookie.
5. Assert the database rows and public response, not Better Auth internals.

Use a valid **test-only** `AUTH_SECRET`, a listener-derived test `PUBLIC_URL`, Vivid's `/api/auth` base path and schema map, and `migrate: false`. The route names are verified for the installed Better Auth 1.7.3 line; recheck the 1.7.5 target after lock convergence. Migrations remain owned by `apps/server/src/schema.ts` and Drizzle Kit. Never stub `auth.getSession` or manufacture a session cookie.

## Runtime: Hono, Flue, scheduler, and provider

Use the real route map from `packages/agent-runtime/src/app.ts`, real `@flue/postgres` conversation storage, and PostgreSQL-backed stores. Current imports eagerly initialize `runtime-db.ts`, handwritten compatibility SQL, both schedulers, and the OpenRouter provider. Before isolated route tests are possible, split app construction from process startup, inject the already-migrated database/store, and disable the import-time `schemaReady`/scheduler path in the test composition. The test must not silently run a second migration mechanism or consult `public` while claiming per-test isolation.

The deterministic provider is the one legitimate fake for orchestration tests. Flue 2.0.3's verified seam is Pi AI's `fauxProvider(...)`, scripted with `faux.setResponses([fauxAssistantMessage([fauxText(...)])])`, then registered through `setProvider(faux.provider)`. Do not mock Flue, its Postgres conversation storage, `init`, `dispatch`, or `read`. There is no public provider unregister; isolate provider tests in their own process/file or replace the same provider ID deliberately, and set the test model to the faux provider's model before importing the Vivid definition.

Scheduler tests must inject a controllable Effect `Clock` or an explicit scheduler clock port after both schedulers are refactored away from import-time initialization. Advance the clock and await an observable admission/result boundary. Never sleep or poll on arbitrary delays.

### Store skeleton improving current cleanup

```ts
// packages/agent-runtime/src/routine-store.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

const databaseUrl = process.env.VIVID_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("VIVID_TEST_DATABASE_URL is required");

test("a completed run cannot be finalized twice", async (context) => {
  const target = makeRuntimeTestTarget(databaseUrl); // unique schema; no I/O
  context.after(async () => target.closeAndDrop()); // before migration/store writes
  const harness = await makeRuntimeStoreHarness(target);

  const routine = await harness.store.createRoutine({
    name: `test-${crypto.randomUUID()}`,
    prompt: "Prepare the brief",
    cron: "0 9 * * *",
    timezone: "Africa/Lagos",
    libraryFolderId: null,
  });
  const run = await harness.store.startRoutineRun(routine.id);
  assert.equal(await harness.store.finishRoutineRun(run.id, "first"), true);
  assert.equal(await harness.store.finishRoutineRun(run.id, "duplicate"), false);
});
```

`makeRuntimeTestTarget` and `makeRuntimeStoreHarness` are target project adapters, not current or third-party APIs. Target creation chooses a schema name without I/O so teardown can be registered first. Harness startup then validates the base test URL, creates and migrates that schema through the real Drizzle Kit child with only that target bridged to `DATABASE_URL`, injects the database into store factories, and owns the `pg.Pool`. Teardown ends the pool before dropping the schema. It must not import the current singleton `runtime-db.ts` bootstrap.

### Route/provider skeleton (API verification required)

```ts
// packages/agent-runtime/src/app.test.ts
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { setProvider } from "@flue/runtime";
import { test } from "node:test";

const faux = fauxProvider({ provider: "vivid-test" });
faux.setResponses([fauxAssistantMessage([fauxText("deterministic result")])]);
setProvider(faux.provider);

test("invalid routine input is rejected before persistence", async (context) => {
  const target = makeRuntimeTestTarget(requireTestDatabaseUrl()); // no I/O
  context.after(async () => target.closeAndDrop()); // before startup writes
  const runtime = await startRuntimeHarness({
    target,
    model: `${faux.provider.id}/${faux.getModel().id}`,
  });

  const response = await fetch(new URL("/api/routines", runtime.origin), {
    method: "POST",
    headers: runtime.authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.equal(await runtime.countRoutines(), 0);
});
```

This is a target shape, not a claim that `startRuntimeHarness` exists. The faux-provider calls are verified against installed pi-ai/Flue 2.0.3; recheck the target lock after convergence. The harness must mount the actual Hono app, use real stores and Flue Postgres, prevent import-time scheduler/database startup, and register the listener, pools, Flue storage, and scheduler jobs with the pre-registered target teardown. Because provider registration is global with no unregister, run this file without parallel provider-sharing tests.

## Flue durability and failure cases

Cover observable outcomes, not implementation calls:

- Persist `submissionId` before treating local admission as complete.
- Test the actual dangerous window: Flue accepts `dispatch`, then the process crashes before `attachRoutineSubmission` / `attachFollowUpSubmission`. Restart from the durable local run, dispatch again with the same idempotency key, assert Flue returns the deduplicated receipt, attach that `submissionId`, then `read` and finalize once.
- Separately, crash after `submissionId` is attached but before result persistence; restart, `read(submissionId)`, and finish once.
- Crash before durable Flue admission; restart must not invent a submission.
- A timeout, network reset, or 5xx after a write can mean **outcome unknown**. Reconcile by stable id/idempotency key before retrying.
- Duplicate task/follow-up/notification requests produce one durable effect.
- Readiness is an awaited state with a cause, not a fixed delay. Verify unavailable → ready and unavailable → degraded/failed paths.
- Restart tests must create a new process/runtime instance against the same disposable database, not call an in-memory reset method.

## Live model evals

Use `.live.test.ts` only for claims that depend on real model behavior. Gate them behind an explicit opt-in and credentials. The intended package is `vitest-evals` with its pi-ai harness, but it is not currently declared in workspace manifests or the lock. Inspect the refreshed local `vitest-evals` skill and add dependencies through an approved change before naming imports or APIs.

A live eval should record model/version, token and cost usage, judge configuration, and retained runs. It must not be the only test for persistence, authorization, routing, or idempotency; those remain deterministic integration tests with the provider fake.

## Connectors

Keep fakes at the remote network edge only. Run the real connector request construction, Effect error mapping, persistence, and idempotency code against recorded or deterministic simulated HTTP responses.

Cover:

- access-token expiry, refresh, refresh-token rotation, and concurrent refresh;
- 401 after refresh, 429/`Retry-After`, bounded 5xx retry, and network outcome-unknown;
- stable action idempotency keys and replay after process restart;
- redaction: recordings, snapshots, assertions, and logs contain no credentials;
- malformed and forward-compatible provider payloads decoded once at ingress.

Do not record live OAuth secrets. Build recordings from sanitized fixtures and assert that the authorization header is supplied at runtime.

## Alchemy local stack

`pnpm infra:dev` runs Alchemy v2 in the local stage, applies ordered migrations, starts the runtime and Effect server, and wires the web only to the runtime URL/token. Its PostgreSQL 18 container uses a named persistent volume; it is a developer stack, not the disposable `VIVID_TEST_DATABASE_URL` database. Use it for startup, health, migration-order, and runtime-to-web smoke checks. A browser-to-Effect-server auth path is not currently wired through the web and must not be claimed.

Do not use Alchemy dev for destructive database checks, transaction races, scheduler time, crash points, or model quality. It is slower, owns persistent resources/long-lived processes, and does not provide precise fault injection. Never point these checks at a shared stage or remote AWS resources.

## Naming and gating

- `*.test.ts`: deterministic unit or integration tests, including real local PostgreSQL and deterministic provider tests.
- `*.live.test.ts`: explicitly gated tests that call a live model or external provider.
- Before adding these files, add an explicit server test command (none exists today) and split the runtime commands: its current `node --test src/*.test.ts` glob also matches `*.live.test.ts`. The default command must exclude live files; a separate opt-in command may include them.
- `vitest-evals` live files need their own gated Vitest command after the dependency is approved; filename alone is not a gate.
- A test requiring `VIVID_TEST_DATABASE_URL` should skip or fail with one clear message according to the owning package's documented test policy; it must never silently substitute another URL.

## Do not write these tests

- A mock database test for a SQL constraint, transaction, or restart claim.
- A stubbed Better Auth session test presented as authentication coverage.
- A mock Flue conversation/store test presented as durability coverage.
- A test that only proves `Effect.retry`, a Schema literal, or a fake's return value.
- A test that sleeps and hopes a scheduler, readiness state, or retry has advanced.
- Parallel tests sharing fixed IDs, a schema, a global provider, or mutable module state.
- A connector test that mocks the connector itself instead of remote HTTP.
- A model eval used to prove deterministic authorization or persistence behavior.
- A migration test that uses push or hand-written schema SQL.

## Completion checklist

- [ ] The selected seam is the smallest real boundary containing the failure.
- [ ] `VIVID_TEST_DATABASE_URL` is required and cleanup is registered before the first write.
- [ ] Real Drizzle Kit migrations ran against disposable PostgreSQL 18.
- [ ] Pools, listeners, scheduler jobs, and storage are closed; provider globals are process-isolated or deliberately replaced.
- [ ] No sleeps, default database URL, shared IDs, secrets, or unbounded retries remain.
- [ ] The Effect pin and the declared test libraries are described as installed, not as remembered.
- [ ] Restart and outcome-unknown behavior is covered when durability is claimed.
