import { describe, expect, layer } from '@effect/vitest'
import {
  BackgroundWork,
  ChildBudget,
  ChildRunState,
  ConnectionId,
  DEFAULT_CHILD_BUDGET,
  CreateWatchRequest,
  RunId,
  RUN_WORKING_LONG_MS,
  ThreadId,
  WorkFailure,
  WorkRef,
  WorkStall,
  WorkStanding,
  WorkStopResult,
  WatchCondition,
  WatchIntent,
  standingOf,
  type WatchId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Clock, Context, Effect, Layer, Option, Queue, Ref, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import type { Actor } from '../auth/access.ts'
import {
  ExecutorAppId,
  ExecutorAppOwnership,
  ExecutorBinding,
  ExecutorOwnerId,
  ExecutorReferences,
} from '../connections/executor.ts'
import { madeService } from '../connections/made.ts'
import { encodeReferences } from '../connections/records.ts'
import { connections } from '../connections/tables.ts'
import { ConnectionStore } from '../connections/store.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { Runtime } from '../runtime/client.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { childRunsLayer } from '../runs/store.ts'
import { childRuns } from '../runs/tables.ts'
import { runs, threads } from '../threads/tables.ts'
import { TTL_MS, Watches } from '../watches/lifecycle.ts'
import { Executor, person, testLayer } from '../watches/testing.ts'
import { listWork } from './list.ts'
import { stopAllWork, stopWork } from './stop.ts'

/**
 * Background work on the disposable database: the real Run, Thread, Watch and Integration rows,
 * the real Watches service. Executor and the runtime behind a Run lie outside this server and
 * stand in; the runtime records which Threads it was told to stop.
 */

/** What the runtime was told to stop: each Thread's Run, and each helper by its id. */
class Aborted extends Context.Service<Aborted, Ref.Ref<ReadonlyArray<string>>>()(
  'test/WorkAborted',
) {}
const runtimeLayer = Layer.effectContext(
  Effect.gen(function* () {
    const aborted = yield* Ref.make<ReadonlyArray<string>>([])
    const runtime = Layer.mock(Runtime, {
      stop: (thread) => Ref.update(aborted, (all) => [...all, thread]).pipe(Effect.as(true)),
      stopChild: (_thread, helper) =>
        Ref.update(aborted, (all) => [...all, helper]).pipe(Effect.as(true)),
    })
    return (yield* Layer.build(runtime)).pipe(Context.add(Aborted, aborted))
  }),
)

// The helper store is the real one; only the runtime's abort under it stands in.
const workLayer = childRunsLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeLayer,
      // Removal of a made Integration goes through Executor; these tests never press Remove.
      Layer.mock(ConnectionStore, { discordPeople: new Set<string>() }),
    ),
  ),
  Layer.provideMerge(testLayer),
)

const encodeOrigin = Schema.encodeSync(StoredRunOrigin)

/** A Thread of the Actor's with one Run in it, as the Run store would have written them. */
const threadWithRun = Effect.fn('WorkTest.threadWithRun')(function* (
  actor: Actor,
  input: {
    readonly title: string
    readonly state: 'working' | 'failed'
    readonly origin: StoredRunOrigin
  },
) {
  const database = yield* Database
  const thread = ThreadId.make(crypto.randomUUID())
  const run = RunId.make(crypto.randomUUID())
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database.insert(threads).values({
      id: thread,
      personId: actor.person.id,
      companyId: null,
      title: input.title,
      titleSource: 'Seed',
      audience: 'private',
      updatedAt: now,
    }),
  )
  yield* database.run(
    database.insert(runs).values({
      id: run,
      threadId: thread,
      personId: actor.person.id,
      turn: 1,
      state: input.state,
      origin: encodeOrigin(input.origin),
      startedAt: now,
      finishedAt: input.state === 'failed' ? now : null,
      failureReason: input.state === 'failed' ? 'RateLimited' : null,
    }),
  )
  return { thread, run }
})

const encodeBudget = Schema.encodeEffect(ChildBudget)
const encodeHelperState = Schema.encodeEffect(ChildRunState)

/** A helper the Run in a Thread started and that is working, as the helper store writes it. */
const workingHelper = Effect.fn('WorkTest.workingHelper')(function* (parent: {
  readonly thread: ThreadId
  readonly run: RunId
}) {
  const database = yield* Database
  const id = RunId.make(`helper_${crypto.randomUUID()}`)
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database.insert(childRuns).values({
      id,
      parentRunId: parent.run,
      threadId: parent.thread,
      parentToolCallId: 'call-1',
      number: 1,
      kind: 'Researcher',
      brief: 'Compare fares to Lisbon',
      budget: yield* encodeBudget(DEFAULT_CHILD_BUDGET),
      requestedAt: now,
      state: yield* encodeHelperState(ChildRunState.cases.Working.make({ startedAt: now })),
      wake: 'held',
    }),
  )
  return id
})

/** An Integration Vivid made for itself, as `make_integration` leaves its row. */
const madeIntegration = Effect.fn('WorkTest.madeIntegration')(function* (actor: Actor) {
  const database = yield* Database
  const id = ConnectionId.make(crypto.randomUUID())
  const app = ExecutorAppId.make(`app-${id}`)
  const references = ExecutorReferences.cases.Public.make({
    service: madeService('Reminders'),
    app,
    owner: ExecutorOwnerId.make(`owner-${actor.person.id}`),
    binding: ExecutorBinding.cases.Public.make({}),
    appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
  })
  const now = yield* Clock.currentTimeMillis
  yield* database.run(
    database.insert(connections).values({
      id,
      personId: actor.person.id,
      companyId: null,
      service: references.service,
      serviceName: 'Reminders',
      name: null,
      executorApp: app,
      references: yield* encodeReferences(references),
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    }),
  )
  return id
})

/** A Watch the fixture's Mail account grants for a week. */
const grantedWatch = Effect.fn('WorkTest.grantedWatch')(function* (actor: Actor) {
  const executor = yield* Executor
  yield* Queue.offer(executor.answers, {
    id: `evs_${'0'.repeat(32)}`,
    refreshBefore: new Date(TTL_MS),
  })
  const watch = yield* (yield* Watches).create(
    actor,
    CreateWatchRequest.make({
      name: 'New mail in Work Mail',
      account: 'mail (work)',
      event: 'message.received',
      arguments: {},
      instruction: 'Tell me when a client writes.',
      condition: WatchCondition.cases.Continuous.make({}),
      purpose: WatchIntent.cases.Event.make({}),
    }),
  )
  yield* Queue.take(executor.subscribed)
  return watch.id
})

const watchOrigin = (watch: WatchId) =>
  StoredRunOrigin.cases.Watch.make({
    watchId: watch,
    watchName: 'New mail in Work Mail',
    eventId: 'evt-1',
    event: 'message.received',
    occurredAt: '2026-11-08T12:00:00Z',
  })

describe.skipIf(!testDatabaseConfigured)('Background work', () => {
  layer(workLayer)((it) => {
    it.effect('lists working Runs and live Watches with the facts their standing comes from', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const watch = yield* grantedWatch(actor)
        const made = yield* madeIntegration(actor)
        const trip = yield* threadWithRun(actor, {
          title: 'Plan the trip',
          state: 'working',
          origin: StoredRunOrigin.cases.Message.make({}),
        })
        yield* threadWithRun(actor, {
          title: 'Mail from a client',
          state: 'failed',
          origin: watchOrigin(watch),
        })
        yield* TestClock.adjust(RUN_WORKING_LONG_MS + 1)
        const now = yield* Clock.currentTimeMillis
        const work = yield* listWork(actor)
        expect(work.map((one) => one._tag)).toEqual(['Run', 'Watch', 'MadeIntegration'])
        const [run, watching, reminders] = work
        if (!BackgroundWork.guards.Run(run)) return expect.fail('Run not listed first')
        expect(run.title).toBe('Plan the trip')
        expect(run.run).toBe(trip.run)
        expect(standingOf(run, now)).toEqual(
          WorkStanding.cases.Stalled.make({
            stall: WorkStall.cases.WorkingLong.make({ since: 0 }),
          }),
        )
        if (!BackgroundWork.guards.Watch(watching)) return expect.fail('Watch not listed')
        expect(watching.account).toBe('Mail (Work)')
        expect(standingOf(watching, now)).toEqual(
          WorkStanding.cases.Failing.make({
            failure: WorkFailure.cases.LastRunFailed.make({ at: 0, reason: 'RateLimited' }),
          }),
        )
        if (!BackgroundWork.guards.MadeIntegration(reminders))
          return expect.fail('Made Integration not listed')
        expect(reminders.connection).toBe(made)
        expect(reminders.account).toBe('Reminders')
        // Nothing watches it, so on its own it never reaches Vivid.
        expect(reminders.watches).toBe(0)
        expect(standingOf(reminders, now)).toEqual(WorkStanding.cases.Going.make({}))
      }).pipe(Effect.scoped),
    )

    it.effect('stops everything but the calling Thread, and says what each Stop did', () =>
      Effect.gen(function* () {
        const owner = yield* person()
        const watch = yield* grantedWatch(owner)
        yield* madeIntegration(owner)
        const other = yield* threadWithRun(owner, {
          title: 'Research flights',
          state: 'working',
          origin: StoredRunOrigin.cases.Message.make({}),
        })
        const calling = yield* threadWithRun(owner, {
          title: 'Stop everything',
          state: 'working',
          origin: StoredRunOrigin.cases.Message.make({}),
        })
        const helper = yield* workingHelper(other)
        const actor: Actor = { ...owner, threadId: Option.some(calling.thread) }
        const asVivid = Effect.provideService(
          AuthContext,
          AuthState.Vivid({
            person: owner.person,
            workspace: owner.workspace,
            threadId: calling.thread,
          }),
        )
        const report = yield* stopAllWork(actor).pipe(asVivid)
        // Watches first, so no event starts a Run while the Runs are being stopped.
        expect(report.map(({ work, result }) => [work._tag, result._tag])).toEqual([
          ['Watch', 'Stopped'],
          ['Helper', 'Stopped'],
          ['Run', 'Stopped'],
        ])
        // Helpers before the Runs that started them, so each is stopped and reported on its own.
        expect(yield* Ref.get(yield* Aborted)).toEqual([helper, other.thread])
        expect(yield* Ref.get((yield* Executor).unsubscribed)).toContain('mail.message.received')
        const left = yield* listWork(actor)
        // Removal is never part of Stop everything: the made Integration is still there.
        expect(left.map((one) => (BackgroundWork.guards.Run(one) ? one.run : one._tag))).toEqual([
          calling.run,
          'MadeIntegration',
        ])
        // A second press finds the Run already ended, which is not a failure.
        const again = yield* stopWork(actor, WorkRef.cases.Run.make({ run: other.run })).pipe(
          asVivid,
        )
        expect(again).toEqual(WorkStopResult.cases.AlreadyEnded.make({}))
        const watchAgain = yield* stopWork(actor, WorkRef.cases.Watch.make({ watch })).pipe(asVivid)
        expect(watchAgain).toEqual(WorkStopResult.cases.AlreadyEnded.make({}))
      }).pipe(Effect.scoped),
    )
  })
})
