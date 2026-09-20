import type { FlueConversationMessage } from '@flue/react'
import { Option, Schema } from 'effect'

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
const MessageUsageSchema = Schema.Struct({
  inputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  totalTokens: Schema.optionalKey(Schema.Number),
})
const MessageMetadataSchema = Schema.Struct({
  startedAt: Schema.optionalKey(Schema.Number),
  finishedAt: Schema.optionalKey(Schema.Number),
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(MessageUsageSchema),
})
const RuntimeMessageSchema = Schema.Struct({
  purpose: Schema.optionalKey(Schema.String),
  signal: Schema.optionalKey(
    Schema.Struct({
      attributes: Schema.optionalKey(
        Schema.Struct({ scheduledAt: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
})

const decodeMessageMetadata = Schema.decodeUnknownOption(MessageMetadataSchema)
const decodeRuntimeMessage = Schema.decodeUnknownOption(RuntimeMessageSchema)
const decodeToolPayload = Schema.decodeUnknownOption(ToolPayloadSchema)

type ToolPayload = typeof ToolPayloadSchema.Type
type ToolState = 'running' | 'failed' | 'done'
type ToolCallDescription = { label: string; detail?: string }

type Activity = {
  id: string
  detail?: string
  failed?: boolean
  label: string
  timestamp?: number
  type: 'request' | 'response' | 'tool'
}

type MessageContext = {
  finishedAt?: number
  metadata: typeof MessageMetadataSchema.Type | null
  runtimeMessage: typeof RuntimeMessageSchema.Type | null
  startedAt?: number
  text: string
}

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

/** Collapses text parts exactly as the activity timeline presents them. */
function messageText(message: FlueConversationMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

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

/** Decodes untrusted message metadata once before timeline classification. */
function contextForMessage(message: FlueConversationMessage): MessageContext {
  const metadataResult = decodeMessageMetadata(message.metadata)
  const metadata = Option.isSome(metadataResult) ? metadataResult.value : null
  const runtimeMessageResult = decodeRuntimeMessage(message)
  const runtimeMessage = Option.isSome(runtimeMessageResult) ? runtimeMessageResult.value : null
  const startedAt = metadata ? metadata.startedAt : undefined
  return {
    metadata,
    runtimeMessage,
    startedAt,
    finishedAt: metadata ? (metadata.finishedAt ?? startedAt) : startedAt,
    text: messageText(message),
  }
}

/** Projects a Person-authored message into the single request event shown in the log. */
function requestActivity(message: FlueConversationMessage, context: MessageContext): Activity[] {
  return [
    {
      id: message.id,
      label: 'Request submitted',
      detail: context.text || undefined,
      timestamp: context.startedAt,
      type: 'request',
    },
  ]
}

/** Projects a dispatch signal into the routine event while rejecting invalid timestamps. */
function dispatchActivity(message: FlueConversationMessage, context: MessageContext): Activity[] {
  const runtimeMessage = context.runtimeMessage
  const scheduledAt =
    runtimeMessage && runtimeMessage.signal && runtimeMessage.signal.attributes
      ? runtimeMessage.signal.attributes.scheduledAt
      : undefined
  const timestamp = scheduledAt ? Date.parse(scheduledAt) : undefined
  return [
    {
      id: message.id,
      label: 'Routine triggered',
      detail: context.text || undefined,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      type: 'request',
    },
  ]
}

/** Decodes one dynamic tool part and records its terminal state without leaking raw payloads. */
function activityForTool(
  message: FlueConversationMessage,
  context: MessageContext,
  tool: Extract<FlueConversationMessage['parts'][number], { type: 'dynamic-tool' }>,
): Activity {
  const inputResult = decodeToolPayload(tool.input)
  const input = Option.isSome(inputResult) ? inputResult.value : null
  const outputResult = decodeToolPayload('output' in tool ? tool.output : null)
  const output = Option.isSome(outputResult) ? outputResult.value : null
  const running = tool.state === 'input-available'
  const failed = tool.state === 'output-error'
  const described = describeToolCall(
    tool.toolName,
    input,
    output,
    running ? 'running' : failed ? 'failed' : 'done',
  )
  return {
    id: `${message.id}:${tool.toolCallId}`,
    label: described.label,
    detail: described.detail,
    failed,
    timestamp: context.finishedAt,
    type: 'tool',
  }
}

/** Builds the compact model, duration, and token summary attached to a response event. */
function responseFacts(context: MessageContext) {
  const metadata = context.metadata
  const model = metadata && metadata.model ? metadata.model.replace(/^openrouter\//, '') : undefined
  const duration =
    context.startedAt && context.finishedAt
      ? `${Math.max(0, (context.finishedAt - context.startedAt) / 1000).toFixed(1)}s`
      : undefined
  const usage = metadata ? metadata.usage : undefined
  const tokens = usage
    ? (usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined))
    : undefined
  return [model, duration, tokens ? `${tokens.toLocaleString()} tokens` : undefined]
    .filter(Boolean)
    .join(' · ')
}

/** Projects an assistant or advisory message into tool events followed by its response outcome. */
function responseActivity(message: FlueConversationMessage, context: MessageContext): Activity[] {
  const tools = message.parts
    .filter((part) => part.type === 'dynamic-tool')
    .map((tool) => activityForTool(message, context, tool))
  const failed = message.settlement ? message.settlement.outcome === 'failed' : false
  const facts = responseFacts(context)
  return [
    ...tools,
    {
      id: message.id,
      label: failed ? 'Response failed' : 'Response completed',
      detail: facts || context.text.slice(0, 120) || undefined,
      failed,
      timestamp: context.finishedAt,
      type: 'response',
    },
  ]
}

/** Classifies one materialized Flue message into the ordered events shown in the activity panel. */
export function activityForMessage(message: FlueConversationMessage): Activity[] {
  const context = contextForMessage(message)
  if (message.role === 'user') return requestActivity(message, context)
  if (
    message.role === 'system' &&
    context.runtimeMessage &&
    context.runtimeMessage.purpose === 'dispatch'
  )
    return dispatchActivity(message, context)
  return responseActivity(message, context)
}
