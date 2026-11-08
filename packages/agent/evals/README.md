# Evaluations

**Nothing lives here.** Live checks sit beside the code they prove as `.live.test.ts` files
(`apps/server/src/**`), skipped unless their test configuration and real credentials are present.
Memory model suites require `VIVID_LIVE_MEMORY=1` and `OPENROUTER_API_KEY`; storage-backed live
checks also need isolated Helix (`VIVID_TEST_HELIX_URL`) and disposable PostgreSQL
(`VIVID_TEST_DATABASE_URL`). Ordinary memory privacy, graph and idempotency tests use real
isolated storage with deterministic provider inputs and need no model credentials. For
rehearsing the whole product without a provider there is the scripted model,
`packages/agent/runtime/src/providers/rehearsal.ts` (`VIVID_MODEL=rehearsal/script`). Behavioural
checks of memory extraction, brief generation, and post-Run learning are built in
`apps/server/src/memory/*.live.test.ts`. A broad evaluation suite of Vivid's product judgement
is not built.
