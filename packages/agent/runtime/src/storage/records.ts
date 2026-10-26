/**
 * The envelopes a stored record must have before the storage hands it to Pi. Ported from the
 * earlier Pi port's shared record checks (`packages/agent/durable/src/records.ts` on the
 * `ai-sdk-durable` branch). Pi owns the payloads; these check only what the storage and Pi's
 * recovery rely on, and never strip a field.
 */
import type { JsonValue } from '@earendil-works/chord'
import type {
  EntryRecord,
  TaskRecord,
  TaskOutcome,
  SubmissionRecord,
} from '@earendil-works/pi-durable'
import * as Schema from 'effect/Schema'

/** Pi types.d.ts EntryRecord has an open kind/payload vocabulary but required numeric identity.
 * Keep extension/provider payloads intact. SQLite storage.js readEntries/readEntry only parse
 * JSON; memory.js prepares detached writes but trusts their envelope. This shared ingress check
 * prevents a wrong-shape history record from being silently skipped on any backend. */
export const EntryEnvelope = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  conversationId: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.String,
})
// Installed pi-ai 1.2.0 `types.d.ts`. Decode the message
// variant before history/model accounting; an intact row envelope is not a valid body.
const Text = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })
const Image = Schema.Struct({
  type: Schema.Literal('image'),
  data: Schema.String,
  mimeType: Schema.String,
})
const Thinking = Schema.Struct({ type: Schema.Literal('thinking'), thinking: Schema.String })
const ToolCall = Schema.Struct({
  type: Schema.Literal('toolCall'),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.MutableJson),
})
const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  total: Schema.Finite,
})
const Usage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  totalTokens: Schema.Finite,
  cost: Cost,
})
const messageVariants = {
  user: Schema.Struct({
    role: Schema.Literal('user'),
    content: Schema.Union([Schema.String, Schema.Array(Schema.Union([Text, Image]))]),
    timestamp: Schema.Finite,
  }),
  assistant: Schema.Struct({
    role: Schema.Literal('assistant'),
    content: Schema.Array(Schema.Union([Text, Thinking, ToolCall])),
    api: Schema.String,
    provider: Schema.String,
    model: Schema.String,
    usage: Usage,
    stopReason: Schema.Literals([
      'pending',
      'stop',
      'length',
      'toolUse',
      'error',
      'aborted',
      'deferred',
    ]),
    timestamp: Schema.Finite,
  }),
  system: Schema.Struct({
    role: Schema.Literal('system'),
    content: Schema.Union([Schema.String, Schema.Array(Text)]),
    timestamp: Schema.Finite,
  }),
  toolResult: Schema.Struct({
    role: Schema.Literal('toolResult'),
    content: Schema.Array(Schema.Union([Text, Image])),
    toolCallId: Schema.String,
    toolName: Schema.String,
    isError: Schema.Boolean,
    timestamp: Schema.Finite,
  }),
}
const Messages = Schema.Array(
  Schema.Union(Object.values(messageVariants)).pipe(Schema.toTaggedUnion('role')),
)
const NativeEntry = Schema.Struct({ ...EntryEnvelope.fields, model: Messages })
const isNative = Schema.is(NativeEntry)
const isEntryEnvelope = Schema.is(EntryEnvelope)
/** Native message kinds require the payload Pi wrote, including their matching role. Extension
 * entries may legitimately have no model array; that vocabulary remains extension owned. */
const isEntry = (value: ErrorOptions['cause']): boolean => {
  if (!isEntryEnvelope(value)) return false
  const roles = {
    'pi.user': 'user',
    'pi.assistant': 'assistant',
    'pi.tool-result': 'toolResult',
    'pi.system': 'system',
    'pi.compaction': 'user',
  } as const
  const nativeKind = (kind: string): kind is keyof typeof roles => Object.hasOwn(roles, kind)
  if (!nativeKind(value.kind)) return true
  const role = roles[value.kind]
  return isNative(value) && value.model.some((message) => message.role === role)
}
export const StoredEntry = Schema.declare<EntryRecord>((value): value is EntryRecord =>
  isEntry(value),
)

export const DocumentEnvelope = Schema.Struct({
  id: Schema.Finite,
  kind: Schema.String,
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('session') }),
    Schema.Struct({ kind: Schema.Literal('conversation'), conversationId: Schema.Finite }),
    Schema.Struct({ kind: Schema.Literal('task'), taskId: Schema.Finite }),
  ]),
  createdAt: Schema.Finite,
})
export const ConversationEnvelope = Schema.Struct({
  id: Schema.Int,
  parent: Schema.optionalKey(Schema.Struct({ conversationId: Schema.Int, at: Schema.Int })),
  owner: Schema.optionalKey(Schema.Struct({ conversationId: Schema.Int, taskId: Schema.Int })),
})
const taskOutcomes = {
  completed: Schema.Struct({
    status: Schema.tag('completed'),
    result: Schema.optionalKey(Schema.MutableJson),
  }),
  failed: Schema.Struct({
    status: Schema.tag('failed'),
    result: Schema.optionalKey(Schema.MutableJson),
    error: Schema.Struct({
      message: Schema.String,
      detail: Schema.optionalKey(Schema.MutableJson),
    }),
  }),
  faulted: Schema.Struct({
    status: Schema.tag('faulted'),
    error: Schema.Struct({
      message: Schema.String,
      detail: Schema.optionalKey(Schema.MutableJson),
    }),
  }),
  aborted: Schema.Struct({
    status: Schema.tag('aborted'),
    reason: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(Schema.MutableJson),
  }),
  orphaned: Schema.Struct({ status: Schema.tag('orphaned'), reason: Schema.String }),
} satisfies Record<TaskOutcome<JsonValue>['status'], Schema.Constraint>
const TaskResult = Schema.Union(Object.values(taskOutcomes)).pipe(Schema.toTaggedUnion('status'))
const taskStates = {
  pending: Schema.Struct({ status: Schema.tag('pending'), checkpoint: Schema.MutableJson }),
  running: Schema.Struct({ status: Schema.tag('running'), checkpoint: Schema.MutableJson }),
  waiting: Schema.Struct({
    status: Schema.tag('waiting'),
    checkpoint: Schema.MutableJson,
    on: Schema.Array(Schema.Int),
    policy: Schema.Literals(['failFast', 'allSettled']),
  }),
  // Pi 1.4.0: a durable sleep holds no invocation and resumes at `checkpoint` once the clock reaches `until`.
  sleeping: Schema.Struct({
    status: Schema.tag('sleeping'),
    checkpoint: Schema.MutableJson,
    until: Schema.Finite,
  }),
  completing: Schema.Struct({ status: Schema.tag('completing'), outcome: TaskResult }),
  terminal: Schema.Struct({ status: Schema.tag('terminal'), outcome: TaskResult }),
} satisfies Record<
  TaskRecord<JsonValue, JsonValue, JsonValue>['state']['status'],
  Schema.Constraint
>
const TaskState = Schema.Union(Object.values(taskStates)).pipe(Schema.toTaggedUnion('status'))

export const TaskEnvelope = Schema.Struct({
  ...EntryEnvelope.fields,
  version: Schema.Finite,
  background: Schema.Boolean,
  abortRequested: Schema.Boolean,
  input: Schema.optionalKey(Schema.MutableJson),
  owner: Schema.optionalKey(Schema.Int),
  memos: Schema.optionalKey(Schema.Record(Schema.String, Schema.MutableJson)),
  startedAt: Schema.optionalKey(Schema.Finite),
  endedAt: Schema.optionalKey(Schema.Finite),
  state: TaskState,
})
/** Receipt lifecycle fields must survive a recovery scan. Payloads remain Pi-owned; these
 * variants validate only the durable fields used to place/settle queued inputs and writes. */
const SubmissionBase = {
  id: Schema.Finite,
  conversationId: Schema.Finite,
  requestId: Schema.optionalKey(Schema.String),
}
const inputReceipts = {
  queued: Schema.Struct({
    ...SubmissionBase,
    type: Schema.Literal('input'),
    status: Schema.tag('queued'),
  }),
  placed: Schema.Struct({
    ...SubmissionBase,
    type: Schema.Literal('input'),
    status: Schema.tag('placed'),
    entry: Schema.Int,
  }),
  done: Schema.Struct({
    ...SubmissionBase,
    type: Schema.Literal('input'),
    status: Schema.tag('done'),
    entry: Schema.Int,
    answer: Schema.Int,
  }),
  unanswered: Schema.Struct({
    ...SubmissionBase,
    type: Schema.Literal('input'),
    status: Schema.tag('unanswered'),
    entry: Schema.optionalKey(Schema.Int),
    reason: Schema.String,
    detail: Schema.optionalKey(Schema.MutableJson),
  }),
} satisfies Record<Extract<SubmissionRecord, { type: 'input' }>['status'], Schema.Constraint>
const writeReceipts = {
  queued: Schema.Struct({
    ...SubmissionBase,
    type: Schema.Literal('write'),
    status: Schema.tag('queued'),
  }),
  done: Schema.Struct({
    ...SubmissionBase,
    type: Schema.Literal('write'),
    status: Schema.tag('done'),
    entry: Schema.Int,
  }),
  unanswered: Schema.Struct({
    ...SubmissionBase,
    type: Schema.Literal('write'),
    status: Schema.tag('unanswered'),
    reason: Schema.String,
    detail: Schema.optionalKey(Schema.MutableJson),
  }),
} satisfies Record<Extract<SubmissionRecord, { type: 'write' }>['status'], Schema.Constraint>
export const SubmissionEnvelope = Schema.Union([
  ...Object.values(inputReceipts),
  ...Object.values(writeReceipts),
])
