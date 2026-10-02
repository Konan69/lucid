import { Schema } from 'effect'
import { LibraryFolderId, OccurrenceId, RoutineId, ThreadId } from './identity.js'

/**
 * What starts a Routine. A schedule fires on a cron expression in a time zone. A webhook fires
 * when an outside service calls the Routine's address with its key. An Integration is addressed
 * by its Person-visible account label; the Connection binding remains private on the server.
 */
export const RoutineTrigger = Schema.TaggedUnion({
  Schedule: { cron: Schema.String, timezone: Schema.String },
  Webhook: {},
  Integration: { account: Schema.String, event: Schema.String, filter: Schema.Json },
})
export type RoutineTrigger = typeof RoutineTrigger.Type

/** Closed Routine occurrence lifecycle values encoded by the current HTTP protocol. */
export const OccurrenceStatus = Schema.Literals(['running', 'succeeded', 'failed'] as const)

/** One bounded Routine occurrence. */
export const Occurrence = Schema.Struct({
  id: OccurrenceId,
  routineId: RoutineId,
  threadId: ThreadId,
  submissionId: Schema.NullOr(Schema.String),
  status: OccurrenceStatus,
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'Occurrence', title: 'Routine occurrence' })
/** Decoded Routine occurrence. */
export interface Occurrence extends Schema.Schema.Type<typeof Occurrence> {}

/** Reusable Routine returned by the runtime. */
export const Routine = Schema.Struct({
  id: RoutineId,
  name: Schema.String,
  prompt: Schema.String,
  trigger: RoutineTrigger,
  libraryFolderId: Schema.NullOr(LibraryFolderId),
  enabled: Schema.Boolean,
  nextExpectedAt: Schema.NullOr(Schema.Number),
  lastMissedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  nextRunAt: Schema.NullOr(Schema.Number),
  runs: Schema.Array(Occurrence),
}).annotate({ identifier: 'Routine', title: 'Routine' })
/** Decoded Routine. */
export interface Routine extends Schema.Schema.Type<typeof Routine> {}
/** Input accepted while creating a Routine. */
export const CreateRoutineRequest = Schema.Struct({
  name: Schema.String,
  prompt: Schema.String,
  trigger: RoutineTrigger,
  libraryFolderId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
})
/** Input accepted while updating a Routine. */
export const PatchRoutineRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(RoutineTrigger),
  libraryFolderId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
  enabled: Schema.optionalKey(Schema.Boolean),
})
/** Routine path parameters. */
export const RoutineParams = Schema.Struct({ id: RoutineId })
/** Routine list response. */
export const RoutineListResponse = Schema.Struct({ routines: Schema.Array(Routine) })
/** Single Routine response. */
export const RoutineResponse = Schema.Struct({ routine: Routine })
/** Accepted Routine occurrence response. */
export const OccurrenceResponse = Schema.Struct({ run: Occurrence })

/** Provider event discovery is readable configuration, never a Connection reference. */
export const FindEventsRequest = Schema.Struct({ account: Schema.String })
export const FindEventsResponse = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      event: Schema.String,
      description: Schema.String,
      filter: Schema.Json,
    }),
  ),
})

/**
 * The address and key an outside service uses to start a webhook Routine. Shown once to its owner
 * when asked for; the key is the only thing that authorizes the call.
 */
export const RoutineWebhook = Schema.Struct({
  address: Schema.String,
  key: Schema.Redacted(Schema.String),
})
export interface RoutineWebhook extends Schema.Schema.Type<typeof RoutineWebhook> {}
