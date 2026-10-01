import { and, asc, desc, eq, inArray, isNotNull, isNull, like, lte, sql } from 'drizzle-orm'
import * as Arr from 'effect/Array'
import * as Option from 'effect/Option'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import {
  CreateRoutineRequest,
  DatabaseFailure,
  Occurrence,
  OccurrenceId,
  PatchRoutineRequest,
  RoutineId,
  RoutineTrigger,
  RoutineWebhook,
  Routine,
  type RunId,
} from '@vivid/contracts'
import { companyColumnOf, ownedHere, type Actor } from '../auth/access.ts'
import { ServerConfig } from '../config.ts'
import { Database, returned, type DatabaseInfrastructureError } from '../database/client.ts'
import { membershipTable } from '../companies/tables.ts'
import {
  OccurrenceClaim,
  OccurrenceOpening,
  OccurrenceFailure,
  scheduledAttempt,
  replayAttempt,
  THREAD_OPENING_FAILURE,
  type RoutineAttempt,
} from './attempts.ts'
import { runs } from '../threads/tables.ts'
import { hashKey, issueKey, matchesKey } from './keys.ts'
import { decodeOccurrence, decodeRoutine, triggerColumns, type RoutineRecord } from './records.ts'
import { occurrences, routines } from './tables.ts'
import { nextExpectedAt, type InvalidRoutineSchedule } from './timing.ts'

export class RoutineMissing extends Schema.TaggedError<RoutineMissing>()(
  'RoutineMissing',
  {
    id: RoutineId,
  },
  { title: 'Routine not found' },
) {}

export class RoutineWebhookRequired extends Schema.TaggedError<RoutineWebhookRequired>()(
  'RoutineWebhookRequired',
  { id: RoutineId },
  { title: 'Webhook Routine required' },
) {}

type StoreError = DatabaseInfrastructureError | RoutineMissing
type ChangeError = StoreError | InvalidRoutineSchedule
type CreateInput = typeof CreateRoutineRequest.Type
type PatchInput = typeof PatchRoutineRequest.Type
type DatabaseService = Database['Service']

export interface RoutineStoreService {
  readonly list: (
    actor: Actor,
  ) => Effect.Effect<ReadonlyArray<Routine>, DatabaseInfrastructureError>
  readonly get: (actor: Actor, id: RoutineId) => Effect.Effect<RoutineRecord, StoreError>
  readonly create: (actor: Actor, input: CreateInput) => Effect.Effect<Routine, ChangeError>
  readonly patch: (
    actor: Actor,
    id: RoutineId,
    input: PatchInput,
  ) => Effect.Effect<Routine, ChangeError>
  readonly remove: (actor: Actor, id: RoutineId) => Effect.Effect<void, StoreError>
  readonly issueWebhook: (
    actor: Actor,
    id: RoutineId,
  ) => Effect.Effect<RoutineWebhook, StoreError | RoutineWebhookRequired>
  readonly authorizeWebhook: (
    id: RoutineId,
    key: Redacted.Redacted,
  ) => Effect.Effect<RoutineRecord, StoreError>
  readonly claimDue: () => Effect.Effect<
    ReadonlyArray<ScheduledReceipt>,
    DatabaseInfrastructureError | InvalidRoutineSchedule
  >
  readonly findOccurrence: (
    record: RoutineRecord,
    id: OccurrenceId,
  ) => Effect.Effect<Option.Option<Occurrence>, DatabaseInfrastructureError>
  readonly claimOccurrence: (
    record: RoutineRecord,
    attempt: RoutineAttempt,
    opening: OccurrenceOpening,
  ) => Effect.Effect<OccurrenceClaim, StoreError>
  readonly failOccurrence: (
    id: OccurrenceId,
    failure: OccurrenceFailure,
  ) => Effect.Effect<boolean, DatabaseInfrastructureError>
  readonly attachSubmission: (
    id: OccurrenceId,
    runId: RunId,
  ) => Effect.Effect<void, DatabaseInfrastructureError>
}

/** A tick and its durable receipt leave the claim transaction together. */
interface ScheduledReceipt {
  readonly record: RoutineRecord
  readonly attempt: RoutineAttempt
}

export class RoutineStore extends Context.Service<RoutineStore, RoutineStoreService>()(
  'vivid/RoutineStore',
) {}

/** The owner-scoped Routine load is also the authorization check before running or issuing keys. */
const makeGet = (database: DatabaseService) =>
  Effect.fn('RoutineStore.get')(function* (actor: Actor, id: RoutineId) {
    const rows = yield* database.run(
      database
        .select()
        .from(routines)
        .where(and(eq(routines.id, id), ownedHere(routines, actor))),
    )
    const row = rows[0]
    if (row === undefined) return yield* Effect.fail(new RoutineMissing({ id }))
    return yield* decodeRoutine(row)
  })

/** Ownership is already authorized in each record; the history query contains only those ids. */
const makeView = (database: DatabaseService) =>
  Effect.fn('RoutineStore.view')(function* (records: ReadonlyArray<RoutineRecord>) {
    if (records.length === 0) return []
    const ids = records.map((record) => record.routine.id)
    const recent = database
      .select({
        id: occurrences.id,
        position:
          sql<number>`row_number() OVER (PARTITION BY ${occurrences.routineId} ORDER BY ${occurrences.startedAt} DESC, ${occurrences.id} DESC)`.as(
            'position',
          ),
      })
      .from(occurrences)
      .where(inArray(occurrences.routineId, ids))
      .as('recent')
    const rows = yield* database.run(
      database
        .select({ occurrence: occurrences, state: runs.state, finishedAt: runs.finishedAt })
        .from(occurrences)
        .innerJoin(recent, and(eq(recent.id, occurrences.id), lte(recent.position, 12)))
        .leftJoin(runs, eq(runs.id, occurrences.submissionId))
        .orderBy(desc(occurrences.startedAt), desc(occurrences.id)),
    )
    const history = Arr.groupBy(
      yield* Effect.forEach(rows, decodeOccurrence),
      (occurrence) => occurrence.routineId,
    )
    // A Routine that has never run legitimately has no entry in the history groups.
    return records.map((record) =>
      routineView(
        record,
        Option.getOrElse(Option.fromUndefinedOr(history[record.routine.id]), () => []),
      ),
    )
  })

/** Projects the wire view without copying server-only ownership or credential fields. */
const routineView = (record: RoutineRecord, history: ReadonlyArray<Occurrence>) =>
  Routine.make({
    id: record.routine.id,
    name: record.routine.name,
    prompt: record.routine.prompt,
    trigger: record.routine.trigger,
    libraryFolderId: record.routine.libraryFolderId,
    enabled: record.routine.enabled,
    nextExpectedAt: record.routine.nextExpectedAt,
    lastMissedAt: record.routine.lastMissedAt,
    createdAt: record.routine.createdAt,
    updatedAt: record.routine.updatedAt,
    nextRunAt: record.routine.nextRunAt,
    runs: history,
  })

/** Loads all owned Routines and their bounded recent history with one batch rather than N queries. */
const makeList = (database: DatabaseService, view: ReturnType<typeof makeView>) =>
  Effect.fn('RoutineStore.list')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select()
        .from(routines)
        .where(ownedHere(routines, actor))
        .orderBy(desc(routines.updatedAt)),
    )
    return yield* view(yield* Effect.forEach(rows, decodeRoutine))
  })

/** Computes the schedule before writing, so invalid cron cannot leave a partially created Routine. */
const makeCreate = (database: DatabaseService) =>
  Effect.fn('RoutineStore.create')(function* (actor: Actor, input: CreateInput) {
    const now = yield* Clock.currentTimeMillis
    const next = yield* nextExpectedAt(input.trigger, true, now)
    const rows = yield* database.run(
      database
        .insert(routines)
        .values({
          id: crypto.randomUUID(),
          personId: actor.person.id,
          companyId: companyColumnOf(actor.workspace),
          name: input.name,
          prompt: input.prompt,
          ...triggerColumns(input.trigger),
          webhookKeyHash: null,
          libraryFolderId: input.libraryFolderId === undefined ? null : input.libraryFolderId,
          enabled: true,
          nextExpectedAt: next,
          lastMissedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    )
    return routineView(yield* decodeRoutine(yield* returned(rows, 'Routine')), [])
  })

/** Row locking preserves concurrent partial updates and key rotation while a trigger is changed. */
const makePatch = (database: DatabaseService, view: ReturnType<typeof makeView>) =>
  Effect.fn('RoutineStore.patch')(function* (actor: Actor, id: RoutineId, input: PatchInput) {
    const now = yield* Clock.currentTimeMillis
    const updated = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .select()
          .from(routines)
          .where(and(eq(routines.id, id), ownedHere(routines, actor)))
          .for('update')
        const row = rows[0]
        if (row === undefined) return yield* Effect.fail(new RoutineMissing({ id }))
        const current = yield* decodeRoutine(row)
        const trigger = input.trigger === undefined ? current.routine.trigger : input.trigger
        const enabled = input.enabled === undefined ? current.routine.enabled : input.enabled
        const next =
          input.trigger === undefined && input.enabled === undefined
            ? current.routine.nextExpectedAt
            : yield* nextExpectedAt(trigger, enabled, now)
        const result = yield* tx
          .update(routines)
          .set({
            name: input.name === undefined ? current.routine.name : input.name,
            prompt: input.prompt === undefined ? current.routine.prompt : input.prompt,
            ...triggerColumns(trigger),
            webhookKeyHash: RoutineTrigger.guards.Schedule(trigger) ? null : current.webhookKeyHash,
            libraryFolderId:
              input.libraryFolderId === undefined
                ? current.routine.libraryFolderId
                : input.libraryFolderId,
            enabled,
            nextExpectedAt: next,
            updatedAt: now,
          })
          .where(and(eq(routines.id, id), ownedHere(routines, actor)))
          .returning()
        return yield* decodeRoutine(yield* returned(result, 'Routine'))
      }),
    )
    return yield* returned(yield* view([updated]), 'Routine')
  })

/** Deleting by both identity and ownership conceals other People's Routines as absent. */
const makeRemove = (database: DatabaseService) =>
  Effect.fn('RoutineStore.remove')(function* (actor: Actor, id: RoutineId) {
    const rows = yield* database.run(
      database
        .delete(routines)
        .where(and(eq(routines.id, id), ownedHere(routines, actor)))
        .returning({ id: routines.id }),
    )
    if (rows.length === 0) return yield* Effect.fail(new RoutineMissing({ id }))
    return yield* Effect.void
  })

/** A key rotation is conditional on the current trigger, so racing a schedule change grants nothing. */
const makeIssueWebhook = (
  database: DatabaseService,
  publicUrl: URL,
  get: ReturnType<typeof makeGet>,
) =>
  Effect.fn('RoutineStore.issueWebhook')(function* (actor: Actor, id: RoutineId) {
    const record = yield* get(actor, id)
    if (!RoutineTrigger.guards.Webhook(record.routine.trigger)) {
      return yield* Effect.fail(new RoutineWebhookRequired({ id }))
    }
    const key = yield* Effect.sync(issueKey)
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .update(routines)
        .set({ webhookKeyHash: hashKey(key), updatedAt: now })
        .where(
          and(eq(routines.id, id), ownedHere(routines, actor), eq(routines.trigger, 'webhook')),
        )
        .returning({ id: routines.id }),
    )
    if (rows.length === 0) return yield* Effect.fail(new RoutineWebhookRequired({ id }))
    return RoutineWebhook.make({
      address: new URL(`/api/hooks/routines/${encodeURIComponent(id)}`, publicUrl).href,
      key,
    })
  })

/** The Membership row is locked only for database work, so removal cannot overtake receipt insertion. */
const requireMember = Effect.fn('RoutineStore.requireMember')(function* (
  database: Pick<DatabaseService, 'select'>,
  record: RoutineRecord,
) {
  if (record.companyId !== null) {
    const members = yield* database
      .select({ id: membershipTable.id })
      .from(membershipTable)
      .where(
        and(
          eq(membershipTable.companyId, record.companyId),
          eq(membershipTable.userId, record.personId),
        ),
      )
      .limit(1)
      .for('key share')
    if (members.length === 0)
      return yield* Effect.fail(new RoutineMissing({ id: record.routine.id }))
  }
  return yield* Effect.void
})

/** The key grants only this Routine; disabled, absent and incorrect credentials share one failure. */
const makeAuthorizeWebhook = (database: DatabaseService) =>
  Effect.fn('RoutineStore.authorizeWebhook')(function* (id: RoutineId, key: Redacted.Redacted) {
    const rows = yield* database.run(database.select().from(routines).where(eq(routines.id, id)))
    const row = rows[0]
    // A denial digest also does the fixed-size comparison when no credential exists.
    const hash =
      row === undefined || row.webhookKeyHash === null ? '0'.repeat(64) : row.webhookKeyHash
    const valid = matchesKey(key, hash)
    if (
      row === undefined ||
      !valid ||
      !row.enabled ||
      row.trigger !== 'webhook' ||
      row.webhookKeyHash === null
    ) {
      return yield* Effect.fail(new RoutineMissing({ id }))
    }
    const record = yield* decodeRoutine(row)
    yield* database.run(requireMember(database, record))
    return record
  })

/** Claims each tick with its receipt atomically and replays every unsubmitted scheduled receipt.
 * Concurrent passes may replay the same receipt after commit; Conversation's original key makes
 * admission idempotent. No in-memory claim or lease is needed to recover a process crash.
 */
const makeClaimDue = (database: DatabaseService) =>
  Effect.fn('RoutineStore.claimDue')(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const pending = yield* tx
          .select({ routine: routines, occurrence: occurrences })
          .from(occurrences)
          .innerJoin(routines, eq(routines.id, occurrences.routineId))
          .where(
            and(
              like(occurrences.id, 'scheduled-%'),
              eq(occurrences.status, 'not-admitted'),
              isNull(occurrences.submissionId),
            ),
          )
          .for('update', { skipLocked: true, of: occurrences })
        const receipts: ScheduledReceipt[] = []
        for (const row of pending) {
          const record = yield* decodeRoutine(row.routine)
          receipts.push({ record, attempt: replayAttempt(OccurrenceId.make(row.occurrence.id)) })
        }
        const rows = yield* tx
          .select()
          .from(routines)
          .where(
            and(
              eq(routines.trigger, 'schedule'),
              eq(routines.enabled, true),
              isNotNull(routines.nextExpectedAt),
              lte(routines.nextExpectedAt, now),
            ),
          )
          .orderBy(asc(routines.nextExpectedAt))
          .for('update', { skipLocked: true })
        for (const row of rows) {
          const record = yield* decodeRoutine(row)
          if (row.nextExpectedAt === null)
            return yield* new DatabaseFailure({ message: 'Due Routine has no tick timestamp' })
          const attempt = scheduledAttempt(record.routine.id, row.nextExpectedAt)
          const next = yield* nextExpectedAt(record.routine.trigger, true, now)
          yield* tx
            .insert(occurrences)
            .values({
              id: attempt.id,
              routineId: record.routine.id,
              conversationId: `routine-${record.routine.id}`,
              submissionId: null,
              status: 'not-admitted',
              startedAt: now,
              finishedAt: null,
              output: null,
              error: null,
            })
            .onConflictDoNothing({ target: occurrences.id })
          yield* tx
            .update(routines)
            .set({ nextExpectedAt: next })
            .where(eq(routines.id, record.routine.id))
          receipts.push({ record, attempt })
        }
        return receipts
      }),
    )
  })

/** An authorized Routine receipt remains readable even when its Thread and Run have been deleted. */
const makeFindOccurrence = (database: DatabaseService) =>
  Effect.fn('RoutineStore.findOccurrence')(function* (record: RoutineRecord, id: OccurrenceId) {
    const rows = yield* database.run(
      database
        .select({ occurrence: occurrences, state: runs.state, finishedAt: runs.finishedAt })
        .from(occurrences)
        .leftJoin(runs, eq(runs.id, occurrences.submissionId))
        .where(and(eq(occurrences.id, id), eq(occurrences.routineId, record.routine.id)))
        .limit(1),
    )
    const row = rows[0]
    return row === undefined ? Option.none() : Option.some(yield* decodeOccurrence(row))
  })

/** The unique receipt insertion arbitrates concurrent keyed requests, including failed openings. */
const makeClaimOccurrence = (
  database: DatabaseService,
  find: ReturnType<typeof makeFindOccurrence>,
) =>
  Effect.fn('RoutineStore.claimOccurrence')(function* (
    record: RoutineRecord,
    attempt: RoutineAttempt,
    opening: OccurrenceOpening,
  ) {
    const startedAt = yield* Clock.currentTimeMillis
    const snapshot = OccurrenceOpening.match(opening, {
      Ready: (): OccurrenceSnapshot => ({
        status: 'not-admitted',
        finishedAt: null,
        output: null,
        error: null,
      }),
      Failed: ({ reason }): OccurrenceSnapshot => ({
        status: 'failed',
        finishedAt: startedAt,
        output: null,
        error: reason,
      }),
    })
    // Receipt snapshots describe admission failures until submission_id joins the authoritative Run.
    const rows = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        yield* requireMember(tx, record)
        return yield* tx
          .insert(occurrences)
          .values({
            id: attempt.id,
            routineId: record.routine.id,
            conversationId: `routine-${record.routine.id}`,
            submissionId: null,
            startedAt,
            ...snapshot,
          })
          .onConflictDoNothing({ target: occurrences.id })
          .returning()
      }),
    )
    const row = rows[0]
    if (row !== undefined)
      return OccurrenceClaim.cases.Created.make({
        occurrence: yield* decodeOccurrence({ occurrence: row, state: null, finishedAt: null }),
      })
    const existing = yield* find(record, attempt.id)
    if (Option.isNone(existing))
      return yield* Effect.fail(
        new DatabaseFailure({ message: 'Routine receipt conflict has no matching Occurrence' }),
      )
    return OccurrenceClaim.cases.Existing.make({ occurrence: existing.value })
  })

interface OccurrenceSnapshot {
  readonly status: 'not-admitted' | 'failed'
  readonly finishedAt: number | null
  readonly output: null
  readonly error: string | null
}

/** Failure reasons stay durable; only opening failures stop replay, and admission errors keep the key. */
const makeFailOccurrence = (database: DatabaseService) =>
  Effect.fn('RoutineStore.failOccurrence')(function* (
    id: OccurrenceId,
    failure: OccurrenceFailure,
  ) {
    const now = yield* Clock.currentTimeMillis
    const snapshot = OccurrenceFailure.match(failure, {
      Opening: () => ({ status: 'failed', error: THREAD_OPENING_FAILURE, finishedAt: now }),
      Delivery: ({ reason }) => ({ status: 'not-admitted', error: reason, finishedAt: now }),
    })
    const rows = yield* database.run(
      database
        .update(occurrences)
        .set(snapshot)
        .where(
          and(
            eq(occurrences.id, id),
            isNull(occurrences.submissionId),
            eq(occurrences.status, 'not-admitted'),
          ),
        )
        .returning({ id: occurrences.id }),
    )
    return rows.length > 0
  })

/** Persists the returned Run id; future reads join that Run rather than settling a second lifecycle. */
const makeAttachSubmission = (database: DatabaseService) =>
  Effect.fn('RoutineStore.attachSubmission')(function* (id: OccurrenceId, runId: RunId) {
    const rows = yield* database.run(
      database
        .update(occurrences)
        .set({ submissionId: runId, error: null, finishedAt: null })
        .where(eq(occurrences.id, id))
        .returning({ id: occurrences.id }),
    )
    if (rows.length === 0)
      return yield* Effect.fail(
        new DatabaseFailure({
          message: 'Routine occurrence disappeared before delivery was attached',
        }),
      )
    return yield* Effect.void
  })

/** Persistence and key authority are acquired once; callers pass their Actor explicitly. */
export const routineStoreLayer = Layer.effect(
  RoutineStore,
  Effect.gen(function* () {
    const database = yield* Database
    const config = yield* ServerConfig
    const get = makeGet(database)
    const view = makeView(database)
    const findOccurrence = makeFindOccurrence(database)
    return RoutineStore.of({
      list: makeList(database, view),
      get,
      create: makeCreate(database),
      patch: makePatch(database, view),
      remove: makeRemove(database),
      issueWebhook: makeIssueWebhook(database, config.PUBLIC_URL, get),
      authorizeWebhook: makeAuthorizeWebhook(database),
      claimDue: makeClaimDue(database),
      findOccurrence,
      claimOccurrence: makeClaimOccurrence(database, findOccurrence),
      attachSubmission: makeAttachSubmission(database),
      failOccurrence: makeFailOccurrence(database),
    })
  }),
)
