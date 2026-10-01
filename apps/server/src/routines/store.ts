import { and, asc, desc, eq, isNotNull, lte } from 'drizzle-orm'
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
  type ThreadId,
} from '@vivid/contracts'
import { companyColumnOf, ownedHere, type Actor } from '../auth/access.ts'
import { ServerConfig } from '../config.ts'
import { Database, returned, type DatabaseInfrastructureError } from '../database/client.ts'
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
    ReadonlyArray<RoutineRecord>,
    DatabaseInfrastructureError | InvalidRoutineSchedule
  >
  readonly startOccurrence: (
    record: RoutineRecord,
    threadId: ThreadId,
  ) => Effect.Effect<Occurrence, DatabaseInfrastructureError>
  readonly attachSubmission: (
    id: OccurrenceId,
    runId: RunId,
  ) => Effect.Effect<void, DatabaseInfrastructureError>
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

/** Recent history uses durable Runs; legacy settlement columns never decide its lifecycle. */
const makeView = (database: DatabaseService) =>
  Effect.fn('RoutineStore.view')(function* (record: RoutineRecord) {
    const rows = yield* database.run(
      database
        .select({
          occurrence: occurrences,
          state: runs.state,
          finishedAt: runs.finishedAt,
        })
        .from(occurrences)
        .leftJoin(runs, eq(runs.id, occurrences.submissionId))
        .where(eq(occurrences.routineId, record.routine.id))
        .orderBy(desc(occurrences.startedAt))
        .limit(12),
    )
    const history = yield* Effect.forEach(rows, decodeOccurrence)
    return Routine.make({
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
  })

/** An owner sees their own commitments in this workspace, regardless of their Company role. */
const makeList = (database: DatabaseService, view: ReturnType<typeof makeView>) =>
  Effect.fn('RoutineStore.list')(function* (actor: Actor) {
    const rows = yield* database.run(
      database
        .select()
        .from(routines)
        .where(ownedHere(routines, actor))
        .orderBy(desc(routines.updatedAt)),
    )
    const records = yield* Effect.forEach(rows, decodeRoutine)
    return yield* Effect.forEach(records, view)
  })

/** Computes the schedule before writing, so invalid cron cannot leave a partially created Routine. */
const makeCreate = (database: DatabaseService, view: ReturnType<typeof makeView>) =>
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
    return yield* view(yield* decodeRoutine(yield* returned(rows, 'Routine')))
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
    return yield* view(updated)
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
    return yield* decodeRoutine(row)
  })

/** Advances each due timestamp under SKIP LOCKED before releasing the claim to another worker. */
const makeClaimDue = (database: DatabaseService) =>
  Effect.fn('RoutineStore.claimDue')(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
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
        const records = yield* Effect.forEach(rows, decodeRoutine)
        for (const record of records) {
          const next = yield* nextExpectedAt(record.routine.trigger, true, now)
          yield* tx
            .update(routines)
            .set({ nextExpectedAt: next })
            .where(eq(routines.id, record.routine.id))
        }
        return records
      }),
    )
  })

/** The Thread must already exist; the Occurrence's id is the delivery's idempotency key. */
const makeStartOccurrence = (database: DatabaseService) =>
  Effect.fn('RoutineStore.startOccurrence')(function* (record: RoutineRecord, threadId: ThreadId) {
    const startedAt = yield* Clock.currentTimeMillis
    const rows = yield* database.run(
      database
        .insert(occurrences)
        .values({
          id: crypto.randomUUID(),
          routineId: record.routine.id,
          conversationId: threadId,
          submissionId: null,
          status: 'running',
          startedAt,
          finishedAt: null,
          output: null,
          error: null,
        })
        .returning(),
    )
    return yield* decodeOccurrence({
      occurrence: yield* returned(rows, 'Routine occurrence'),
      state: null,
      finishedAt: null,
    })
  })

/** Persists the returned Run id; future reads join that Run rather than settling a second lifecycle. */
const makeAttachSubmission = (database: DatabaseService) =>
  Effect.fn('RoutineStore.attachSubmission')(function* (id: OccurrenceId, runId: RunId) {
    const rows = yield* database.run(
      database
        .update(occurrences)
        .set({ submissionId: runId })
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
    return RoutineStore.of({
      list: makeList(database, view),
      get,
      create: makeCreate(database, view),
      patch: makePatch(database, view),
      remove: makeRemove(database),
      issueWebhook: makeIssueWebhook(database, config.PUBLIC_URL, get),
      authorizeWebhook: makeAuthorizeWebhook(database),
      claimDue: makeClaimDue(database),
      startOccurrence: makeStartOccurrence(database),
      attachSubmission: makeAttachSubmission(database),
    })
  }),
)
