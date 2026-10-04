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
