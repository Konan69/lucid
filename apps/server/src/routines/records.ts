import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  CompanyId,
  DatabaseFailure,
  LibraryFolderId,
  Occurrence,
  PersonId,
  Routine,
  RoutineId,
  RoutineTrigger,
} from '@vivid/contracts'
import { decodeStored } from '../database/client.ts'
import { occurrences, routines } from './tables.ts'
import { Watch } from './watch.ts'

const RoutineRow = createSelectSchema(routines, {
  id: RoutineId,
  integration: Schema.NullOr(Watch),
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  libraryFolderId: Schema.NullOr(LibraryFolderId),
  webhookKeyHash: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
})
const decodeOccurrenceView = decodeStored(Occurrence, 'Routine occurrence')
const decodeRow = decodeStored(RoutineRow, 'Routine')

/** Ownership stays inside the server; the public Routine never carries credential hashes. */
export interface RoutineRecord {
  readonly routine: Routine
  readonly personId: PersonId
  readonly companyId: CompanyId | null
  readonly webhookKeyHash: string | null
  readonly integration: Watch | null
  readonly watchRevision: number
}

/** Schedule authority cannot coexist with an Integration binding or webhook credential. */
const scheduleTrigger = Effect.fn('RoutineStore.scheduleTrigger')(function* (
  row: typeof RoutineRow.Type,
) {
  if (
    row.onceAt !== null ||
    row.cron === null ||
    row.timezone === null ||
    row.webhookKeyHash !== null ||
    row.integration !== null
  )
    return yield* new DatabaseFailure({ message: 'Routine trigger columns disagree' })
  return RoutineTrigger.cases.Schedule.make({ cron: row.cron, timezone: row.timezone })
})
/** Integration authority has a fully typed private Watch and no webhook credential. */
const integrationTrigger = Effect.fn('RoutineStore.integrationTrigger')(function* (
  row: typeof RoutineRow.Type,
) {
  if (
    row.onceAt !== null ||
    row.integration === null ||
    row.cron !== null ||
    row.timezone !== null ||
    row.webhookKeyHash !== null
  )
    return yield* new DatabaseFailure({ message: 'Routine trigger columns disagree' })
  return row.integration.trigger
})

/** A consumed one-off retains its instant after its next due time has been cleared. */
const onceTrigger = Effect.fn('RoutineStore.onceTrigger')(function* (row: typeof RoutineRow.Type) {
  if (
    row.onceAt === null ||
    row.timezone === null ||
    row.cron !== null ||
    row.webhookKeyHash !== null ||
    row.integration !== null
  )
    return yield* new DatabaseFailure({ message: 'Routine trigger columns disagree' })
  return RoutineTrigger.cases.Once.make({ at: row.onceAt, timezone: row.timezone })
})

/** Rejects contradictory storage rather than guessing a trigger from nullable columns. */
const triggerOf = Effect.fn('RoutineStore.triggerOf')(function* (row: typeof RoutineRow.Type) {
  if (row.trigger === 'once') return yield* onceTrigger(row)
  if (row.trigger === 'schedule') return yield* scheduleTrigger(row)
  if (row.trigger === 'integration') return yield* integrationTrigger(row)
  if (
    row.trigger === 'webhook' &&
    row.onceAt === null &&
    row.cron === null &&
    row.timezone === null &&
    row.integration === null &&
    row.nextExpectedAt === null
  ) {
    return RoutineTrigger.cases.Webhook.make({})
  }
  return yield* new DatabaseFailure({ message: 'Routine trigger columns disagree' })
})

/** Decodes the database ingress once and constructs the public view without exposing authority. */
export const decodeRoutine = Effect.fn('RoutineStore.decodeRoutine')(function* (
  value: typeof routines.$inferSelect,
): Effect.fn.Return<RoutineRecord, DatabaseFailure> {
  const row = yield* decodeRow(value)
  const trigger = yield* triggerOf(row)
  return {
    personId: row.personId,
    companyId: row.companyId,
    webhookKeyHash: row.webhookKeyHash,
    integration: row.integration,
    watchRevision: row.watchRevision,
    routine: Routine.make({
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      trigger,
      libraryFolderId: row.libraryFolderId,
      enabled: row.enabled,
      nextExpectedAt: row.nextExpectedAt,
      lastMissedAt: row.lastMissedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      nextRunAt: row.enabled ? row.nextExpectedAt : null,
      runs: [],
    }),
  }
})

/** The Run alone decides status; an occurrence without an admitted Run is not running work. */
export const decodeOccurrence = Effect.fn('RoutineStore.decodeOccurrence')(function* (joined: {
  readonly occurrence: typeof occurrences.$inferSelect
  readonly state: string | null
  readonly finishedAt: number | null
}) {
  const row = joined.occurrence
  if (row.submissionId !== null && joined.state === null) {
    // Deleting a Thread cascades its Runs, while the Routine retains its immutable receipt history.
    return yield* decodeOccurrenceView({
      id: row.id,
      routineId: row.routineId,
      threadId: row.conversationId,
      submissionId: row.submissionId,
      status: 'failed',
      startedAt: row.startedAt,
      finishedAt: row.startedAt,
      output: row.output,
      error: 'Its thread was deleted',
    })
  }
  let status: Occurrence['status'] = 'failed'
  if (joined.state === 'working') status = 'running'
  if (joined.state === 'completed') status = 'succeeded'
  return yield* decodeOccurrenceView({
    id: row.id,
    routineId: row.routineId,
    threadId: row.conversationId,
    submissionId: row.submissionId,
    status,
    startedAt: row.startedAt,
    finishedAt: joined.state === null ? row.finishedAt : joined.finishedAt,
    output: row.output,
    error: row.error,
  })
})

interface TriggerColumns {
  readonly trigger: 'once' | 'schedule' | 'webhook' | 'integration'
  readonly onceAt: number | null
  readonly cron: string | null
  readonly timezone: string | null
}

/** Each trigger writes a complete column set, clearing authority when switching to a schedule. */
export const triggerColumns = (trigger: RoutineTrigger) =>
  RoutineTrigger.match(trigger, {
    Once: ({ at, timezone }): TriggerColumns => ({
      trigger: 'once',
      onceAt: at,
      cron: null,
      timezone,
    }),
    Schedule: ({ cron, timezone }): TriggerColumns => ({
      onceAt: null,
      trigger: 'schedule',
      cron,
      timezone,
    }),
    Integration: (): TriggerColumns => ({
      trigger: 'integration',
      onceAt: null,
      cron: null,
      timezone: null,
    }),
    Webhook: (): TriggerColumns => ({
      trigger: 'webhook',
      onceAt: null,
      cron: null,
      timezone: null,
    }),
  })
