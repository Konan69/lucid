import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as RpcMiddleware from 'effect/unstable/rpc/RpcMiddleware'
import {
  Conflict,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  Forbidden,
  NotFound,
  Unauthenticated,
} from './index.js'
import {
  ConnectionDeletionResponse,
  ConnectionId,
  ConnectionListResponse,
  CreateLibraryFolderRequest,
  CreateRoutineRequest,
  CreateTaskRequest,
  FollowUpId,
  FollowUpInput,
  FollowUpResponse,
  LibraryFolderId,
  LibraryFolderListResponse,
  LibraryFolderResponse,
  LibraryItemId,
  LibraryItemResponse,
  LibraryListQuery,
  LibraryListResponse,
  LibrarySearchRequest,
  LibrarySearchResponse,
  NotificationListResponse,
  NotificationReadResponse,
  NudgeTaskRequest,
  OccurrenceResponse,
  PatchFollowUpRequest,
  PatchLibraryFolderRequest,
  PatchLibraryItemRequest,
  PatchRoutineRequest,
  PatchTaskRequest,
  PatchThreadRequest,
  PutThreadRequest,
  ReadNotificationsRequest,
  RoutineId,
  RoutineListResponse,
  RoutineResponse,
  TaskId,
  TaskListQuery,
  TaskListResponse,
  TaskResponse,
  ThreadId,
  ThreadListResponse,
  ThreadResponse,
} from './runtime.js'
import { AuthContext } from './api.js'

/**
 * Every product call a Vivid client makes to the application server, declared once.
 *
 * The server implements this group; web, mobile, desktop and the Flue runtime's tools all derive
 * their client from it with `RpcClient.make(VividRpc)`. No client writes a path, a method, a
 * response type or a status check by hand, so a changed payload or a renamed call is a compile
 * error in every consumer.
 *
 * Only three kinds of route stay plain HTTP, because a browser or a third party calls them
 * without our client: Better Auth (`/api/auth/*`), the OAuth callback a provider redirects to, and
 * byte transfer (Library upload, and the source and content links a Person opens in a tab). Flue
 * keeps its own conversation transport.
 */

/** The request was well-formed wire data but breaks a domain rule, such as an invalid schedule. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  'InvalidRequest',
  { message: Schema.String },
  { title: 'Invalid request' },
) {}

/** Vivid's runtime could not accept the work the server tried to start. */
export class RuntimeUnavailable extends Schema.TaggedError<RuntimeUnavailable>()(
  'RuntimeUnavailable',
  { message: Schema.String },
  { title: 'Runtime unavailable' },
) {}

/** Every failure a product call can return. Clients branch on `_tag`, never on a message. */
export const RpcFailure = Schema.Union([
  Unauthenticated,
  Forbidden,
  NotFound,
  Conflict,
  InvalidRequest,
  RuntimeUnavailable,
  DatabaseConstraintViolation,
  DatabaseUnavailable,
  DatabaseFailure,
])
export type RpcFailure = typeof RpcFailure.Type

/** Authenticates every RPC and provides the same request-local context as `VividApi`. */
export class RpcAuthMiddleware extends RpcMiddleware.Service<
  RpcAuthMiddleware,
  { provides: AuthContext; requires: never }
>()('vivid/RpcAuthMiddleware', { error: RpcFailure }) {}

const call = { error: RpcFailure } as const

// ── Threads ────────────────────────────────────────────────────────────────
const ListThreads = Rpc.make('ListThreads', { ...call, success: ThreadListResponse })
const PutThread = Rpc.make('PutThread', {
  ...call,
  payload: { id: ThreadId, thread: PutThreadRequest },
  success: ThreadResponse,
})
const PatchThread = Rpc.make('PatchThread', {
  ...call,
  payload: { id: ThreadId, patch: PatchThreadRequest },
  success: ThreadResponse,
})
const DeleteThread = Rpc.make('DeleteThread', { ...call, payload: { id: ThreadId } })

// ── Tasks and follow-ups ───────────────────────────────────────────────────
const ListTasks = Rpc.make('ListTasks', {
  ...call,
  payload: TaskListQuery,
  success: TaskListResponse,
})
const CreateTask = Rpc.make('CreateTask', {
  ...call,
  payload: CreateTaskRequest,
  success: TaskResponse,
})
const PatchTask = Rpc.make('PatchTask', {
  ...call,
  payload: { id: TaskId, patch: PatchTaskRequest },
  success: TaskResponse,
})
const DeleteTask = Rpc.make('DeleteTask', { ...call, payload: { id: TaskId } })
/** Ask Vivid to chase a Task now, outside its scheduled follow-ups. */
const NudgeTask = Rpc.make('NudgeTask', {
  ...call,
  payload: { id: TaskId, nudge: NudgeTaskRequest },
  success: TaskResponse,
})
const AddFollowUp = Rpc.make('AddFollowUp', {
  ...call,
  payload: { taskId: TaskId, followUp: FollowUpInput },
  success: FollowUpResponse,
})
const PatchFollowUp = Rpc.make('PatchFollowUp', {
  ...call,
  payload: { id: FollowUpId, patch: PatchFollowUpRequest },
  success: FollowUpResponse,
})
const DeleteFollowUp = Rpc.make('DeleteFollowUp', { ...call, payload: { id: FollowUpId } })
const RunFollowUp = Rpc.make('RunFollowUp', {
  ...call,
  payload: { id: FollowUpId },
  success: FollowUpResponse,
})

// ── Notifications ──────────────────────────────────────────────────────────
const ListNotifications = Rpc.make('ListNotifications', {
  ...call,
  success: NotificationListResponse,
})
const ReadNotifications = Rpc.make('ReadNotifications', {
  ...call,
  payload: ReadNotificationsRequest,
  success: NotificationReadResponse,
})

// ── Routines ───────────────────────────────────────────────────────────────
const ListRoutines = Rpc.make('ListRoutines', { ...call, success: RoutineListResponse })
const CreateRoutine = Rpc.make('CreateRoutine', {
  ...call,
  payload: CreateRoutineRequest,
  success: RoutineResponse,
})
const PatchRoutine = Rpc.make('PatchRoutine', {
  ...call,
  payload: { id: RoutineId, patch: PatchRoutineRequest },
  success: RoutineResponse,
})
const DeleteRoutine = Rpc.make('DeleteRoutine', { ...call, payload: { id: RoutineId } })
/** Start one Occurrence now, outside the Routine's schedule. */
const RunRoutine = Rpc.make('RunRoutine', {
  ...call,
  payload: { id: RoutineId },
  success: OccurrenceResponse,
})

// ── Library (metadata; bytes travel over plain HTTP) ───────────────────────
const ListLibrary = Rpc.make('ListLibrary', {
  ...call,
  payload: LibraryListQuery,
  success: LibraryListResponse,
})
const GetLibraryItem = Rpc.make('GetLibraryItem', {
  ...call,
  payload: { id: LibraryItemId },
  success: LibraryItemResponse,
})
const PatchLibraryItem = Rpc.make('PatchLibraryItem', {
  ...call,
  payload: { id: LibraryItemId, patch: PatchLibraryItemRequest },
  success: LibraryItemResponse,
})
const DeleteLibraryItem = Rpc.make('DeleteLibraryItem', {
  ...call,
  payload: { id: LibraryItemId },
})
const SearchLibrary = Rpc.make('SearchLibrary', {
  ...call,
  payload: LibrarySearchRequest,
  success: LibrarySearchResponse,
})
const ListLibraryFolders = Rpc.make('ListLibraryFolders', {
  ...call,
  success: LibraryFolderListResponse,
})
const CreateLibraryFolder = Rpc.make('CreateLibraryFolder', {
  ...call,
  payload: CreateLibraryFolderRequest,
  success: LibraryFolderResponse,
})
const PatchLibraryFolder = Rpc.make('PatchLibraryFolder', {
  ...call,
  payload: { id: LibraryFolderId, patch: PatchLibraryFolderRequest },
  success: LibraryFolderResponse,
})
const DeleteLibraryFolder = Rpc.make('DeleteLibraryFolder', {
  ...call,
  payload: { id: LibraryFolderId },
})

// ── Connections (authorization itself is a browser redirect over HTTP) ─────
const ListConnections = Rpc.make('ListConnections', { ...call, success: ConnectionListResponse })
const DeleteConnection = Rpc.make('DeleteConnection', {
  ...call,
  payload: { id: ConnectionId },
  success: ConnectionDeletionResponse,
})
/** Executes a named Connection action while credential values remain inside the server. */
const ExecuteConnectionTool = Rpc.make('ExecuteConnectionTool', {
  ...call,
  payload: { connector: ConnectionId, tool: Schema.String, input: Schema.Json },
  success: Schema.Struct({ output: Schema.Json }),
})

export const VividRpc = RpcGroup.make(
  ListThreads,
  PutThread,
  PatchThread,
  DeleteThread,
  ListTasks,
  CreateTask,
  PatchTask,
  DeleteTask,
  NudgeTask,
  AddFollowUp,
  PatchFollowUp,
  DeleteFollowUp,
  RunFollowUp,
  ListNotifications,
  ReadNotifications,
  ListRoutines,
  CreateRoutine,
  PatchRoutine,
  DeleteRoutine,
  RunRoutine,
  ListLibrary,
  GetLibraryItem,
  PatchLibraryItem,
  DeleteLibraryItem,
  SearchLibrary,
  ListLibraryFolders,
  CreateLibraryFolder,
  PatchLibraryFolder,
  DeleteLibraryFolder,
  ListConnections,
  DeleteConnection,
  ExecuteConnectionTool,
).middleware(RpcAuthMiddleware)
