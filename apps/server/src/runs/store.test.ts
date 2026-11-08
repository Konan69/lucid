import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import {
  ChildEnding,
  ChildFailure,
  ChildReport,
  ChildRunState,
  DEFAULT_CHILD_BUDGET,
  PersonId,
  PersonSummary,
  Run,
  RunOrigin,
  RunState,
  RuntimeChildAnswer,
  RuntimeSubmissionId,
  ThreadId,
  type ChildRun,
  type RunId,
  type WorkerKind,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Queue, Ref, Result, Stream } from 'effect'
import { ActionOrigin, actionOrigin } from '../approvals/gate.ts'
import { requireActor } from '../auth/access.ts'
import { authenticateHelper } from '../auth/session.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { Conversation, StoredRunOrigin, type ServerDelivery } from '../threads/conversation.ts'
import { deliveryRunId } from '../threads/key.ts'
import { RunStore, runStoreLayer } from '../threads/runs.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { childHandlers } from './handlers.ts'
import { childRuns } from './tables.ts'
import { ChildRuns, childRunsLayer } from './store.ts'

const testLayer = Layer.mergeAll(runStoreLayer, threadStoreLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0 }

/**
 * A Thread with one admitted Run answering its creator, and the helper store over it. The runtime
 * answers every helper as finished and records the stops it was asked for; the Thread records the
 * result deliveries it was given. Cleanup is registered before the first write.
 */
const fixture = Effect.fn('Helpers.test.fixture')(function* () {
  const database = yield* Database
  const personId = PersonId.make(NodeCrypto.randomUUID())
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(threads).where(eq(threads.id, threadId))).pipe(
      Effect.andThen(
        database.run(database.delete(personTable).where(eq(personTable.id, personId))),
      ),
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Helper fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: personId, name: 'Helper test', email: `${personId}@example.test` }),
  )
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      personId,
      title: 'Helper test',
      titleSource: 'Person',
      updatedAt: 0,
    }),
  )
  const delivery = 'message-helper-test'
  const parentRunId = deliveryRunId(threadId, delivery)
  const runs = yield* RunStore
  yield* runs.start({
    id: parentRunId,
    threadId,
    personId,
    origin: StoredRunOrigin.cases.Message.make({}),
  })
  yield* runs.admitted({ runId: parentRunId, submissionId: RuntimeSubmissionId.make(1) })

  const delivered = yield* Queue.unbounded<ServerDelivery>()
  const stopped = yield* Ref.make<ReadonlyArray<RunId>>([])
  const summary = PersonSummary.make({ id: personId, name: 'Helper test', image: null })
  const runtime = Runtime.of({
    admit: () => Effect.die('Helper tests admit nothing'),
    settled: () => Effect.die('Helper tests settle nothing'),
    stop: () => Effect.succeed(false),
    child: () =>
      Effect.succeed(RuntimeChildAnswer.cases.Completed.make({ text: 'Found it', usage })),
    stopChild: (_threadId, runId) =>
      Ref.update(stopped, (all) => [...all, runId]).pipe(Effect.as(true)),
    read: () => Effect.die('Helper tests read nothing'),
    watch: () => Stream.never,
  })
  const conversation = Conversation.of({
    deliver: (input) =>
      Queue.offer(delivered, input).pipe(
        Effect.as(
          Run.make({
            id: deliveryRunId(threadId, input.idempotencyKey),
            threadId,
            turn: 2,
            origin: RunOrigin.cases.ChildResult.make({ person: summary }),
            state: RunState.cases.Working.make({}),
            outcome: null,
            startedAt: 0,
          }),
        ),
      ),
    admit: () => Effect.die('Helper tests admit nothing'),
  })
  const context = yield* Layer.build(
    childRunsLayer.pipe(
      Layer.provide([
        Layer.succeed(Runtime, runtime),
        Layer.succeed(Conversation, conversation),
        silentChangesLayer,
      ]),
    ),
  )
  const helpers = yield* ChildRuns.pipe(Effect.provideContext(context))
  const reporter = { personId, threadId }
  const spawn = (toolCallId: string, kind: WorkerKind = 'Researcher') =>
    helpers.spawn(reporter, {
      delivery,
      toolCallId,
      kind,
      brief: `Read the page for ${toolCallId}`,
      budget: DEFAULT_CHILD_BUDGET,
    })
  const start = (run: ChildRun) =>
    helpers.settle(
      reporter,
      run.id,
      ChildReport.cases.Started.make({ receipt: { conversation: 7, submission: 3 } }),
    )
  return {
    personId,
    threadId,
    parentRunId,
    helpers,
    reporter,
    spawn,
    start,
    delivered,
    stopped,
    context,
  }
})

layer(testLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Helper Runs', () => {
    it.effect('a repeated spawn call reserves the same helper; the limits refuse more', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const first = yield* test.spawn('call-1')
        const again = yield* test.spawn('call-1')
        expect(again.id).toBe(first.id)
        expect(first.parentRunId).toBe(test.parentRunId)
        expect(first.state).toEqual(ChildRunState.cases.Reserved.make({}))
        const others = yield* Effect.forEach(['call-2', 'call-3', 'call-4'], (call) =>
          test.spawn(call),
        )
        expect([first, ...others].map((run) => run.number)).toEqual([1, 2, 3, 4])
        const fifth = yield* test.spawn('call-5').pipe(Effect.flip)
        expect(fifth._tag).toBe('Conflict')
        expect(yield* test.helpers.inThread(test.threadId)).toHaveLength(4)
      }).pipe(Effect.scoped),
    )

    it.effect('only one helper at a time may use the computer', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* test.spawn('desktop-1', 'ComputerUse')
        const second = yield* test.spawn('desktop-2', 'ComputerUse').pipe(Effect.flip)
        expect(second._tag).toBe('Conflict')
        yield* test.spawn('reader', 'Researcher')
      }).pipe(Effect.scoped),
    )

    it.effect('an ending is recorded once and the Thread hears it once', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const run = yield* test.spawn('ends')
        expect((yield* test.start(run)).state._tag).toBe('Working')
        const ended = ChildReport.cases.Ended.make({
          ending: ChildEnding.cases.Completed.make({}),
          wake: true,
        })
        expect((yield* test.helpers.settle(test.reporter, run.id, ended)).state._tag).toBe(
          'Completed',
        )
        const wake = yield* Queue.take(test.delivered)
        expect(wake.idempotencyKey).toBe(`child-result:${run.id}`)
        expect(wake.personId).toBe(test.personId)
        expect(wake.origin).toEqual(StoredRunOrigin.cases.ChildResult.make({ childRunId: run.id }))
        expect(wake.message).toMatchObject({ cue: { _tag: 'ChildResult', helper: 1 } })
        // A repeated report and a late failure change nothing about how it ended.
        const late = ChildReport.cases.Ended.make({
          ending: ChildEnding.cases.Failed.make({
            failure: ChildFailure.cases.RuntimeFault.make({}),
          }),
          wake: true,
        })
        expect((yield* test.helpers.settle(test.reporter, run.id, late)).state._tag).toBe(
          'Completed',
        )
        // A result the parent read by waiting is not delivered again.
        const waited = yield* test.spawn('waited')
        yield* test.start(waited)
        yield* test.helpers.settle(
          test.reporter,
          waited.id,
          ChildReport.cases.Ended.make({
            ending: ChildEnding.cases.Completed.make({}),
            wake: false,
          }),
        )
        const database = yield* Database
        const rows = yield* database.run(
          database
            .select({ wake: childRuns.wake })
            .from(childRuns)
            .where(eq(childRuns.threadId, test.threadId)),
        )
        expect(rows.map((row) => row.wake).sort()).toEqual(['none', 'sent'])
      }).pipe(Effect.scoped),
    )

    it.effect('a Person stopping a helper is news to Vivid; Vivid stopping one is not', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const byPerson = yield* test.spawn('person-stops')
        yield* test.start(byPerson)
        const stopped = yield* test.helpers.cancel(byPerson, 'Person')
        expect(ChildRunState.guards.Stopped(stopped.state) && stopped.state.by).toBe('Person')
        expect(yield* Ref.get(test.stopped)).toEqual([byPerson.id])
        const wake = yield* Queue.take(test.delivered)
        expect(wake.idempotencyKey).toBe(`child-result:${byPerson.id}`)
        // Stopping again reads the same outcome and asks the runtime for nothing more.
        expect((yield* test.helpers.cancel(stopped, 'Person')).state).toEqual(stopped.state)
        expect(yield* Ref.get(test.stopped)).toEqual([byPerson.id])

        const byVivid = yield* test.spawn('vivid-stops')
        yield* test.start(byVivid)
        const quiet = yield* test.helpers.cancel(byVivid, 'Vivid')
        expect(ChildRunState.guards.Stopped(quiet.state) && quiet.state.by).toBe('Vivid')
        expect(yield* Queue.size(test.delivered)).toBe(0)
      }).pipe(Effect.scoped),
    )

    it.effect('Thread Stop drops unheard results, then stops every helper', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const working = yield* test.spawn('working')
        yield* test.start(working)
        const reserved = yield* test.spawn('reserved')
        yield* test.helpers.stopThread(test.threadId)
        const after = yield* test.helpers.inThread(test.threadId)
        expect(after.map((run) => run.state._tag)).toEqual(['Stopped', 'Stopped'])
        expect([...(yield* Ref.get(test.stopped))].sort()).toEqual([working.id, reserved.id].sort())
        // The runtime's own report of the abort arrives late and wakes nobody.
        yield* test.helpers.settle(
          test.reporter,
          working.id,
          ChildReport.cases.Ended.make({ ending: ChildEnding.cases.Aborted.make({}), wake: true }),
        )
        expect(yield* Queue.size(test.delivered)).toBe(0)
      }).pipe(Effect.scoped),
    )

    it.effect("a helper's call is authenticated, attributed and gated as that helper", () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const run = yield* test.spawn('acts')
        const headers = { thread: test.threadId, actor: test.personId, helper: run.id }
        // Reserved is not yet working: it can do nothing.
        expect(Result.isFailure(yield* authenticateHelper(headers).pipe(Effect.result))).toBe(true)
        yield* test.start(run)
        const auth = yield* authenticateHelper(headers)
        expect(AuthState.$is('Helper')(auth) && auth.runId).toBe(run.id)
        const actor = yield* requireActor().pipe(Effect.provideService(AuthContext, auth))
        // The parent Run is still working; the action is the helper's all the same.
        expect(yield* actionOrigin(actor)).toEqual(
          ActionOrigin.cases.Helper.make({ threadId: test.threadId, runId: run.id }),
        )
        // A helper cannot start a helper.
        const nested = yield* childHandlers
          .SpawnChildRun({
            delivery: 'message-helper-test',
            toolCallId: 'nested',
            kind: 'Researcher',
            brief: 'Nested',
            budget: DEFAULT_CHILD_BUDGET,
          })
          .pipe(
            Effect.provideService(AuthContext, auth),
            Effect.provideContext(test.context),
            Effect.flip,
          )
        expect(nested._tag).toBe('Forbidden')
        // Another Person cannot borrow it.
        const stranger = yield* authenticateHelper({
          ...headers,
          actor: PersonId.make(NodeCrypto.randomUUID()),
        }).pipe(Effect.result)
        expect(Result.isFailure(stranger)).toBe(true)
        // Once stopped, it acts no more.
        yield* test.helpers.cancel(run, 'Vivid')
        expect(Result.isFailure(yield* authenticateHelper(headers).pipe(Effect.result))).toBe(true)
      }).pipe(Effect.scoped),
    )
  })
})
