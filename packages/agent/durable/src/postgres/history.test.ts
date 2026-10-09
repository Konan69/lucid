import { describe } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { historyCases } from '../fixtures/paging.ts'
import { FixtureFailed } from '../fixtures/harness.ts'
import { postgresFixture } from './testing.ts'

const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])

/** Disposable PostgreSQL exercises the same host API and real fork-aware scans.
 * Schema cleanup is registered before opening and writing any fixture records. */
describe.skipIf(Option.isNone(testUrl))('PostgreSQL', () => {
  historyCases('PostgreSQL', () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    return Effect.tryPromise({
      try: () => fixture.open(),
      catch: (cause) => new FixtureFailed({ cause }),
    })
  })
})
