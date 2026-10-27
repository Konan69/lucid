import * as NodeCrypto from 'node:crypto'
import { RuntimeSubmissionId } from '@vivid/contracts'
import { describe, expect, layer } from '@effect/vitest'
import { Person, PersonId, RunId, RunState, SessionId, ThreadId, Workspace } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Array as Arr, Effect, Layer, Option, Order, Result } from 'effect'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { ActionOrigin, actionOrigin } from '../approvals/gate.ts'
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
    Replayed: ({ turn }) => Effect.succeed(turn),
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
    database
      .insert(threads)
      .values({ id: threadId, personId, title: 'Run test', titleSource: 'Person', updatedAt: 0 }),
  )
  return { personId, threadId }
})

layer(testLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Run failure persistence', () => {
    it.effect(
      'persists the classified reason once and reads legacy failed rows as Unexplained',
      () =>
        Effect.gen(function* () {
          const { personId, threadId } = yield* fixture()
          const store = yield* RunStore
          const database = yield* Database
          const id = RunId.make(NodeCrypto.randomUUID())
          yield* reserve({
            id,
            personId,
            threadId,
            origin: StoredRunOrigin.cases.Message.make({}),
          })
          expect(yield* store.end(id, RunEnding.cases.Failed.make({ reason: 'TimedOut' }))).toBe(
            true,
          )
          expect(yield* store.end(id, RunEnding.cases.Failed.make({ reason: 'NoAnswer' }))).toBe(
            false,
          )
          const recorded = yield* store.list(threadId)
          expect(recorded.map((run) => run.state)).toEqual([
            RunState.cases.Failed.make({ finishedAt: 0, reason: 'TimedOut' }),
          ])
          yield* database.run(
            database.update(runs).set({ failureReason: null }).where(eq(runs.id, id)),
          )
          const legacy = yield* store.list(threadId)
          expect(legacy.map((run) => run.state)).toEqual([
            RunState.cases.Failed.make({ finishedAt: 0, reason: 'Unexplained' }),
          ])
        }).pipe(Effect.scoped),
    )
  })

  /** Real PostgreSQL transactions prove that two deliveries cannot claim the same place in a Thread. */
  describe.skipIf(!testDatabaseConfigured)('Delivery turn authority', () => {
    /** The gate uses the host turn; checking all rows prevents a later foreign Run lending authority. */
    it.effect(
      'resolves joined same-Person actions to the oldest turn and refuses any other Person',
      () =>
        Effect.gen(function* () {
          const { personId, threadId } = yield* fixture()
          const other = yield* fixture()
          const store = yield* RunStore
          const database = yield* Database
          const actor = {
            person: new Person({ id: personId, name: 'Run test', email: 'run@example.test' }),
            workspace: Workspace.cases.Personal.make({}),
            by: 'vivid' as const,
            threadId: Option.some(threadId),
          }
          const host = RunId.make(NodeCrypto.randomUUID())
          const joined = RunId.make(NodeCrypto.randomUUID())
          const ids = [host, joined]
          for (const id of ids) {
            yield* reserve({
              id,
              personId,
              threadId,
              origin: StoredRunOrigin.cases.Message.make({}),
            })
            yield* store.admitted({ runId: id, submissionId: RuntimeSubmissionId.make(1) })
          }
          expect(yield* actionOrigin(actor)).toEqual(
            ActionOrigin.cases.Run.make({ threadId, runId: host }),
          )
          const foreign = RunId.make(NodeCrypto.randomUUID())
          yield* reserve({
            id: foreign,
            personId,
            threadId,
            origin: StoredRunOrigin.cases.Message.make({}),
          })
          yield* store.admitted({ runId: foreign, submissionId: RuntimeSubmissionId.make(1) })
          // Admission prevents this state normally; old or inconsistent rows must still fail closed.
          yield* database.run(
            database.update(runs).set({ personId: other.personId }).where(eq(runs.id, foreign)),
          )
          const refusal = yield* actionOrigin(actor).pipe(Effect.flip)
          expect(refusal._tag).toBe('NotFound')
          expect(refusal.message).toBe('Action is acting for another Person')
          yield* store.end(host, RunEnding.cases.Completed.make({}))
          yield* store.end(joined, RunEnding.cases.Completed.make({}))
          yield* store.end(foreign, RunEnding.cases.Completed.make({}))
          expect(yield* actionOrigin(actor)).toEqual(
            ActionOrigin.cases.RuntimeThread.make({ threadId }),
          )
        }).pipe(Effect.scoped),
    )

    it.effect('allocates racing turns once and retains acting authority on replay', () =>
      Effect.gen(function* () {
        const { personId, threadId } = yield* fixture()
        const store = yield* RunStore
        const inputs = Array.from({ length: 8 }, () => ({
          id: RunId.make(NodeCrypto.randomUUID()),
          threadId,
          personId,
          origin: StoredRunOrigin.cases.Message.make({}),
        }))
        const turns = yield* Effect.forEach(inputs, (input) => reserve(input), {
          concurrency: 'unbounded',
        })
        expect(Arr.sort(turns, Order.Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        const replayed = yield* Effect.forEach(inputs, reserve)
        expect(replayed).toEqual(turns)
        for (const turn of turns)
          expect(yield* store.scope({ threadId, turn })).toEqual({
            acting: personId,
          })
        expect(
          Arr.sort(
            (yield* store.list(threadId)).map((run) => run.turn),
            Order.Number,
          ),
        ).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      }).pipe(Effect.scoped),
    )

    it.effect(
      'refuses a Person session and an attributed runtime call, accepts only bare runtime authority',
      () =>
        Effect.gen(function* () {
          const { personId, threadId } = yield* fixture()
          const turn = yield* reserve({
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
          expect(scope).toEqual({ acting: personId })
        }).pipe(Effect.scoped),
    )
  })
})
