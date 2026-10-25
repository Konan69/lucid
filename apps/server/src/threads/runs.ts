import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm'
import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  Conflict,
  DeliveryScope,
  NotFound,
  type DeliveryScopeRequest,
  Run,
  RunFailure,
  RunOrigin,
  RunState,
  type PersonId,
  PersonSummary,
  RunId,
  ThreadId,
  RuntimeSubmissionId,
} from '@vivid/contracts'
import { loadSummaries } from '../auth/access.ts'
import { announceFeed } from '../feed/changes.ts'
import { personTable } from '../auth/tables.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { Admitted, StoredReceipt, StoredRunOrigin } from './conversation.ts'
import { runs, threads } from './tables.ts'
import { summaryFor } from './wire.ts'

/** How a Run that is no longer working ended, as its row stores it. */
export const RunEnding = Schema.TaggedUnion({
  Completed: {},
  Failed: { reason: RunFailure },
  Stopped: {},
  Unknown: {},
})
export type RunEnding = typeof RunEnding.Type

/** A busy Thread keeps its first Person's authority; only a reserved turn may reach Pi. */
export const TurnReservation = Schema.TaggedUnion({
  Reserved: { turn: Schema.Finite },
  Replayed: { turn: Schema.Finite, receipt: Admitted },
  Unfollowed: { turn: Schema.Finite, runId: RunId },
  Busy: { person: PersonSummary },
})
export type TurnReservation = typeof TurnReservation.Type

/** A read can report a replay or refusal, but cannot claim that it reserved a new turn. */
export const ReservationNotice = Schema.Union([
  TurnReservation.cases.Replayed,
  TurnReservation.cases.Unfollowed,
  TurnReservation.cases.Busy,
]).pipe(Schema.toTaggedUnion('_tag'))
export type ReservationNotice = typeof ReservationNotice.Type

/** A Run that has not ended, with what is needed to pick its observation back up. */
export const WorkingRun = Schema.Struct({
  id: Run.fields.id,
  threadId: ThreadId,
  personId: PersonSummary.fields.id,
  submissionId: RuntimeSubmissionId,
})
export type WorkingRun = typeof WorkingRun.Type

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
 * its host is the earlier submission (`RuntimeSettlement.Done.answeredBy`). Check every admitted
 * working Run's authority before choosing that host by turn. Only admitted Runs can act through
 * tools. The Busy reservation check also includes unadmitted work because Pi may already hold it.
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
  /** Read-only preflight; the locked start must check again after the admission gate opens. */
  readonly check: (
    input: Parameters<RunStoreService['start']>[0],
  ) => Effect.Effect<Option.Option<ReservationNotice>, Conflict | DatabaseInfrastructureError>
  /** Reserves a turn only when no working Run acts for another Person; replays keep their turn. */
  readonly start: (input: {
    readonly id: RunId
    readonly threadId: ThreadId
    readonly personId: PersonId
    readonly origin: StoredRunOrigin
  }) => Effect.Effect<TurnReservation, Conflict | DatabaseInfrastructureError>
  /** Records acceptance after Pi returns its receipt, and reopens a failed delivery on retry. */
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
  /** Boot only: end legacy and receiptless work Unknown, then return admitted Runs to observe. */
  readonly working: Effect.Effect<ReadonlyArray<WorkingRun>, DatabaseInfrastructureError>
  /** An exact reservation, including an old keyed replay beyond the recent Thread window. */
  readonly get: (id: RunId) => Effect.Effect<Run, NotFound | DatabaseInfrastructureError>
  /** A Thread's most recent Runs, oldest first, each naming the Person Vivid acted for. */
  readonly list: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<Run>, DatabaseInfrastructureError>
}

/**
 * The record of every Run: which Thread, for which Person, why it started and how it ended.
 * Pi's history has the words; this has the attribution Pi does not keep.
 */
export class RunStore extends Context.Service<RunStore, RunStoreService>()('vivid/RunStore') {}

type DatabaseService = Database['Service']

const decodeReceipt = decodeStored(StoredReceipt, 'Run admission receipt')
const encodeReceipt = encodeStored(Admitted, 'Run admission receipt')
const decodeOrigin = decodeStored(StoredRunOrigin, 'Run origin')

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
    Watch: ({ watchName }): RunOrigin => RunOrigin.cases.Watch.make({ person, watchName }),
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

const toRun = Effect.fn('RunStore.toRun')(function* (
  row: typeof runs.$inferSelect,
  summaries: ReadonlyMap<PersonId, PersonSummary>,
) {
  const person = yield* summaryFor(summaries, row.personId)
  const receipt = row.receipt === null ? undefined : yield* decodeReceipt(row.receipt)
  return Run.make({
    id: row.id,
    submissionId:
      receipt !== undefined && StoredReceipt.guards.Pi(receipt)
        ? String(receipt.submissionId)
        : undefined,
    threadId: row.threadId,
    turn: row.turn,
    origin: originOf(yield* decodeOrigin(row.origin), person),
    state: yield* stateOf(row),
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

/** Shared by preflight and locked reservation, so replay precedence and Busy authority agree. */
const checkReservation = Effect.fn('RunStore.checkReservation')(function* (
  tx: Pick<DatabaseService, 'select'>,
  input: Parameters<RunStoreService['start']>[0],
) {
  const [existing] = yield* tx.select().from(runs).where(eq(runs.id, input.id))
  if (existing !== undefined) {
    yield* sameAuthority(existing, input)
    if (
      existing.admittedAt === null &&
      RunState.isAnyOf(['Stopped', 'Unknown', 'Completed'])(yield* stateOf(existing))
    )
      return Option.some(
        TurnReservation.cases.Unfollowed.make({
          turn: existing.turn,
          runId: existing.id,
        }),
      )
    if (existing.admittedAt !== null) {
      const receipt = yield* decodeReceipt(existing.receipt)
      return Option.some(
        yield* StoredReceipt.match(receipt, {
          Legacy: (old) =>
            Effect.succeed(
              TurnReservation.cases.Unfollowed.make({ turn: existing.turn, runId: old.runId }),
            ),
          Pi: (current) =>
            Effect.succeed(
              TurnReservation.cases.Replayed.make({ turn: existing.turn, receipt: current }),
            ),
        }),
      )
    }
  }
  const [answering] = yield* tx
    .select({ id: runs.personId, name: personTable.name, image: personTable.image })
    .from(runs)
    .innerJoin(personTable, eq(personTable.id, runs.personId))
    .where(
      and(
        eq(runs.threadId, input.threadId),
        eq(runs.state, 'working'),
        ne(runs.personId, input.personId),
      ),
    )
    .orderBy(asc(runs.turn))
    .limit(1)
  return answering === undefined
    ? Option.none<ReservationNotice>()
    : Option.some(TurnReservation.cases.Busy.make({ person: answering }))
})

/**
 * A response holds one Person's authority. Pi can steer several deliveries into it, so the
 * server must refuse another Person before admitting their delivery. The working-Person check and
 * turn reservation share the parent Thread lock: simultaneous different-Person deliveries cannot both pass an idle check.
 * Same-Person Routine deliveries still join. An admitted replay returns its original receipt before Busy;
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
        const notice = yield* checkReservation(tx, input)
        if (Option.isSome(notice)) return notice.value
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

/** The actor and optional confinement survive runtime restarts without entering Pi history. */
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
          .where(
            and(
              eq(runs.id, receipt.runId),
              sql`${runs.admittedAt} is null`,
              ne(runs.state, 'stopped'),
              ne(runs.state, 'unknown'),
              ne(runs.state, 'completed'),
            ),
          )
          .returning({ thread: runs.threadId })
        const row = rows[0]
        if (row !== undefined) yield* announceFeed(tx, [row.thread])
      }),
    )
  })

type EndingColumns = Pick<typeof runs.$inferInsert, 'state' | 'failureReason'>

const makeEnd = (database: DatabaseService) =>
  Effect.fn('RunStore.end')(function* (id: RunId, ending: RunEnding) {
    const now = yield* Clock.currentTimeMillis
    const columns = RunEnding.match(ending, {
      Completed: (): EndingColumns => ({
        state: 'completed',
        failureReason: null,
      }),
      Failed: ({ reason }) => ({ state: 'failed', failureReason: reason }),
      Stopped: () => ({ state: 'stopped', failureReason: null }),
      Unknown: () => ({ state: 'unknown', failureReason: null }),
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
        // Settlement dates the Feed's history even when admission failed before delivery's touch.
        yield* tx.update(threads).set({ updatedAt: now }).where(eq(threads.id, row.thread))
        yield* announceFeed(tx, [row.thread])
        return true
      }),
    )
  })

/** Boot only. A legacy or receiptless Run ends Unknown without notification, naming or learning.
 * Pi may still hold and answer a receiptless delivery. Its reply appears through the state link
 * with no Run attached; startup never admits it again. */
const makeWorking = Effect.fn('RunStore.working')(function* (database: DatabaseService) {
  const rows = yield* database.run(database.select().from(runs).where(eq(runs.state, 'working')))
  const working = yield* Effect.forEach(
    rows,
    Effect.fn('RunStore.resume')(function* (row) {
      const identity = { id: row.id, threadId: row.threadId, personId: row.personId }
      const legacy = makeEnd(database)(row.id, RunEnding.cases.Unknown.make({})).pipe(
        Effect.as<ReadonlyArray<WorkingRun>>([]),
      )
      if (row.receipt === null) return yield* legacy
      return yield* StoredReceipt.match(yield* decodeReceipt(row.receipt), {
        Pi: (receipt) =>
          Effect.succeed([WorkingRun.make({ ...identity, submissionId: receipt.submissionId })]),
        Legacy: () => legacy,
      })
    }),
  )
  return working.flat()
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
    const newestFirst = yield* Effect.forEach(rows, (row) => toRun(row, summaries))
    return Arr.reverse(newestFirst)
  })

/** Exact lookups must not depend on the bounded recent Run list used by a screen. */
const makeGet = (database: DatabaseService) =>
  Effect.fn('RunStore.get')(function* (id: RunId) {
    const [row] = yield* database.run(database.select().from(runs).where(eq(runs.id, id)))
    if (row === undefined) return yield* new NotFound({ message: 'Run not found' })
    const summaries = yield* loadSummaries([row.personId]).pipe(
      Effect.provideService(Database, database),
    )
    return yield* toRun(row, summaries)
  })

export const runStoreLayer = Layer.effect(
  RunStore,
  Effect.gen(function* () {
    const database = yield* Database
    return RunStore.of({
      check: Effect.fn('RunStore.check')((input) =>
        database.run(checkReservation(database, input)),
      ),
      start: makeStart(database),
      admitted: makeAdmitted(database),
      scope: makeScope(database),
      end: makeEnd(database),
      working: makeWorking(database),
      list: makeList(database),
      get: makeGet(database),
    })
  }),
)
