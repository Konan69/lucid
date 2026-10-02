import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm'
import { Clock, Effect, Schema } from 'effect'
import { DatabaseFailure, OccurrenceId, RoutineId, RoutineTrigger } from '@vivid/contracts'
import { Database, decodeStored } from '../database/client.ts'
import { integrationAttempt, replayAttempt } from './attempts.ts'
import { decodeRoutine, type RoutineRecord } from './records.ts'
import { occurrences, routines } from './tables.ts'
import { IntegrationWatch, ProviderEvent, Watch, type WatchBatch } from './watch.ts'

/** Notice intent survives crashes; the immutable key makes Thread delivery retry-safe. */
const Pause = Schema.TaggedUnion({
  Pending: { key: Schema.String, reason: Schema.String },
  Notified: { key: Schema.String, reason: Schema.String },
})
const decodePause = decodeStored(Pause, 'Routine Integration pause')
const decodeEvent = decodeStored(ProviderEvent, 'Routine provider event')
const encodeWatch = Schema.encodeSync(Watch)
const encodePause = Schema.encodeSync(Pause)
const encodeEvent = Schema.encodeSync(ProviderEvent)
type Membership = (
  database: Pick<Database['Service'], 'select'>,
  record: RoutineRecord,
) => Effect.Effect<
  boolean,
  | import('drizzle-orm/effect-core/errors').EffectDrizzleQueryError
  | import('effect/unstable/sql/SqlError').SqlError
>

/** A single conditional transition owns the reason and one durable Thread notice. */
const pauseIntegration = (database: Database['Service']) =>
  Effect.fn('RoutineIntegration.pause')(function* (record: RoutineRecord, reason: string) {
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const changed = yield* tx
          .update(routines)
          .set({
            enabled: false,
            nextExpectedAt: null,
            pause: encodePause(Pause.cases.Pending.make({ key: crypto.randomUUID(), reason })),
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
          .set({ status: 'failed', error: reason, finishedAt: now })
          .where(
            and(
              eq(occurrences.routineId, record.routine.id),
              isNotNull(occurrences.providerEvent),
              isNull(occurrences.submissionId),
              eq(occurrences.status, 'not-admitted'),
            ),
          )
        return true
      }),
    )
  })

/** Due claims persist cadence before observing; a crash merely delays the next read. */
const claimWatches = (database: Database['Service'], memberPresent: Membership) =>
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
        const records = yield* Effect.forEach(rows, decodeRoutine)
        const allowed: RoutineRecord[] = []
        for (const record of records) {
          if (record.integration === null)
            return yield* Effect.fail(
              new DatabaseFailure({ message: 'Integration Routine has no Watch' }),
            )
          if (!(yield* memberPresent(tx, record))) {
            yield* tx
              .update(routines)
              .set({
                enabled: false,
                nextExpectedAt: null,
                pause: encodePause(
                  Pause.cases.Pending.make({
                    key: crypto.randomUUID(),
                    reason: 'Its owner is no longer a Member of its Company',
                  }),
                ),
              })
              .where(eq(routines.id, record.routine.id))
            continue
          }
          yield* tx
            .update(routines)
            .set({ nextExpectedAt: now + record.integration.intervalMillis })
            .where(eq(routines.id, record.routine.id))
          allowed.push(record)
        }
        return allowed
      }),
    )
    return claimed
  })

/** Advance a cursor only in the transaction that persists every item in provider order. */
const recordEvents = (database: Database['Service'], memberPresent: Membership) =>
  Effect.fn('RoutineIntegration.record')(function* (record: RoutineRecord, batch: WatchBatch) {
    const now = yield* Clock.currentTimeMillis
    if (record.integration === null)
      return yield* Effect.fail(
        new DatabaseFailure({ message: 'Integration Routine has no Watch' }),
      )
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
            integration: encodeWatch(Watch.make({ ...binding, cursor: batch.cursor })),
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
      return yield* Effect.fail(
        new DatabaseFailure({ message: 'Integration Routine has no Watch' }),
      )
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
        yield* pause(record, 'Its owner is no longer a Member of its Company')
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
      if (Pause.guards.Pending(notice)) pending.push({ record: yield* decodeRoutine(row), notice })
    }
    return pending
  })

/** Only the originally delivered notice is acknowledged; a newer pause cannot be overwritten. */
const markIntegrationNotified = (database: Database['Service']) =>
  Effect.fn('RoutineIntegration.notified')(function* (
    id: RoutineId,
    notice: typeof Pause.cases.Pending.Type,
  ) {
    yield* database.run(
      database
        .update(routines)
        .set({
          pause: encodePause(Pause.cases.Notified.make({ key: notice.key, reason: notice.reason })),
        })
        .where(and(eq(routines.id, id), eq(routines.pause, encodePause(notice)))),
    )
  })

/** Compose the Integration persistence operations inside the existing RoutineStore authority. */
export function integrationOperations(
  database: Database['Service'],
  watch: IntegrationWatch['Service'],
  memberPresent: Membership,
) {
  const pause = pauseIntegration(database)
  return {
    pauseIntegration: pause,
    claimWatches: claimWatches(database, memberPresent),
    recordEvents: recordEvents(database, memberPresent),
    readIntegration: readIntegration(watch),
    pendingEvents: pendingEvents(database, memberPresent, pause),
    integrationNotices: integrationNotices(database),
    markIntegrationNotified: markIntegrationNotified(database),
  }
}
