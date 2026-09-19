import { describe, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { TestDatabase, testDatabaseConfigured, testDatabaseLayer } from './testdb.ts'

const routineName = 'Morning brief'

describe.skipIf(!testDatabaseConfigured)('routine store', () => {
  layer(testDatabaseLayer)((it) => {
    it.effect('an unfinished routine run remains resumable by its Flue submission', () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase
        yield* Effect.addFinalizer(() =>
          database.cleanupRoutinesNamed(routineName).pipe(Effect.orDie),
        )
        yield* database.cleanupRoutinesNamed(routineName)

        const routine = yield* Effect.tryPromise(() =>
          database.routineStore.createRoutine({
            name: routineName,
            prompt: 'Prepare the brief',
            cron: '0 9 * * *',
            timezone: 'Africa/Lagos',
            libraryFolderId: null,
          }),
        )
        const run = yield* Effect.tryPromise(() =>
          database.routineStore.startRoutineRun(routine.id),
        )
        yield* Effect.tryPromise(() =>
          database.routineStore.attachRoutineSubmission(run.id, 'submission-456'),
        )

        const resumable = (yield* Effect.tryPromise(() =>
          database.routineStore.listRunningRoutineRuns(),
        )).find((item) => item.id === run.id)
        expect(resumable).toMatchObject({ submissionId: 'submission-456' })
        expect(
          yield* Effect.tryPromise(() =>
            database.routineStore.finishRoutineRun(run.id, 'First durable result'),
          ),
        ).toBe(true)
        expect(
          yield* Effect.tryPromise(() =>
            database.routineStore.finishRoutineRun(run.id, 'Duplicate result'),
          ),
        ).toBe(false)

        const [finished] = yield* Effect.tryPromise(() =>
          database.routineStore.listRoutineRuns(routine.id),
        )
        expect(finished).toMatchObject({ output: 'First durable result' })
      }),
    )
  })
})
