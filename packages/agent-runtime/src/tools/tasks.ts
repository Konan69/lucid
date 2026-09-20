import * as NodeCrypto from 'node:crypto'
import { defineTool } from '@flue/runtime'
import * as Effect from 'effect/Effect'
import * as v from 'valibot'
import { VividRpcClient } from '@vivid/client-runtime'
import { FollowUpId, TaskId, ThreadId, type FollowUp, type Task } from '@vivid/contracts'
import { runServerRpc } from '../client.ts'

const REPEAT_MS = { none: null, daily: 86_400_000, weekly: 7 * 86_400_000 } as const
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/iu
const isoDateTime = v.pipe(
  v.string(),
  v.check(
    (value) => HAS_OFFSET.test(value) && Number.isFinite(Date.parse(value)),
    'Expected an ISO 8601 date-time with a timezone offset',
  ),
)
const parseWhen = (value: string | null) => (value === null ? null : Date.parse(value))
const trimNullable = (value: string | null) => (value === null ? null : value.trim() || null)

/** Stable ids make Flue durable-step retries idempotent at the server insert boundary. */
const operationId = (threadId: string, toolCallId: string, purpose: string) => {
  const hex = NodeCrypto.createHash('sha256')
    .update(`${threadId}:${toolCallId}:${purpose}`)
    .digest('hex')
    .slice(0, 32)
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`
}

const describeFollowUp = (followUp: FollowUp) => ({
  id: followUp.id,
  at: new Date(followUp.at).toISOString(),
  note: followUp.note,
  repeatEveryMs: followUp.repeatEveryMs,
  status: followUp.status,
})
const describeTask = (task: Task) => ({
  id: task.id,
  title: task.title,
  detail: task.detail,
  status: task.status,
  priority: task.priority,
  assignee: task.assignee ?? 'you',
  dueAt: task.dueAt === null ? null : new Date(task.dueAt).toISOString(),
  nextFollowUpAt: task.nextFollowUpAt === null ? null : new Date(task.nextFollowUpAt).toISOString(),
  followUps: task.followUps
    .filter((followUp) => followUp.status === 'scheduled')
    .map(describeFollowUp),
})

/** Builds one server RPC program while keeping the client acquisition in the runtime adapter. */
const withClient = <A, E>(use: (client: VividRpcClient['Service']) => Effect.Effect<A, E>) =>
  runServerRpc(
    Effect.gen(function* () {
      return yield* use(yield* VividRpcClient)
    }),
  )

const cache = new Map<string, ReturnType<typeof buildTaskTools>>()
export function taskToolsFor(threadId: string) {
  const cached = cache.get(threadId)
  if (cached !== undefined) return cached
  const tools = buildTaskTools(threadId)
  cache.set(threadId, tools)
  return tools
}

/** Creates the tool that records a Task and its optional first follow-up. */
function buildCreateTaskTool(threadId: string) {
  return defineTool({
    name: 'create_task',
    description:
      'Track work as a Task and optionally schedule a follow-up. Dates require a timezone offset.',
    input: v.object({
      title: v.pipe(v.string(), v.minLength(2), v.maxLength(200)),
      detail: v.optional(v.pipe(v.string(), v.maxLength(2000))),
      assignee: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(80))),
      dueAt: v.optional(isoDateTime),
      priority: v.optional(v.picklist(['normal', 'urgent'])),
      followUpAt: v.optional(isoDateTime),
      followUpNote: v.optional(v.pipe(v.string(), v.maxLength(500))),
      repeat: v.optional(v.picklist(['none', 'daily', 'weekly'])),
    }),
    durable: true,
    async run({ data, step, toolCallId }) {
      const response = await step.do('create-task', () => {
        const detail = data.detail === undefined ? undefined : data.detail.trim()
        const assignee = data.assignee === undefined ? null : data.assignee.trim() || null
        const dueAt = data.dueAt === undefined ? null : parseWhen(data.dueAt)
        const followUpAt = data.followUpAt
        if (followUpAt === undefined) {
          return Effect.runPromise(
            withClient((client) =>
              client.CreateTask({
                id: TaskId.make(operationId(threadId, toolCallId, 'task')),
                threadId: ThreadId.make(threadId),
                title: data.title.trim(),
                detail,
                assignee,
                dueAt,
                priority: data.priority,
              }),
            ),
          )
        }
        const note = data.followUpNote === undefined ? undefined : data.followUpNote.trim()
        return Effect.runPromise(
          withClient((client) =>
            client.CreateTask({
              id: TaskId.make(operationId(threadId, toolCallId, 'task')),
              threadId: ThreadId.make(threadId),
              title: data.title.trim(),
              detail,
              assignee,
              dueAt,
              priority: data.priority,
              followUp: {
                id: FollowUpId.make(operationId(threadId, toolCallId, 'follow-up')),
                at: Date.parse(followUpAt),
                note,
                repeatEveryMs: data.repeat === undefined ? null : REPEAT_MS[data.repeat],
              },
            }),
          ),
        )
      })
      return { output: { task: describeTask(response.task) } }
    },
  })
}

/** Creates the tool that applies one explicit Task patch variant. */
function buildUpdateTaskTool() {
  return defineTool({
    name: 'update_task',
    description: 'Change a tracked Task. Use list_tasks first when the id is unknown.',
    input: v.object({
      id: v.pipe(v.string(), v.uuid()),
      status: v.optional(v.picklist(['open', 'done', 'dropped'])),
      title: v.optional(v.pipe(v.string(), v.minLength(2), v.maxLength(200))),
      detail: v.optional(v.pipe(v.string(), v.maxLength(2000))),
      assignee: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(80)))),
      dueAt: v.optional(v.nullable(isoDateTime)),
      priority: v.optional(v.picklist(['normal', 'urgent'])),
    }),
    durable: true,
    async run({ data, step }) {
      const response = await step.do('update-task', () => {
        const title = data.title === undefined ? undefined : data.title.trim()
        const detail = data.detail === undefined ? undefined : data.detail.trim()
        const assignee = data.assignee === undefined ? undefined : trimNullable(data.assignee)
        const dueAt = data.dueAt === undefined ? undefined : parseWhen(data.dueAt)
        return Effect.runPromise(
          withClient((client) =>
            client.PatchTask({
              id: TaskId.make(data.id),
              patch: {
                status: data.status,
                title,
                detail,
                assignee,
                dueAt,
                priority: data.priority,
              },
            }),
          ),
        )
      })
      return { output: { task: describeTask(response.task) } }
    },
  })
}

/** Creates the read-only tool that lists Tasks and their scheduled follow-ups. */
function buildListTasksTool() {
  return defineTool({
    name: 'list_tasks',
    description: 'List tracked Tasks and scheduled follow-ups.',
    input: v.object({
      status: v.optional(v.picklist(['open', 'done', 'dropped'])),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
    }),
    async run({ data }) {
      const response = await Effect.runPromise(
        withClient((client) => client.ListTasks({ status: data.status ?? 'open' })),
      )
      return {
        output: {
          now: new Date().toISOString(),
          tasks: response.tasks.slice(0, data.limit ?? 20).map(describeTask),
        },
      }
    },
  })
}

/** Creates the tool that schedules a follow-up on an existing Task. */
function buildScheduleFollowUpTool(threadId: string) {
  return defineTool({
    name: 'schedule_follow_up',
    description: 'Schedule a follow-up for a tracked Task. Dates require a timezone offset.',
    input: v.object({
      taskId: v.pipe(v.string(), v.uuid()),
      at: isoDateTime,
      note: v.optional(v.pipe(v.string(), v.maxLength(500))),
      repeat: v.optional(v.picklist(['none', 'daily', 'weekly'])),
    }),
    durable: true,
    async run({ data, step, toolCallId }) {
      const response = await step.do('schedule-follow-up', () => {
        const note = data.note === undefined ? undefined : data.note.trim()
        return Effect.runPromise(
          withClient((client) =>
            client.AddFollowUp({
              taskId: TaskId.make(data.taskId),
              followUp: {
                id: FollowUpId.make(operationId(threadId, toolCallId, 'follow-up')),
                at: Date.parse(data.at),
                note,
                repeatEveryMs: data.repeat === undefined ? null : REPEAT_MS[data.repeat],
              },
            }),
          ),
        )
      })
      return {
        output: {
          task: { id: response.task.id, title: response.task.title },
          followUp: describeFollowUp(response.followUp),
        },
      }
    },
  })
}

/** Builds the per-Thread tool set so durable operation ids cannot cross conversations. */
function buildTaskTools(threadId: string) {
  const createTask = buildCreateTaskTool(threadId)
  const updateTask = buildUpdateTaskTool()
  const listTasks = buildListTasksTool()
  const scheduleFollowUp = buildScheduleFollowUpTool(threadId)
  return [createTask, updateTask, listTasks, scheduleFollowUp] as const
}
