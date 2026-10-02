import { defineTool } from '@flue/runtime'
import {
  CreateTaskRequest,
  FollowUpId,
  FollowUpInput,
  PatchTaskRequest,
  TaskId,
  type AssigneeInput,
  type ThreadId,
} from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as v from 'valibot'
import type { Acting } from '../client.ts'
import { Scope, type RunTool } from './scope.ts'
import { inventory, named, NameMissing } from './names.ts'
import * as views from './views.ts'
import { resolveFor } from './assignees.ts'
import { operationId } from './identity.ts'
import { text } from './inputs.ts'

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
  task: text('The exact Task title shown by list_tasks.', 240),
  status: v.optional(status),
  title: v.optional(v.pipe(text('The new outcome to track.', 200), v.trim(), v.minLength(2))),
  detail: v.optional(v.pipe(v.string(), v.maxLength(2000), v.description('Replacement details.'))),
  assignee: v.optional(v.nullable(text('The assignee name; null clears the assignee.', 120))),
  dueAt: v.optional(v.nullable(when)),
  priority: v.optional(priority),
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

/** Use the complete accessible inventory so status filtering never renumbers duplicate titles. */
const taskInventory = Effect.fn('Tools.taskInventory')(function* () {
  const { client } = yield* Scope
  const response = yield* client.ListTasks({})
  return inventory(response.tasks, (item) => views.modelText(item.title))
})

/** Durable creation keeps operation identities internal and returns the same title resolution uses. */
function createTool(runTool: RunTool) {
  return defineTool({
    name: 'create_task',
    description:
      'Track work as a Task and optionally schedule a follow-up. Dates require a timezone offset.',
    input: createInput,
    durable: true,
    /** The single durable step owns reads and writes; replay retains the safe result. */
    run({ data, step, toolCallId, signal }) {
      return step.do('create-task', () =>
        runTool(
          Effect.gen(function* () {
            const { client, acting } = yield* Scope
            const assignee = yield* resolveFor(
              Option.fromNullishOr(data.assignee),
              client.ListPeople(),
            )
            const response = yield* client.CreateTask(
              createRequest(acting, toolCallId, data, assignee),
            )
            const entries = yield* taskInventory()
            return {
              output: {
                task: views.task(response.task, yield* titleOf(entries, response.task.id)),
              },
            }
          }),
          { signal, tool: 'create_task' },
        ),
      )
    },
  })
}

/** A successful write must be present in the same accessible list used for later name resolution. */
function titleOf(entries: readonly { name: string; item: { id: TaskId } }[], id: TaskId) {
  const entry = entries.find(({ item }) => item.id === id)
  if (entry === undefined) return Effect.fail(new NameMissing({ name: 'the saved Task' }))
  return Effect.succeed(entry.name)
}

/** Updates use exact titles and patches remain idempotent under Flue recovery. */
function updateTool(runTool: RunTool) {
  return defineTool({
    name: 'update_task',
    description: 'Change a tracked Task using its exact title from list_tasks.',
    input: updateInput,
    durable: true,
    /** Resolve within current access before selecting a record for mutation. */
    run({ data, step, signal }) {
      return step.do('update-task', () =>
        runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const task = yield* Effect.fromResult(named(yield* taskInventory(), data.task))
            const assignee =
              data.assignee === undefined
                ? Option.none<AssigneeInput>()
                : Option.some(
                    yield* resolveFor(Option.fromNullishOr(data.assignee), client.ListPeople()),
                  )
            const response = yield* client.PatchTask({
              id: task.id,
              patch: patchRequest(data, assignee),
            })
            const title = yield* titleOf(yield* taskInventory(), response.task.id)
            return { output: { task: views.task(response.task, title) } }
          }),
          { signal, tool: 'update_task' },
        ),
      )
    },
  })
}

/** Name the full list first, then preserve the open default and bounded display. */
function listTool(runTool: RunTool) {
  return defineTool({
    name: 'list_tasks',
    description: 'List tracked Tasks and scheduled follow-ups. Use their exact titles for changes.',
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
    /** Closed statuses stay resolvable even when the display is filtered to open Tasks. */
    run({ data, signal }) {
      return runTool(
        Effect.gen(function* () {
          const entries = (yield* taskInventory()).filter(({ item }) => item.status === data.status)
          return {
            output: {
              now: new Date().toISOString(),
              tasks: entries.slice(0, data.limit).map(({ item, name }) => views.task(item, name)),
              truncated: entries.length > data.limit,
            },
          }
        }),
        { signal, tool: 'list_tasks' },
      )
    },
  })
}

/** Follow-ups keep deterministic operation identities inside the runtime boundary. */
function followUpTool(runTool: RunTool) {
  return defineTool({
    name: 'schedule_follow_up',
    description:
      'Schedule a follow-up for the exact Task title from list_tasks. Dates require a timezone offset.',
    input: v.object({
      task: text('The exact Task title shown by list_tasks.', 240),
      at: when,
      note: v.optional(
        v.pipe(v.string(), v.maxLength(500), v.description('What to check or chase.')),
      ),
      repeat,
    }),
    durable: true,
    /** A changed accessible inventory fails rather than scheduling against an arbitrary title. */
    run({ data, step, toolCallId, signal }) {
      return step.do('schedule-follow-up', () =>
        runTool(
          Effect.gen(function* () {
            const { client, acting } = yield* Scope
            const entries = yield* taskInventory()
            const task = yield* Effect.fromResult(named(entries, data.task))
            const response = yield* client.AddFollowUp({
              taskId: task.id,
              followUp: followUpInput(acting.threadId, toolCallId, data),
            })
            const title = yield* titleOf(entries, response.task.id)
            return {
              output: {
                task: views.task(response.task, title),
                followUp: views.followUp(response.followUp),
              },
            }
          }),
          { signal, tool: 'schedule_follow_up' },
        ),
      )
    },
  })
}

/** Tools share one per-render boundary; no tool owns a client or selects an actor. */
export function taskTools(runTool: RunTool) {
  return [
    createTool(runTool),
    updateTool(runTool),
    listTool(runTool),
    followUpTool(runTool),
  ] as const
}
