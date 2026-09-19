import { Cause, Config, Context, Effect, Layer, Option } from 'effect'

export interface TestDatabaseService {
  readonly taskStore: typeof import('./task-store.ts')
  readonly routineStore: typeof import('./routine-store.ts')
  readonly cleanupTask: (taskId: string) => Effect.Effect<void, Cause.UnknownError>
  readonly cleanupRoutinesNamed: (name: string) => Effect.Effect<void, Cause.UnknownError>
  readonly close: () => Effect.Effect<void>
}

/** Test-only access to stores whose production adapter reads `DATABASE_URL`. */
export class TestDatabase extends Context.Service<TestDatabase, TestDatabaseService>()(
  'vivid/TestDatabase',
) {}

/**
 * `describe.skipIf` needs a synchronous condition. The package Vitest config
 * separately adapts this same Effect-decoded value to production `DATABASE_URL`.
 */
export const testDatabaseConfigured = Option.isSome(
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Vitest suite declaration requires a synchronous skip condition.
  Effect.runSync(Config.option(Config.Redacted('VIVID_TEST_DATABASE_URL'))),
)

/**
 * Require the isolated URL, wait for the production store schema, and close
 * the pool when the shared test layer releases.
 */
export const testDatabaseLayer = Layer.effect(
  TestDatabase,
  Effect.acquireRelease(
    Effect.gen(function* () {
      yield* Config.Redacted('VIVID_TEST_DATABASE_URL')

      const [runtime, taskStore, routineStore] = yield* Effect.tryPromise(() =>
        Promise.all([
          import('./runtime-db.ts'),
          import('./task-store.ts'),
          import('./routine-store.ts'),
        ]),
      )
      yield* Effect.tryPromise(() => runtime.schemaReady)

      return TestDatabase.of({
        taskStore,
        routineStore,
        cleanupTask: Effect.fn('TestDatabase.cleanupTask')(function* (taskId) {
          yield* Effect.tryPromise(() =>
            runtime.pool.query('DELETE FROM vivid_notifications WHERE task_id = $1', [taskId]),
          )
          yield* Effect.tryPromise(() => taskStore.deleteTask(taskId))
        }),
        cleanupRoutinesNamed: Effect.fn('TestDatabase.cleanupRoutinesNamed')(function* (name) {
          yield* Effect.tryPromise(() =>
            runtime.pool.query('DELETE FROM vivid_routines WHERE name = $1', [name]),
          )
        }),
        close: Effect.fn('TestDatabase.close')(function* () {
          yield* Effect.promise(() => runtime.pool.end())
        }),
      })
    }),
    Effect.fn('TestDatabase.release')(function* (database) {
      yield* database.close()
    }),
  ),
)
