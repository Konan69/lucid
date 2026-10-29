import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  ApprovalInvalidation,
  DatabaseFailure,
  Conflict,
  DeliveryScope,
  NotFound,
  type DeliveryScopeRequest,
  Forbidden,
  Run,
  RunDeliveryReceipt,
  RunFailure,
  RunOrigin,
  RunOutcome,
  RunState,
  RunUncertainty,
  type PersonId,
  PersonSummary,
  RunId,
  ThreadId,
} from '@vivid/contracts'
import { unresolvedOf, type Unresolved } from '../actions/journal.ts'
import { loadSummaries } from '../auth/access.ts'
import { announceFeed } from '../feed/changes.ts'
import { askedBy, invalidatePending } from '../approvals/stale.ts'
import { personTable } from '../auth/tables.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { requireThread } from './access.ts'
import { Admitted, StoredRunOrigin, StoredRunOriginColumn } from './conversation.ts'
import { runs, threads } from './tables.ts'
import { summaryFor } from './wire.ts'

/** How a Run that is no longer working ended, as its row stores it. `responseId` names its answer. */
export const RunEnding = Schema.TaggedUnion({
  Completed: { responseId: RunId },
  Failed: { reason: RunFailure },
  Stopped: {},
  Unknown: {},
})
export type RunEnding = typeof RunEnding.Type

/** A busy Thread keeps its first Person's authority; only a reserved turn may reach the runtime. */
export const TurnReservation = Schema.TaggedUnion({
  Reserved: { turn: Schema.Finite },
  Replayed: { turn: Schema.Finite, receipt: Admitted },
  Busy: { person: PersonSummary },
})
export type TurnReservation = typeof TurnReservation.Type

/** A Run that has not ended, with what is needed to pick its observation back up. */
export interface WorkingRun {
  readonly id: RunId
  readonly threadId: ThreadId
  readonly personId: PersonId
}

/**
 * A Thread has no Run that may act for this Person right now. `NoWorkingRun`: nothing is running.
 * `ActsForAnotherPerson`: at least one admitted working Run acts for somebody else.
 */
export class NoActingRun extends Schema.TaggedError<NoActingRun>()(
  'NoActingRun',
  {
    threadId: ThreadId,
    reason: Schema.Literals(['NoWorkingRun', 'ActsForAnotherPerson']),
  },
  { title: 'No Run in this Thread is acting for this Person' },
) {}

/**
 * The oldest admitted working Run in a Thread, when all working Runs act for this Person.
 *
 * A tool call names a Thread and a Person and no Run, so the Run is found from the record:
 * `vivid_runs.person_id` is the Person each Run acts for, written when the Run was reserved. This
 * is what stops something that belongs to one Person (their own computer) being used by a Run
 * another member of a shared Thread started. Same-Person deliveries may join the live response;
 * Pi identifies the host in settlement's `answeredBy`. Check every admitted working Run's
 * authority before choosing that host by turn. A reserved turn the runtime has not accepted is also `working`, so only admitted
 * Runs count, as in `start` below.
 */
export const actingRun = Effect.fn('RunStore.actingRun')(function* (
  threadId: ThreadId,
  personId: PersonId,
) {
  const database = yield* Database
  const working = yield* database.run(
    database
      .select({ id: runs.id, personId: runs.personId })
      .from(runs)
      .where(
        and(eq(runs.threadId, threadId), eq(runs.state, 'working'), isNotNull(runs.admittedAt)),
      )
      .orderBy(asc(runs.turn)),
  )
  const [run] = working
  if (run === undefined) return yield* new NoActingRun({ threadId, reason: 'NoWorkingRun' })
  if (working.some((candidate) => candidate.personId !== personId))
    return yield* new NoActingRun({ threadId, reason: 'ActsForAnotherPerson' })
  return run.id
})

/** Resolve only the supplied admitted Run and decode its persisted state. What each state
 * authorizes is the caller's rule: see `dispatchRun` in `computers/device.ts`, where a Run acting
 * for itself must be Working and an action the Person approved is also sent for a Completed Run. */
export const admittedRunState = Effect.fn('RunStore.admittedRunState')(function* (input: {
  readonly runId: RunId
  readonly threadId: ThreadId
  readonly personId: PersonId
}) {
  const database = yield* Database
  const [row] = yield* database.run(database.select().from(runs).where(eq(runs.id, input.runId)))
  if (row === undefined || row.threadId !== input.threadId || row.admittedAt === null)
    return yield* new NoActingRun({ threadId: input.threadId, reason: 'NoWorkingRun' })
  if (row.personId !== input.personId)
    return yield* new NoActingRun({ threadId: input.threadId, reason: 'ActsForAnotherPerson' })
  return yield* stateOf(row)
})

/**
 * How many of a Person's newest Runs in a Thread the reviewer looks back over (`requestRuns`).
 * Exported so the reader can tell a complete turn from one this window cut off.
 */
export const REQUEST_RUNS = 20

/** One admitted Run acting for a Person: whether it is the turn in progress, and why it started. */
export interface RequestRun {
  readonly id: RunId
  readonly working: boolean
  readonly origin: StoredRunOrigin
}

/**
 * The newest Runs in a Thread that act for one Person, oldest first, with the stored origin.
 *
 * The review needs the stored origin so a server-written body never counts as the Person's
 * instruction. Filtering by Person here, not
 * after a Thread-wide limit, keeps attribution exact in a long shared Thread. Only admitted Runs
 * count, as in `actingRun`: a reserved turn the runtime has not accepted has no words in history.
 */
export const requestRuns = Effect.fn('RunStore.requestRuns')(function* (
  threadId: ThreadId,
  personId: PersonId,
) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ id: runs.id, state: runs.state, origin: runs.origin })
      .from(runs)
      .where(
        and(eq(runs.threadId, threadId), eq(runs.personId, personId), isNotNull(runs.admittedAt)),
      )
      .orderBy(desc(runs.turn))
      .limit(REQUEST_RUNS),
  )
  return yield* Effect.forEach(Arr.reverse(rows), (row) =>
    Effect.map(decodeOrigin(row.origin), (origin): RequestRun => ({
      id: row.id,
      working: row.state === 'working',
      origin,
    })),
  )
})

export interface RunStoreService {
  /** Reserves a turn only when no working Run acts for another Person; replays keep their turn. */
  readonly start: (input: {
    readonly id: RunId
    readonly threadId: ThreadId
    readonly personId: PersonId
    readonly origin: StoredRunOrigin
  }) => Effect.Effect<TurnReservation, Conflict | DatabaseInfrastructureError>
  /** Records acceptance after the runtime returns its receipt, and reopens a failed delivery on retry. */
  readonly admitted: (receipt: Admitted) => Effect.Effect<void, DatabaseInfrastructureError>
  /** Runtime-only lookup, by the harmless turn number a delivery shows the model. */
  readonly scope: (
    request: DeliveryScopeRequest,
  ) => Effect.Effect<DeliveryScope, NotFound | DatabaseInfrastructureError>
  /** Ends a Run that is still working. False when it had already ended, so nothing is done twice. */
  readonly end: (
    id: RunId,
    ending: RunEnding,
  ) => Effect.Effect<boolean, DatabaseInfrastructureError>
  /** Every Run still marked as working, for picking their observation back up after a restart. */
  readonly working: Effect.Effect<ReadonlyArray<WorkingRun>, DatabaseInfrastructureError>
  /** A Thread's most recent Runs, oldest first, each naming the Person Vivid acted for. */
  readonly list: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<Run>, DatabaseInfrastructureError>
  /**
   * Records that the Person a completed Run acted for, who can still see its Thread, drew its final
   * response. The first acknowledgement is the receipt; it answers with the Thread when it was.
   */
  readonly acknowledge: (input: {
    readonly runId: RunId
    readonly responseId: RunId
    readonly personId: PersonId
  }) => Effect.Effect<Option.Option<ThreadId>, NotFound | Forbidden | DatabaseInfrastructureError>
}

/**
 * The record of every Run: which Thread, for which Person, why it started and how it ended.
 * the runtime's history has the words; this has the attribution the runtime does not keep.
 */
export class RunStore extends Context.Service<RunStore, RunStoreService>()('vivid/RunStore') {}

type DatabaseService = Database['Service']

const decodeReceipt = decodeStored(Admitted, 'Run admission receipt')
const encodeReceipt = encodeStored(Admitted, 'Run admission receipt')
const decodeOrigin = decodeStored(StoredRunOriginColumn, 'Run origin')

/** Watch work reaches the Person through the Feed; completing a quiet check stays quiet. */
export const automaticallyNotifies = Effect.fn('RunStore.automaticallyNotifies')(function* (
  id: RunId,
) {
  const database = yield* Database
  const rows = yield* database.run(
    database.select({ origin: runs.origin }).from(runs).where(eq(runs.id, id)),
  )
  const row = rows[0]
  if (row === undefined) return yield* new DatabaseFailure({ message: 'Settled Run not found.' })
  return StoredRunOrigin.match(yield* decodeOrigin(row.origin), {
    Message: () => true,
    FirstConversation: () => false,
    Decision: () => true,
    // A background wake for the Feed: the Person hears about it only when Vivid posts there.
    Watch: () => false,
    WatchUnrecorded: () => false,
    // The Settings screen shows the forget's receipt; nothing else is said.
    Forget: () => false,
    // A check-in is work nobody is watching too: the Person hears about it only through the Feed.
    Checkin: () => false,
  })
})
const decodeState = decodeStored(
  Schema.Literals(['working', 'completed', 'failed', 'stopped', 'unknown']),
  'Run state',
)
const decodeFailure = decodeStored(RunFailure, 'Run failure reason')
const encodeOrigin = encodeStored(StoredRunOrigin, 'Run origin')

/** A Run's stored origin with the Person Vivid acted for put back beside it. */
const originOf = (origin: StoredRunOrigin, person: PersonSummary) =>
  StoredRunOrigin.match(origin, {
    Message: (): RunOrigin => RunOrigin.cases.Message.make({ person }),
    FirstConversation: (): RunOrigin => RunOrigin.cases.FirstConversation.make({ person }),
    Decision: (): RunOrigin => RunOrigin.cases.Decision.make({ person }),
    Watch: (watch): RunOrigin =>
      RunOrigin.cases.Watch.make({
        person,
        watchId: watch.watchId,
        watchName: watch.watchName,
        eventId: watch.eventId,
        event: watch.event,
        occurredAt: watch.occurredAt,
      }),
    WatchUnrecorded: ({ watchName }): RunOrigin =>
      RunOrigin.cases.WatchUnrecorded.make({ person, watchName }),
    Forget: (): RunOrigin => RunOrigin.cases.Forget.make({ person }),
    Checkin: ({ watchId, watchName, eventId }): RunOrigin =>
      RunOrigin.cases.Checkin.make({ person, watchId, watchName, eventId }),
  })

const ENDED = {
  completed: (finishedAt: number): RunState => RunState.cases.Completed.make({ finishedAt }),
  stopped: (finishedAt: number): RunState => RunState.cases.Stopped.make({ finishedAt }),
  unknown: (finishedAt: number): RunState => RunState.cases.Unknown.make({ finishedAt }),
}

/** The stored state and its time as the union. A finished state without a time is a database fault. */
const stateOf = Effect.fn('RunStore.stateOf')(function* (row: typeof runs.$inferSelect) {
  const { finishedAt } = row
  const state = yield* decodeState(row.state)
  if (state === 'working') return RunState.cases.Working.make({})
  if (finishedAt === null) {
    return yield* new DatabaseFailure({ message: 'A finished Run has no finish time' })
  }
  const ending = state
  if (ending === 'failed') {
    // The requested legacy interpretation is explicit; new failures always persist a reason.
    const reason =
      row.failureReason === null ? 'Unexplained' : yield* decodeFailure(row.failureReason)
    return RunState.cases.Failed.make({ finishedAt, reason })
  }
  return ENDED[ending](finishedAt)
})

/**
 * How far a Run is proven to have got, from what its row and the action journal already hold.
 * Nothing here is stored twice: admission is the receipt, completion the settled state and its
 * response, delivery the acknowledgement. An unresolved outward operation outranks completion,
 * since a finished reply does not settle what the Run sent; while working it is still in progress.
 */
const outcomeOf = ({
  row,
  submissionId,
  state,
  person,
  unresolved,
}: {
  readonly row: typeof runs.$inferSelect
  readonly submissionId: Option.Option<string>
  readonly state: RunState
  readonly person: PersonSummary
  readonly unresolved: Option.Option<Unresolved>
}): Option.Option<RunOutcome> => {
  if (Option.isNone(submissionId) || row.admittedAt === null) return Option.none()
  const accepted = RunOutcome.cases.Accepted.make({
    acceptedAt: row.admittedAt,
    submissionId: submissionId.value,
  })
  const actionUnknown = Option.map(unresolved, ({ operationId, observedAt }) =>
    RunOutcome.cases.Unknown.make({
      observedAt,
      uncertainty: RunUncertainty.cases.Action.make({ operationId }),
    }),
  )
  return Option.some(
    RunState.match(state, {
      Working: (): RunOutcome => accepted,
      Unknown: ({ finishedAt }): RunOutcome =>
        RunOutcome.cases.Unknown.make({
          observedAt: finishedAt,
          uncertainty: RunUncertainty.cases.Execution.make({}),
        }),
      Failed: (): RunOutcome => Option.getOrElse(actionUnknown, () => accepted),
      Stopped: (): RunOutcome => Option.getOrElse(actionUnknown, () => accepted),
      Completed: ({ finishedAt }): RunOutcome =>
        Option.getOrElse(actionUnknown, () => answered(row, accepted, finishedAt, person)),
    }),
  )
}

/** A completed Run's answer: delivered once its Person acknowledged it, else only completed. */
const answered = (
  row: typeof runs.$inferSelect,
  accepted: RunOutcome,
  completedAt: number,
  person: PersonSummary,
): RunOutcome => {
  // Runs completed before the answering response was kept cannot name it, so stay accepted.
  if (row.responseId === null) return accepted
  const completed = { completedAt, responseId: row.responseId }
  if (row.deliveredAt === null) return RunOutcome.cases.Completed.make(completed)
  return RunOutcome.cases.Delivered.make({
    ...completed,
    receipt: RunDeliveryReceipt.cases.Thread.make({
      person,
      acknowledgedAt: row.deliveredAt,
      responseId: row.responseId,
    }),
  })
}

const toRun = Effect.fn('RunStore.toRun')(function* (
  row: typeof runs.$inferSelect,
  summaries: ReadonlyMap<PersonId, PersonSummary>,
  unresolved: ReadonlyMap<RunId, Unresolved>,
) {
  const person = yield* summaryFor(summaries, row.personId)
  const receipt = row.receipt === null ? undefined : yield* decodeReceipt(row.receipt)
  const submissionId = receipt === undefined ? undefined : String(receipt.submissionId)
  const state = yield* stateOf(row)
  const outcome = outcomeOf({
    row,
    submissionId: Option.fromUndefinedOr(submissionId),
    state,
    person,
    unresolved: Option.fromUndefinedOr(unresolved.get(row.id)),
  })
  return Run.make({
    submissionId,
    id: row.id,
    threadId: row.threadId,
    turn: row.turn,
    origin: originOf(yield* decodeOrigin(row.origin), person),
    state,
    outcome: Option.getOrNull(outcome),
    startedAt: row.startedAt,
  })
})

/** Idempotency never changes which Thread and Person owned the first reservation. */
const sameAuthority = Effect.fn('RunStore.sameAuthority')(function* (
  recorded: typeof runs.$inferSelect,
  input: Parameters<RunStoreService['start']>[0],
) {
  if (recorded.threadId !== input.threadId || recorded.personId !== input.personId)
    return yield* new DatabaseFailure({
      message: 'Run authority conflicts with its original delivery',
    })
  const origin = yield* decodeOrigin(recorded.origin)
  if (StoredRunOrigin.guards.Message(input.origin) && input.origin.fingerprint !== undefined) {
    if (!StoredRunOrigin.guards.Message(origin) || origin.fingerprint !== input.origin.fingerprint)
      return yield* new Conflict({
        message:
          'This message key was already used for different text or pictures. Send it with a new key.',
      })
  }
  return yield* Effect.void
})

/**
 * The server never joins a different Person's delivery into a response in progress. Check
 * acting authority before runtime admission. The working-Person check and turn reservation share the
 * parent Thread lock: simultaneous different-Person deliveries cannot both pass an idle check.
 * Same-Person server deliveries still join. An admitted replay returns its original receipt before Busy;
 * unadmitted reservations remain subject to the current working authority.
 */
const makeStart = (database: DatabaseService): RunStoreService['start'] =>
  Effect.fn('RunStore.start')(function* (input) {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, input.threadId))
          .for('update')
        const [existing] = yield* tx.select().from(runs).where(eq(runs.id, input.id))
        if (existing !== undefined) {
          yield* sameAuthority(existing, input)
          if (existing.admittedAt !== null)
            return TurnReservation.cases.Replayed.make({
              turn: existing.turn,
              receipt: yield* decodeReceipt(existing.receipt),
            })
        }
        const [answering] = yield* tx
          .select({ id: runs.personId, name: personTable.name, image: personTable.image })
          .from(runs)
          .innerJoin(personTable, eq(personTable.id, runs.personId))
          .where(
            and(
              eq(runs.threadId, input.threadId),
              eq(runs.state, 'working'),
              isNotNull(runs.admittedAt),
              ne(runs.personId, input.personId),
            ),
          )
          .orderBy(asc(runs.turn))
          .limit(1)
        if (answering !== undefined) return TurnReservation.cases.Busy.make({ person: answering })
        const inserted = yield* tx
          .insert(runs)
          .values({
            id: input.id,
            threadId: input.threadId,
            personId: input.personId,
            turn: sql`(select coalesce(max("turn"), 0) + 1 from "vivid_runs" where "thread_id" = ${input.threadId})`,
            origin: yield* encodeOrigin(input.origin),
            state: 'working',
            startedAt: now,
          })
          .onConflictDoNothing({ target: runs.id })
          .returning({ id: runs.id })
        if (inserted.length > 0) yield* announceFeed(tx, [input.threadId])
        const [recorded] = yield* tx.select().from(runs).where(eq(runs.id, input.id))
        if (recorded === undefined)
          return yield* new DatabaseFailure({ message: 'Reserved Run not found' })
        yield* sameAuthority(recorded, input)
        return TurnReservation.cases.Reserved.make({ turn: recorded.turn })
      }),
    )
  })

/** The acting Person survives runtime restarts without entering the runtime history. */
const makeScope = (database: DatabaseService): RunStoreService['scope'] =>
  Effect.fn('RunStore.scope')(function* ({ threadId, turn }) {
    const [row] = yield* database.run(
      database
        .select()
        .from(runs)
        .where(and(eq(runs.threadId, threadId), eq(runs.turn, turn))),
    )
    if (row === undefined) return yield* new NotFound({ message: 'Delivery not found' })
    return DeliveryScope.make({ acting: row.personId })
  })

/** A failed admission is replayable with its original turn; acceptance starts its observation. */
const makeAdmitted = (database: DatabaseService) =>
  Effect.fn('RunStore.admitted')(function* (receipt: Admitted) {
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .update(runs)
          .set({
            admittedAt: now,
            receipt: yield* encodeReceipt(receipt),
            state: 'working',
            finishedAt: null,
            failureReason: null,
          })
          .where(and(eq(runs.id, receipt.runId), sql`${runs.admittedAt} is null`))
          .returning({ thread: runs.threadId })
        const row = rows[0]
        if (row !== undefined) yield* announceFeed(tx, [row.thread])
      }),
    )
  })

type EndingColumns = Pick<typeof runs.$inferInsert, 'state' | 'failureReason' | 'responseId'>

const makeEnd = (database: DatabaseService) =>
  Effect.fn('RunStore.end')(function* (id: RunId, ending: RunEnding) {
    const now = yield* Clock.currentTimeMillis
    const columns = RunEnding.match(ending, {
      Completed: ({ responseId }): EndingColumns => ({
        state: 'completed',
        failureReason: null,
        responseId,
      }),
      Failed: ({ reason }) => ({ state: 'failed', failureReason: reason, responseId: null }),
      Stopped: () => ({ state: 'stopped', failureReason: null, responseId: null }),
      Unknown: () => ({ state: 'unknown', failureReason: null, responseId: null }),
    })
    // One conditional update: only the caller that moves the Run out of `working` gets `true`, so
    // a settlement observed twice (a restart, a repeated delivery) acts once.
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const [run] = yield* tx.select({ thread: runs.threadId }).from(runs).where(eq(runs.id, id))
        if (run === undefined) return false
        // Start and Thread deletion lock the parent first; settlement must keep that lock order.
        yield* tx
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, run.thread))
          .for('update')
        const rows = yield* tx
          .update(runs)
          .set({ ...columns, finishedAt: now })
          .where(and(eq(runs.id, id), eq(runs.state, 'working')))
          .returning({ thread: runs.threadId })
        const row = rows[0]
        if (row === undefined) return false
        // A Run the Person stopped takes its open asks with it; a Run that only finished does not,
        // because asking and then waiting for the answer is how a Run normally ends.
        if (RunEnding.guards.Stopped(ending))
          yield* invalidatePending(
            tx,
            askedBy(id),
            ApprovalInvalidation.cases.RunStopped.make({ runId: id }),
          )
        // Settlement dates the Feed's history even when admission failed before delivery's touch.
        yield* tx.update(threads).set({ updatedAt: now }).where(eq(threads.id, row.thread))
        yield* announceFeed(tx, [row.thread])
        return true
      }),
    )
  })

/** Receiptless reservations have no runtime identity to observe after a server crash.
 * The cutover importer carries working legacy Runs; only saved Pi receipts resume here. */
const makeWorking = Effect.fn('RunStore.working')(function* (database: DatabaseService) {
  const rows = yield* database.run(database.select().from(runs).where(eq(runs.state, 'working')))
  const resumed = yield* Effect.forEach(
    rows,
    Effect.fn('RunStore.resume')(function* (run) {
      if (run.receipt === null) {
        yield* makeEnd(database)(run.id, RunEnding.cases.Unknown.make({}))
        return []
      }
      yield* decodeReceipt(run.receipt)
      return [{ id: run.id, threadId: run.threadId, personId: run.personId }]
    }),
  )
  return resumed.flat()
})

const makeList = (database: DatabaseService) =>
  Effect.fn('RunStore.list')(function* (threadId: ThreadId) {
    const rows = yield* database.run(
      database
        .select()
        .from(runs)
        .where(eq(runs.threadId, threadId))
        .orderBy(desc(runs.turn))
        .limit(200),
    )
    const summaries = yield* loadSummaries(rows.map((row) => row.personId)).pipe(
      Effect.provideService(Database, database),
    )
    const unresolved = yield* unresolvedOf(rows.map((row) => row.id)).pipe(
      Effect.provideService(Database, database),
    )
    const newestFirst = yield* Effect.forEach(rows, (row) => toRun(row, summaries, unresolved))
    return Arr.reverse(newestFirst)
  })

/**
 * Only the Person the Run acted for acknowledges it, and only for the response that answered it:
 * another member of a shared Thread drawing it is not that Person's receipt. Thread access is
 * checked first; one conditional write makes a repeat harmless.
 */
const makeAcknowledge = (database: DatabaseService): RunStoreService['acknowledge'] =>
  Effect.fn('RunStore.acknowledge')(function* ({ runId, responseId, personId }) {
    const [row] = yield* database.run(database.select().from(runs).where(eq(runs.id, runId)))
    if (row === undefined) return yield* new NotFound({ message: 'Run not found' })
    // A Person who can no longer see the Thread learns nothing about its Runs, this one included.
    yield* requireThread(row.threadId, personId).pipe(Effect.provideService(Database, database))
    if (row.personId !== personId)
      return yield* new Forbidden({ message: 'Only the Person this Run acted for acknowledges it' })
    if (row.state !== 'completed' || row.responseId !== responseId)
      return yield* new NotFound({ message: 'That is not this Run’s final response' })
    const now = yield* Clock.currentTimeMillis
    const written = yield* database.run(
      database
        .update(runs)
        .set({ deliveredAt: now })
        .where(and(eq(runs.id, runId), isNull(runs.deliveredAt)))
        .returning({ thread: runs.threadId }),
    )
    return Option.map(Arr.head(written), (first) => first.thread)
  })

export const runStoreLayer = Layer.effect(
  RunStore,
  Effect.gen(function* () {
    const database = yield* Database
    return RunStore.of({
      start: makeStart(database),
      admitted: makeAdmitted(database),
      scope: makeScope(database),
      end: makeEnd(database),
      working: makeWorking(database),
      list: makeList(database),
      acknowledge: makeAcknowledge(database),
    })
  }),
)
