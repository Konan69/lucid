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
  AuditEvent,
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
import { appendAudit, AuditAttribution } from '../audit/record.ts'
import { Changes, Topic } from '../live/changes.ts'
import { ServerConfig } from '../config.ts'
import {
  Database,
  decodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
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
import { IntegrationWatch, Watch, type WatchError } from './watch.ts'
import { integrationPollingLayer } from '../connections/watch.ts'
import { integrationOperations } from './integration.ts'

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

/** Scheduled receipts have a finite admission window; no stale work is silently delivered later. */
export const scheduledReplayMillis = 15 * 60 * 1000
export const ScheduledFailure = Schema.TaggedUnion({
  Disabled: {},
  Membership: {},
  Missed: {},
})
export type ScheduledFailure = typeof ScheduledFailure.Type
const StoredOccurrenceFailure = Schema.Union([
  OccurrenceFailure.cases.Opening,
  OccurrenceFailure.cases.Delivery,
  ScheduledFailure.cases.Disabled,
  ScheduledFailure.cases.Membership,
  ScheduledFailure.cases.Missed,
]).pipe(Schema.toTaggedUnion('_tag'))

/** Durable terminal reasons distinguish withdrawn authority from an expired delivery window. */
const scheduledFailureReason = (failure: ScheduledFailure) =>
  ScheduledFailure.match(failure, {
    Disabled: () => 'Its Routine was disabled before delivery',
    Membership: () => 'Its owner is no longer a Member of its Company',
    Missed: () => 'Missed: delivery was not admitted within 15 minutes',
  })

type StoreError = DatabaseInfrastructureError | RoutineMissing
type ChangeError =
  | import('@vivid/contracts').Conflict
  | StoreError
  | InvalidRoutineSchedule
  | WatchError
  | import('@vivid/contracts').InvalidRequest
  | import('@vivid/contracts').ServiceUnavailable
type CreateInput = typeof CreateRoutineRequest.Type
type PatchInput = typeof PatchRoutineRequest.Type
const encodeWatch = Schema.encodeSync(Watch)
type DatabaseService = Database['Service']

export interface RoutineStoreService extends ReturnType<typeof integrationOperations> {
  readonly findEvents: IntegrationWatch['Service']['discover']
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
    failure: OccurrenceFailure | ScheduledFailure,
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
const makeCreate = (database: DatabaseService, watch: IntegrationWatch['Service']) =>
  Effect.fn('RoutineStore.create')(function* (actor: Actor, input: CreateInput) {
    const now = yield* Clock.currentTimeMillis
    const integration = RoutineTrigger.guards.Integration(input.trigger)
      ? yield* watch.prepare(actor, input.trigger)
      : null
    const trigger = integration === null ? input.trigger : integration.trigger
    const next =
      integration === null
        ? yield* nextExpectedAt(trigger, true, now)
        : now + integration.intervalMillis
    const rows = yield* database.run(
      database
        .insert(routines)
        .values({
          id: crypto.randomUUID(),
          personId: actor.person.id,
          companyId: companyColumnOf(actor.workspace),
          name: input.name,
          prompt: input.prompt,
          ...triggerColumns(trigger),
          integration: integration === null ? null : encodeWatch(integration),
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

/** Trigger changes replace the binding; metadata-only patches retain the established cursor. */
function patchedTrigger(current: RoutineRecord, input: PatchInput, prepared: Watch | null) {
  if (input.trigger === undefined)
    return {
      trigger: current.routine.trigger,
      integration: prepared === null ? current.integration : prepared,
    }
  if (prepared === null) return { trigger: input.trigger, integration: null }
  return { trigger: prepared.trigger, integration: prepared }
}

/** Resume schedules a future observation; editing the prompt does not reset the provider baseline. */
const patchedDue = Effect.fn('RoutineStore.patchedDue')(function* (change: {
  readonly current: RoutineRecord
  readonly input: PatchInput
  readonly trigger: RoutineTrigger
  readonly integration: Watch | null
  readonly enabled: boolean
  readonly now: number
}) {
  if (change.input.trigger === undefined && change.input.enabled === undefined)
    return change.current.routine.nextExpectedAt
  if (change.integration === null)
    return yield* nextExpectedAt(change.trigger, change.enabled, change.now)
  return change.enabled ? change.now + change.integration.intervalMillis : null
})

/** Row locking preserves concurrent partial updates and key rotation while a trigger is changed. */
const makePatch = (
  database: DatabaseService,
  view: ReturnType<typeof makeView>,
  watch: IntegrationWatch['Service'],
) =>
  Effect.fn('RoutineStore.patch')(function* (actor: Actor, id: RoutineId, input: PatchInput) {
    const now = yield* Clock.currentTimeMillis
    // Authorize before the read-only baseline call; network I/O never runs under a row lock.
    const authorized = yield* makeGet(database)(actor, id)
    const selected = input.trigger === undefined ? authorized.routine.trigger : input.trigger
    const rebaseline = input.trigger !== undefined || input.enabled === true
    const prepared =
      rebaseline && RoutineTrigger.guards.Integration(selected)
        ? yield* watch.prepare(actor, selected)
        : null
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
        const { trigger, integration } = patchedTrigger(current, input, prepared)
        const enabled = input.enabled === undefined ? current.routine.enabled : input.enabled
        const next = yield* patchedDue({ current, input, trigger, integration, enabled, now })
        // A changed trigger must not admit queued content from the previous Integration binding.
        if (input.trigger !== undefined)
          yield* tx
            .update(occurrences)
            .set({
              status: 'failed',
              error: 'Its Integration trigger changed before delivery',
              finishedAt: now,
            })
            .where(
              and(
                eq(occurrences.routineId, id),
                isNotNull(occurrences.providerEvent),
                isNull(occurrences.submissionId),
                eq(occurrences.status, 'not-admitted'),
              ),
            )
        const result = yield* tx
          .update(routines)
          .set({
            name: input.name === undefined ? current.routine.name : input.name,
            prompt: input.prompt === undefined ? current.routine.prompt : input.prompt,
            ...triggerColumns(trigger),
            webhookKeyHash: RoutineTrigger.guards.Webhook(trigger) ? current.webhookKeyHash : null,
            integration: integration === null ? null : encodeWatch(integration),
            watchRevision: current.watchRevision + 1,
            pause: input.enabled === true || input.trigger !== undefined ? null : row.pause,
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
const memberPresent = Effect.fn('RoutineStore.memberPresent')(function* (
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
    return members.length > 0
  }
  return true
})

/** Membership removal conceals manual/webhook operations; the scheduler records that same loss. */
const requireMember = Effect.fn('RoutineStore.requireMember')(function* (
  database: Pick<DatabaseService, 'select'>,
  record: RoutineRecord,
) {
  if (!(yield* memberPresent(database, record)))
    return yield* Effect.fail(new RoutineMissing({ id: record.routine.id }))
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

const decodeAttribution = decodeStored(AuditAttribution, 'Routine owner attribution')

/** Terminal updates happen under the receipt lock and cannot overwrite an attached Run. A missed
 * receipt also updates the Routine's visible missed timestamp, using the original receipt time.
 */
const retireScheduled = Effect.fn('RoutineStore.retireScheduled')(function* (
  tx: Pick<DatabaseService, 'update' | 'insert'>,
  occurrence: typeof occurrences.$inferSelect,
  failure: ScheduledFailure,
  now: number,
) {
  yield* tx
    .update(occurrences)
    .set({
      status: 'failed',
      error: scheduledFailureReason(failure),
      finishedAt: now,
    })
    .where(and(eq(occurrences.id, occurrence.id), isNull(occurrences.submissionId)))
  if (ScheduledFailure.guards.Missed(failure))
    yield* tx
      .update(routines)
      .set({ lastMissedAt: sql`greatest(${routines.lastMissedAt}, ${occurrence.startedAt})` })
      .where(eq(routines.id, occurrence.routineId))
  // A departed owner cannot authorize future ticks either; retain the failed receipt once.
  if (!ScheduledFailure.guards.Membership(failure)) return []
  const stopped = yield* tx
    .update(routines)
    .set({ enabled: false, nextExpectedAt: null, updatedAt: now })
    .where(and(eq(routines.id, occurrence.routineId), eq(routines.enabled, true)))
    .returning({ personId: routines.personId, companyId: routines.companyId })
  const topics: Topic[] = []
  for (const owner of stopped) {
    const attribution = yield* decodeAttribution({ ...owner, by: 'vivid', threadId: null })
    yield* appendAudit(
      tx,
      attribution,
      AuditEvent.cases.RoutineStopped.make({
        routineId: RoutineId.make(occurrence.routineId),
        reason: 'Membership',
      }),
      now,
    )
    topics.push(Topic.person(attribution.personId))
    if (attribution.companyId !== null) topics.push(Topic.company(attribution.companyId))
  }
  return topics
})

/** Enabled, fresh receipts require current Membership before replay. Disabled receipts are retired
 * too, so enabling the Routine later cannot resurrect work the Person explicitly stopped.
 */
const replayScheduled = Effect.fn('RoutineStore.replayScheduled')(function* (
  tx: Pick<DatabaseService, 'select' | 'update' | 'insert'>,
  now: number,
) {
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
  const topics: Topic[] = []
  for (const row of pending) {
    const record = yield* decodeRoutine(row.routine)
    if (!record.routine.enabled) {
      yield* retireScheduled(tx, row.occurrence, ScheduledFailure.cases.Disabled.make({}), now)
      continue
    }
    if (!(yield* memberPresent(tx, record))) {
      topics.push(
        ...(yield* retireScheduled(
          tx,
          row.occurrence,
          ScheduledFailure.cases.Membership.make({}),
          now,
        )),
      )
      continue
    }
    if (now - row.occurrence.startedAt >= scheduledReplayMillis) {
      yield* retireScheduled(tx, row.occurrence, ScheduledFailure.cases.Missed.make({}), now)
      continue
    }
    receipts.push({ record, attempt: replayAttempt(OccurrenceId.make(row.occurrence.id)) })
  }
  return { receipts, topics }
})

/** Claims each tick with its receipt atomically. Replay stops on withdrawal, lost authority or
 * the 15-minute admission limit; Conversation still owns keyed admission across process crashes.
 */
const makeClaimDue = (database: DatabaseService, changes: Changes['Service']) =>
  Effect.fn('RoutineStore.claimDue')(function* () {
    const now = yield* Clock.currentTimeMillis
    const claimed = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const { receipts, topics } = yield* replayScheduled(tx, now)
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
          const inserted = yield* tx
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
            .returning()
          yield* tx
            .update(routines)
            .set({ nextExpectedAt: next })
            .where(eq(routines.id, record.routine.id))
          if (!(yield* memberPresent(tx, record))) {
            const occurrence = yield* returned(inserted, 'Scheduled receipt')
            topics.push(
              ...(yield* retireScheduled(
                tx,
                occurrence,
                ScheduledFailure.cases.Membership.make({}),
                now,
              )),
            )
            continue
          }
          receipts.push({ record, attempt })
        }
        return { receipts, topics }
      }),
    )
    // Live readers wake only once the disabled state and its audit line have both committed.
    if (claimed.topics.length > 0) yield* changes.publish([...new Set(claimed.topics)])
    return claimed.receipts
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

/** Terminal authority failures stop replay; transient admission errors retain the original key. */
const makeFailOccurrence = (database: DatabaseService) =>
  Effect.fn('RoutineStore.failOccurrence')(function* (
    id: OccurrenceId,
    failure: OccurrenceFailure | ScheduledFailure,
  ) {
    const now = yield* Clock.currentTimeMillis
    const snapshot = StoredOccurrenceFailure.match(failure, {
      Disabled: (value) => ({
        status: 'failed',
        error: scheduledFailureReason(value),
        finishedAt: now,
      }),
      Membership: (value) => ({
        status: 'failed',
        error: scheduledFailureReason(value),
        finishedAt: now,
      }),
      Missed: (value) => ({
        status: 'failed',
        error: scheduledFailureReason(value),
        finishedAt: now,
      }),
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
export const routineStoreServiceLayer = Layer.effect(
  RoutineStore,
  Effect.gen(function* () {
    const database = yield* Database
    const config = yield* ServerConfig
    const changes = yield* Changes
    const watch = yield* IntegrationWatch
    const get = makeGet(database)
    const view = makeView(database)
    const findOccurrence = makeFindOccurrence(database)
    return RoutineStore.of({
      ...integrationOperations(database, watch, memberPresent, changes),
      /** Keep the provider service receiver intact when discovery crosses the store boundary. */
      findEvents: Effect.fn('RoutineStore.findEvents')(function* (actor: Actor, account: string) {
        return yield* watch.discover(actor, account)
      }),
      list: makeList(database, view),
      get,
      create: makeCreate(database, watch),
      patch: makePatch(database, view, watch),
      remove: makeRemove(database),
      issueWebhook: makeIssueWebhook(database, config.PUBLIC_URL, get),
      authorizeWebhook: makeAuthorizeWebhook(database),
      claimDue: makeClaimDue(database, changes),
      findOccurrence,
      claimOccurrence: makeClaimOccurrence(database, findOccurrence),
      attachSubmission: makeAttachSubmission(database),
      failOccurrence: makeFailOccurrence(database),
    })
  }),
)

/** Production chooses polling here; replacing the Watch Layer leaves receipt/admission code intact. */
export const routineStoreLayer = routineStoreServiceLayer.pipe(
  Layer.provide(integrationPollingLayer),
)
