import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Fiber, Layer, Scope } from 'effect'
import * as Pg from 'pg'
import { runtimeProcess } from '../tests/child.ts'
import { databaseConfigured, disposableDatabase } from '../tests/database.ts'
import { held, personsOn, start, storesOf, world } from '../tests/process.ts'
import { ada, admit, delivery, IDLE } from '../tests/requests.ts'
import { dropControl, query, storesOn } from '../tests/stores.ts'
import { whileOwned } from './lifetime.ts'
import { ControlLost, MigrationsPending } from './storage/errors.ts'

describe.skipIf(!databaseConfigured)('a runtime that loses its authority', () => {
  it.live(
    'stops recovering stores the moment its control connection is lost',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const given = yield* world()
          // A reply interrupted by a stop: the next process must resume this store.
          const interrupted = yield* held('never said')
          given.faux.setResponses([interrupted.factory])
          const first = yield* Scope.make()
          const before = yield* start(given, { idleMillis: IDLE }).pipe(Scope.provide(first))
          yield* admit(before, ada, delivery('thread-1', 'key-1'))
          yield* interrupted.entered
          yield* Scope.close(first, Exit.void)

          // The next runtime's stores, then the serving side's own scope, then the operator's
          // lock: teardown runs the other way round, as `main.ts` does. The lock goes first, the
          // interrupted recovery is then waited for, and the pool it may still be using ends last.
          const owned = yield* Layer.build(storesOf(given, { idleMillis: IDLE }))
          const serving = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(serving, Exit.void))

          // An operator's session holds the task table, so recovery cannot get past its first read.
          const blocker = yield* Effect.acquireRelease(
            Effect.promise(() => {
              const client = new Pg.Client({ connectionString: given.database })
              return client
                .connect()
                .then(() =>
                  client.query('BEGIN; LOCK TABLE runtime.tasks IN ACCESS EXCLUSIVE MODE'),
                )
                .then(() => client)
            }),
            (client) => Effect.promise(() => client.query('ROLLBACK').finally(() => client.end())),
          )

          const running = yield* Effect.forkChild(
            whileOwned(personsOn(given, { idleMillis: IDLE })).pipe(
              Effect.provide(owned),
              Scope.provide(serving),
            ),
          )
          yield* dropControl(given.database)
          // The loss ends startup while recovery is still blocked, not once it has finished.
          const ended = yield* Fiber.await(running)
          expect(Exit.isFailure(ended)).toBe(true)
          if (Exit.isFailure(ended)) expect(Cause.squash(ended.cause)).toBeInstanceOf(ControlLost)
          // The operator's lock was held the whole time: nothing got past it.
          expect((yield* Effect.promise(() => blocker.query('SELECT 1 AS held'))).rows).toEqual([
            { held: 1 },
          ])
        }),
      ),
    20_000,
  )
})

/** A database as it is before the ordered migrations reach the runtime's owner. */
const unmigrated = Effect.fn('LifetimeTest.unmigrated')(function* () {
  const database = yield* disposableDatabase()
  yield* query(database, 'DROP SCHEMA runtime CASCADE')
  yield* query(database, 'DROP SCHEMA runtime_migrations CASCADE')
  return database
})

/**
 * The runtime service's pre-deploy command as Railway runs it (`infra/railway.ts`), from the
 * repository root, with only `DATABASE_URL` pointing at this case's database.
 */
const migrate = (database: string) =>
  Effect.sync(() =>
    NodeChildProcess.spawnSync('pnpm', ['--filter', '@vivid/agent-runtime', 'db:migrate'], {
      cwd: NodeURL.fileURLToPath(new URL('../../../../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: database },
      encoding: 'utf8',
    }),
  )

describe.skipIf(!databaseConfigured)('a runtime that starts before its migration', () => {
  it.live(
    'refuses to start, changing nothing, and starts once the migration has run',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* unmigrated()
          const early = yield* Effect.exit(Effect.scoped(storesOn(database)))
          expect(Exit.isFailure(early)).toBe(true)
          if (Exit.isFailure(early))
            expect(Cause.squash(early.cause)).toBeInstanceOf(MigrationsPending)
          // Nothing was created: no schema, so no owner row and no lock taken.
          expect(
            yield* query(database, "SELECT to_regclass('runtime.owner') IS NULL AS absent"),
          ).toEqual([{ absent: true }])
          expect((yield* migrate(database)).status).toBe(0)
          yield* storesOn(database)
        }),
      ),
    60_000,
  )

  it.live(
    'exits the process non-zero, naming the migration it waits for',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* unmigrated()
          const notes = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-early-'))),
            (directory) =>
              Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
          )
          const runtime = yield* runtimeProcess({ database, notes })
          expect(yield* runtime.exit).not.toBe(0)
          expect(runtime.output()).toContain('MigrationsPending')
          expect(runtime.output()).toContain('has not applied the runtime migration 2026')
        }),
      ),
    60_000,
  )
})
