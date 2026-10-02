import { Schema } from 'effect'

const ToolTaskSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
})
const ToolFollowUpSchema = Schema.Struct({ at: Schema.optionalKey(Schema.String) })
const ToolPayloadSchema = Schema.Struct({
  task: Schema.optionalKey(ToolTaskSchema),
  followUp: Schema.optionalKey(ToolFollowUpSchema),
  title: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  results: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  tasks: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})
type ToolPayload = typeof ToolPayloadSchema.Type
type ToolState = 'running' | 'failed' | 'done'
type ToolCallDescription = { label: string; detail?: string }

const TOOL_LABELS = {
  search: {
    failed: 'Library search failed',
    running: 'Searching the Library',
    done: 'Searched the Library',
  },
  create: {
    failed: 'Could not start tracking',
    running: 'Starting to track a task',
    done: 'Started tracking a task',
  },
  list: {
    failed: 'Could not read the task list',
    running: 'Checking the task list',
    done: 'Checked the task list',
  },
  followUp: {
    failed: 'Could not schedule the follow-up',
    running: 'Scheduling a follow-up',
    done: 'Scheduled a follow-up',
  },
  fallback: {
    failed: 'Action failed',
    running: 'Working',
    done: 'Action completed',
  },
} as const

/** Keeps state-dependent wording exhaustive without repeating nested conditionals per tool. */
function labelForState(state: ToolState, labels: Record<ToolState, string>) {
  return labels[state]
}

/** Derives the task title with output taking precedence whenever the runtime returned a task. */
function taskTitle(input: ToolPayload | null, output: ToolPayload | null) {
  if (output && output.task) return output.task.title
  return input ? input.title : undefined
}

/** Formats the optional follow-up instant once for every task-oriented activity description. */
function followUpTime(output: ToolPayload | null) {
  const at = output && output.followUp ? output.followUp.at : undefined
  if (!at) return null
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(Date.parse(at))
}

/** Describes a Library search while preserving its query and decoded result count. */
function describeSearch(
  input: ToolPayload | null,
  output: ToolPayload | null,
  state: ToolState,
): ToolCallDescription {
  const query = input ? input.query : undefined
  const results = output && output.results ? output.results.length : null
  return {
    label: labelForState(state, TOOL_LABELS.search),
    detail:
      [
        query ? `“${query}”` : null,
        results !== null ? `${results} ${results === 1 ? 'source' : 'sources'}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
  }
}

/** Describes the creation of a tracked task and its optional follow-up. */
function describeCreate(
  input: ToolPayload | null,
  output: ToolPayload | null,
  state: ToolState,
): ToolCallDescription {
  const when = followUpTime(output)
  return {
    label: labelForState(state, TOOL_LABELS.create),
    detail:
      [taskTitle(input, output), when ? `follow-up ${when}` : null].filter(Boolean).join(' · ') ||
      undefined,
  }
}

/** Distinguishes a completed task from an ordinary task update after failure/running states. */
function describeUpdate(
  input: ToolPayload | null,
  output: ToolPayload | null,
  state: ToolState,
): ToolCallDescription {
  let label = 'Updated a task'
  if (state === 'failed') label = 'Could not update the task'
  else if (state === 'running') label = 'Updating a task'
  else if (output && output.task && output.task.status === 'done') label = 'Marked a task done'
  return { label, detail: taskTitle(input, output) }
}

/** Describes a task-list read with the open count only when a decoded list exists. */
function describeList(output: ToolPayload | null, state: ToolState): ToolCallDescription {
  return {
    label: labelForState(state, TOOL_LABELS.list),
    detail: output && output.tasks ? `${output.tasks.length} open` : undefined,
  }
}

/** Describes a scheduled follow-up with the same title and time precedence as task creation. */
function describeFollowUp(
  input: ToolPayload | null,
  output: ToolPayload | null,
  state: ToolState,
): ToolCallDescription {
  return {
    label: labelForState(state, TOOL_LABELS.followUp),
    detail:
      [taskTitle(input, output), followUpTime(output)].filter(Boolean).join(' · ') || undefined,
  }
}

/** Maps known runtime tools to product language and gives unknown tools a stable generic label. */
export function describeToolCall(
  toolName: string,
  input: ToolPayload | null,
  output: ToolPayload | null,
  state: ToolState,
): ToolCallDescription {
  switch (toolName) {
    case 'search_library':
      return describeSearch(input, output, state)
    case 'create_task':
      return describeCreate(input, output, state)
    case 'update_task':
      return describeUpdate(input, output, state)
    case 'list_tasks':
      return describeList(output, state)
    case 'schedule_follow_up':
      return describeFollowUp(input, output, state)
    default:
      return { label: labelForState(state, TOOL_LABELS.fallback) }
  }
}
