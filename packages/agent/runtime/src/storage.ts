import { postgres } from '@flue/postgres'
import { Effect } from 'effect'
import type { Pool } from 'pg'

/**
 * Flue's PostgreSQL storage on one pg pool. The adapter owns the pool it is given: its `close`
 * is the only caller of `pool.end()`. The runner is moved verbatim from db.ts; rollback and
 * release semantics deliberately remain unchanged until the separately designed fence slice.
 * Flue 2.2.2 postgres-adapter (dist/index.mjs, postgres) constructs stores without I/O and
 * guards close with its own flag. This framework adapter is a value, not an Effect service.
 */
export const flueStorage = (pool: Pool) => {
  return postgres({
    // @effect-diagnostics-next-line asyncFunction:off -- Flue PostgreSQL query callback requires a Promise of rows.
    query: async (text, params) => (await pool.query(text, params)).rows,
    transaction: (fn) => {
      const connect = Effect.tryPromise(() => pool.connect())
      const transaction = Effect.acquireUseRelease(
        connect,
        (client) => {
          const run = Effect.fn('FlueDatabase.transaction')(function* () {
            yield* Effect.tryPromise(() => client.query('BEGIN'))
            const result = yield* Effect.tryPromise(() =>
              fn({
                // @effect-diagnostics-next-line asyncFunction:off -- Flue transaction query callback requires a Promise of rows.
                query: async (text, params) => (await client.query(text, params)).rows,
              }),
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
}
