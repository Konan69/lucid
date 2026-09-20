import { Schema } from 'effect'
import { FollowUpId, RoutineId, TaskId, ThreadId } from './identity.js'

/** Closed Task lifecycle values encoded by the current HTTP protocol. */
export const TaskStatus = Schema.Literals(['open', 'done', 'dropped'] as const)
/** Closed Task priority values encoded by the current HTTP protocol. */
export const TaskPriority = Schema.Literals(['normal', 'urgent'] as const)
/** Closed follow-up lifecycle values encoded by the current HTTP protocol. */
export const FollowUpStatus = Schema.Literals([
  'scheduled',
  'running',
  'fired',
  'failed',
  'cancelled',
] as const)

/** Epoch milliseconds or an ISO 8601 timestamp accepted by mutation routes. */
export const TimestampInput = Schema.Union([Schema.Number, Schema.String])
/** Decoded timestamp input. */
export type TimestampInput = typeof TimestampInput.Type

/** One scheduled follow-up attached to a Task. */
export const FollowUp = Schema.Struct({
  id: FollowUpId,
  taskId: TaskId,
  at: Schema.Number,
  note: Schema.String,
  repeatEveryMs: Schema.NullOr(Schema.Number),
  status: FollowUpStatus,
  submissionId: Schema.NullOr(Schema.String),
  firedAt: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdBy: Schema.Literals(['you', 'vivid'] as const),
  createdAt: Schema.Number,
}).annotate({ identifier: 'FollowUp', title: 'Follow-up' })
/** Decoded follow-up. */
export interface FollowUp extends Schema.Schema.Type<typeof FollowUp> {}

/** Manual origin for a Task. */
const ManualTaskOrigin = Schema.Struct({ kind: Schema.Literal('manual') })
/** Thread origin for a Task. */
const ThreadTaskOrigin = Schema.Struct({
  kind: Schema.Literal('conversation'),
  conversationId: ThreadId,
})
/** Routine origin for a Task. */
const RoutineTaskOrigin = Schema.Struct({ kind: Schema.Literal('routine'), routineId: RoutineId })
/** Closed Task origin variants used by the runtime wire. */
export const TaskOrigin = Schema.Union([ManualTaskOrigin, ThreadTaskOrigin, RoutineTaskOrigin])
/** Decoded Task origin. */
export type TaskOrigin = typeof TaskOrigin.Type

/** Task projection returned to web and mobile. */
export const Task = Schema.Struct({
  id: TaskId,
  title: Schema.String,
  detail: Schema.String,
  status: TaskStatus,
  priority: TaskPriority,
  assignee: Schema.NullOr(Schema.String),
  dueAt: Schema.NullOr(Schema.Number),
  origin: TaskOrigin,
  createdBy: Schema.Literals(['you', 'vivid'] as const),
  conversationId: ThreadId,
  overdueNotifiedAt: Schema.NullOr(Schema.Number),
  completedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  followUps: Schema.Array(FollowUp),
  nextFollowUpAt: Schema.NullOr(Schema.Number),
}).annotate({ identifier: 'Task', title: 'Task' })
/** Decoded Task projection. */
export interface Task extends Schema.Schema.Type<typeof Task> {}

/** Follow-up values accepted while creating or rescheduling one. */
export const FollowUpInput = Schema.Struct({
  id: Schema.optionalKey(FollowUpId),
  at: TimestampInput,
  note: Schema.optionalKey(Schema.String),
  repeatEveryMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}).annotate({ identifier: 'FollowUpInput', title: 'Follow-up input' })
/** Decoded follow-up input. */
export interface FollowUpInput extends Schema.Schema.Type<typeof FollowUpInput> {}

/** Input accepted when creating a Task. */
export const CreateTaskRequest = Schema.Struct({
  id: Schema.optionalKey(TaskId),
  threadId: Schema.optionalKey(ThreadId),
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dueAt: Schema.optionalKey(Schema.NullOr(TimestampInput)),
  priority: Schema.optionalKey(TaskPriority),
  followUp: Schema.optionalKey(FollowUpInput),
}).annotate({ identifier: 'CreateTaskRequest', title: 'Create Task request' })
/** Decoded Task creation input. */
export interface CreateTaskRequest extends Schema.Schema.Type<typeof CreateTaskRequest> {}

/** Fields accepted by the Task PATCH route. */
export const PatchTaskRequest = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dueAt: Schema.optionalKey(Schema.NullOr(TimestampInput)),
  priority: Schema.optionalKey(TaskPriority),
  status: Schema.optionalKey(TaskStatus),
}).annotate({ identifier: 'PatchTaskRequest', title: 'Patch Task request' })
/** Decoded Task patch input. */
export interface PatchTaskRequest extends Schema.Schema.Type<typeof PatchTaskRequest> {}

/** Task path parameters. */
export const TaskParams = Schema.Struct({ id: TaskId })
/** Follow-up path parameters. */
export const FollowUpParams = Schema.Struct({ id: FollowUpId })
/** Optional Task status filter. */
export const TaskListQuery = Schema.Struct({ status: Schema.optionalKey(TaskStatus) })
/** Optional note accepted by the immediate Task nudge route. */
export const NudgeTaskRequest = Schema.Struct({ note: Schema.optionalKey(Schema.String) })
/** Follow-up patch fields accepted by the runtime. */
export const PatchFollowUpRequest = Schema.Struct({
  at: Schema.optionalKey(TimestampInput),
  note: Schema.optionalKey(Schema.String),
  repeatEveryMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  status: Schema.optionalKey(Schema.Literals(['scheduled', 'cancelled'] as const)),
})
/** List response for Tasks. */
export const TaskListResponse = Schema.Struct({ tasks: Schema.Array(Task) })
/** Single Task response. */
export const TaskResponse = Schema.Struct({ task: Task })
/** Task plus follow-up response. */
export const FollowUpResponse = Schema.Struct({ followUp: FollowUp, task: Task })
