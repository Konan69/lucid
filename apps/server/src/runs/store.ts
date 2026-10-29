import * as NodeCrypto from 'node:crypto'
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  ChildBudget,
  ChildReceipt,
  ChildRun,
  ChildRunDetail,
  ChildRunResult,
  ChildRunState,
  ChildEnding,
  ChildFailure,
  Conflict,
  NotFound,
  RunId,
  RuntimeChildAnswer,
  type ChildReport,
  type ChildStopCause,
  type PersonId,
  type RuntimeUnavailable,
  type SpawnChildRunRequest,
  type ThreadId,
} from '@vivid/contracts'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import {
  Database,
  decodeStored,
  encodeStored,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { audienceTopics, findThread } from '../threads/access.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
} from '../threads/conversation.ts'
import { deliveryRunId } from '../threads/key.ts'
import { ThreadStore } from '../threads/store.ts'
import { runs, threads } from '../threads/tables.ts'
import { childRuns } from './tables.ts'

/**
 * How many helpers one Run may have at work at once. Four parallel reads already outrun what one
 * answer can use; more mostly spends the Person's model budget (Child Runs scope, section 4).
 */
export const HELPERS_PER_RUN = 4

/** The longest helper answer a result delivery carries; the whole answer stays readable in Pi. */
const RESULT_LIMIT = 12_000

type Row = typeof childRuns.$inferSelect

/** Who is reporting on a helper: Vivid, acting for a Person, in one Thread. */
export interface Reporter {
  readonly personId: PersonId
  readonly threadId: ThreadId
}

export interface ChildRunsService {
  /** Reserves the helper for one tool call of the Run answering now; a repeated call finds it. */
  readonly spawn: (
    reporter: Reporter,
    request: SpawnChildRunRequest,
  ) => Effect.Effect<ChildRun, NotFound | Conflict | DatabaseInfrastructureError>
  /** Records that a helper's work started or ended. Repeating a report changes nothing. */
  readonly settle: (
    reporter: Reporter,
    id: RunId,
    report: ChildReport,
  ) => Effect.Effect<ChildRun, NotFound | DatabaseInfrastructureError>
  /** A Thread's helpers, oldest first. */
  readonly inThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ChildRun>, DatabaseInfrastructureError>
  /** One helper and, once it ended, its result as the runtime holds it. */
  readonly detail: (
    run: ChildRun,
  ) => Effect.Effect<ChildRunDetail, RuntimeUnavailable | DatabaseInfrastructureError>
  /** One helper by id, in the Thread it belongs to. */
  readonly find: (id: RunId) => Effect.Effect<Option.Option<ChildRun>, DatabaseInfrastructureError>
  /** The Person the Run that started a helper acts for, the only Person it may act for. */
  readonly actingFor: (
    id: RunId,
  ) => Effect.Effect<Option.Option<PersonId>, DatabaseInfrastructureError>
  /** Stops one helper and answers once its work ended. */
  readonly cancel: (
    run: ChildRun,
    by: ChildStopCause,
  ) => Effect.Effect<ChildRun, NotFound | RuntimeUnavailable | DatabaseInfrastructureError>
  /**
   * Stops every helper of a Thread for its Thread Stop. The results nobody heard yet are dropped
   * first, so no late result starts the Thread again after it was stopped.
   */
  readonly stopThread: (
    threadId: ThreadId,
  ) => Effect.Effect<void, RuntimeUnavailable | DatabaseInfrastructureError>
}

/** A Thread's helpers. Implemented here by `childRunsLayer`. */
export class ChildRuns extends Context.Service<ChildRuns, ChildRunsService>()('vivid/ChildRuns') {}

const decodeState = decodeStored(ChildRunState, 'helper state')
const encodeState = encodeStored(ChildRunState, 'helper state')
const decodeBudget = decodeStored(ChildBudget, 'helper budget')
const encodeBudget = encodeStored(ChildBudget, 'helper budget')
const encodeReceipt = encodeStored(ChildReceipt, 'helper receipt')

/** The tags of a helper that has not ended. Stored state is the encoded union, keyed by `_tag`. */
const ACTIVE = ['Reserved', 'Working', 'Stopping'] as const
const active: SQL = sql`${childRuns.state}->>'_tag' in ('Reserved', 'Working', 'Stopping')`

/** A helper's product id is derived from its call, so a repeated call reserves nothing new. */
const childRunId = (parentRunId: RunId, toolCallId: string) =>
  RunId.make(
    `helper_${NodeCrypto.createHash('sha256')
      .update(JSON.stringify([parentRunId, toolCallId]))
      .digest('hex')}`,
  )

const toChildRun = Effect.fn('ChildRuns.toChildRun')(function* (row: Row) {
  return ChildRun.make({
    id: row.id,
    parentRunId: row.parentRunId,
    parentToolCallId: row.parentToolCallId,
    threadId: row.threadId,
    number: row.number,
    kind: row.kind,
    brief: row.brief,
    budget: yield* decodeBudget(row.budget),
    requestedAt: row.requestedAt,
    state: yield* decodeState(row.state),
  })
})

/**
 * Where a helper ends when its work ended. An abort is a stop only when someone asked for one
 * (`Stopping` records who); an abort nobody asked for is a fault the runtime cannot name.
 */
const endingState = (
  state: ChildRunState,
  ending: ChildEnding,
  finishedAt: number,
): ChildRunState =>
  ChildEnding.match(ending, {
    Completed: (): ChildRunState => ChildRunState.cases.Completed.make({ finishedAt }),
    Failed: ({ failure }): ChildRunState =>
      ChildRunState.cases.Failed.make({ finishedAt, reason: failure }),
    Aborted: (): ChildRunState =>
      ChildRunState.guards.Stopping(state)
        ? ChildRunState.cases.Stopped.make({ finishedAt, by: state.by })
        : ChildRunState.cases.Failed.make({
            finishedAt,
            reason: ChildFailure.cases.RuntimeFault.make({}),
          }),
  })

/**
 * Whether the Thread must hear about a helper that just ended. Nobody needs to when a Thread
 * Stop already dropped it, when the parent read it by waiting, or when the parent stopped it.
 */
const wakeAfter = (current: Row['wake'], ended: ChildRunState, parentWaiting: boolean) => {
  if (current === 'none' || !parentWaiting) return 'none' as const
  if (ChildRunState.guards.Stopped(ended) && ended.by === 'Vivid') return 'none' as const
  return 'due' as const
}

/** What a result delivery says. Its words are the helper's own; the rest names helper and ending. */
const resultBody = (run: ChildRun, answer: RuntimeChildAnswer) =>
  RuntimeChildAnswer.match(answer, {
    Running: () => Option.none<string>(),
    Completed: ({ text }) =>
      Option.some(
        `Helper ${run.number} finished: ${run.brief}\n\n${text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n[The rest of this answer was cut.]` : text}`,
      ),
    Failed: ({ failure }) =>
      Option.some(`Helper ${run.number} could not finish (${failure._tag}): ${run.brief}`),
    Aborted: () =>
      Option.some(
        `Helper ${run.number} was stopped by a person before it finished: ${run.brief}. Anything it already did stays done.`,
      ),
  })

/** How a terminal helper's result reads to a client, joining Pi's answer to the stored ending. */
const resultOf = (state: ChildRunState, answer: RuntimeChildAnswer) =>
  RuntimeChildAnswer.match(answer, {
    Running: () => Option.none<ChildRunResult>(),
    Completed: ({ text, usage }) =>
      Option.some(ChildRunResult.cases.Completed.make({ text, usage })),
    Failed: ({ failure, usage }) =>
      Option.some(ChildRunResult.cases.Failed.make({ failure, usage })),
    Aborted: ({ usage }) =>
      Option.some(
        ChildRunState.guards.Stopped(state)
          ? ChildRunResult.cases.Stopped.make({ by: state.by, usage })
          : ChildRunResult.cases.Failed.make({
              failure: ChildFailure.cases.RuntimeFault.make({}),
              usage,
            }),
      ),
  })

/** Retries a result delivery the Thread could not take yet: busy with another Person, or unreachable. */
const WAKE_RETRY = Schedule.min([Schedule.exponential('2 seconds'), Schedule.spaced('1 minute')])

const makeChildRuns = Effect.fn('ChildRuns.make')(function* () {
  const database = yield* Database
  const runtime = yield* Runtime
  const conversation = yield* Conversation
  const changes = yield* Changes
  const threadStore = yield* ThreadStore
  const scope = yield* Effect.scope
  const withDatabase = Effect.provideService(Database, database)

  const rowOf = (id: RunId) =>
    database
      .run(database.select().from(childRuns).where(eq(childRuns.id, id)))
      .pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])))

  /** A helper's change moves its Thread's activity: the Thread view and every list showing it. */
  const announce = Effect.fn('ChildRuns.announce')(function* (threadId: ThreadId) {
    const thread = yield* findThread(threadId).pipe(withDatabase)
    if (Option.isNone(thread)) return
    yield* changes.publish(
      audienceTopics(thread.value, yield* threadStore.participants(threadId)).map(
        Topic.part('activity'),
      ),
    )
  })

  const actingFor: ChildRunsService['actingFor'] = Effect.fn('ChildRuns.actingFor')(function* (id) {
    const rows = yield* database.run(
      database
        .select({ personId: runs.personId })
        .from(childRuns)
        .innerJoin(runs, eq(runs.id, childRuns.parentRunId))
        .where(eq(childRuns.id, id)),
    )
    return Option.map(Option.fromUndefinedOr(rows[0]), (row) => row.personId)
  })

  /**
   * Delivers one helper's result to its Thread as a new delivery from Vivid, acting for the
   * Person its parent acted for. The key is the helper's, so a repeat starts nothing new. A
   * Thread busy answering another Person refuses it; the retry keeps the key and the Person.
   */
  const deliverWake = Effect.fn('ChildRuns.deliverWake')(function* (id: RunId) {
    const row = yield* rowOf(id)
    if (Option.isNone(row) || row.value.wake !== 'due') return
    const run = yield* toChildRun(row.value)
    const person = yield* actingFor(id)
    if (Option.isNone(person)) return
    const body = resultBody(run, yield* runtime.child(run.threadId, id))
    if (Option.isNone(body)) return
    yield* conversation.deliver({
      threadId: run.threadId,
      personId: person.value,
      speaker: DeliverySpeaker.cases.Vivid.make({}),
      message: DeliveryMessage.cases.Signal.make({
        type: 'child-result',
        body: body.value,
        attributes: { helper: String(run.number) },
      }),
      origin: StoredRunOrigin.cases.ChildResult.make({ childRunId: id }),
      idempotencyKey: `child-result:${id}`,
    })
    const sent = yield* database.run(
      database
        .update(childRuns)
        .set({ wake: 'sent' })
        .where(and(eq(childRuns.id, id), eq(childRuns.wake, 'due')))
        .returning({ id: childRuns.id }),
    )
    // A Thread Stop dropped this result while it was being delivered: stop what it started.
    if (sent.length === 0) yield* runtime.stop(run.threadId)
  })

  /** Delivery runs beside the request that ended the helper and outlives it. */
  const wake = (id: RunId) =>
    deliverWake(id).pipe(
      Effect.retry({
        while: (error) =>
          error._tag === 'Conflict' ||
          error._tag === 'RuntimeUnavailable' ||
          error._tag === 'DatabaseUnavailable',
        schedule: WAKE_RETRY,
      }),
      Effect.catch((error) =>
        Effect.logWarning('A helper result could not be delivered', { reason: error._tag }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    )

  const spawn: ChildRunsService['spawn'] = Effect.fn('ChildRuns.spawn')(
    function* (reporter, request) {
      const now = yield* Clock.currentTimeMillis
      const parentRunId = deliveryRunId(reporter.threadId, request.delivery)
      const id = childRunId(parentRunId, request.toolCallId)
      const state = yield* encodeState(ChildRunState.cases.Reserved.make({}))
      const budget = yield* encodeBudget(request.budget)
      const row = yield* database.transaction((tx) =>
        Effect.gen(function* () {
          // Run start and settlement lock the Thread first; numbering a helper keeps that order.
          yield* tx
            .select({ id: threads.id })
            .from(threads)
            .where(eq(threads.id, reporter.threadId))
            .for('update')
          const [parent] = yield* tx.select().from(runs).where(eq(runs.id, parentRunId))
          if (
            parent === undefined ||
            parent.threadId !== reporter.threadId ||
            parent.personId !== reporter.personId ||
            parent.admittedAt === null
          )
            return yield* new NotFound({ message: 'The Run answering now was not found.' })
          const [existing] = yield* tx.select().from(childRuns).where(eq(childRuns.id, id))
          if (existing !== undefined) return existing
          const working = yield* tx
            .select({ kind: childRuns.kind, parentRunId: childRuns.parentRunId })
            .from(childRuns)
            .innerJoin(runs, eq(runs.id, childRuns.parentRunId))
            .where(and(active, eq(runs.personId, reporter.personId)))
          if (
            working.filter((child) => child.parentRunId === parentRunId).length >= HELPERS_PER_RUN
          )
            return yield* new Conflict({
              message: `${HELPERS_PER_RUN} helpers are already working for this message. Wait for one to finish.`,
            })
          // The Computer has one desktop: a second helper driving it would fight the first.
          if (
            request.kind === 'ComputerUse' &&
            working.some((child) => child.kind === 'ComputerUse')
          )
            return yield* new Conflict({
              message: 'A helper is already using the computer. Wait for it to finish.',
            })
          const [inserted] = yield* tx
            .insert(childRuns)
            .values({
              id,
              parentRunId,
              threadId: reporter.threadId,
              parentToolCallId: request.toolCallId,
              number: sql`(select coalesce(max("number"), 0) + 1 from "vivid_child_runs" where "thread_id" = ${reporter.threadId})`,
              kind: request.kind,
              brief: request.brief,
              budget,
              requestedAt: now,
              state,
              wake: 'held',
            })
            .returning()
          if (inserted === undefined)
            return yield* new NotFound({ message: 'The helper could not be reserved.' })
          return inserted
        }),
      )
      yield* announce(reporter.threadId)
      return yield* toChildRun(row)
    },
  )

  /** Loads a helper the reporter may report on: in its Thread, for the Person its parent acts for. */
  const reported = Effect.fn('ChildRuns.reported')(function* (reporter: Reporter, id: RunId) {
    const row = yield* rowOf(id)
    const person = yield* actingFor(id)
    if (
      Option.isNone(row) ||
      row.value.threadId !== reporter.threadId ||
      Option.isNone(person) ||
      person.value !== reporter.personId
    )
      return yield* new NotFound({ message: 'Helper not found.' })
    return row.value
  })

  /** One conditional write: only the report that moves the helper on acts, so repeats are no-ops. */
  const settle: ChildRunsService['settle'] = Effect.fn('ChildRuns.settle')(
    function* (reporter, id, report) {
      const row = yield* reported(reporter, id)
      const now = yield* Clock.currentTimeMillis
      const state = yield* decodeState(row.state)
      if (report._tag === 'Started') {
        if (!ChildRunState.guards.Reserved(state)) return yield* toChildRun(row)
        yield* database.run(
          database
            .update(childRuns)
            .set({
              state: yield* encodeState(ChildRunState.cases.Working.make({ startedAt: now })),
              receipt: yield* encodeReceipt(report.receipt),
            })
            .where(and(eq(childRuns.id, id), sql`${childRuns.state}->>'_tag' = 'Reserved'`)),
        )
      } else {
        if (!ChildRunState.isAnyOf(ACTIVE)(state)) return yield* toChildRun(row)
        const ended = endingState(state, report.ending, now)
        const changed = yield* database.run(
          database
            .update(childRuns)
            .set({
              state: yield* encodeState(ended),
              wake: wakeAfter(row.wake, ended, report.wake),
            })
            .where(and(eq(childRuns.id, id), active))
            .returning({ wake: childRuns.wake }),
        )
        if (changed[0] !== undefined && changed[0].wake === 'due') yield* wake(id)
      }
      yield* announce(row.threadId)
      return yield* toChildRun(Option.getOrElse(yield* rowOf(id), () => row))
    },
  )

  const inThread: ChildRunsService['inThread'] = Effect.fn('ChildRuns.inThread')(
    function* (threadId) {
      const rows = yield* database.run(
        database
          .select()
          .from(childRuns)
          .where(eq(childRuns.threadId, threadId))
          .orderBy(asc(childRuns.number)),
      )
      return yield* Effect.forEach(rows, toChildRun)
    },
  )

  const find: ChildRunsService['find'] = Effect.fn('ChildRuns.find')(function* (id) {
    const row = yield* rowOf(id)
    if (Option.isNone(row)) return Option.none()
    return Option.some(yield* toChildRun(row.value))
  })

  const detail: ChildRunsService['detail'] = Effect.fn('ChildRuns.detail')(function* (run) {
    if (ChildRunState.isAnyOf(ACTIVE)(run.state)) return ChildRunDetail.cases.Active.make({ run })
    const result = resultOf(run.state, yield* runtime.child(run.threadId, run.id))
    return Option.match(result, {
      onNone: () => ChildRunDetail.cases.Active.make({ run }),
      onSome: (ended) => ChildRunDetail.cases.Ended.make({ run, result: ended }),
    })
  })

  /** Marks the helpers Stopping, by whom, unless they already ended. Answers the ones it marked. */
  const markStopping = Effect.fn('ChildRuns.markStopping')(function* (
    where: SQL,
    by: ChildStopCause,
    suppress: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis
    const stopping = yield* encodeState(ChildRunState.cases.Stopping.make({ requestedAt: now, by }))
    // Dropping the results nobody heard comes first, so none is delivered after this Stop.
    if (suppress)
      yield* database.run(
        database
          .update(childRuns)
          .set({ wake: 'none' })
          .where(and(where, inArray(childRuns.wake, ['held', 'due']))),
      )
    const marked = yield* database.run(
      database
        .update(childRuns)
        .set({ state: stopping })
        .where(and(where, sql`${childRuns.state}->>'_tag' in ('Reserved', 'Working')`))
        .returning({ id: childRuns.id }),
    )
    return marked.map((row) => row.id)
  })

  /** After the runtime said a helper's work ended, the Stopping record becomes Stopped. */
  const markStopped = Effect.fn('ChildRuns.markStopped')(function* (id: RunId) {
    const row = yield* rowOf(id)
    if (Option.isNone(row)) return
    const state = yield* decodeState(row.value.state)
    if (!ChildRunState.guards.Stopping(state)) return
    const now = yield* Clock.currentTimeMillis
    const ended = ChildRunState.cases.Stopped.make({ finishedAt: now, by: state.by })
    const changed = yield* database.run(
      database
        .update(childRuns)
        .set({ state: yield* encodeState(ended), wake: wakeAfter(row.value.wake, ended, true) })
        .where(and(eq(childRuns.id, id), sql`${childRuns.state}->>'_tag' = 'Stopping'`))
        .returning({ wake: childRuns.wake }),
    )
    if (changed[0] !== undefined && changed[0].wake === 'due') yield* wake(id)
  })

  const cancel: ChildRunsService['cancel'] = Effect.fn('ChildRuns.cancel')(function* (run, by) {
    // The parent stopping its own helper already knows; only a Person's stop is news to it.
    yield* markStopping(eq(childRuns.id, run.id), by, false)
    const row = yield* rowOf(run.id)
    if (Option.isNone(row)) return yield* new NotFound({ message: 'Helper not found.' })
    if (ChildRunState.guards.Stopping(yield* decodeState(row.value.state))) {
      yield* runtime.stopChild(run.threadId, run.id)
      yield* markStopped(run.id)
    }
    yield* announce(run.threadId)
    const after = yield* rowOf(run.id)
    return yield* toChildRun(Option.getOrElse(after, () => row.value))
  })

  const stopThread: ChildRunsService['stopThread'] = Effect.fn('ChildRuns.stopThread')(
    function* (threadId) {
      const where = eq(childRuns.threadId, threadId)
      yield* markStopping(where, 'Person', true)
      // A stop asked for earlier and not finished is stopped again here; the abort is idempotent.
      const stopping = yield* database.run(
        database
          .select({ id: childRuns.id })
          .from(childRuns)
          .where(and(where, sql`${childRuns.state}->>'_tag' = 'Stopping'`)),
      )
      yield* Effect.forEach(
        stopping,
        ({ id }) => runtime.stopChild(threadId, id).pipe(Effect.andThen(markStopped(id))),
        { concurrency: 'unbounded', discard: true },
      )
      if (stopping.length > 0) yield* announce(threadId)
    },
  )

  // A server that restarted owes the results it had not delivered yet.
  const owed = yield* database.run(
    database.select({ id: childRuns.id }).from(childRuns).where(eq(childRuns.wake, 'due')),
  )
  yield* Effect.forEach(owed, ({ id }) => wake(id), { discard: true })

  return ChildRuns.of({
    spawn,
    settle,
    inThread,
    detail,
    find,
    actingFor,
    cancel,
    stopThread,
  })
})

/** Needs a `Scope`: result deliveries outlive the request that ended a helper. */
export const childRunsLayer = Layer.effect(ChildRuns, makeChildRuns())
