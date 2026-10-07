import * as Layer from 'effect/Layer'
import { describe, expect, layer } from '@effect/vitest'
import { sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { Database, decodeStored } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { trustTestServices } from './testing.ts'

const planRows = Schema.Array(
  Schema.Struct({
    'QUERY PLAN': Schema.Array(
      Schema.Struct({
        Plan: Schema.Struct({
          'Index Name': Schema.String,
          Filter: Schema.optional(Schema.String),
        }),
      }),
    ),
  }),
)
const planResult = Schema.Struct({ rows: planRows })

/** A replay index must exclude settled/history rows itself, rather than filter them after scanning.
 * Local planner settings make index eligibility observable even in a small disposable database. */
/** Share only PostgreSQL; each case builds its own recording ports and captured stores. */
layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Signal replay query plans', () => {
    for (const table of ['vivid_approvals', 'vivid_input_requests']) {
      it.effect(`${table} claims use an index containing only owed signals`, () =>
        Effect.gen(function* () {
          // This scoped acquisition keeps mutable test ports and their captured stores fresh per case.
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const database = yield* Database
            const result = yield* database.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.execute(sql`set local enable_seqscan = off`)
                yield* tx.execute(sql`set local enable_bitmapscan = off`)
                return yield* tx.execute(sql`
              explain (format json) select id from ${sql.identifier(table)}
              where signal->>'_tag' = 'Owed' and signal_due_at <= 0
            `)
              }),
            )
            const { rows: plans } = yield* decodeStored(planResult, 'replay query plan')(result)
            expect(plans).toMatchObject([
              { 'QUERY PLAN': [{ Plan: { 'Index Name': `${table}_signal` } }] },
            ])
            for (const row of plans) {
              for (const plan of row['QUERY PLAN']) expect(plan.Plan.Filter).toBeUndefined()
            }
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
      )
    }
  })
})
