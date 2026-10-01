import * as Effect from 'effect/Effect'
import {
  FollowUpResponse,
  TaskListResponse,
  TaskResponse,
  type CreateTaskRequest,
  type FollowUpId,
  type FollowUpInput,
  type NudgeTaskRequest,
  type PatchFollowUpRequest,
  type PatchTaskRequest,
  type TaskId,
  type TaskListQuery,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { changed, Topic } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { FollowUps } from './followups.ts'
import { TaskStore } from './store.ts'

/** List and Watch use one loader and therefore one workspace access policy. */
const loadTasks = Effect.fn('Tasks.load')(function* (
  actor: Actor,
  query: typeof TaskListQuery.Type,
) {
  return TaskListResponse.make({ tasks: yield* (yield* TaskStore).list(actor, query) })
})

export const taskHandlers = {
  ListTasks: Effect.fn('Rpc.ListTasks')(function* (query: typeof TaskListQuery.Type) {
    return yield* loadTasks(yield* requireActor(), query)
  }),
  /** The subscription follows workspace switches and membership removal. */
  WatchTasks: (query: typeof TaskListQuery.Type) => live((actor) => loadTasks(actor, query)),
  /** Attribution is taken from the Actor, never from mutation input. */
  CreateTask: Effect.fn('Rpc.CreateTask')(function* (request: CreateTaskRequest) {
    const actor = yield* requireActor()
    const task = yield* (yield* TaskStore).create(actor, request)
    yield* changed(actor, Topic.thread(task.threadId))
    return TaskResponse.make({ task })
  }),
  /** Publish the reporting Thread as well as the caller's workspace after editing. */
  PatchTask: Effect.fn('Rpc.PatchTask')(function* ({
    id,
    patch,
  }: {
    id: TaskId
    patch: PatchTaskRequest
  }) {
    const actor = yield* requireActor()
    const task = yield* (yield* TaskStore).patch(actor, id, patch)
    yield* changed(actor, Topic.thread(task.threadId))
    return TaskResponse.make({ task })
  }),
  /** The store enforces creator-or-assignee deletion. */
  DeleteTask: Effect.fn('Rpc.DeleteTask')(function* ({ id }: { id: TaskId }) {
    const actor = yield* requireActor()
    const store = yield* TaskStore
    const task = yield* store.get(actor, id)
    yield* store.remove(actor, id)
    yield* changed(actor, Topic.thread(task.threadId))
  }),
  /** An immediate nudge uses the same Conversation delivery path as scheduled work. */
  NudgeTask: Effect.fn('Rpc.NudgeTask')(function* ({
    id,
    nudge,
  }: {
    id: TaskId
    nudge: typeof NudgeTaskRequest.Type
  }) {
    const actor = yield* requireActor()
    yield* (yield* FollowUps).nudge(actor, id, nudge)
    yield* changed(actor)
    return TaskResponse.make({ task: yield* (yield* TaskStore).get(actor, id) })
  }),
  /** Follow-up creation inherits its Task's visibility and reports the updated projection. */
  AddFollowUp: Effect.fn('Rpc.AddFollowUp')(function* ({
    taskId,
    followUp,
  }: {
    taskId: TaskId
    followUp: FollowUpInput
  }) {
    const actor = yield* requireActor()
    const store = yield* TaskStore
    const created = yield* store.addFollowUp(actor, taskId, followUp)
    yield* changed(actor)
    return FollowUpResponse.make({ followUp: created, task: yield* store.get(actor, taskId) })
  }),
  /** A payload id cannot edit a follow-up on an invisible Task. */
  PatchFollowUp: Effect.fn('Rpc.PatchFollowUp')(function* ({
    id,
    patch,
  }: {
    id: FollowUpId
    patch: typeof PatchFollowUpRequest.Type
  }) {
    const actor = yield* requireActor()
    const store = yield* TaskStore
    const followUp = yield* store.patchFollowUp(actor, id, patch)
    yield* changed(actor)
    return FollowUpResponse.make({ followUp, task: yield* store.get(actor, followUp.taskId) })
  }),
  /** Removal is scoped at the store boundary and then wakes live queries. */
  DeleteFollowUp: Effect.fn('Rpc.DeleteFollowUp')(function* ({ id }: { id: FollowUpId }) {
    const actor = yield* requireActor()
    yield* (yield* TaskStore).removeFollowUp(actor, id)
    yield* changed(actor)
  }),
  /** The store claims and delivers as the Task's owner, even for a different visible Member. */
  RunFollowUp: Effect.fn('Rpc.RunFollowUp')(function* ({ id }: { id: FollowUpId }) {
    const actor = yield* requireActor()
    const followUp = yield* (yield* FollowUps).run(actor, id)
    yield* changed(actor)
    return FollowUpResponse.make({
      followUp,
      task: yield* (yield* TaskStore).get(actor, followUp.taskId),
    })
  }),
}
