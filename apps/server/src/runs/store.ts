import * as NodeCrypto from 'node:crypto'
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
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
  SignalCue,
  ChildReport,
  ChildTurn,
  RuntimeChildMessaged,
  roundOf,
  type ChildSender,
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
import * as Predicate from 'effect/Predicate'
import * as Schedule from 'effect/Schedule'
import type * as Scope from 'effect/Scope'
import {
  Database,
  decodeStored,
  encodeStored,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { ownedHere, type Actor } from '../auth/access.ts'
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
  /**
   * Sends one helper a follow-up as its next round of work. A repeat of the same follow-up (by its
   * key) starts nothing more. The round is recorded before the runtime is asked: if the runtime
   * cannot be reached the helper reads `Working` with nothing at work until the sender repeats it
   * or someone stops it.
   */
  readonly followUp: (
    run: ChildRun,
    followUp: FollowUp,
  ) => Effect.Effect<
    ChildRun,
    NotFound | Conflict | RuntimeUnavailable | DatabaseInfrastructureError
  >
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

/** A follow-up for a helper: its words, who sent them, and the sender's idempotency key. */
export interface FollowUp {
  readonly message: string
  readonly by: ChildSender
  readonly key: string
}

/** A Thread's helpers. Implemented here by `childRunsLayer`. */
export class ChildRuns extends Context.Service<ChildRuns, ChildRunsService>()('vivid/ChildRuns') {}

const decodeState = decodeStored(ChildRunState, 'helper state')
const encodeState = encodeStored(ChildRunState, 'helper state')
const decodeBudget = decodeStored(ChildBudget, 'helper budget')
const encodeBudget = encodeStored(ChildBudget, 'helper budget')
const encodeReceipt = encodeStored(ChildReceipt, 'helper receipt')
const decodeTurn = decodeStored(ChildTurn, 'helper turn')
const encodeTurn = encodeStored(ChildTurn, 'helper turn')

/** The round a stored helper is in, as SQL: a brief is round one and stores no number. */
const storedRound: SQL = sql`coalesce((${childRuns.turn}->>'round')::int, 1)`

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
    turn: yield* decodeTurn(row.turn),
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

/** Nothing ran, so nothing was spent: what a helper stopped before its first step used. */
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }

/** A stop or a failure the server recorded is the ending when Pi has no other word for it. */
const recorded = (state: ChildRunState, usage: ChildRunResult['usage']) =>
  ChildRunState.guards.Stopped(state)
    ? Option.some<ChildRunResult>(ChildRunResult.cases.Stopped.make({ by: state.by, usage }))
    : ChildRunState.guards.Failed(state)
      ? Option.some<ChildRunResult>(
          ChildRunResult.cases.Failed.make({ failure: state.reason, usage }),
        )
      : Option.none<ChildRunResult>()

/** How a terminal helper's result reads, joining Pi's answer to the stored ending. */
const resultOf = (state: ChildRunState, answer: RuntimeChildAnswer) =>
  RuntimeChildAnswer.match(answer, {
    Absent: () => recorded(state, NO_USAGE),
    Running: () => Option.none<ChildRunResult>(),
    Completed: ({ text, usage }) =>
      Option.some<ChildRunResult>(ChildRunResult.cases.Completed.make({ text, usage })),
    Failed: ({ failure, usage }) =>
      Option.some<ChildRunResult>(ChildRunResult.cases.Failed.make({ failure, usage })),
    Aborted: ({ usage }) =>
      Option.orElse(recorded(state, usage), () =>
        Option.some<ChildRunResult>(
          ChildRunResult.cases.Failed.make({
            failure: ChildFailure.cases.RuntimeFault.make({}),
            usage,
          }),
        ),
      ),
  })

/** What the round that ended was asked: the helper's brief, or the follow-up and who sent it. */
const askedOf = (run: ChildRun) =>
  ChildTurn.match(run.turn, {
    Brief: () => run.brief,
    FollowUp: ({ message, by }) =>
      `${message} (a follow-up ${by === 'Person' ? 'a person' : 'you'} sent; its first task was: ${run.brief})`,
  })

/** What a result delivery says. Its words are the helper's own; the rest names helper and ending. */
const resultBody = (run: ChildRun, result: ChildRunResult) =>
  ChildRunResult.match(result, {
    Completed: ({ text }) =>
      `Helper ${run.number} finished: ${askedOf(run)}\n\n${text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n[The rest of this answer was cut.]` : text}`,
    Failed: ({ failure }) =>
      `Helper ${run.number} could not finish (${failure._tag}): ${askedOf(run)}`,
    Stopped: () =>
      `Helper ${run.number} was stopped by a person before it finished: ${askedOf(run)}. Anything it already did stays done.`,
  })

/**
 * The key of one round's result delivery. Each round is heard once; the first keeps the key it
 * had before helpers took follow-ups.
 */
const resultKey = (run: ChildRun) =>
  ChildTurn.match(run.turn, {
    Brief: () => `child-result:${run.id}`,
    FollowUp: ({ round }) => `child-result:${run.id}:${round}`,
  })

/** Retries a result delivery the Thread could not take yet: busy with another Person, or unreachable. */
const WAKE_RETRY = Schedule.min([Schedule.exponential('2 seconds'), Schedule.spaced('1 minute')])

/** What a stored schema value is written as. */
type Encoded<S extends { readonly Encoded: unknown }> = S['Encoded']

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

/** What every helper operation below reads and writes through, captured once by the Layer. */
interface Deps {
  readonly database: Database['Service']
  readonly runtime: Runtime['Service']
  readonly conversation: Conversation['Service']
  readonly changes: Changes['Service']
  readonly threadStore: ThreadStore['Service']
  readonly scope: Scope.Scope
}

/** The failures a result delivery waits out: a Thread busy with another Person, or unreachable. */
const retryable = (error: { readonly _tag: string }) =>
  Predicate.isTagged(error, 'Conflict') ||
  Predicate.isTagged(error, 'RuntimeUnavailable') ||
  Predicate.isTagged(error, 'DatabaseUnavailable')

const rowReader = (database: Database['Service']) => (id: RunId) =>
  database
    .run(database.select().from(childRuns).where(eq(childRuns.id, id)))
    .pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])))

/** A helper's change moves its Thread's activity: the Thread view and every list showing it. */
const announcer = (deps: Deps) =>
  Effect.fn('ChildRuns.announce')(function* (threadId: ThreadId) {
    const thread = yield* findThread(threadId).pipe(Effect.provideService(Database, deps.database))
    if (Option.isNone(thread)) return
    yield* deps.changes.publish(
      audienceTopics(thread.value, yield* deps.threadStore.participants(threadId)).map(
        Topic.part('activity'),
      ),
    )
  })

/** The Person the Run that started a helper acts for. */
const actingReader = (database: Database['Service']): ChildRunsService['actingFor'] =>
  Effect.fn('ChildRuns.actingFor')(function* (id) {
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
const waker = (deps: Deps) => {
  const rowOf = rowReader(deps.database)
  const actingFor = actingReader(deps.database)
  const deliverWake = Effect.fn('ChildRuns.deliverWake')(function* (id: RunId) {
    const row = yield* rowOf(id)
    if (Option.isNone(row) || row.value.wake !== 'due') return
    const run = yield* toChildRun(row.value)
    const person = yield* actingFor(id)
    if (Option.isNone(person)) return
    const result = resultOf(run.state, yield* deps.runtime.child(run.threadId, id))
    if (Option.isNone(result)) return
    yield* deps.conversation.deliver({
      threadId: run.threadId,
      personId: person.value,
      speaker: DeliverySpeaker.cases.Vivid.make({}),
      message: DeliveryMessage.cases.Signal.make({
        cue: SignalCue.cases.ChildResult.make({
          body: resultBody(run, result.value),
          helper: run.number,
        }),
      }),
      origin: StoredRunOrigin.cases.ChildResult.make({ childRunId: id }),
      idempotencyKey: resultKey(run),
    })
    const sent = yield* deps.database.run(
      deps.database
        .update(childRuns)
        .set({ wake: 'sent' })
        .where(and(eq(childRuns.id, id), eq(childRuns.wake, 'due')))
        .returning({ id: childRuns.id }),
    )
    // A Thread Stop dropped this result while it was being delivered: stop what it started.
    if (sent.length === 0) yield* deps.runtime.stop(run.threadId)
  })
  /** Delivery runs beside the request that ended the helper and outlives it. */
  return (id: RunId) =>
    deliverWake(id).pipe(
      Effect.retry({ while: retryable, schedule: WAKE_RETRY }),
      Effect.catch((error) =>
        Effect.logWarning('A helper result could not be delivered', { reason: error._tag }),
      ),
      Effect.forkIn(deps.scope),
      Effect.asVoid,
    )
}

/**
 * Reserves one helper inside the spawn's transaction: the parent must be the admitted Run of this
 * Person in this Thread, a repeated call finds its helper, and the per-Run and Computer limits
 * hold. The Thread row is locked first, the order Run start and settlement take.
 */
const reserve = Effect.fn('ChildRuns.reserve')(function* (
  tx: Transaction,
  reporter: Reporter,
  request: SpawnChildRunRequest,
  fixed: {
    readonly id: RunId
    readonly parentRunId: RunId
    readonly budget: Encoded<typeof ChildBudget>
    readonly state: Encoded<typeof ChildRunState>
    readonly turn: Encoded<typeof ChildTurn>
    readonly requestedAt: number
  },
) {
  const { id, parentRunId } = fixed
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
  if (working.filter((child) => child.parentRunId === parentRunId).length >= HELPERS_PER_RUN)
    return yield* new Conflict({
      message: `${HELPERS_PER_RUN} helpers are already working for this message. Wait for one to finish.`,
    })
  // The Computer has one desktop: a second helper driving it would fight the first.
  if (request.kind === 'ComputerUse' && working.some((child) => child.kind === 'ComputerUse'))
    return yield* new Conflict({
      message: 'A helper is already using the computer. Wait for it to finish.',
    })
  const [inserted] = yield* tx
    .insert(childRuns)
    .values({
      ...fixed,
      threadId: reporter.threadId,
      parentToolCallId: request.toolCallId,
      number: sql`(select coalesce(max("number"), 0) + 1 from "vivid_child_runs" where "thread_id" = ${reporter.threadId})`,
      kind: request.kind,
      brief: request.brief,
      wake: 'held',
    })
    .returning()
  if (inserted === undefined)
    return yield* new NotFound({ message: 'The helper could not be reserved.' })
  return inserted
})

const spawner = (deps: Deps): ChildRunsService['spawn'] => {
  const announce = announcer(deps)
  return Effect.fn('ChildRuns.spawn')(function* (reporter, request) {
    const now = yield* Clock.currentTimeMillis
    const parentRunId = deliveryRunId(reporter.threadId, request.delivery)
    const fixed = {
      id: childRunId(parentRunId, request.toolCallId),
      parentRunId,
      budget: yield* encodeBudget(request.budget),
      state: yield* encodeState(ChildRunState.cases.Reserved.make({})),
      turn: yield* encodeTurn(ChildTurn.cases.Brief.make({})),
      requestedAt: now,
    }
    const row = yield* deps.database.transaction((tx) => reserve(tx, reporter, request, fixed))
    yield* announce(reporter.threadId)
    return yield* toChildRun(row)
  })
}

/** Loads a helper the reporter may report on: in its Thread, for the Person its parent acts for. */
const reportedReader = (database: Database['Service']) => {
  const rowOf = rowReader(database)
  const actingFor = actingReader(database)
  return Effect.fn('ChildRuns.reported')(function* (reporter: Reporter, id: RunId) {
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
}

/** One conditional write: only the report that moves the helper on acts, so repeats are no-ops. */
const settler = (
  deps: Deps,
  wake: (id: RunId) => Effect.Effect<void>,
): ChildRunsService['settle'] => {
  const { database } = deps
  const rowOf = rowReader(database)
  const reported = reportedReader(database)
  const announce = announcer(deps)
  const started = Effect.fn('ChildRuns.started')(function* (
    row: Row,
    receipt: ChildReceipt,
    now: number,
  ) {
    if (!ChildRunState.guards.Reserved(yield* decodeState(row.state))) return
    yield* database.run(
      database
        .update(childRuns)
        .set({
          state: yield* encodeState(ChildRunState.cases.Working.make({ startedAt: now })),
          receipt: yield* encodeReceipt(receipt),
        })
        .where(and(eq(childRuns.id, row.id), sql`${childRuns.state}->>'_tag' = 'Reserved'`)),
    )
  })
  /** Only the report of the helper's current round ends it; an earlier round's comes late. */
  const ended = Effect.fn('ChildRuns.ended')(function* (
    row: Row,
    report: Extract<ChildReport, { readonly _tag: 'Ended' }>,
    now: number,
  ) {
    const state = yield* decodeState(row.state)
    if (!ChildRunState.isAnyOf(ACTIVE)(state)) return
    if (roundOf(yield* decodeTurn(row.turn)) !== report.round) return
    const next = endingState(state, report.ending, now)
    const changed = yield* database.run(
      database
        .update(childRuns)
        .set({ state: yield* encodeState(next), wake: wakeAfter(row.wake, next, report.wake) })
        .where(and(eq(childRuns.id, row.id), active, sql`${storedRound} = ${report.round}`))
        .returning({ wake: childRuns.wake }),
    )
    if (changed[0] !== undefined && changed[0].wake === 'due') yield* wake(row.id)
  })
  return Effect.fn('ChildRuns.settle')(function* (reporter, id, report) {
    const row = yield* reported(reporter, id)
    const now = yield* Clock.currentTimeMillis
    yield* ChildReport.match(report, {
      Started: ({ receipt }) => started(row, receipt, now),
      Ended: (end) => ended(row, end, now),
    })
    yield* announce(row.threadId)
    return yield* toChildRun(Option.getOrElse(yield* rowOf(id), () => row))
  })
}

/** Marks the helpers Stopping, by whom, unless they already ended. Answers the ones it marked. */
const stoppingMarker = (database: Database['Service']) =>
  Effect.fn('ChildRuns.markStopping')(function* (
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
const stoppedMarker = (database: Database['Service'], wake: (id: RunId) => Effect.Effect<void>) => {
  const rowOf = rowReader(database)
  return Effect.fn('ChildRuns.markStopped')(function* (id: RunId) {
    const row = yield* rowOf(id)
    if (Option.isNone(row)) return
    const state = yield* decodeState(row.value.state)
    if (!ChildRunState.guards.Stopping(state)) return
    const now = yield* Clock.currentTimeMillis
    const next = ChildRunState.cases.Stopped.make({ finishedAt: now, by: state.by })
    const changed = yield* database.run(
      database
        .update(childRuns)
        .set({ state: yield* encodeState(next), wake: wakeAfter(row.value.wake, next, true) })
        .where(and(eq(childRuns.id, id), sql`${childRuns.state}->>'_tag' = 'Stopping'`))
        .returning({ wake: childRuns.wake }),
    )
    if (changed[0] !== undefined && changed[0].wake === 'due') yield* wake(id)
  })
}

/** Stopping one helper, and every helper of a Thread for its Thread Stop. */
const stoppers = (deps: Deps, wake: (id: RunId) => Effect.Effect<void>) => {
  const { database, runtime } = deps
  const rowOf = rowReader(database)
  const announce = announcer(deps)
  const markStopping = stoppingMarker(database)
  const markStopped = stoppedMarker(database, wake)
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
  return { cancel, stopThread }
}

/** Why a helper takes no follow-up in this state. */
const notNow = (state: ChildRunState) =>
  new Conflict({
    message: ChildRunState.guards.Reserved(state)
      ? 'This helper has not started yet. Try again in a moment.'
      : 'This helper was stopped. Start a new one instead.',
  })

/**
 * Records a helper's next round inside one transaction, the Thread row locked first as a spawn
 * locks it. A helper at work stays `Working` (the follow-up steers it); one whose round ended
 * works again. A result nobody heard yet stays owed; any other is settled, so the new round's
 * ending is heard on its own. A helper that drives the computer may not start again while
 * another one does. Answers the row as it now stands, unchanged for a repeat of the same key.
 */
const reopen = Effect.fn('ChildRuns.reopen')(function* (
  tx: Transaction,
  run: ChildRun,
  followUp: FollowUp,
  now: number,
) {
  yield* tx
    .select({ id: threads.id })
    .from(threads)
    .where(eq(threads.id, run.threadId))
    .for('update')
  const [row] = yield* tx.select().from(childRuns).where(eq(childRuns.id, run.id)).for('update')
  if (row === undefined) return yield* new NotFound({ message: 'Helper not found.' })
  const turn = yield* decodeTurn(row.turn)
  if (ChildTurn.guards.FollowUp(turn) && turn.key === followUp.key) return row
  const state = yield* decodeState(row.state)
  if (!ChildRunState.isAnyOf(['Working', 'Completed', 'Failed'])(state)) return yield* notNow(state)
  if (row.kind === 'ComputerUse' && !ChildRunState.guards.Working(state)) {
    const driving = yield* tx
      .select({ id: childRuns.id })
      .from(childRuns)
      .innerJoin(runs, eq(runs.id, childRuns.parentRunId))
      .where(
        and(
          active,
          eq(childRuns.kind, 'ComputerUse'),
          eq(
            runs.personId,
            sql`(select ${runs.personId} from ${runs} where ${runs.id} = ${row.parentRunId})`,
          ),
        ),
      )
    if (driving.length > 0)
      return yield* new Conflict({
        message: 'A helper is already using the computer. Wait for it to finish.',
      })
  }
  const next = ChildTurn.cases.FollowUp.make({
    round: roundOf(turn) + 1,
    message: followUp.message,
    by: followUp.by,
    key: followUp.key,
    sentAt: now,
  })
  const working = ChildRunState.guards.Working(state)
    ? state
    : ChildRunState.cases.Working.make({ startedAt: now })
  const [updated] = yield* tx
    .update(childRuns)
    .set({
      turn: yield* encodeTurn(next),
      state: yield* encodeState(working),
      wake: row.wake === 'due' ? 'due' : 'held',
    })
    .where(eq(childRuns.id, run.id))
    .returning()
  if (updated === undefined) return yield* new NotFound({ message: 'Helper not found.' })
  return updated
})

/**
 * Sending a helper a follow-up: its next round is recorded, then the runtime starts it in the
 * helper's own conversation (`children.ts` in the runtime). A round the runtime has nothing to
 * continue for ends at once as a fault, so no helper reads `Working` with nothing at work.
 */
const followUpper = (deps: Deps): ChildRunsService['followUp'] => {
  const { database, runtime } = deps
  const rowOf = rowReader(database)
  const announce = announcer(deps)
  return Effect.fn('ChildRuns.followUp')(function* (run, followUp) {
    const now = yield* Clock.currentTimeMillis
    const row = yield* database.transaction((tx) => reopen(tx, run, followUp, now))
    const reopened = yield* toChildRun(row)
    yield* announce(run.threadId)
    if (!ChildTurn.guards.FollowUp(reopened.turn)) return reopened
    const turn = reopened.turn
    const messaged = yield* runtime.messageChild(run.threadId, run.id, {
      round: turn.round,
      message: turn.message,
      by: turn.by,
      budget: reopened.budget,
    })
    if (RuntimeChildMessaged.guards.Started(messaged)) return reopened
    const failed = ChildRunState.cases.Failed.make({
      finishedAt: now,
      reason: ChildFailure.cases.Delivery.make({}),
    })
    yield* database.run(
      database
        .update(childRuns)
        .set({ state: yield* encodeState(failed) })
        .where(and(eq(childRuns.id, run.id), active, sql`${storedRound} = ${turn.round}`)),
    )
    yield* announce(run.threadId)
    return yield* toChildRun(Option.getOrElse(yield* rowOf(run.id), () => row))
  })
}

/** Reading helpers: a Thread's, one by id, and one with its result once it ended. */
const readers = (deps: Deps) => {
  const { database, runtime } = deps
  const rowOf = rowReader(database)
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
  return { inThread, find, detail }
}

const makeChildRuns = Effect.fn('ChildRuns.make')(function* () {
  const deps: Deps = {
    database: yield* Database,
    runtime: yield* Runtime,
    conversation: yield* Conversation,
    changes: yield* Changes,
    threadStore: yield* ThreadStore,
    scope: yield* Effect.scope,
  }
  const wake = waker(deps)
  // A server that restarted owes the results it had not delivered yet.
  const owed = yield* deps.database.run(
    deps.database.select({ id: childRuns.id }).from(childRuns).where(eq(childRuns.wake, 'due')),
  )
  yield* Effect.forEach(owed, ({ id }) => wake(id), { discard: true })
  return ChildRuns.of({
    spawn: spawner(deps),
    settle: settler(deps, wake),
    followUp: followUpper(deps),
    actingFor: actingReader(deps.database),
    ...readers(deps),
    ...stoppers(deps, wake),
  })
})

/** Needs a `Scope`: result deliveries outlive the request that ended a helper. */
export const childRunsLayer = Layer.effect(ChildRuns, makeChildRuns())

/**
 * The helpers that have not ended, started by Runs acting for this Person in their current
 * workspace, newest first, each with its parent's Thread title: what the list of background work
 * shows (`work/list.ts`). Stopping one goes through `ChildRuns.cancel`, like a Person's Stop.
 */
export const liveHelpers = Effect.fn('ChildRuns.liveHelpers')(function* (actor: Actor) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ helper: childRuns, title: threads.title })
      .from(childRuns)
      .innerJoin(runs, eq(runs.id, childRuns.parentRunId))
      .innerJoin(threads, eq(threads.id, childRuns.threadId))
      .where(
        and(active, ownedHere({ personId: runs.personId, companyId: threads.companyId }, actor)),
      )
      .orderBy(desc(childRuns.requestedAt), desc(childRuns.id)),
  )
  return yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* ({ helper, title }) {
      return { run: yield* toChildRun(helper), title }
    }),
  )
})
