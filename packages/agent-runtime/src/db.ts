// flue-blueprint: database/postgres@1
import { postgres } from '@flue/postgres'
import { Config, Effect, Redacted } from 'effect'
import { Pool } from 'pg'

// Flue imports this module as its database composition root before application services exist.
// oxlint-disable-next-line vivid/no-runpromise-in-library
const databaseUrl = Redacted.value(Effect.runSync(Config.Redacted('DATABASE_URL')))
const pool = new Pool({ connectionString: databaseUrl })

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: (fn) => {
    const connect = Effect.tryPromise(() => pool.connect())
    const transaction = Effect.acquireUseRelease(
      connect,
      (client) => {
        const run = Effect.fn('FlueDatabase.transaction')(function* () {
          yield* Effect.tryPromise(() => client.query('BEGIN'))
          const result = yield* Effect.tryPromise(() =>
            fn({ query: async (text, params) => (await client.query(text, params)).rows }),
          )
          yield* Effect.tryPromise(() => client.query('COMMIT'))
          return result
        })
        return run().pipe(
          Effect.tapError(() =>
            Effect.tryPromise(() => client.query('ROLLBACK')).pipe(Effect.ignore),
          ),
        )
      },
      (client) => Effect.sync(() => client.release()),
    )
    // Flue owns this Promise adapter and invokes it as the transaction framework boundary.
    // oxlint-disable-next-line vivid/no-runpromise-in-library
    return Effect.runPromise(transaction)
  },
  close: () => pool.end(),
})
