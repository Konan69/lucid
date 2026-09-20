import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { TaskId } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { TaskStore, taskStoreLayer } from './store.ts'
import { tasks } from './tables.ts'
import { eq } from 'drizzle-orm'

const testLayer = taskStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))

describe.skipIf(!testDatabaseConfigured)('TaskStore', () => {
  layer(testLayer)((it) => {
    it.effect('persists a Task and atomically claims its due follow-up once', () =>
      Effect.gen(function* () {
        const store = yield* TaskStore
        const database = yield* Database
        const id = TaskId.make(NodeCrypto.randomUUID())
        yield* Effect.addFinalizer(() =>
          database.run(database.delete(tasks).where(eq(tasks.id, id))).pipe(Effect.ignore),
        )
        const task = yield* store.create({
          request: { id, title: 'Review contract' },
          origin: { kind: 'manual' },
          createdBy: 'you',
        })
        const followUp = yield* store.addFollowUp(task.id, { at: 0 }, 'you')
        const first = yield* store.claimDueFollowUps()
        const replay = yield* store.claimDueFollowUps()
        expect(first.map((item) => item.id)).toContain(followUp.id)
        expect(replay.map((item) => item.id)).not.toContain(followUp.id)
      }),
    )
  })
})
