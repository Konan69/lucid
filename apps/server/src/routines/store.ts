import { and, desc, eq, sql } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  Occurrence as OccurrenceSchema,
  type Occurrence,
  type OccurrenceId,
  Routine as RoutineSchema,
  type Routine,
  type RoutineId,
  CreateRoutineRequest,
  PatchRoutineRequest,
} from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError, returned } from '../database/client.ts'
import { occurrences, routines } from './tables.ts'

const RoutineRow = createSelectSchema(routines)
const OccurrenceRow = createSelectSchema(occurrences)
type RoutineRecord = Omit<Routine, 'nextRunAt' | 'runs'>
type CreateRoutineInput = typeof CreateRoutineRequest.Type
type PatchRoutineInput = typeof PatchRoutineRequest.Type
/** A raw `RETURNING` result: the claim statement is SQL text, so its rows are decoded here. */
const RawRows = Schema.Struct({ rows: Schema.Array(RoutineRow) })

const invalidRow = (subject: string) =>
  new DatabaseFailure({ message: `Database returned an invalid ${subject}` })

const invalidRoutineClaim = () => invalidRow('Routine claim')

const routineRowDecoder = Schema.decodeUnknownEffect(RoutineRow)
const routineSchemaDecoder = Schema.decodeUnknownEffect(RoutineSchema)

const decodeRoutine = Effect.fn('RoutineStore.decodeRoutine')(function* (
  value: typeof routines.$inferSelect,
) {
  const row = yield* routineRowDecoder(value).pipe(Effect.mapError(() => invalidRow('Routine')))
  const decoded = yield* routineSchemaDecoder({
    ...row,
    nextRunAt: row.nextExpectedAt,
    runs: [],
  }).pipe(Effect.mapError(() => invalidRow('Routine')))
  const { nextRunAt: _nextRunAt, runs: _runs, ...record } = decoded
  return record
})

const occurrenceRowDecoder = Schema.decodeUnknownEffect(OccurrenceRow)
const occurrenceSchemaDecoder = Schema.decodeUnknownEffect(OccurrenceSchema)

const decodeOccurrence = Effect.fn('RoutineStore.decodeOccurrence')(function* (
  value: typeof occurrences.$inferSelect,
) {
  const row = yield* occurrenceRowDecoder(value).pipe(
    Effect.mapError(() => invalidRow('Routine occurrence')),
  )
  return yield* occurrenceSchemaDecoder(row).pipe(
    Effect.mapError(() => invalidRow('Routine occurrence')),
  )
})

export interface RoutineStoreService {
  readonly list: () => Effect.Effect<ReadonlyArray<Routine>, DatabaseInfrastructureError>
  readonly get: (
    id: RoutineId,
  ) => Effect.Effect<Option.Option<Routine>, DatabaseInfrastructureError>
  readonly create: (
    request: CreateRoutineInput,
  ) => Effect.Effect<Routine, DatabaseInfrastructureError>
  readonly patch: (
    id: RoutineId,
    patch: PatchRoutineInput,
  ) => Effect.Effect<Option.Option<Routine>, DatabaseInfrastructureError>
  readonly remove: (id: RoutineId) => Effect.Effect<boolean, DatabaseInfrastructureError>
  readonly setSchedule: (
    id: RoutineId,
    nextExpectedAt: number | null,
    lastMissedAt: number | null,
  ) => Effect.Effect<void, DatabaseInfrastructureError>
  readonly claimDue: () => Effect.Effect<ReadonlyArray<Routine>, DatabaseInfrastructureError>
  readonly startOccurrence: (
    routineId: RoutineId,
  ) => Effect.Effect<Occurrence, DatabaseInfrastructureError>
  readonly attachSubmission: (
    id: OccurrenceId,
    submissionId: string,
  ) => Effect.Effect<boolean, DatabaseInfrastructureError>
}

export class RoutineStore extends Context.Service<RoutineStore, RoutineStoreService>()(
  'vivid/RoutineStore',
) {}

const rawRowsDecoder = Schema.decodeUnknownEffect(RawRows)
type DatabaseService = Database['Service']

/** Loads the recent Occurrences needed to render one Routine. */
const makeListRuns = (database: DatabaseService) =>
  Effect.fn('RoutineStore.listOccurrences')(function* (routineId: RoutineId) {
    const rows = yield* database.run(
      database
        .select()
        .from(occurrences)
        .where(eq(occurrences.routineId, routineId))
        .orderBy(desc(occurrences.startedAt))
        .limit(12),
    )
    return yield* Effect.forEach(rows, decodeOccurrence)
  })

/** Projects a stored Routine record with its recent Occurrences and computed next run. */
const makeView = (listRuns: ReturnType<typeof makeListRuns>) =>
  Effect.fn('RoutineStore.view')(function* (record: RoutineRecord) {
    const runs = yield* listRuns(record.id)
    return {
      ...record,
      nextRunAt: record.enabled ? record.nextExpectedAt : null,
      runs,
    } satisfies Routine
  })

/** Loads a Routine record without performing the Occurrence join used by the wire view. */
const makeGetRecord = (database: DatabaseService) =>
  Effect.fn('RoutineStore.getRecord')(function* (id: RoutineId) {
    const rows = yield* database.run(
      database.select().from(routines).where(eq(routines.id, id)).limit(1),
    )
    const row = rows[0]
    return row === undefined ? Option.none() : Option.some(yield* decodeRoutine(row))
  })

/** Reads one Routine and returns Option.none when the durable record is absent. */
const makeGet = (getRecord: ReturnType<typeof makeGetRecord>, view: ReturnType<typeof makeView>) =>
  Effect.fn('RoutineStore.get')(function* (id: RoutineId) {
    const record = yield* getRecord(id)
    if (Option.isNone(record)) return Option.none()
    return Option.some(yield* view(record.value))
  })

/** Lists stored Routines in update order and renders each one with its recent Occurrences. */
const makeList = (database: DatabaseService, view: ReturnType<typeof makeView>) =>
  Effect.fn('RoutineStore.list')(function* () {
    const rows = yield* database.run(
      database.select().from(routines).orderBy(desc(routines.updatedAt)),
    )
    const records = yield* Effect.forEach(rows, decodeRoutine)
    return yield* Effect.forEach(records, view, { concurrency: 1 })
  })

/** Inserts a Routine and returns its fully rendered wire view. */
const makeCreate = (database: DatabaseService, view: ReturnType<typeof makeView>) =>
  Effect.fn('RoutineStore.create')(function* (request: CreateRoutineInput) {
    const now = yield* Clock.currentTimeMillis
    const libraryFolderId = request.libraryFolderId === undefined ? null : request.libraryFolderId
    const rows = yield* database.run(
      database
        .insert(routines)
        .values({
          id: crypto.randomUUID(),
          name: request.name,
          prompt: request.prompt,
          cron: request.cron,
          timezone: request.timezone,
          libraryFolderId,
          enabled: true,
          nextExpectedAt: null,
          lastMissedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    )
    return yield* view(yield* decodeRoutine(yield* returned(rows, 'Routine')))
  })

/** Updates an existing Routine while retaining omitted patch fields. */
const makePatch = (
  database: DatabaseService,
  getRecord: ReturnType<typeof makeGetRecord>,
  view: ReturnType<typeof makeView>,
) =>
  Effect.fn('RoutineStore.patch')(function* (id: RoutineId, changes: PatchRoutineInput) {
    const current = yield* getRecord(id)
    if (Option.isNone(current)) return Option.none()
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(routines)
        .set({
          name: changes.name ?? current.value.name,
          prompt: changes.prompt ?? current.value.prompt,
          cron: changes.cron ?? current.value.cron,
          timezone: changes.timezone ?? current.value.timezone,
          libraryFolderId:
            changes.libraryFolderId === undefined
              ? current.value.libraryFolderId
              : changes.libraryFolderId,
          enabled: changes.enabled ?? current.value.enabled,
          updatedAt: now,
        })
        .where(eq(routines.id, id))
        .returning(),
    )
    const row = rows[0]
    return row === undefined ? Option.none() : Option.some(yield* view(yield* decodeRoutine(row)))
  })

/** Deletes one Routine and reports whether a durable row was removed. */
const makeRemove = (database: DatabaseService) =>
  Effect.fn('RoutineStore.remove')(function* (id: RoutineId) {
    const rows = yield* database.run(
      database.delete(routines).where(eq(routines.id, id)).returning({ id: routines.id }),
    )
    return rows.length > 0
  })

/** Persists scheduler timestamps after a Routine is claimed or rescheduled. */
const makeSetSchedule = (database: DatabaseService) =>
  Effect.fn('RoutineStore.setSchedule')(function* (
    id: RoutineId,
    nextExpectedAt: number | null,
    lastMissedAt: number | null,
  ) {
    yield* database.run(
      database.update(routines).set({ nextExpectedAt, lastMissedAt }).where(eq(routines.id, id)),
    )
  })

/** Claims due Routines under row locks before the scheduler creates Occurrences. */
const makeClaimDue = (database: DatabaseService, view: ReturnType<typeof makeView>) =>
  Effect.fn('RoutineStore.claimDue')(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const result = yield* tx.execute(sql`
          WITH due AS (
            SELECT id FROM vivid_routines
            WHERE enabled = true AND next_expected_at IS NOT NULL AND next_expected_at <= ${now}
            ORDER BY next_expected_at ASC FOR UPDATE SKIP LOCKED
          )
          UPDATE vivid_routines target SET next_expected_at = NULL
          FROM due WHERE target.id = due.id
          RETURNING target.id, target.name, target.prompt, target.cron, target.timezone,
            target.library_folder_id AS "libraryFolderId", target.enabled,
            target.next_expected_at::float8 AS "nextExpectedAt", target.last_missed_at::float8 AS "lastMissedAt",
            target.created_at::float8 AS "createdAt", target.updated_at::float8 AS "updatedAt"
        `)
        const claimed = yield* rawRowsDecoder(result).pipe(Effect.mapError(invalidRoutineClaim))
        const records = yield* Effect.forEach(claimed.rows, decodeRoutine)
        return yield* Effect.forEach(records, view, { concurrency: 1 })
      }),
    )
  })

/** Starts one Occurrence with the durable conversation identity derived from its Routine. */
const makeStartOccurrence = (database: DatabaseService) =>
  Effect.fn('RoutineStore.startOccurrence')(function* (routineId: RoutineId) {
    const startedAt = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .insert(occurrences)
        .values({
          id: crypto.randomUUID(),
          routineId,
          conversationId: `routine-${routineId}`,
          submissionId: null,
          status: 'running',
          startedAt,
          finishedAt: null,
          output: null,
          error: null,
        })
        .returning(),
    )
    return yield* decodeOccurrence(yield* returned(rows, 'Routine'))
  })

/** Attaches a runtime submission only while the Occurrence is still running. */
const makeAttachSubmission = (database: DatabaseService) =>
  Effect.fn('RoutineStore.attachSubmission')(function* (id: OccurrenceId, submissionId: string) {
    const rows = yield* database.run(
      database
        .update(occurrences)
        .set({ submissionId })
        .where(and(eq(occurrences.id, id), eq(occurrences.status, 'running')))
        .returning({ id: occurrences.id }),
    )
    return rows.length > 0
  })

export const routineStoreLayer = Layer.effect(
  RoutineStore,
  Effect.gen(function* () {
    const database = yield* Database
    const listRuns = makeListRuns(database)
    const view = makeView(listRuns)
    const getRecord = makeGetRecord(database)
    return RoutineStore.of({
      list: makeList(database, view),
      get: makeGet(getRecord, view),
      create: makeCreate(database, view),
      patch: makePatch(database, getRecord, view),
      remove: makeRemove(database),
      setSchedule: makeSetSchedule(database),
      claimDue: makeClaimDue(database, view),
      startOccurrence: makeStartOccurrence(database),
      attachSubmission: makeAttachSubmission(database),
    })
  }),
)
