import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import {
  LibraryFolderId,
  Person,
  PersonId,
  RunId,
  RunState,
  SessionId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Array as Arr, Effect, Layer, Order, Result } from 'effect'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { threadHandlers } from './handlers.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { StoredRunOrigin } from './conversation.ts'
import { RunEnding, RunStore, runStoreLayer, TurnReservation } from './runs.ts'
import { runs, threads } from './tables.ts'

const testLayer = runStoreLayer.pipe(Layer.provideMerge(testDatabaseLayer))

/** These fixtures expect free turns; a busy reservation must fail the test rather than invent a number. */
const reserve = Effect.fn('Run.test.reserve')(function* (
  input: Parameters<RunStore['Service']['start']>[0],
) {
  const reservation = yield* (yield* RunStore).start(input)
  return yield* TurnReservation.match(reservation, {
    Reserved: ({ turn }) => Effect.succeed(turn),
    Busy: () => Effect.sync(() => expect.fail('Fixture Thread unexpectedly busy')),
  })
})

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
      yield* reserve({
        id,
        personId,
        threadId,
        libraryFolder: null,
        origin: StoredRunOrigin.cases.Message.make({}),
      })
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

/** Real PostgreSQL transactions prove that two deliveries cannot claim the same place in a Thread. */
describe.skipIf(!testDatabaseConfigured)('Delivery turn authority', () => {
  it.effect('allocates racing turns once and retains confinement on replay', () =>
    Effect.gen(function* () {
      const { personId, threadId } = yield* fixture()
      const store = yield* RunStore
      const folder = LibraryFolderId.make(NodeCrypto.randomUUID())
      const inputs = Array.from({ length: 8 }, () => ({
        id: RunId.make(NodeCrypto.randomUUID()),
        threadId,
        personId,
        origin: StoredRunOrigin.cases.Message.make({}),
        libraryFolder: folder,
      }))
      const turns = yield* Effect.forEach(inputs, (input) => reserve(input), {
        concurrency: 'unbounded',
      })
      expect(Arr.sort(turns, Order.Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      const replayed = yield* Effect.forEach(inputs, (input) =>
        reserve({ ...input, libraryFolder: LibraryFolderId.make(NodeCrypto.randomUUID()) }),
      )
      expect(replayed).toEqual(turns)
      for (const turn of turns)
        expect(yield* store.scope({ threadId, turn })).toEqual({
          acting: personId,
          libraryFolder: folder,
        })
      expect(
        Arr.sort(
          (yield* store.list(threadId)).map((run) => run.turn),
          Order.Number,
        ),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )

  it.effect(
    'refuses a Person session and an attributed runtime call, accepts only bare runtime authority',
    () =>
      Effect.gen(function* () {
        const { personId, threadId } = yield* fixture()
        const turn = yield* reserve({
          libraryFolder: null,
          id: RunId.make(NodeCrypto.randomUUID()),
          threadId,
          personId,
          origin: StoredRunOrigin.cases.Message.make({}),
        })
        const person = new Person({ id: personId, name: 'Run test', email: 'run@example.test' })
        const workspace = Workspace.cases.Personal.make({})
        for (const auth of [
          AuthState.Person({ person, workspace, sessionId: SessionId.make('test-session') }),
          AuthState.Vivid({ person, workspace, threadId }),
        ]) {
          const result = yield* Effect.result(
            threadHandlers
              .GetDeliveryScope({ threadId, turn })
              .pipe(Effect.provideService(AuthContext, auth)),
          )
          expect(Result.isFailure(result) && result.failure._tag).toBe('Forbidden')
        }
        const scope = yield* threadHandlers
          .GetDeliveryScope({ threadId, turn })
          .pipe(Effect.provideService(AuthContext, AuthState.Runtime()))
        expect(scope).toEqual({ acting: personId, libraryFolder: null })
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  )
})
