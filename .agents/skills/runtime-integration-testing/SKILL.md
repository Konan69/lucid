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
- Apply migrations through the real Drizzle Kit migrate path: `pnpm db:migrate`, or the owning package's `pnpm --filter <package> db:migrate` while diagnosing one schema. Never use push.
- Register cleanup **before the first write**. Prefer a unique schema/database per test worker. Use transaction rollback only when every operation shares that transaction and no background worker needs another connection.
- Delete rows in foreign-key-safe order and close pools/servers in `after`/`afterEach`, including on assertion failure.

The current `routine-store.test.ts` and `task-store.test.ts` use a real database but set a default `DATABASE_URL`, create durable rows, and do not close their pool. Improve them by requiring `VIVID_TEST_DATABASE_URL`, creating unique IDs or a unique schema, registering cleanup before inserts, and exposing a store/database lifecycle that can be closed. Fixed idempotency IDs must be scoped per test run.

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

Build the same router contributions as `apps/server/src/main.ts`: the Better Auth catch-all, `/health`, and `apiLayer`. Provide a test `Database` backed by a PostgreSQL `PgClient`, provide `ServerConfig`, start an ephemeral Node HTTP listener, and make real HTTP requests.

Do not import `main.ts` as a test harness: it currently launches `NodeRuntime.runMain` during module evaluation. First extract/export an app Layer factory and keep process startup in `main.ts`. The test factory must preserve the production `HttpApiBuilder.layer(api)`, auth middleware, and encoded tagged errors.

Dependency truth matters:

- The lock currently resolves Effect and platform packages at rc.112; manifests target rc.116.
- Verify the installed declarations for `effect`, `@effect/platform-node`, and `@effect/sql-pg` before naming an in-process server/test helper.
- `@effect/vitest` appears only transitively in the stale lock and is not a declared workspace dependency. Do not import or recommend helper names until the package is explicitly available and its pinned API is inspected.
- Until then, ordinary Node test code may launch the real Layer and use standard HTTP. Keep raw Promises at this narrow test/framework adapter only.

### Target server skeleton (requires the named extraction)

```ts
// apps/server/src/api.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";

// Proposed project seam: extract this from main.ts; it does not exist yet.
import { startTestServer } from "./test-server.js";

const databaseUrl = process.env.VIVID_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("VIVID_TEST_DATABASE_URL is required");

const server = await startTestServer({ databaseUrl });
after(async () => server.close());

test("health is served by the composed router", async () => {
  const response = await fetch(new URL("/health", server.origin));
  assert.equal(response.status, 200);
});
```

`startTestServer` is an explicitly deferred local adapter, not an installed Effect helper. Its implementation must be checked against the resolved rc.112 declarations and then rc.116 after lock convergence.

## Better Auth: mount, do not stub

Test through the mounted `* /api/auth/*` handler configured in `apps/server/src/main.ts` and `auth.ts`:

1. POST a unique email/password to the real signup route.
2. Capture every `Set-Cookie` value in a cookie jar.
3. Sign in through the mounted handler when signup does not establish the desired session.
4. Call a protected endpoint such as `/api/me` with the real session cookie.
5. Assert the database rows and public response, not Better Auth internals.

Use Vivid's real `AUTH_SECRET`, `PUBLIC_URL`, `/api/auth` base path, schema map, and `migrate: false`. Migrations remain owned by `apps/server/src/schema.ts` and Drizzle Kit. Never stub `auth.getSession` or manufacture a session cookie.

## Runtime: Hono, Flue, scheduler, and provider

Use the real route map from `packages/agent-runtime/src/app.ts`, real `@flue/postgres` conversation storage, and PostgreSQL-backed stores. Current imports eagerly initialize `runtime-db.ts`, `routine-scheduler.ts`, and the OpenRouter provider. Before isolated route tests are possible, split app construction from process startup and accept explicit store/scheduler/provider registration at that construction boundary.

The deterministic provider is the one legitimate fake for orchestration tests. Register it at Flue's actual `setProvider` seam and return a fixed sequence of model/tool events. Do not mock Flue, its Postgres conversation storage, `init`, `dispatch`, or `read`. Preserve receiver calls.

Scheduler tests must inject a controllable Effect `Clock` or an explicit scheduler clock port after the scheduler is refactored away from import-time initialization. Advance the clock and await an observable admission/result boundary. Never sleep or poll on arbitrary delays.

### Store skeleton improving current cleanup

```ts
// packages/agent-runtime/src/routine-store.test.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const databaseUrl = process.env.VIVID_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("VIVID_TEST_DATABASE_URL is required");

// Proposed seam: factory/lifecycle extraction from runtime-db.ts is required first.
const harness = await makeRuntimeStoreHarness({ databaseUrl });
before(async () => harness.clean()); // registered before the first store write
after(async () => harness.close());

test("a completed run cannot be finalized twice", async () => {
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

`makeRuntimeStoreHarness` is a target project adapter, not a current or third-party API. It should apply the real migrations before tests, own a unique schema, expose existing store operations, clean rows in dependency order, and end the `pg.Pool`.

### Route/provider skeleton (API verification required)

```ts
// packages/agent-runtime/src/app.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

const runtime = await startRuntimeHarness({
  databaseUrl: requireTestDatabaseUrl(),
  providerScript: [{ type: "text", text: "deterministic result" }],
});

test("invalid routine input is rejected before persistence", async () => {
  const response = await fetch(new URL("/api/routines", runtime.origin), {
    method: "POST",
    headers: runtime.authHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.equal(await runtime.countRoutines(), 0);
});
```

This is a target shape, not a claim that `startRuntimeHarness` exists. Verify Hono's installed testing/server adapter before implementing it. The harness must mount the actual app, use real stores and Flue Postgres, disable only external model traffic through `setProvider`, and prevent import-time scheduler startup.

## Flue durability and failure cases

Cover observable outcomes, not implementation calls:

- Persist `submissionId` before treating dispatch as admitted.
- Crash after dispatch but before result persistence; restart, `read(submissionId)`, and finish once.
- Crash before durable admission; restart must not invent a submission.
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

`pnpm infra:dev` runs Alchemy v2 in the local stage, orders the real migration command before runtime/server processes, and wires the web, server, runtime URL, token, and local PostgreSQL. Use it for a small black-box smoke path across deployed local resources.

Do not use Alchemy dev as the primary test for transaction races, scheduler time, crash points, or model quality. It is slower, owns long-lived processes, and does not provide precise fault injection. Do not point destructive checks at a shared stage or remote AWS resources.

## Naming and gating

- `*.test.ts`: deterministic unit or integration tests, including real local PostgreSQL and deterministic provider tests.
- `*.live.test.ts`: explicitly gated tests that call a live model or external provider.
- Keep live files excluded from default test commands unless an opt-in environment flag is present.
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
- [ ] Pools, listeners, scheduler jobs, and provider globals are closed or restored.
- [ ] No sleeps, default database URL, shared IDs, secrets, or unbounded retries remain.
- [ ] rc.112/rc.116 and undeclared test-library APIs are described truthfully.
- [ ] Restart and outcome-unknown behavior is covered when durability is claimed.
