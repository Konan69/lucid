import { defineConfig } from 'vitest/config'

/**
 * One runner for every workspace package. Each package is its own project so a
 * filter such as `vitest --project @vivid/agent-runtime` runs a single surface,
 * and so package-local config (setup files, environment) stays with its owner.
 *
 * Database-backed suites read `VIVID_TEST_DATABASE_URL` only; they must never
 * fall back to `DATABASE_URL`. Tooling tests under `scripts/` stay on
 * `node --test` because they exercise plain Node entry points.
 */
export default defineConfig({
  test: {
    projects: ['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'],
    passWithNoTests: true,
  },
})
