import { defineConfig } from 'vitest/config'

/** Reuse the production database migrations and per-file disposable clone setup. */
export default defineConfig({
  test: {
    name: 'history-reader',
    environment: 'node',
    include: ['scripts/oneoff/reader.test.ts'],
    globalSetup: ['./apps/server/tests/template.ts'],
    setupFiles: ['./apps/server/tests/setup.ts', './packages/agent/runtime/tests/setup.ts'],
    maxWorkers: 1,
  },
})
