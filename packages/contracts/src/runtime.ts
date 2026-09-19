import { Schema } from "effect"

/** Creates a branded identifier schema for one Vivid ownership boundary. */
const identifier = <Name extends string>(name: Name) => Schema.String.pipe(Schema.brand(name))

/** Durable Thread identifier used by collaboration and Flue transport routes. */
export const ThreadId = identifier("ThreadId")
/** Decoded Thread identifier. */
export type ThreadId = typeof ThreadId.Type
/** Durable Task identifier. */
export const TaskId = identifier("TaskId")
/** Decoded Task identifier. */
export type TaskId = typeof TaskId.Type
/** Durable follow-up identifier. */
export const FollowUpId = identifier("FollowUpId")
/** Decoded follow-up identifier. */
export type FollowUpId = typeof FollowUpId.Type
/** Durable notification identifier. */
export const NotificationId = identifier("NotificationId")
/** Decoded notification identifier. */
export type NotificationId = typeof NotificationId.Type
/** Durable Routine identifier. */
export const RoutineId = identifier("RoutineId")
/** Decoded Routine identifier. */
export type RoutineId = typeof RoutineId.Type
/** Durable Routine occurrence identifier. */
export const OccurrenceId = identifier("OccurrenceId")
/** Decoded Routine occurrence identifier. */
export type OccurrenceId = typeof OccurrenceId.Type
/** Durable Library item identifier. */
export const LibraryItemId = identifier("LibraryItemId")
/** Decoded Library item identifier. */
export type LibraryItemId = typeof LibraryItemId.Type
/** Durable Library folder identifier. */
export const LibraryFolderId = identifier("LibraryFolderId")
/** Decoded Library folder identifier. */
export type LibraryFolderId = typeof LibraryFolderId.Type
/** Supported external Connection identifier. */
export const ConnectionId = Schema.Literals(["gmail", "calendar", "drive"] as const)
/** Decoded Connection identifier. */
export type ConnectionId = typeof ConnectionId.Type

/** Closed Thread lifecycle values encoded by the current HTTP protocol. */
export const ThreadStatus = Schema.Literals(["active", "archived"] as const)
/** Closed Task lifecycle values encoded by the current HTTP protocol. */
export const TaskStatus = Schema.Literals(["open", "done", "dropped"] as const)
/** Closed Task priority values encoded by the current HTTP protocol. */
export const TaskPriority = Schema.Literals(["normal", "urgent"] as const)
/** Closed follow-up lifecycle values encoded by the current HTTP protocol. */
export const FollowUpStatus = Schema.Literals(["scheduled", "running", "fired", "failed", "cancelled"] as const)
/** Closed notification variants encoded by the current HTTP protocol. */
export const NotificationKind = Schema.Literals(["tracked", "overdue", "follow-up", "follow-up-failed"] as const)
/** Closed Routine occurrence lifecycle values encoded by the current HTTP protocol. */
export const OccurrenceStatus = Schema.Literals(["running", "succeeded", "failed"] as const)
/** Closed Library processing lifecycle values encoded by the current HTTP protocol. */
export const LibraryItemStatus = Schema.Literals(["processing", "ready", "failed"] as const)
/** Closed Connection lifecycle values encoded by the current HTTP protocol. */
export const ConnectionStatus = Schema.Literals(["disconnected", "connecting", "connected", "error"] as const)

/** Thread summary exchanged by web, mobile, and the conversation runtime. */
export const Thread = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  preview: Schema.String,
  updatedAt: Schema.Number,
  archived: Schema.Boolean,
}).annotate({ identifier: "Thread", title: "Thread" })
/** Decoded Thread summary. */
export interface Thread extends Schema.Schema.Type<typeof Thread> {}

/** Complete replacement input for a Thread summary. */
export const PutThreadRequest = Schema.Struct({
  title: Schema.String,
  preview: Schema.String,
  updatedAt: Schema.optionalKey(Schema.Number),
  archived: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "PutThreadRequest", title: "Put Thread request" })
/** Decoded Thread replacement input. */
export interface PutThreadRequest extends Schema.Schema.Type<typeof PutThreadRequest> {}

/** Partial Thread fields accepted by the current PATCH route. */
export const PatchThreadRequest = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "PatchThreadRequest", title: "Patch Thread request" })
/** Decoded Thread patch input. */
export interface PatchThreadRequest extends Schema.Schema.Type<typeof PatchThreadRequest> {}

/** Thread path parameters used by conversation routes. */
export const ThreadParams = Schema.Struct({ id: ThreadId })
/** List response for Threads. */
export const ThreadListResponse = Schema.Struct({ conversations: Schema.Array(Thread) })
/** Decoded Thread list response. */
export interface ThreadListResponse extends Schema.Schema.Type<typeof ThreadListResponse> {}
/** Single Thread response. */
export const ThreadResponse = Schema.Struct({ conversation: Thread })
/** Decoded single Thread response. */
export interface ThreadResponse extends Schema.Schema.Type<typeof ThreadResponse> {}

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
  createdBy: Schema.Literals(["you", "vivid"] as const),
  createdAt: Schema.Number,
}).annotate({ identifier: "FollowUp", title: "Follow-up" })
/** Decoded follow-up. */
export interface FollowUp extends Schema.Schema.Type<typeof FollowUp> {}

/** Manual origin for a Task. */
const ManualTaskOrigin = Schema.Struct({ kind: Schema.Literal("manual") })
/** Thread origin for a Task. */
const ThreadTaskOrigin = Schema.Struct({ kind: Schema.Literal("conversation"), conversationId: ThreadId })
/** Routine origin for a Task. */
const RoutineTaskOrigin = Schema.Struct({ kind: Schema.Literal("routine"), routineId: RoutineId })
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
  createdBy: Schema.Literals(["you", "vivid"] as const),
  conversationId: ThreadId,
  overdueNotifiedAt: Schema.NullOr(Schema.Number),
  completedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  followUps: Schema.Array(FollowUp),
  nextFollowUpAt: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Task", title: "Task" })
/** Decoded Task projection. */
export interface Task extends Schema.Schema.Type<typeof Task> {}

/** Follow-up values accepted while creating or rescheduling one. */
export const FollowUpInput = Schema.Struct({
  at: TimestampInput,
  note: Schema.optionalKey(Schema.String),
  repeatEveryMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}).annotate({ identifier: "FollowUpInput", title: "Follow-up input" })
/** Decoded follow-up input. */
export interface FollowUpInput extends Schema.Schema.Type<typeof FollowUpInput> {}

/** Input accepted when creating a Task. */
export const CreateTaskRequest = Schema.Struct({
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dueAt: Schema.optionalKey(Schema.NullOr(TimestampInput)),
  priority: Schema.optionalKey(TaskPriority),
  followUp: Schema.optionalKey(FollowUpInput),
}).annotate({ identifier: "CreateTaskRequest", title: "Create Task request" })
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
}).annotate({ identifier: "PatchTaskRequest", title: "Patch Task request" })
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
  status: Schema.optionalKey(Schema.Literals(["scheduled", "cancelled"] as const)),
})
/** List response for Tasks. */
export const TaskListResponse = Schema.Struct({ tasks: Schema.Array(Task) })
/** Single Task response. */
export const TaskResponse = Schema.Struct({ task: Task })
/** Task plus follow-up response. */
export const FollowUpResponse = Schema.Struct({ followUp: FollowUp, task: Task })

/** Durable notification returned by the runtime. */
export const Notification = Schema.Struct({
  id: NotificationId,
  kind: NotificationKind,
  title: Schema.String,
  body: Schema.String,
  taskId: Schema.NullOr(TaskId),
  conversationId: Schema.NullOr(ThreadId),
  createdAt: Schema.Number,
  readAt: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Notification", title: "Notification" })
/** Decoded notification. */
export interface Notification extends Schema.Schema.Type<typeof Notification> {}
/** Input for marking selected or all notifications read. */
export const ReadNotificationsRequest = Schema.Struct({ ids: Schema.optionalKey(Schema.Array(NotificationId)) })
/** Notification list response. */
export const NotificationListResponse = Schema.Struct({
  notifications: Schema.Array(Notification),
  unreadCount: Schema.Number,
})
/** Notification mutation response. */
export const NotificationReadResponse = Schema.Struct({ changed: Schema.Number, unreadCount: Schema.Number })

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
}).annotate({ identifier: "Occurrence", title: "Routine occurrence" })
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
}).annotate({ identifier: "Routine", title: "Routine" })
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

/** Library item metadata returned by list and mutation routes. */
export const LibraryItem = Schema.Struct({
  id: LibraryItemId,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  status: LibraryItemStatus,
  error: Schema.NullOr(Schema.String),
  preview: Schema.String,
  chunkCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  folderId: Schema.NullOr(LibraryFolderId),
}).annotate({ identifier: "LibraryItem", title: "Library item" })
/** Decoded Library item. */
export interface LibraryItem extends Schema.Schema.Type<typeof LibraryItem> {}

/** Recursive Library folder metadata returned by the runtime. */
export const LibraryFolder = Schema.Struct({
  id: LibraryFolderId,
  name: Schema.String,
  parentId: Schema.NullOr(LibraryFolderId),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  itemCount: Schema.Number,
}).annotate({ identifier: "LibraryFolder", title: "Library folder" })
/** Decoded Library folder. */
export interface LibraryFolder extends Schema.Schema.Type<typeof LibraryFolder> {}

/** One ranked Library search match. */
export const LibrarySearchResult = Schema.Struct({
  chunkId: Schema.String,
  documentId: LibraryItemId,
  filename: Schema.String,
  page: Schema.NullOr(Schema.Number),
  text: Schema.String,
  score: Schema.Number,
})
/** Optional folder filter for Library list routes. */
export const LibraryListQuery = Schema.Struct({ folderId: Schema.optionalKey(LibraryFolderId) })
/** Source-name query for Library content lookup. */
export const LibrarySourceQuery = Schema.Struct({ name: Schema.String })
/** Library item path parameters. */
export const LibraryItemParams = Schema.Struct({ id: LibraryItemId })
/** Library folder path parameters. */
export const LibraryFolderParams = Schema.Struct({ id: LibraryFolderId })
/** Library list response. */
export const LibraryListResponse = Schema.Struct({
  documents: Schema.Array(LibraryItem),
  folders: Schema.Array(LibraryFolder),
})
/** Single Library item response. */
export const LibraryItemResponse = Schema.Struct({ document: LibraryItem })
/** Single Library folder response. */
export const LibraryFolderResponse = Schema.Struct({ folder: LibraryFolder })
/** Library folder list response. */
export const LibraryFolderListResponse = Schema.Struct({ folders: Schema.Array(LibraryFolder) })
/** Decoded metadata extracted from a multipart Library upload. */
export const LibraryUploadMetadata = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.Literals(["application/pdf", "text/markdown", "text/plain"] as const),
  size: Schema.Number,
  folderId: Schema.NullOr(LibraryFolderId),
})
/** Library upload response. */
export const LibraryUploadResponse = Schema.Struct({
  document: LibraryItem,
  duplicate: Schema.optionalKey(Schema.Boolean),
})
/** Library search request. */
export const LibrarySearchRequest = Schema.Struct({
  query: Schema.String,
  folderId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
  limit: Schema.optionalKey(Schema.Number),
})
/** Library search response. */
export const LibrarySearchResponse = Schema.Struct({ results: Schema.Array(LibrarySearchResult) })
/** Library folder creation request. */
export const CreateLibraryFolderRequest = Schema.Struct({
  name: Schema.String,
  parentId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
})
/** Library folder patch request. */
export const PatchLibraryFolderRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  parentId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
})
/** Library item patch request. */
export const PatchLibraryItemRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  folderId: Schema.optionalKey(Schema.NullOr(LibraryFolderId)),
})

/** External Connection metadata shown by clients. */
export const Connection = Schema.Struct({
  id: ConnectionId,
  status: ConnectionStatus,
  metadata: Schema.Struct({
    id: ConnectionId,
    name: Schema.String,
    description: Schema.String,
    icon: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
}).annotate({ identifier: "Connection", title: "Connection" })
/** Decoded external Connection metadata. */
export interface Connection extends Schema.Schema.Type<typeof Connection> {}
/** Connection path parameters. */
export const ConnectionParams = Schema.Struct({ id: ConnectionId })
/** OAuth callback query returned by Google. */
export const ConnectionCallbackQuery = Schema.Struct({
  code: Schema.String,
  state: Schema.optionalKey(Schema.String),
})
/** Signed state payload carried through the OAuth redirect. */
export const ConnectionCallbackState = Schema.Struct({ connector: ConnectionId, nonce: Schema.String })
/** Connection list response. */
export const ConnectionListResponse = Schema.Struct({ connectors: Schema.Array(Connection) })
/** Connection authorization response. */
export const ConnectionAuthorizationResponse = Schema.Struct({ authUrl: Schema.String })
/** Connection deletion response. */
export const ConnectionDeletionResponse = Schema.Struct({ success: Schema.Boolean, deleted: Schema.Number })

/** Runtime message requesting authorization for one external Connection. */
export const ConnectionRequestMessage = Schema.Struct({
  kind: Schema.Literal("connector-request"),
  connector: ConnectionId,
  reason: Schema.String,
}).annotate({ identifier: "ConnectionRequestMessage", title: "Connection request message" })
/** Decoded Connection request message. */
export interface ConnectionRequestMessage extends Schema.Schema.Type<typeof ConnectionRequestMessage> {}

/** Existing runtime error envelope retained on the HTTP wire. */
export const RuntimeErrorResponse = Schema.Struct({ error: Schema.String })
/** Empty successful response used by 204 routes. */
export const EmptyResponse = Schema.Void
