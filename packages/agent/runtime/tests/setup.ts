import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'

/**
 * Vitest 5 runs setupFiles in each worker before importing the test module (run.C5UmxDPh.js,
 * runSetupFiles/collectTests). Workers inherit the shell's environment, so DATABASE_URL must
 * come only from VIVID_TEST_DATABASE_URL, or be absent. This is the runtime project's sole
 * mapping adapter; it never reads DATABASE_URL. Delete instead of vi.stubEnv so unstubbing cannot
 * restore live authority. An empty URL must fail: pg otherwise falls back to ambient PG* values.
 */
const supplied = NodeProcess.env.VIVID_TEST_DATABASE_URL
if (supplied === undefined) {
  delete NodeProcess.env.DATABASE_URL
} else if (supplied === '') {
  throw new Error('VIVID_TEST_DATABASE_URL must be non-empty when supplied')
} else {
  NodeProcess.env.DATABASE_URL = supplied
}

/**
 * Runtime authority is settled here for the same reason, and cannot be settled later. Effect
 * rc.116 `ConfigProvider.fromEnv` copies `process.env` once (src/ConfigProvider.ts, fromEnv), and
 * the `ConfigProvider` reference caches that default for the process (src/Context.ts,
 * getDefaultValue). `src/providers/rehearsal.ts` reads `Config` while a test module is imported,
 * so the copy exists before any case runs. `src/app.ts` and `src/client.ts` then read it through
 * their own `Effect.runPromise`, which a provider Layer around a test does not reach. A case that
 * changes `process.env` afterwards changes nothing those programs can see.
 *
 * No inherited product server: `client.ts` reads `VIVID_SERVER_URL` before it builds a client, so
 * with it absent every context read fails at configuration and no request leaves the worker.
 * No inherited credential: the worker's token is its own, and fixtures read it back through
 * `Config`, the path the application uses, so the two cannot disagree.
 */
delete NodeProcess.env.VIVID_SERVER_URL
NodeProcess.env.VIVID_RUNTIME_TOKEN = NodeCrypto.randomUUID()
