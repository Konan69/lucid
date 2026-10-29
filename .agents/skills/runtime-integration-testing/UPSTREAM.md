# Local provenance

- Source: Vivid repository-local adaptation of the VCOS owner doctrine
- Source type: `local`
- Owner reference: the VCOS repository, `.agents/skills/runtime-integration-testing/SKILL.md` (repository-relative; the owner directory holds no `UPSTREAM.md`)
- Owner file last changed: `f5e0e85e460f20dee1db2f954cf9e79ef71da365` (`2026-09-17`)
- External upstream: none discoverable. No official Effect, Flue, Better Auth or Vitest skill is the source of this one; its API facts come from installed package source.
- First added to Vivid: `0f3d7bb605b57089ace331c1ae3f09400013d615` and `0975e5b5658f843391428aa2e54cee717806dfa0` (`2026-09-19`)
- Rewritten from source: `2026-10-04`. This file names no commit for that rewrite; `git log` on `SKILL.md` is the record.

## What is kept from the owner

The owner rule is preserved: test a real runtime seam, and do not use a mock to prove runtime behavior. The 21 October 2026 policy puts state invariants in the Effect Machine or the type model and removes pure unit tests.

Everything specific to the owner's platform was replaced. The owner skill is written for Cloudflare Workers, workerd and Durable Objects. Vivid's skill covers product PostgreSQL, the Effect RPC server and HTTP routes, mounted Better Auth, the Pi/celld runtime boundary, and Integrations transport. It is a deliberate adaptation, not a vendor copy, so there is no owner conflict to resolve on refresh.

## Seams the skill now names

`SKILL.md` is authoritative. The list below records the 2026-10-04 source review. Runtime findings from that review are historical and do not prove Pi/celld integration. Version numbers are not repeated here: `AGENTS.md` owns the pins and `SKILL.md` lists what was verified.

- **Pins.** The workspace catalog, the lockfile and the installed packages agree for Effect, `@effect/platform-node`, `@effect/sql-pg`, `@effect/vitest`, Vitest, Better Auth, Flue, pi-ai and Drizzle. `@effect/vitest` remains a direct dev dependency of packages with retained Effect integration tests, including the server and runtime.
- **Database.** `apps/server/tests/template.ts` (one migrated template per Vitest invocation, through Drizzle Kit) and `apps/server/tests/setup.ts` (one clone per test file). `apps/server/src/database/testdb.ts` exports `testDatabaseConfigured`, `testConfigLayer` and `testDatabaseLayer`. Only `VIVID_TEST_DATABASE_URL` is read as input; Product `DATABASE_URL` is written from it by the template's migration child and `testConfigLayer`, and never read back. The supplied database is administration-only for the server project. The runtime's custom PG adapter is being deleted; it is not a future test backend.
- **Server.** There is no `HttpApi` in the repository. Product calls are `VividRpc` over `RpcServer`; `apps/server/src/http/router.ts` exports `routerLayer`. Tests use `RpcTest.makeClient`, `HttpRouter.toHttpEffect`, or `NodeHttpServer.layerTest` with `HttpRouter.serve`. All four symbols exist in the installed Effect source.
- **Better Auth.** `authEffect` in `apps/server/src/auth/provider.ts` reads `ServerConfig` from context, so it follows the test configuration.
- **Runtime.** The chosen host is one celld Person cell with a native Pi Durable Harness over
  Durable Object SQLite, defined in [Runtime cells](../../../docs/27-runtime-cells.md). The
  existing integration is Pi 1.2.0; the target uses Pi 1.4.0 and celld 0.6.2. Pi owns tasks,
  queues, deduplication, wait, abort, restart, and `onWake`/alarm scheduling. celld owns activation,
  ownership, and idle lifecycle. Cell host, Notes, infrastructure, and verification integration
  are in progress and unproven. The existing verifier still launches the old Node host and calls
  a runtime PG migration command; cell-backed journeys are blocked until that wiring is replaced.
- **Commands.** Both packages run `vitest run`; root `pnpm test` is `turbo run test`.

## Corrections to the earlier notes

The first version of this file said the lockfile resolved an older Effect release candidate than the manifests, that `@effect/vitest` was not a direct dependency, that the server was an Effect `HttpApi`, that Flue was an older major-minor, and that server and runtime app factories and database harnesses "still require extraction". None of these is true of the current source. The database harness exists on disk, and the skill forbids a parallel factory beside it.

## Remaining limitations

These are the skill's "Missing capabilities", unchanged by this file:

- No in-process composed server: nothing builds `routerLayer` whole or exports the Layer graph of `main.ts`.
- No in-process signup or cookie test; mounted signup is exercised only against a running stack.
- Isolation is per test file plus per-case row cleanup, not per test case.
- The cell-backed runtime fixture and verifier launcher are not yet integrated.
- No test proves that a new operating-system process recovers work owed by one that stopped. `apps/server/src/library/extraction.test.ts` does launch the production command as a real process and proves its exit; restart recovery is proven with a fresh Layer over the same database.
- `vitest-evals` is not a workspace dependency.

The 2026-10-04 review ran no tests, lint, typecheck, build, server, or database. This host-transition update read Pi 1.4.0 and celld 0.6.2 source but ran no runtime proof. Re-verify installed source when a pin moves.
