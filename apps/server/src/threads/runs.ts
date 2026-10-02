import { and, desc, eq, sql } from 'drizzle-orm'
import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  DeliveryScope,
  NotFound,
  type DeliveryScopeRequest,
  type LibraryFolderId,
  Run,
  RunFailure,
  RunOrigin,
  RunState,
  type PersonId,
  type PersonSummary,
  type RunId,
  type ThreadId,
} from '@vivid/contracts'
import { loadSummaries } from '../auth/access.ts'
import { Database, decodeStored, type DatabaseInfrastructureError } from '../database/client.ts'
import { StoredRunOrigin } from './conversation.ts'
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

/** A Run that has not ended, with what is needed to pick its observation back up. */
export interface WorkingRun {
  readonly id: RunId
  readonly threadId: ThreadId
  readonly personId: PersonId
}

export interface RunStoreService {
  /** Records that a Run began. Recording the same Run twice changes nothing. */
  readonly start: (input: {
    readonly id: RunId
    readonly threadId: ThreadId
    readonly personId: PersonId
    readonly origin: StoredRunOrigin
    readonly libraryFolder: LibraryFolderId | null
  }) => Effect.Effect<number, DatabaseInfrastructureError>
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

const decodeOrigin = decodeStored(StoredRunOrigin, 'Run origin')
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
    Routine: ({ routineName }): RunOrigin => RunOrigin.cases.Routine.make({ person, routineName }),
    FollowUp: ({ taskTitle }): RunOrigin => RunOrigin.cases.FollowUp.make({ person, taskTitle }),
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

/** Lock the parent Thread inside the insert transaction: racing deliveries allocate distinct turns.
 * A replay preserves both its turn and its original authority, including after a failed admission. */
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
        if (
          recorded === undefined ||
          recorded.threadId !== input.threadId ||
          recorded.personId !== input.personId
        ) {
          return yield* Effect.fail(
            new DatabaseFailure({ message: 'Run authority conflicts with its original delivery' }),
          )
        }
        return recorded.turn
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
      scope: makeScope(database),
      end: makeEnd(database),
      working: makeWorking(database),
      list: makeList(database),
    })
  }),
)
