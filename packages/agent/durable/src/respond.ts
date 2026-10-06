import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import {
  Array as Arr,
  Effect,
  Function,
  Option,
  Predicate,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from 'effect'

import { HoldId, TurnInvalid } from './errors.ts'
import { answerObserved, decideObserved } from './holds.ts'
import { runMessageId } from './chunks.ts'
import * as Pi from './pi.ts'
import { LiveDoc } from '@earendil-works/pi-durable'
import { continueRun, prepareRun } from './stream.ts'
import { waiting } from './waiting.ts'

/** The transport-neutral turn carries only the client's newest input or named tool settlements. */
export const ChatTurn = Schema.TaggedUnion({
  Input: { messageId: Schema.String, text: Schema.String.check(Schema.isMinLength(1)) },
  Resume: {
    messageId: Schema.optionalKey(Schema.String),
    known: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    decisions: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        holdId: HoldId,
        approved: Schema.Boolean,
        reason: Schema.optionalKey(Schema.String),
      }),
    ),
    outputs: Schema.Array(Schema.Struct({ callId: Schema.String, output: Schema.MutableJson })),
  },
})
export type ChatTurn = typeof ChatTurn.Type

const ToolName = Schema.String.check(Schema.isPattern(/^(?:tool-|dynamic-tool$)/u))
const ApprovalValue = Schema.Struct({
  id: HoldId,
  approved: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
})
/** An invalid reason does not undo a valid decision; only string reasons have protocol meaning. */
const Approval = Schema.Struct({
  id: HoldId,
  approved: Schema.Boolean,
  reason: Schema.optionalKey(Schema.Unknown),
}).pipe(
  Schema.decodeTo(Schema.toType(ApprovalValue), {
    decode: SchemaGetter.transform((approval) =>
      Predicate.isString(approval.reason)
        ? { id: approval.id, approved: approval.approved, reason: approval.reason }
        : { id: approval.id, approved: approval.approved },
    ),
    encode: SchemaGetter.passthroughSupertype(),
  }),
)
const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({
    type: ToolName,
    toolCallId: Schema.String,
    state: Schema.Literal('approval-responded'),
    approval: Approval,
  }),
  Schema.Struct({
    type: ToolName,
    toolCallId: Schema.String,
    state: Schema.Literal('output-available'),
    output: Schema.MutableJson,
  }),
  Schema.Struct({ type: ToolName, toolCallId: Schema.String }),
  // Unknown part types carry no input/settlement semantics and are intentionally discarded.
  Schema.Struct({ type: Schema.String }),
])
const decodePart = Function.compose(Schema.decodeUnknownOption(Part), Option.toArray)
/** Malformed and unsupported parts carry no turn semantics; decode meaningful parts independently. */
const Parts = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(Schema.Array(Schema.toType(Part)), {
    decode: SchemaGetter.transform((parts) => parts.flatMap(decodePart)),
    encode: SchemaGetter.passthroughSupertype(),
  }),
)
const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literal('user'), id: Schema.String, parts: Parts }),
  Schema.Struct({
    role: Schema.Literal('assistant'),
    id: Schema.optionalKey(Schema.String),
    parts: Parts,
  }),
])
const Body = Schema.Struct({ messages: Schema.Array(Schema.Unknown) })
const decodeMessage = Schema.decodeUnknownEffect(Message)

/** Derive only settlements with the complete decoded payload; generic tool parts merely name known calls. */
function resumed(message: Extract<typeof Message.Type, { role: 'assistant' }>) {
  const { parts } = message
  const tools = parts.filter(
    (part): part is Extract<typeof Part.Type, { toolCallId: string }> => 'toolCallId' in part,
  )
  const decisions = tools.flatMap((part) => {
    if (!('approval' in part)) return []
    const { id, ...decision } = part.approval
    return [{ callId: part.toolCallId, holdId: id, ...decision }]
  })
  const outputs = tools.flatMap((part) =>
    'output' in part ? [{ callId: part.toolCallId, output: part.output }] : [],
  )
  const resume = {
    known: tools.map((part) => part.toolCallId),
    decisions,
    outputs,
  }
  return message.id === undefined
    ? ChatTurn.cases.Resume.makeEffect(resume)
    : ChatTurn.cases.Resume.makeEffect({ ...resume, messageId: message.id })
}

/** Validate only the newest message; the historical client transcript is neither trusted nor required. */
const toTurn = Effect.fn('Durable.decodeTurn')(function* (body: typeof Body.Type) {
  const last = Arr.last(body.messages)
  if (Option.isNone(last)) return yield* new TurnInvalid({})
  const message = yield* decodeMessage(last.value)
  if (message.role === 'user') {
    const text = message.parts.flatMap((part) => ('text' in part ? [part.text] : [])).join('\n')
    return yield* ChatTurn.cases.Input.makeEffect({ messageId: message.id, text })
  }
  return yield* resumed(message)
})

/** One chat-body contract yields a decoded turn for both object and JSON-text ingress. */
export const TurnBody = Body.pipe(
  Schema.decodeTo(ChatTurn, {
    decode: SchemaGetter.transformEffect((body) =>
      toTurn(body).pipe(
        Effect.mapError((cause) => {
          if (cause instanceof TurnInvalid)
            return new SchemaIssue.InvalidValue(
              { message: 'Expected a user message or a message with tool calls' },
              body,
            )
          return cause instanceof Schema.SchemaError ? cause.issue : cause
        }),
      ),
    ),
    encode: SchemaGetter.forbiddenEncoding,
  }),
)

/** Compiled ingress accepts untrusted chat bodies without an untyped application function parameter. */
export const decodeTurn = Schema.decodeUnknownEffect(TurnBody)

/** Only the current run message accepts settlements; stale resumes settle nothing. Outputs match call
 * ids and rely on provider ids remaining unique within one run; approvals are task-scoped. Read waiting
 * once for the whole batch; finished and unstarted parts are ignored, with atomic task revalidation. */
const settleHolds = Effect.fn('Durable.settleHolds')(function* (
  harness: Harness,
  conversationId: ConversationId,
  turn: typeof ChatTurn.cases.Resume.Type,
  context: Context,
) {
  const live = yield* Pi.snapshot(harness, LiveDoc, conversationId, context)
  if (
    Option.isNone(live) ||
    live.value.run === undefined ||
    turn.messageId !== runMessageId(live.value.run.inputs)
  )
    return
  const held = yield* waiting(harness, conversationId, context)
  const approvable = new Map(
    held.filter((each) => each.kind === 'approval').map((each) => [each.holdId, each.callId]),
  )
  for (const decision of turn.decisions) {
    if (approvable.get(decision.holdId) === decision.callId)
      yield* decideObserved(harness, conversationId, { decision, held }, context).pipe(
        // A task can settle between observation and admission; stale POSTs do not authorize successors.
        Effect.catchTag('CallNotWaiting', () => Effect.void),
      )
  }
  // AI SDK addToolOutput carries no task identity. Resolve only a currently waiting unique call;
  // replayed outputs rely on the provider's call ids being unique within a run. Approvals do not.
  const answerable = new Map(
    held.filter((each) => each.kind === 'answer').map((each) => [each.callId, each.holdId]),
  )
  for (const output of turn.outputs) {
    const holdId = answerable.get(output.callId)
    if (holdId !== undefined)
      yield* answerObserved(
        harness,
        conversationId,
        { given: { holdId, output: output.output }, held },
        context,
      ).pipe(Effect.catchTag('CallNotWaiting', () => Effect.void))
  }
})

/** Authorize before calling. A stale assistant message settles nothing and still resumes observation.
 * Client outputs match call ids and require uniqueness within one run; approvals are task-scoped. */
export const respond = Effect.fn('Durable.respond')(function* (
  harness: Harness,
  conversationId: ConversationId,
  turn: ChatTurn,
  context: Context,
) {
  return yield* ChatTurn.match(turn, {
    Input: (input) =>
      prepareRun(
        harness,
        { conversationId, content: input.text, requestId: input.messageId },
        context,
      ),
    Resume: (resume) =>
      settleHolds(harness, conversationId, resume, context).pipe(
        Effect.andThen(continueRun(harness, conversationId, new Set(resume.known), context)),
      ),
  })
})
