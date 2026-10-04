import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm'
import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  Conflict,
  DeliveryScope,
  NotFound,
  type DeliveryScopeRequest,
  type LibraryFolderId,
  Run,
  RunFailure,
  RunOrigin,
  RunState,
  type PersonId,
  PersonSummary,
  type RunId,
  ThreadId,
} from '@vivid/contracts'
import { loadSummaries } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database, decodeStored, type DatabaseInfrastructureError } from '../database/client.ts'
import { Admitted, StoredRunOrigin } from './conversation.ts'
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

/** A busy Thread keeps its first Person's authority; only a reserved turn may reach Flue. */
export const TurnReservation = Schema.TaggedUnion({
  Reserved: { turn: Schema.Number },
  Replayed: { turn: Schema.Number, receipt: Admitted },
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
 * `SeveralWorkingRuns`: more than one is, so which of them asked cannot be told.
 * `ActsForAnotherPerson`: the Run in progress was started for somebody else in a shared Thread.
 */
export class NoActingRun extends Schema.TaggedError<NoActingRun>()(
  'NoActingRun',
  {
    threadId: ThreadId,
    reason: Schema.Literals(['NoWorkingRun', 'SeveralWorkingRuns', 'ActsForAnotherPerson']),
  },
  { title: 'No Run in this Thread is acting for this Person' },
) {}

/**
 * The one Run working in a Thread, when it is acting for this Person.
 *
 * A tool call names a Thread and a Person and no Run, so the Run is found from the record:
 * `vivid_runs.person_id` is the Person each Run acts for, written when the Run was reserved. This
 * is what stops something that belongs to one Person (their own computer) being used by a Run
 * another member of a shared Thread started. Nothing is inferred when the record is not exact:
 * no working Run, or more than one, is a refusal rather than a pick. A reserved turn the runtime
 * has not accepted yet is also `working`, so only admitted Runs count, as in `start` below.
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
      .limit(2),
  )
  const [run, another] = working
  if (run === undefined) return yield* new NoActingRun({ threadId, reason: 'NoWorkingRun' })
  if (another !== undefined)
    return yield* new NoActingRun({ threadId, reason: 'SeveralWorkingRuns' })
  if (run.personId !== personId)
    return yield* new NoActingRun({ threadId, reason: 'ActsForAnotherPerson' })
  return run.id
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
 * `list` cannot serve the reviewer of a proposed action (`approvals/request.ts`): it folds
 * `Standing` and `Attention` into `Routine`, and those two start from text the server or Vivid
 * wrote, which must never be read as the Person's instruction. Filtering by Person here, not
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
    readonly libraryFolder: LibraryFolderId | null
  }) => Effect.Effect<TurnReservation, Conflict | DatabaseInfrastructureError>
  /** Records acceptance after Flue returns its receipt, and reopens a failed delivery on retry. */
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
  readonly working: () => Effect.Effect<ReadonlyArray<WorkingRun>, DatabaseInfrastructureError>
  /** A Thread's most recent Runs, oldest first, each naming the Person Vivid acted for. */
  readonly list: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<Run>, DatabaseInfrastructureError>
}

/**
 * The record of every Run: which Thread, for which Person, why it started and how it ended.
 * Flue's history has the words; this has the attribution Flue does not keep.
 */
export class RunStore extends Context.Service<RunStore, RunStoreService>()('vivid/RunStore') {}

type DatabaseService = Database['Service']

const decodeReceipt = decodeStored(Admitted, 'Run admission receipt')
const encodeReceipt = Schema.encodeSync(Admitted)
const decodeOrigin = decodeStored(StoredRunOrigin, 'Run origin')

/** Standing checks choose attention through notify_person; completing a quiet check stays quiet. */
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
    Routine: () => true,
    Standing: () => false,
    Attention: () => false,
    Decision: () => true,
  })
})
const decodeEnding = decodeStored(
  Schema.Literals(['completed', 'failed', 'stopped', 'unknown']),
  'Run state',
)
const decodeFailure = decodeStored(RunFailure, 'Run failure reason')
const encodeOrigin = Schema.encodeSync(StoredRunOrigin)

/** A Run's stored origin with the Person Vivid acted for put back beside it. */
const originOf = (origin: StoredRunOrigin, person: PersonSummary) =>
  StoredRunOrigin.match(origin, {
    Message: (): RunOrigin => RunOrigin.cases.Message.make({ person }),
    FirstConversation: (): RunOrigin => RunOrigin.cases.FirstConversation.make({ person }),
    Routine: ({ routineName }): RunOrigin => RunOrigin.cases.Routine.make({ person, routineName }),
    Standing: ({ routineName }): RunOrigin => RunOrigin.cases.Routine.make({ person, routineName }),
    Attention: ({ routineName }): RunOrigin =>
      RunOrigin.cases.Routine.make({ person, routineName }),
    Decision: (): RunOrigin => RunOrigin.cases.Decision.make({ person }),
  })

const ENDED = {
  completed: (finishedAt: number): RunState => RunState.cases.Completed.make({ finishedAt }),
  stopped: (finishedAt: number): RunState => RunState.cases.Stopped.make({ finishedAt }),
  unknown: (finishedAt: number): RunState => RunState.cases.Unknown.make({ finishedAt }),
}

/** The stored state and its time as the union. A finished state without a time is a database fault. */
const stateOf = Effect.fn('RunStore.stateOf')(function* (row: typeof runs.$inferSelect) {
  const { state, finishedAt } = row
  if (state === 'working') return RunState.cases.Working.make({})
  if (finishedAt === null) {
    return yield* Effect.fail(new DatabaseFailure({ message: 'A finished Run has no finish time' }))
  }
  const ending = yield* decodeEnding(state)
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
  return Run.make({
    id: row.id,
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
    return yield* Effect.fail(
      new DatabaseFailure({ message: 'Run authority conflicts with its original delivery' }),
    )
  const origin = yield* decodeOrigin(recorded.origin)
  if (StoredRunOrigin.guards.Message(input.origin) && input.origin.fingerprint !== undefined) {
    if (!StoredRunOrigin.guards.Message(origin) || origin.fingerprint !== input.origin.fingerprint)
      return yield* Effect.fail(
        new Conflict({
          message:
            'This message key was already used for different text or pictures. Send it with a new key.',
        }),
      )
  }
  return yield* Effect.void
})

/**
 * The server never joins a different Person's delivery into a response in progress. Flue 2.1
 * rerenders joined deliveries with their authority and has no queue-only dispatch, so checking
 * before calling Flue is mandatory. The working-Person check and turn reservation share the
 * parent Thread lock: simultaneous different-Person deliveries cannot both pass an idle check.
 * Same-Person Routine deliveries still join. An admitted replay returns its original receipt before Busy;
 * unadmitted reservations remain subject to the current working authority.
 */
const makeStart = (database: DatabaseService): RunStoreService['start'] =>
  Effect.fn('RunStore.start')(function* (input) {
    const now = yield* Clock.currentTimeMillis
    const folder = input.libraryFolder
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
        yield* tx
          .insert(runs)
          .values({
            id: input.id,
            threadId: input.threadId,
            personId: input.personId,
            libraryFolder: folder,
            turn: sql`(select coalesce(max("turn"), 0) + 1 from "vivid_runs" where "thread_id" = ${input.threadId})`,
            origin: encodeOrigin(input.origin),
            state: 'working',
            startedAt: now,
          })
          .onConflictDoNothing({ target: runs.id })
        const [recorded] = yield* tx.select().from(runs).where(eq(runs.id, input.id))
        if (recorded === undefined)
          return yield* Effect.fail(new DatabaseFailure({ message: 'Reserved Run not found' }))
        yield* sameAuthority(recorded, input)
        return TurnReservation.cases.Reserved.make({ turn: recorded.turn })
      }),
    )
  })

/** The actor and optional confinement survive runtime restarts without entering Flue history. */
const makeScope = (database: DatabaseService): RunStoreService['scope'] =>
  Effect.fn('RunStore.scope')(function* ({ threadId, turn }) {
    const [row] = yield* database.run(
      database
        .select()
        .from(runs)
        .where(and(eq(runs.threadId, threadId), eq(runs.turn, turn))),
    )
    if (row === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Delivery not found' }))
    return DeliveryScope.make({ acting: row.personId, libraryFolder: row.libraryFolder })
  })

/** A failed admission is replayable with its original turn; acceptance starts its observation. */
const makeAdmitted = (database: DatabaseService) =>
  Effect.fn('RunStore.admitted')(function* (receipt: Admitted) {
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .update(runs)
        .set({
          admittedAt: now,
          receipt: encodeReceipt(receipt),
          state: 'working',
          finishedAt: null,
          failureReason: null,
        })
        .where(and(eq(runs.id, receipt.runId), sql`${runs.admittedAt} is null`)),
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
    const rows = yield* database.run(
      database
        .update(runs)
        .set({ ...columns, finishedAt: now })
        .where(and(eq(runs.id, id), eq(runs.state, 'working')))
        .returning({ id: runs.id }),
    )
    return rows.length > 0
  })

const makeWorking = (database: DatabaseService) =>
  Effect.fn('RunStore.working')(function* () {
    return yield* database.run(
      database
        .select({ id: runs.id, threadId: runs.threadId, personId: runs.personId })
        .from(runs)
        .where(eq(runs.state, 'working')),
    )
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
    })
  }),
)
