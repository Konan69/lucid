import { defineTool } from '@flue/runtime'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  CreateTaskRequest,
  FollowUpId,
  FollowUpInput,
  PatchTaskRequest,
  TaskId,
  type AssigneeInput,
  type FollowUp,
  type Task,
  type ThreadId,
} from '@vivid/contracts'
import { RpcFailure } from '@vivid/contracts/rpc'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as v from 'valibot'
import { asActing, NobodyToActFor, type Acting } from '../client.ts'
import { assigneeName, resolveAssignee } from './assignees.ts'
import { operationId } from './identity.ts'
import { id, text } from './inputs.ts'
import { settle } from './result.ts'

const REPEAT_MS = { none: null, daily: 86_400_000, weekly: 7 * 86_400_000 } as const
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/iu
const when = v.pipe(
  v.string(),
  v.check(
    (value) => HAS_OFFSET.test(value) && Number.isFinite(Date.parse(value)),
    'Use an ISO date-time with a timezone offset.',
  ),
  v.description('ISO date-time including Z or a timezone offset.'),
)
const repeat = v.optional(
  v.pipe(
    v.picklist(['none', 'daily', 'weekly']),
    v.description('How often to repeat the follow-up.'),
  ),
  'none',
)
const priority = v.pipe(
  v.picklist(['normal', 'urgent']),
  v.description('Whether this work is urgent.'),
)
const status = v.pipe(
  v.picklist(['open', 'done', 'dropped']),
  v.description('The Task’s current state.'),
)
const createInput = v.object({
  title: v.pipe(
    text('The outcome to track, rather than the chase.', 200),
    v.trim(),
    v.minLength(2),
  ),
  detail: v.optional(v.pipe(v.string(), v.maxLength(2000), v.description('Details of the work.'))),
  assignee: v.optional(
    text('The name of who owes the work; me or you means the person asking.', 120),
  ),
  dueAt: v.optional(when),
  priority: v.optional(priority, 'normal'),
  followUpAt: v.optional(when),
  followUpNote: v.optional(
    v.pipe(v.string(), v.maxLength(500), v.description('What to check or chase.')),
  ),
  repeat,
})
const updateInput = v.object({
  id,
  status: v.optional(status),
  title: v.optional(v.pipe(text('The new outcome to track.', 200), v.trim(), v.minLength(2))),
  detail: v.optional(v.pipe(v.string(), v.maxLength(2000), v.description('Replacement details.'))),
  assignee: v.optional(v.nullable(text('The assignee name; null clears the assignee.', 120))),
  dueAt: v.optional(v.nullable(when)),
  priority: v.optional(priority),
})

/** Operation ids require a real Thread; missing attribution never supplies a fake identity. */
const requireActing = Effect.fn('Tools.requireActing')(function* (acting: Option.Option<Acting>) {
  return yield* Option.match(acting, {
    onNone: () =>
      Effect.fail(
        new NobodyToActFor({ message: 'There is no person behind this message to act for.' }),
      ),
    onSome: Effect.succeed,
  })
})

/** A failed Company directory lookup never invents a Member identity; transport failures still propagate. */
const resolveFor = Effect.fn('Tools.resolveAssignee')(function* (
  client: VividRpcClient['Service'],
  name: Option.Option<string>,
) {
  if (Option.isNone(name) || ['me', 'you'].includes(name.value.trim().toLowerCase()))
    return resolveAssignee(name, [])
  const people = yield* client.ListPeople().pipe(
    Effect.map((response) => response.members),
    Effect.catchIf(Schema.is(RpcFailure), () => Effect.succeed([])),
  )
  return resolveAssignee(name, people)
})

/** Stable follow-up ids survive a Flue durable-step replay without scheduling duplicates. */
function followUpInput(
  threadId: ThreadId,
  toolCallId: string,
  data: { at: string; note?: string; repeat: keyof typeof REPEAT_MS },
) {
  const input: Schema.Struct.Mutable<FollowUpInput> = {
    id: FollowUpId.make(operationId(threadId, toolCallId, 'follow-up')),
    at: Date.parse(data.at),
    repeatEveryMs: REPEAT_MS[data.repeat],
  }
  if (data.note !== undefined) input.note = data.note.trim()
  return FollowUpInput.make(input)
}

/** Explicit optional assignments keep absence distinct from a field that is cleared. */
function createRequest(
  who: Acting,
  toolCallId: string,
  data: v.InferOutput<typeof createInput>,
  assignee: AssigneeInput,
) {
  const input: Schema.Struct.Mutable<CreateTaskRequest> = {
    id: TaskId.make(operationId(who.threadId, toolCallId, 'task')),
    threadId: who.threadId,
    title: data.title.trim(),
    assignee,
    dueAt: data.dueAt === undefined ? null : Date.parse(data.dueAt),
    priority: data.priority,
  }
  if (data.detail !== undefined) input.detail = data.detail.trim()
  if (data.followUpAt !== undefined)
    input.followUp = followUpInput(who.threadId, toolCallId, {
      at: data.followUpAt,
      note: data.followUpNote,
      repeat: data.repeat,
    })
  return CreateTaskRequest.make(input)
}

/** Patch omission preserves saved values; explicit null dates and Nobody assignments clear them. */
function patchRequest(
  data: v.InferOutput<typeof updateInput>,
  assignee: Option.Option<AssigneeInput>,
) {
  const patch: Schema.Struct.Mutable<PatchTaskRequest> = {}
  if (data.title !== undefined) patch.title = data.title.trim()
  if (data.detail !== undefined) patch.detail = data.detail.trim()
  if (data.status !== undefined) patch.status = data.status
  if (data.priority !== undefined) patch.priority = data.priority
  if (data.dueAt !== undefined) patch.dueAt = data.dueAt === null ? null : Date.parse(data.dueAt)
  if (Option.isSome(assignee)) patch.assignee = assignee.value
  return PatchTaskRequest.make(patch)
}

/** The model receives scheduled follow-ups and ISO dates, matching the existing task behavior. */
function describeFollowUp(followUp: FollowUp) {
  return {
    id: followUp.id,
    at: new Date(followUp.at).toISOString(),
    note: followUp.note,
    repeatEveryMs: followUp.repeatEveryMs,
    status: followUp.status,
  }
}

/** Member identity is rendered as a name while task ids remain available for later updates. */
function describeTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
    status: task.status,
    priority: task.priority,
    assignee: assigneeName(task.assignee),
    dueAt: task.dueAt === null ? null : new Date(task.dueAt).toISOString(),
    nextFollowUpAt:
      task.nextFollowUpAt === null ? null : new Date(task.nextFollowUpAt).toISOString(),
    followUps: task.followUps
      .filter((followUp) => followUp.status === 'scheduled')
      .map(describeFollowUp),
  }
}

/** The durable step records a bounded result and ids stay tied to this Thread and tool call. */
function createTool(acting: Option.Option<Acting>) {
  return defineTool({
    name: 'create_task',
    description:
      'Track work as a Task and optionally schedule a follow-up. Dates require a timezone offset.',
    input: createInput,
    durable: true,
    /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
    async run({ data, step, toolCallId, signal }) {
      return await step.do('create-task', () =>
        Effect.runPromise(
          settle(
            asActing(
              acting,
              Effect.fn('Tools.createTask')(function* (client) {
                const who = yield* requireActing(acting)
                const assignee = yield* resolveFor(client, Option.fromNullishOr(data.assignee))
                const response = yield* client.CreateTask(
                  createRequest(who, toolCallId, data, assignee),
                )
                return { output: { task: describeTask(response.task) } }
              }),
            ),
          ),
          { signal },
        ),
      )
    },
  })
}

/** Updates are idempotent patches and Member resolution is made under the acting Person's access. */
function updateTool(acting: Option.Option<Acting>) {
  return defineTool({
    name: 'update_task',
    description: 'Change a tracked Task. Use list_tasks first when the id is unknown.',
    input: updateInput,
    durable: true,
    /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
    async run({ data, step, signal }) {
      return await step.do('update-task', () =>
        Effect.runPromise(
          settle(
            asActing(
              acting,
              Effect.fn('Tools.updateTask')(function* (client) {
                const assignee =
                  data.assignee === undefined
                    ? Option.none<AssigneeInput>()
                    : Option.some(yield* resolveFor(client, Option.fromNullishOr(data.assignee)))
                const response = yield* client.PatchTask({
                  id: TaskId.make(data.id),
                  patch: patchRequest(data, assignee),
                })
                return { output: { task: describeTask(response.task) } }
              }),
            ),
          ),
          { signal },
        ),
      )
    },
  })
}

/** Read-only lists retain the open-task default and never return more than 25 tasks. */
function listTool(acting: Option.Option<Acting>) {
  return defineTool({
    name: 'list_tasks',
    description: 'List tracked Tasks and scheduled follow-ups.',
    input: v.object({
      status: v.optional(status, 'open'),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(25),
          v.description('Maximum tasks to return.'),
        ),
        20,
      ),
    }),
    /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
    run({ data, signal }) {
      return Effect.runPromise(
        settle(
          asActing(acting, (client) =>
            client.ListTasks({ status: data.status }).pipe(
              Effect.map((response) => ({
                output: {
                  now: new Date().toISOString(),
                  tasks: response.tasks.slice(0, data.limit).map(describeTask),
                  truncated: response.tasks.length > data.limit,
                },
              })),
            ),
          ),
        ),
        { signal },
      )
    },
  })
}

/** Follow-ups keep the original idempotency key and the Person's explicit offset date. */
function followUpTool(acting: Option.Option<Acting>) {
  return defineTool({
    name: 'schedule_follow_up',
    description: 'Schedule a follow-up for a tracked Task. Dates require a timezone offset.',
    input: v.object({
      taskId: id,
      at: when,
      note: v.optional(
        v.pipe(v.string(), v.maxLength(500), v.description('What to check or chase.')),
      ),
      repeat,
    }),
    durable: true,
    /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
    async run({ data, step, toolCallId, signal }) {
      return await step.do('schedule-follow-up', () =>
        Effect.runPromise(
          settle(
            asActing(
              acting,
              Effect.fn('Tools.scheduleFollowUp')(function* (client) {
                const who = yield* requireActing(acting)
                const response = yield* client.AddFollowUp({
                  taskId: TaskId.make(data.taskId),
                  followUp: followUpInput(who.threadId, toolCallId, data),
                })
                return {
                  output: {
                    task: { id: response.task.id, title: response.task.title },
                    followUp: describeFollowUp(response.followUp),
                  },
                }
              }),
            ),
          ),
          { signal },
        ),
      )
    },
  })
}

/** Tools close over exactly this render's acting Person and are never cached across people. */
export function taskTools(acting: Option.Option<Acting>) {
  return [createTool(acting), updateTool(acting), listTool(acting), followUpTool(acting)] as const
}
