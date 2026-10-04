import * as NodeProcess from 'node:process'
import { describe, expect, it } from '@effect/vitest'
import { Config, Effect, Result, Schema, SchemaIssue } from 'effect'
import { testDatabaseConfigured } from '../../../../apps/server/src/database/testdb.ts'

/** Exercise the project setup, including root project runs, without printing either URL. */
it.effect('runtime database authority comes only from the explicit test URL', () =>
  Effect.sync(() => {
    expect(NodeProcess.env.DATABASE_URL === NodeProcess.env.VIVID_TEST_DATABASE_URL).toBe(true)
  }),
)

describe.skipIf(testDatabaseConfigured)('unconfigured runtime database', () => {
  /**
   * Import the production composition root only when no database was supplied. Installed rc.116
   * runSync throws the squashed ConfigError; Config.schema retains the missing key as a Pointer.
   * pg-pool's constructor and Flue postgres() issue no query, so a setup regression fails this
   * assertion without connecting to the ambient database.
   */
  it.effect('refuses to initialize without database authority', () =>
    Effect.gen(function* () {
      const loaded = yield* Effect.tryPromise({
        try: () => import('./db.ts'),
        catch: (error) => {
          if (!(error instanceof Config.ConfigError)) {
            return expect.fail('Runtime database import failed outside its Config contract')
          }
          return error
        },
      }).pipe(Effect.result)
      Result.match(loaded, {
        onSuccess: () =>
          expect.fail('Runtime database initialized without explicit test authority'),
        onFailure: (error) => {
          if (!Schema.isSchemaError(error.cause)) {
            return expect.fail('Expected a missing database configuration key')
          }
          if (!(error.cause.issue instanceof SchemaIssue.Pointer)) {
            return expect.fail('Expected the database configuration issue to retain its key path')
          }
          return expect(error.cause.issue.path).toEqual(['DATABASE_URL'])
        },
      })
    }),
  )
})
