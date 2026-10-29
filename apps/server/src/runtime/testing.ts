import * as NodeCrypto from 'node:crypto'
import { expect } from '@effect/vitest'
import { PersonId, ThreadId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseLayer } from '../database/testdb.ts'
import { runStoreLayer } from '../threads/runs.ts'
import { threads } from '../threads/tables.ts'

/** Server fixtures resolve Drizzle from the persistence owner's package, preserving its nominal SQL types. */
export const productLayer = runStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))

/** Cleanup failures must fail the suite instead of leaving private test rows silently behind. */
const cleanupFailed = () => Effect.sync(() => expect.fail('Product fixture cleanup failed'))

/** Product rows use the same public RunStore tested in production; no failure envelope is manufactured. */
export const productFixture = Effect.fn('Models.test.product')(function* () {
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database
      .run(database.delete(threads).where(eq(threads.id, threadId)))
      .pipe(
        Effect.andThen(
          database.run(database.delete(personTable).where(eq(personTable.id, personId))),
        ),
        Effect.asVoid,
        Effect.catch(cleanupFailed),
      ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: personId, name: 'Provider test', email: `${personId}@example.test` }),
  )
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      personId,
      title: 'Provider test',
      titleSource: 'Person',
      updatedAt: 0,
    }),
  )
  return { personId, threadId }
})
