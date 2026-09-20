import { VividRpcClient } from '@vivid/client-runtime'
import { FollowUpId, NotificationId, TaskId } from '@vivid/contracts'
import type {
  CreateTaskRequest,
  FollowUp,
  FollowUpInput as FollowUpInputContract,
  Notification,
  Task,
} from '@vivid/contracts'
import { Effect } from 'effect'
import type { Program as RuntimeProgram } from './runtime'

export type Program<Value> = RuntimeProgram<Value>
export type TaskStatus = Task['status']
export type TaskPriority = Task['priority']
export type TaskInput = Pick<
  CreateTaskRequest,
  'title' | 'detail' | 'assignee' | 'dueAt' | 'priority'
>
export type FollowUpInput = FollowUpInputContract
export type { FollowUp, Notification, Task }

const makeTaskId = (id: string) => TaskId.make(id)
const notificationId = (id: string) => NotificationId.make(id)

/** Loads the task and notification snapshots shown by Today. */
export const load = Effect.fn('Tasks.load')(function* () {
  const client = yield* VividRpcClient
  const [taskBody, notificationBody] = yield* Effect.all([
    client.ListTasks({}),
    client.ListNotifications(),
  ])
  return { tasks: [...taskBody.tasks], notifications: [...notificationBody.notifications] }
})

/** Updates one task's open/done state. */
export const setStatus = Effect.fn('Tasks.setStatus')(function* (id: string, status: TaskStatus) {
  const client = yield* VividRpcClient
  yield* client.PatchTask({ id: makeTaskId(id), patch: { status } })
})

/** Marks every current notification read. */
export const markAllNotificationsRead = Effect.fn('Tasks.markAllNotificationsRead')(function* () {
  const client = yield* VividRpcClient
  yield* client.ReadNotifications({})
})

/** Marks one opened notification read without delaying navigation. */
export const markNotificationRead = Effect.fn('Tasks.markNotificationRead')(function* (id: string) {
  const client = yield* VividRpcClient
  yield* client.ReadNotifications({ ids: [notificationId(id)] })
})

/** Creates one manual task and an optional first follow-up. */
export const create = Effect.fn('Tasks.create')(function* (
  input: TaskInput,
  followUp: FollowUpInput | null,
) {
  const client = yield* VividRpcClient
  const response = yield* client.CreateTask(followUp === null ? input : { ...input, followUp })
  return response.task
})

/** Updates the editable fields of one task. */
export const update = Effect.fn('Tasks.update')(function* (id: string, input: TaskInput) {
  const client = yield* VividRpcClient
  const response = yield* client.PatchTask({ id: makeTaskId(id), patch: input })
  return response.task
})

/** Starts Vivid's immediate follow-up for one task. */
export const nudge = Effect.fn('Tasks.nudge')(function* (id: string) {
  const client = yield* VividRpcClient
  yield* client.NudgeTask({ id: makeTaskId(id), nudge: {} })
})

/** Permanently deletes one task and its follow-ups. */
export const remove = Effect.fn('Tasks.remove')(function* (id: string) {
  const client = yield* VividRpcClient
  yield* client.DeleteTask({ id: makeTaskId(id) })
})

/** Adds one scheduled follow-up to a task. */
export const addFollowUp = Effect.fn('Tasks.addFollowUp')(function* (
  taskIdValue: string,
  input: FollowUpInput,
) {
  const client = yield* VividRpcClient
  yield* client.AddFollowUp({ taskId: makeTaskId(taskIdValue), followUp: input })
})

/** Runs one follow-up immediately. */
export const runFollowUp = Effect.fn('Tasks.runFollowUp')(function* (id: string) {
  const client = yield* VividRpcClient
  yield* client.RunFollowUp({ id: FollowUpId.make(id) })
})

/** Cancels one scheduled follow-up. */
export const cancelFollowUp = Effect.fn('Tasks.cancelFollowUp')(function* (id: string) {
  const client = yield* VividRpcClient
  yield* client.PatchFollowUp({ id: FollowUpId.make(id), patch: { status: 'cancelled' } })
})

/** Deletes one follow-up. */
export const removeFollowUp = Effect.fn('Tasks.removeFollowUp')(function* (id: string) {
  const client = yield* VividRpcClient
  yield* client.DeleteFollowUp({ id: FollowUpId.make(id) })
})
