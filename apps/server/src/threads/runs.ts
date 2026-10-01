import { and, desc, eq } from 'drizzle-orm'
import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  Run,
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
import { runs } from './tables.ts'
import { summaryFor } from './wire.ts'

/** How a Run that is no longer working ended, as its row stores it. */
export const RunEnding = Schema.Literals(['completed', 'failed', 'stopped', 'unknown'] as const)
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
  }) => Effect.Effect<void, DatabaseInfrastructureError>
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
const decodeEnding = decodeStored(RunEnding, 'Run state')
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
  failed: (finishedAt: number): RunState => RunState.cases.Failed.make({ finishedAt }),
  stopped: (finishedAt: number): RunState => RunState.cases.Stopped.make({ finishedAt }),
  unknown: (finishedAt: number): RunState => RunState.cases.Unknown.make({ finishedAt }),
} satisfies Record<RunEnding, (finishedAt: number) => RunState>

/** The stored state and its time as the union. A finished state without a time is a database fault. */
const stateOf = Effect.fn('RunStore.stateOf')(function* (state: string, finishedAt: number | null) {
  if (state === 'working') return RunState.cases.Working.make({})
  if (finishedAt === null) {
    return yield* Effect.fail(new DatabaseFailure({ message: 'A finished Run has no finish time' }))
  }
  return ENDED[yield* decodeEnding(state)](finishedAt)
})

const toRun = Effect.fn('RunStore.toRun')(function* (
  row: typeof runs.$inferSelect,
  summaries: ReadonlyMap<PersonId, PersonSummary>,
) {
  const person = yield* summaryFor(summaries, row.personId)
  return Run.make({
    id: row.id,
    threadId: row.threadId,
    origin: originOf(yield* decodeOrigin(row.origin), person),
    state: yield* stateOf(row.state, row.finishedAt),
    startedAt: row.startedAt,
  })
})

const makeStart = (database: DatabaseService) =>
  Effect.fn('RunStore.start')(function* (input: {
    readonly id: RunId
    readonly threadId: ThreadId
    readonly personId: PersonId
    readonly origin: StoredRunOrigin
  }) {
    const now = yield* Clock.currentTimeMillis
    yield* database.run(
      database
        .insert(runs)
        .values({
          id: input.id,
          threadId: input.threadId,
          personId: input.personId,
          origin: encodeOrigin(input.origin),
          state: 'working',
          startedAt: now,
        })
        .onConflictDoNothing({ target: runs.id }),
    )
  })

const makeEnd = (database: DatabaseService) =>
  Effect.fn('RunStore.end')(function* (id: RunId, ending: RunEnding) {
    const now = yield* Clock.currentTimeMillis
    // One conditional update: only the caller that moves the Run out of `working` gets `true`, so
    // a settlement observed twice (a restart, a repeated delivery) acts once.
    const rows = yield* database.run(
      database
        .update(runs)
        .set({ state: ending, finishedAt: now })
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
        .orderBy(desc(runs.startedAt))
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
      end: makeEnd(database),
      working: makeWorking(database),
      list: makeList(database),
    })
  }),
)
