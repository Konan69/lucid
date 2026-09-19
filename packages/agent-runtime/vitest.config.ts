import { Config, Effect, Option, Redacted } from 'effect'
import { defineProject } from 'vitest/config'

// oxlint-disable-next-line vivid/no-runpromise-in-library -- Vitest config is the process boundary that injects the isolated URL before workers start.
const testDatabaseUrl = Effect.runSync(Config.option(Config.Redacted('VIVID_TEST_DATABASE_URL')))
const testEnvironment: Record<string, string> = Option.isSome(testDatabaseUrl)
  ? { DATABASE_URL: Redacted.value(testDatabaseUrl.value) }
  : {}

export default defineProject({
  test: {
    name: '@vivid/agent-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true,
    env: testEnvironment,
  },
})
