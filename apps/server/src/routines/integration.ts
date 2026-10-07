import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm'
import { Clock, Effect, Option, Result, Schema } from 'effect'
import {
  AuditEvent,
  DatabaseFailure,
  OccurrenceId,
  RoutineId,
  RoutineTrigger,
} from '@vivid/contracts'
import { appendAudit, AuditAttribution } from '../audit/record.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Database, decodeStored } from '../database/client.ts'
import { integrationAttempt, replayAttempt } from './attempts.ts'
import { decodeRoutine, type RoutineRecord } from './records.ts'
import { occurrences, routines } from './tables.ts'
import { IntegrationWatch, ProviderEvent, Watch, WatchCursor, type WatchBatch } from './watch.ts'

/** Notice intent survives crashes; the immutable key makes Thread delivery retry-safe. */
export const IntegrationNotice = Schema.TaggedUnion({
  Pending: { key: Schema.String, reason: Schema.String },
  Notified: { key: Schema.String, reason: Schema.String },
  GapPending: { key: Schema.String, reason: Schema.String },
  GapNotified: { key: Schema.String, reason: Schema.String },
  Corrupt: { reason: Schema.String },
})
const decodePause = decodeStored(IntegrationNotice, 'Routine Integration pause')
const decodeEvent = decodeStored(ProviderEvent, 'Routine provider event')
const encodeWatch = Schema.encodeSync(Watch)
const encodePause = Schema.encodeSync(IntegrationNotice)
const encodeEvent = Schema.encodeSync(ProviderEvent)
type Membership = (
  database: Pick<Database['Service'], 'select'>,
  record: RoutineRecord,
) => Effect.Effect<
  boolean,
  | import('drizzle-orm/effect-core/errors').EffectDrizzleQueryError
  | import('effect/unstable/sql/SqlError').SqlError
>

/** Server retirement reasons are closed decisions, independent of provider error text. */
export const IntegrationStopReason = Schema.TaggedUnion({ Membership: {}, Revoked: {} })
export type IntegrationStopReason = typeof IntegrationStopReason.Type
/** Stable notice wording is derived from the retirement decision, never a provider payload. */
const stopMessage = (reason: IntegrationStopReason) =>
  IntegrationStopReason.match(reason, {
    Membership: () => 'Its owner is no longer a Member of its Company',
    Revoked: () => 'Its Integration was revoked or needs sign-in',
  })

/** The conditional row write owns one durable notice and terminal queued receipts. The audit line
 * commits with the stop, whatever the reason: a Routine that Vivid switched off on its own is on
 * the record, attributed to the stored owner even after their access disappears. */
const retireIntegration = Effect.fn('RoutineIntegration.retire')(function* (
  tx: Pick<Database['Service'], 'update' | 'insert'>,
  record: RoutineRecord,
  reason: IntegrationStopReason,
  now: number,
) {
  const changed = yield* tx
    .update(routines)
    .set({
      enabled: false,
      nextExpectedAt: null,
      pause: encodePause(
        IntegrationNotice.cases.Pending.make({
          key: crypto.randomUUID(),
          reason: stopMessage(reason),
        }),
      ),
      updatedAt: now,
      watchRevision: record.watchRevision + 1,
    })
    .where(
      and(
        eq(routines.id, record.routine.id),
        eq(routines.enabled, true),
        eq(routines.watchRevision, record.watchRevision),
      ),
    )
    .returning()
  if (changed.length === 0) return false
  yield* tx
    .update(occurrences)
    .set({ status: 'failed', error: stopMessage(reason), finishedAt: now })
    .where(
      and(
        eq(occurrences.routineId, record.routine.id),
        isNotNull(occurrences.providerEvent),
        isNull(occurrences.submissionId),
        eq(occurrences.status, 'not-admitted'),
      ),
    )
  yield* appendAudit(
    tx,
    AuditAttribution.make({
      personId: record.personId,
      companyId: record.companyId,
      by: 'vivid',
      threadId: null,
    }),
    AuditEvent.cases.RoutineStopped.make({ routineId: record.routine.id, reason: reason._tag }),
    now,
  )
  return true
})

/** Publish only committed transitions; both the owner's and Company's readers observe retirement. */
const publishRetirement = (changes: Changes['Service']) =>
  Effect.fn('RoutineIntegration.publishRetirement')((record: RoutineRecord) =>
    changes.publish(
      record.companyId === null
        ? [Topic.person(record.personId)]
        : [Topic.person(record.personId), Topic.company(record.companyId)],
    ),
  )

/** A single conditional transition owns the reason and one durable Thread notice. */
const pauseIntegration = (database: Database['Service'], changes: Changes['Service']) =>
  Effect.fn('RoutineIntegration.pause')(function* (
    record: RoutineRecord,
    reason: IntegrationStopReason,
  ) {
    const now = yield* Clock.currentTimeMillis
    const changed = yield* database.transaction((tx) => retireIntegration(tx, record, reason, now))
    if (changed) yield* publishRetirement(changes)(record)
    return changed
  })

/** Losing a cursor grants no authority to replay older content. Persist the new baseline and a
 * retry-safe notice together; the Routine remains enabled and observes only subsequent arrivals. */
const rebaselineIntegration = (database: Database['Service']) =>
  Effect.fn('RoutineIntegration.rebaseline')(function* (
    record: RoutineRecord,
    cursor: WatchCursor,
    reason: string,
  ) {
    if (record.integration === null)
      return yield* new DatabaseFailure({ message: 'Integration Routine has no Watch' })
    const now = yield* Clock.currentTimeMillis
    const changed = yield* database.run(
      database
        .update(routines)
        .set({
          integration: encodeWatch(
            Watch.make({ ...record.integration, cursor, failures: Option.none() }),
          ),
          watchRevision: record.watchRevision + 1,
          pause: encodePause(
            IntegrationNotice.cases.GapPending.make({ key: crypto.randomUUID(), reason }),
          ),
          nextExpectedAt: now + record.integration.intervalMillis,
          updatedAt: now,
        })
        .where(
          and(
            eq(routines.id, record.routine.id),
            eq(routines.enabled, true),
            eq(routines.watchRevision, record.watchRevision),
          ),
        )
        .returning(),
    )
    return changed.length > 0
  })

/** Retry delay is persisted per Routine, so restarting the server cannot reset a failing provider's budget.
 * Reads are safe to retry; four or more consecutive failures stay at sixty minutes until a success. */
const retryMinutes = (failures: number) => {
  if (failures === 1) return 1
  if (failures === 2) return 5
  if (failures === 3) return 15
  return 60
}
const backoffIntegration = (database: Database['Service']) =>
  Effect.fn('RoutineIntegration.backoff')(function* (record: RoutineRecord) {
    if (record.integration === null)
      return yield* new DatabaseFailure({ message: 'Integration Routine has no Watch' })
    const failures = Option.match(record.integration.failures, {
      onNone: () => 1,
      onSome: (count) => count + 1,
    })
    const now = yield* Clock.currentTimeMillis
    const changed = yield* database.run(
      database
        .update(routines)
        .set({
          integration: encodeWatch(
            Watch.make({ ...record.integration, failures: Option.some(failures) }),
          ),
          watchRevision: record.watchRevision + 1,
          nextExpectedAt: now + retryMinutes(failures) * 60_000,
          updatedAt: now,
        })
        .where(
          and(
            eq(routines.id, record.routine.id),
            eq(routines.enabled, true),
            eq(routines.watchRevision, record.watchRevision),
          ),
        )
        .returning(),
    )
    if (changed.length > 0)
      yield* Effect.logWarning('Routine Integration read deferred', {
        routineId: record.routine.id,
        failures,
        retryMinutes: retryMinutes(failures),
      })
    return changed.length > 0
  })

/** Invalid persisted configuration is quarantined once, with a bounded stored reason. Decoding
 * failure never aborts the installation-wide claim transaction or leaks the invalid payload. */
const skipCorrupt = Effect.fn('RoutineIntegration.skipCorrupt')(function* (
  tx: Pick<Database['Service'], 'update'>,
  row: typeof routines.$inferSelect,
  now: number,
) {
  yield* tx
    .update(routines)
    .set({
      enabled: false,
      nextExpectedAt: null,
      updatedAt: now,
      watchRevision: row.watchRevision + 1,
      pause: encodePause(
        IntegrationNotice.cases.Corrupt.make({
          reason: 'Its stored Integration configuration is invalid',
        }),
      ),
    })
    .where(eq(routines.id, row.id))
  yield* tx
    .update(occurrences)
    .set({
      status: 'failed',
      finishedAt: now,
      error: 'Its stored Integration configuration is invalid',
    })
    .where(
      and(
        eq(occurrences.routineId, row.id),
        isNotNull(occurrences.providerEvent),
        isNull(occurrences.submissionId),
        eq(occurrences.status, 'not-admitted'),
      ),
    )
  yield* Effect.logError('Corrupt Integration Routine skipped', { routineId: row.id })
})

/** Due claims persist cadence before observing; a crash merely delays the next read. */
const claimWatches = (
  database: Database['Service'],
  memberPresent: Membership,
  changes: Changes['Service'],
) =>
  Effect.fn('RoutineIntegration.claim')(function* () {
    const now = yield* Clock.currentTimeMillis
    const claimed = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .select()
          .from(routines)
          .where(
            and(
              eq(routines.trigger, 'integration'),
              eq(routines.enabled, true),
              lte(routines.nextExpectedAt, now),
            ),
          )
          .orderBy(asc(routines.nextExpectedAt), asc(routines.id))
          .for('update', { skipLocked: true })
        const allowed: RoutineRecord[] = []
        const stopped: RoutineRecord[] = []
        for (const row of rows) {
          const decoded = yield* decodeRoutine(row).pipe(Effect.result)
          if (Result.isFailure(decoded)) {
            yield* skipCorrupt(tx, row, now)
            continue
          }
          const record = decoded.success
          if (record.integration === null) {
            yield* skipCorrupt(tx, row, now)
            continue
          }
          if (!(yield* memberPresent(tx, record))) {
            if (
              yield* retireIntegration(
                tx,
                record,
                IntegrationStopReason.cases.Membership.make({}),
                now,
              )
            )
              stopped.push(record)
            continue
          }
          yield* tx
            .update(routines)
            .set({ nextExpectedAt: now + record.integration.intervalMillis })
            .where(eq(routines.id, record.routine.id))
          allowed.push(record)
        }
        return { allowed, stopped }
      }),
    )
    yield* Effect.forEach(claimed.stopped, publishRetirement(changes), { discard: true })
    return claimed.allowed
  })

/** Advance a cursor only in the transaction that persists every item in provider order. */
const recordEvents = (database: Database['Service'], memberPresent: Membership) =>
  Effect.fn('RoutineIntegration.record')(function* (record: RoutineRecord, batch: WatchBatch) {
    const now = yield* Clock.currentTimeMillis
    if (record.integration === null)
      return yield* new DatabaseFailure({ message: 'Integration Routine has no Watch' })
    const binding = record.integration
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .select()
          .from(routines)
          .where(
            and(
              eq(routines.id, record.routine.id),
              eq(routines.enabled, true),
              eq(routines.watchRevision, record.watchRevision),
            ),
          )
          .for('update')
        const row = rows[0]
        if (row === undefined) return false
        if (!(yield* memberPresent(tx, record))) return false
        for (const [position, item] of batch.items.entries()) {
          const attempt = integrationAttempt(record.routine.id, item.id)
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
              providerEvent: encodeEvent(item),
              eventOrder: row.eventCounter + position,
            })
            .onConflictDoNothing({ target: occurrences.id })
        }
        yield* tx
          .update(routines)
          .set({
            integration: encodeWatch(
              Watch.make({ ...binding, cursor: batch.cursor, failures: Option.none() }),
            ),
            watchRevision: row.watchRevision + 1,
            eventCounter: row.eventCounter + batch.items.length,
          })
          .where(eq(routines.id, row.id))
        return true
      }),
    )
  })

/** Polling and native Layers share this single input seam. */
const readIntegration = (watch: IntegrationWatch['Service']) =>
  Effect.fn('RoutineIntegration.read')(function* (record: RoutineRecord) {
    if (record.integration === null)
      return yield* new DatabaseFailure({ message: 'Integration Routine has no Watch' })
    return yield* watch.newItems({
      routineId: record.routine.id,
      personId: record.personId,
      companyId: record.companyId,
      watch: record.integration,
    })
  })

/** Persisted items replay without another provider read, including after a fresh process starts. */
const pendingEvents = (
  database: Database['Service'],
  memberPresent: Membership,
  pause: ReturnType<typeof pauseIntegration>,
) =>
  Effect.fn('RoutineIntegration.pending')(function* () {
    const rows = yield* database.run(
      database
        .select({ routine: routines, occurrence: occurrences })
        .from(occurrences)
        .innerJoin(routines, eq(routines.id, occurrences.routineId))
        .where(
          and(
            isNotNull(occurrences.providerEvent),
            isNull(occurrences.submissionId),
            eq(occurrences.status, 'not-admitted'),
          ),
        )
        .orderBy(asc(routines.id), asc(occurrences.eventOrder)),
    )
    const receipts = []
    for (const row of rows) {
      const record = yield* decodeRoutine(row.routine)
      if (!record.routine.enabled || !RoutineTrigger.guards.Integration(record.routine.trigger)) {
        yield* database.run(
          database
            .update(occurrences)
            .set({
              status: 'failed',
              error: 'Its Routine was paused or its Integration trigger removed before delivery',
              finishedAt: yield* Clock.currentTimeMillis,
            })
            .where(eq(occurrences.id, row.occurrence.id)),
        )
        continue
      }
      if (!(yield* database.run(memberPresent(database, record)))) {
        yield* pause(record, IntegrationStopReason.cases.Membership.make({}))
        continue
      }
      const event = yield* decodeEvent(row.occurrence.providerEvent)
      receipts.push({
        record,
        attempt: replayAttempt(OccurrenceId.make(row.occurrence.id)),
        event,
      })
    }
    return receipts
  })

/** Pending notice reads make failure between pause and delivery recoverable. */
const integrationNotices = (database: Database['Service']) =>
  Effect.fn('RoutineIntegration.notices')(function* () {
    const rows = yield* database.run(
      database.select().from(routines).where(isNotNull(routines.pause)),
    )
    const pending = []
    for (const row of rows) {
      const notice = yield* decodePause(row.pause)
      if (IntegrationNotice.isAnyOf(['Pending', 'GapPending'])(notice))
        pending.push({ record: yield* decodeRoutine(row), notice })
    }
    return pending
  })

/** Only the originally delivered notice is acknowledged; a newer pause cannot be overwritten. */
const markIntegrationNotified = (database: Database['Service']) =>
  Effect.fn('RoutineIntegration.notified')(function* (
    id: RoutineId,
    notice:
      | typeof IntegrationNotice.cases.Pending.Type
      | typeof IntegrationNotice.cases.GapPending.Type,
  ) {
    yield* database.run(
      database
        .update(routines)
        .set({
          pause: encodePause(
            IntegrationNotice.guards.GapPending(notice)
              ? IntegrationNotice.cases.GapNotified.make({ key: notice.key, reason: notice.reason })
              : IntegrationNotice.cases.Notified.make({ key: notice.key, reason: notice.reason }),
          ),
        })
        .where(and(eq(routines.id, id), eq(routines.pause, encodePause(notice)))),
    )
  })

/** Compose the Integration persistence operations inside the existing RoutineStore authority. */
export function integrationOperations(
  database: Database['Service'],
  watch: IntegrationWatch['Service'],
  memberPresent: Membership,
  changes: Changes['Service'],
) {
  const pause = pauseIntegration(database, changes)
  return {
    pauseIntegration: pause,
    rebaselineIntegration: rebaselineIntegration(database),
    backoffIntegration: backoffIntegration(database),
    claimWatches: claimWatches(database, memberPresent, changes),
    recordEvents: recordEvents(database, memberPresent),
    readIntegration: readIntegration(watch),
    pendingEvents: pendingEvents(database, memberPresent, pause),
    integrationNotices: integrationNotices(database),
    markIntegrationNotified: markIntegrationNotified(database),
  }
}
