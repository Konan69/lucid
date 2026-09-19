import * as NodeCrypto from 'node:crypto'
import { defineTool } from '@flue/runtime'
import * as v from 'valibot'
import {
  createFollowUp,
  createNotification,
  createTask,
  getTask,
  getTaskView,
  listTaskViews,
  updateTask,
  type FollowUp,
  type TaskOrigin,
  type TaskView,
} from '../task-store.ts'

const REPEAT_MS = { none: null, daily: 86_400_000, weekly: 7 * 86_400_000 } as const

// Require an explicit offset or Z: a bare "2026-09-04T09:00" would be read in the server's zone.
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i
const isoDateTime = v.pipe(
  v.string(),
  v.check(
    (value) => HAS_OFFSET.test(value) && Number.isFinite(Date.parse(value)),
    'Expected an ISO 8601 date-time with a timezone offset, like 2026-09-04T09:00:00+01:00',
  ),
)

function parseWhen(value?: string | null): number | null {
  if (value === undefined || value === null) return null
  return Date.parse(value)
}

function originFor(conversationId: string): TaskOrigin {
  if (conversationId.startsWith('routine-'))
    return { kind: 'routine', routineId: conversationId.slice('routine-'.length) }
  return { kind: 'conversation', conversationId }
}

function operationId(conversationId: string, toolCallId: string, purpose: string) {
  const hex = NodeCrypto.createHash('sha256')
    .update(`${conversationId}:${toolCallId}:${purpose}`)
    .digest('hex')
    .slice(0, 32)
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`
}

function describeFollowUp(followUp: FollowUp) {
  return {
    id: followUp.id,
    at: new Date(followUp.at).toISOString(),
    note: followUp.note,
    repeatEveryMs: followUp.repeatEveryMs,
    status: followUp.status,
  }
}

function describeTask(task: TaskView) {
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee ?? 'you',
    dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : null,
    nextFollowUpAt: task.nextFollowUpAt ? new Date(task.nextFollowUpAt).toISOString() : null,
    followUps: task.followUps
      .filter((followUp) => followUp.status === 'scheduled')
      .map(describeFollowUp),
  }
}

const cache = new Map<string, ReturnType<typeof buildTaskTools>>()

/** Task tools bound to the conversation that is using them, so every task remembers where it came from. */
export function taskToolsFor(conversationId: string) {
  let tools = cache.get(conversationId)
  if (!tools) {
    tools = buildTaskTools(conversationId)
    cache.set(conversationId, tools)
  }
  return tools
}

function buildTaskTools(conversationId: string) {
  const createTaskTool = defineTool({
    name: 'create_task',
    description:
      "Track a piece of work as a task Vivid will follow up on. Use it when the user asks for a reminder, a chase, or to keep track of something, or after they accept your offer to track work that depends on another person, has a deadline, or should be checked later. Never file work you can finish right now. Set assignee to the person the work waits on, or omit it when the work is the user's own. Dates are ISO 8601 with a timezone offset. Returns the stored task; tell the user plainly what is now being tracked and when you will follow up.",
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
      const task = await step.do('create-task', () =>
        createTask({
          id: operationId(conversationId, toolCallId, 'task'),
          title: data.title.trim(),
          detail: data.detail === undefined ? undefined : data.detail.trim(),
          assignee: data.assignee === undefined ? null : data.assignee.trim() || null,
          dueAt: parseWhen(data.dueAt),
          priority: data.priority,
          origin: originFor(conversationId),
          createdBy: 'vivid',
        }),
      )
      const followUpAt = parseWhen(data.followUpAt)
      const followUp = followUpAt
        ? await step.do('schedule-follow-up', () =>
            createFollowUp({
              id: operationId(conversationId, toolCallId, 'follow-up'),
              taskId: task.id,
              at: followUpAt,
              note: data.followUpNote === undefined ? undefined : data.followUpNote.trim(),
              repeatEveryMs: REPEAT_MS[data.repeat ?? 'none'],
              createdBy: 'vivid',
            }),
          )
        : null
      await step.do('create-notification', () =>
        createNotification({
          id: operationId(conversationId, toolCallId, 'notification'),
          kind: 'tracked',
          title: `Now tracking: ${task.title}`,
          body: [
            task.assignee ? `Waiting on ${task.assignee}.` : null,
            task.dueAt ? `Due ${new Date(task.dueAt).toLocaleString()}.` : null,
            followUp ? `Follow-up ${new Date(followUp.at).toLocaleString()}.` : null,
          ]
            .filter(Boolean)
            .join(' '),
          taskId: task.id,
          conversationId,
        }),
      )
      return {
        output: {
          task: describeTask(await getTaskView(task)),
          followUp: followUp ? describeFollowUp(followUp) : null,
        },
      }
    },
  })

  const updateTaskTool = defineTool({
    name: 'update_task',
    description:
      'Change a tracked task: mark it done or dropped, reopen it, change who it waits on, its due date, priority, title, or detail. Marking a task done or dropped cancels its scheduled follow-ups. Use list_tasks first if you do not have the task id.',
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
      const task = await step.do('update-task', () =>
        updateTask(data.id, {
          status: data.status,
          title: data.title === undefined ? undefined : data.title.trim(),
          detail: data.detail === undefined ? undefined : data.detail.trim(),
          assignee:
            data.assignee === undefined
              ? undefined
              : data.assignee === null
                ? null
                : data.assignee.trim() || null,
          dueAt: data.dueAt === undefined ? undefined : parseWhen(data.dueAt),
          priority: data.priority,
        }),
      )
      if (!task) throw new Error(`No task with id ${data.id}`)
      return { output: { task: describeTask(await getTaskView(task)) } }
    },
  })

  const listTasksTool = defineTool({
    name: 'list_tasks',
    description:
      'List tracked tasks with their scheduled follow-ups. Defaults to open tasks. Use it to answer what is outstanding, what is waiting on whom, or to find a task id before updating it.',
    input: v.object({
      status: v.optional(v.picklist(['open', 'done', 'dropped'])),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
    }),
    async run({ data }) {
      const tasks = (await listTaskViews(data.status ?? 'open'))
        .slice(0, data.limit ?? 20)
        .map(describeTask)
      return { output: { now: new Date().toISOString(), tasks } }
    },
  })

  const scheduleFollowUpTool = defineTool({
    name: 'schedule_follow_up',
    description:
      'Schedule a moment when Vivid wakes up on its own to follow up on a tracked task: remind the user, draft a nudge for the person it waits on, or check whether it is done. Use an ISO 8601 date-time with a timezone offset. Repeat daily or weekly when the user wants ongoing chasing.',
    input: v.object({
      taskId: v.pipe(v.string(), v.uuid()),
      at: isoDateTime,
      note: v.optional(v.pipe(v.string(), v.maxLength(500))),
      repeat: v.optional(v.picklist(['none', 'daily', 'weekly'])),
    }),
    durable: true,
    async run({ data, step, toolCallId }) {
      const task = await getTask(data.taskId)
      if (!task) throw new Error(`No task with id ${data.taskId}`)
      if (task.status !== 'open')
        throw new Error(
          `Task "${task.title}" is ${task.status}; reopen it before scheduling a follow-up`,
        )
      const at = parseWhen(data.at) ?? Date.now()
      const followUp = await step.do('schedule-follow-up', () =>
        createFollowUp({
          id: operationId(conversationId, toolCallId, 'follow-up'),
          taskId: task.id,
          at,
          note: data.note === undefined ? undefined : data.note.trim(),
          repeatEveryMs: REPEAT_MS[data.repeat ?? 'none'],
          createdBy: 'vivid',
        }),
      )
      return {
        output: { task: { id: task.id, title: task.title }, followUp: describeFollowUp(followUp) },
      }
    },
  })

  return [createTaskTool, updateTaskTool, listTasksTool, scheduleFollowUpTool] as const
}
