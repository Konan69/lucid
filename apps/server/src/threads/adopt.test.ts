import * as NodeCrypto from 'node:crypto'
import { expect, layer, describe } from '@effect/vitest'
import {
  PersonId,
  RunId,
  RuntimeSubmissionId,
  ThreadId,
  RuntimeHistoryMap,
  RuntimeHistoryResult,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { StoredRunOrigin } from './conversation.ts'
import { adoptRuns } from './adopt.ts'
import { RunStore, runStoreLayer } from './runs.ts'
import { runs, threads } from './tables.ts'

layer(runStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer)))((it) => {
  describe.skipIf(!testDatabaseConfigured)('receipt adoption', () => {
    it.effect('adopts mapped receipts, clears unmapped ones, and ends receiptless work once', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const personId = PersonId.make(NodeCrypto.randomUUID())
        const threadId = ThreadId.make(NodeCrypto.randomUUID())
        const ids = Array.from({ length: 3 }, () => RunId.make(NodeCrypto.randomUUID()))
        yield* Effect.addFinalizer(() =>
          database.run(database.delete(threads).where(eq(threads.id, threadId))).pipe(
            Effect.andThen(
              database.run(database.delete(personTable).where(eq(personTable.id, personId))),
            ),
            Effect.asVoid,
            Effect.catch(() => Effect.sync(() => expect.fail('Adoption fixture cleanup failed'))),
          ),
        )
        yield* database.run(
          database
            .insert(personTable)
            .values({ id: personId, name: 'History', email: `${personId}@example.test` }),
        )
        yield* database.run(
          database.insert(threads).values({
            id: threadId,
            personId,
            title: 'Earlier Thread',
            titleSource: 'Person',
            updatedAt: 1,
          }),
        )
        for (const [turn, id] of ids.entries())
          yield* database.run(
            database.insert(runs).values({
              id,
              threadId,
              personId,
              turn,
              origin: StoredRunOrigin.cases.Message.make({}),
              state: turn === 2 ? 'working' : 'completed',
              startedAt: 1,
              finishedAt: turn === 2 ? null : 2,
              receipt: { runId: `earlier-${turn}`, offset: '1', incarnation: 'earlier' },
            }),
          )
        const map = RuntimeHistoryMap.make([
          {
            personId,
            ...RuntimeHistoryResult.cases.Loaded.make({
              threadId,
              deliveries: [{ requestId: 'earlier-0', submissionId: RuntimeSubmissionId.make(7) }],
            }),
          },
        ])
        expect(yield* adoptRuns(map)).toBeGreaterThanOrEqual(3)
        const read = database.run(
          database.select().from(runs).where(eq(runs.threadId, threadId)).orderBy(runs.turn),
        )
        const adopted = yield* read
        expect(adopted.map((run) => run.receipt)).toEqual([
          { runId: ids[0], submissionId: '7' },
          null,
          null,
        ])
        expect(yield* adoptRuns(map)).toBe(0)
        expect(yield* read).toEqual(adopted)
        const store = yield* RunStore
        yield* store.working
        const ended = yield* store.list(threadId)
        expect(ended.map((run) => run.state._tag)).toEqual(['Completed', 'Completed', 'Unknown'])
        yield* store.working
        expect(yield* store.list(threadId)).toEqual(ended)
      }).pipe(Effect.scoped),
    )
  })
})
