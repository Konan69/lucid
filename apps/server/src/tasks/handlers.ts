import * as Effect from 'effect/Effect'
import {
  FollowUpResponse,
  NotFound,
  RoutineId,
  TaskListResponse,
  TaskResponse,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/api'
import { FollowUps } from './followups.ts'
import { TaskStore } from './store.ts'

const withTask = Effect.fn('TaskHandlers.withTask')(function* (store: TaskStore['Service'], id) {
  const task = yield* store.get(id)
  return task === undefined ? yield* Effect.fail(new NotFound({ message: 'Task not found' })) : task
})

export const taskHandlers = {
  ListTasks: Effect.fn('Rpc.ListTasks')(function* ({ status }) {
    const store = yield* TaskStore
    return TaskListResponse.make({ tasks: yield* store.list(status) })
  }),
  CreateTask: Effect.fn('Rpc.CreateTask')(function* (request) {
    const store = yield* TaskStore
    const auth = yield* AuthContext
    const runtime = AuthState.$is('Runtime')(auth)
    const origin =
      runtime && request.threadId !== undefined
        ? request.threadId.startsWith('routine-')
          ? {
              kind: 'routine' as const,
              routineId: RoutineId.make(request.threadId.slice('routine-'.length)),
            }
          : { kind: 'conversation' as const, conversationId: request.threadId }
        : { kind: 'manual' as const }
    return TaskResponse.make({
      task: yield* store.create({ request, origin, createdBy: runtime ? 'vivid' : 'you' }),
    })
  }),
  PatchTask: Effect.fn('Rpc.PatchTask')(function* ({ id, patch }) {
    const store = yield* TaskStore
    const task = yield* store.patch(id, patch)
    if (task === undefined) return yield* Effect.fail(new NotFound({ message: 'Task not found' }))
    return TaskResponse.make({ task })
  }),
  DeleteTask: Effect.fn('Rpc.DeleteTask')(function* ({ id }) {
    const store = yield* TaskStore
    if (!(yield* store.remove(id)))
      return yield* Effect.fail(new NotFound({ message: 'Task not found' }))
  }),
  NudgeTask: Effect.fn('Rpc.NudgeTask')(function* ({ id, nudge }) {
    const store = yield* TaskStore
    yield* withTask(store, id)
    const followUps = yield* FollowUps
    yield* followUps.nudge(id, nudge.note ?? '')
    return TaskResponse.make({ task: yield* withTask(store, id) })
  }),
  AddFollowUp: Effect.fn('Rpc.AddFollowUp')(function* ({ taskId, followUp }) {
    const store = yield* TaskStore
    const task = yield* withTask(store, taskId)
    const created = yield* store.addFollowUp(taskId, followUp, 'you')
    return FollowUpResponse.make({ followUp: created, task: (yield* store.get(task.id)) ?? task })
  }),
  PatchFollowUp: Effect.fn('Rpc.PatchFollowUp')(function* ({ id, patch }) {
    const store = yield* TaskStore
    const followUp = yield* store.patchFollowUp(id, patch)
    if (followUp === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Follow-up not found' }))
    return FollowUpResponse.make({ followUp, task: yield* withTask(store, followUp.taskId) })
  }),
  DeleteFollowUp: Effect.fn('Rpc.DeleteFollowUp')(function* ({ id }) {
    const store = yield* TaskStore
    if (!(yield* store.removeFollowUp(id)))
      return yield* Effect.fail(new NotFound({ message: 'Follow-up not found' }))
  }),
  RunFollowUp: Effect.fn('Rpc.RunFollowUp')(function* ({ id }) {
    const service = yield* FollowUps
    const followUp = yield* service.run(id)
    if (followUp === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Follow-up not found' }))
    const store = yield* TaskStore
    return FollowUpResponse.make({ followUp, task: yield* withTask(store, followUp.taskId) })
  }),
}
