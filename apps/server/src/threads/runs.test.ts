import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { PersonId, RunId, RunState, ThreadId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { StoredRunOrigin } from './conversation.ts'
import { RunEnding, RunStore, runStoreLayer } from './runs.ts'
import { runs, threads } from './tables.ts'

const testLayer = runStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))

/** Cleanup precedes the first write and removes Thread-owned rows even if settlement assertions fail. */
const fixture = Effect.fn('Run.test.fixture')(function* () {
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(threads).where(eq(threads.id, threadId))).pipe(
      Effect.andThen(
        database.run(database.delete(personTable).where(eq(personTable.id, personId))),
      ),
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Run fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: personId, name: 'Run test', email: `${personId}@example.test` }),
  )
  yield* database.run(
    database.insert(threads).values({ id: threadId, personId, title: 'Run test', updatedAt: 0 }),
  )
  return { personId, threadId }
})

describe.skipIf(!testDatabaseConfigured)('Run failure persistence', () => {
  it.effect('persists the classified reason once and reads legacy failed rows as Unexplained', () =>
    Effect.gen(function* () {
      const { personId, threadId } = yield* fixture()
      const store = yield* RunStore
      const database = yield* Database
      const id = RunId.make(NodeCrypto.randomUUID())
      yield* store.start({ id, personId, threadId, origin: StoredRunOrigin.cases.Message.make({}) })
      expect(yield* store.end(id, RunEnding.cases.Failed.make({ reason: 'TimedOut' }))).toBe(true)
      expect(yield* store.end(id, RunEnding.cases.Failed.make({ reason: 'NoAnswer' }))).toBe(false)
      const recorded = yield* store.list(threadId)
      expect(recorded.map((run) => run.state)).toEqual([
        RunState.cases.Failed.make({ finishedAt: 0, reason: 'TimedOut' }),
      ])
      yield* database.run(database.update(runs).set({ failureReason: null }).where(eq(runs.id, id)))
      const legacy = yield* store.list(threadId)
      expect(legacy.map((run) => run.state)).toEqual([
        RunState.cases.Failed.make({ finishedAt: 0, reason: 'Unexplained' }),
      ])
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )
})
