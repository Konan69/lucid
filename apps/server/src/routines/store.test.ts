import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as Option from 'effect/Option'
import { RoutineId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { RoutineStore, routineStoreLayer } from './store.ts'
import { routines } from './tables.ts'

const testLayer = routineStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))

describe.skipIf(!testDatabaseConfigured)('RoutineStore', () => {
  layer(testLayer)((it) => {
    it.effect('persists a Routine and one accepted occurrence', () =>
      Effect.gen(function* () {
        const store = yield* RoutineStore
        const database = yield* Database
        const name = `Routine ${NodeCrypto.randomUUID()}`
        const routine = yield* store.create({
          name,
          prompt: 'Summarize updates',
          cron: '0 9 * * *',
          timezone: 'UTC',
        })
        yield* Effect.addFinalizer(() =>
          database
            .run(database.delete(routines).where(eq(routines.id, routine.id)))
            .pipe(Effect.ignore),
        )
        const occurrence = yield* store.startOccurrence(routine.id)
        expect(occurrence.routineId).toBe(routine.id)
        const stored = yield* store.get(RoutineId.make(routine.id))
        if (Option.isNone(stored)) return yield* Effect.fail(new Error('Routine was not persisted'))
        expect(stored.value.runs).toHaveLength(1)
        return yield* Effect.void
      }),
    )
  })
})
