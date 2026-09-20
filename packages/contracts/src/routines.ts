import { Schema } from 'effect'
import { LibraryFolderId, OccurrenceId, RoutineId, ThreadId } from './identity.js'

/** Closed Routine occurrence lifecycle values encoded by the current HTTP protocol. */
export const OccurrenceStatus = Schema.Literals(['running', 'succeeded', 'failed'] as const)

/** One bounded Routine occurrence. */
export const Occurrence = Schema.Struct({
  id: OccurrenceId,
  routineId: RoutineId,
  conversationId: ThreadId,
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
  cron: Schema.String,
  timezone: Schema.String,
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
  cron: Schema.String,
  timezone: Schema.String,
  libraryFolderId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
})
/** Input accepted while updating a Routine. */
export const PatchRoutineRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  cron: Schema.optionalKey(Schema.String),
  timezone: Schema.optionalKey(Schema.String),
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
