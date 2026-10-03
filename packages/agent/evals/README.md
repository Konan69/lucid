# Evaluations

**Nothing lives here.** Live checks sit beside the code they prove as `.live.test.ts` files
(`apps/server/src/**`), skipped unless their test configuration and real credentials are present.
Check each suite's exact opt-in: the memory model suites use `VIVID_TEST_HELIX_URL` plus
`EXPLABS_API_KEY`, and the learning suite also requires `VIVID_TEST_DATABASE_URL`. For
rehearsing the whole product without a provider there is the scripted model,
`packages/agent/runtime/src/providers/rehearsal.ts` (`VIVID_MODEL=rehearsal/script`). Behavioural
checks of memory extraction, brief generation, and post-Run learning are built in
`apps/server/src/memory/*.live.test.ts`. A broad evaluation suite of Vivid's product judgement
is not built.
