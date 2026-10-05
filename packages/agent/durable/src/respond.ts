import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { Array as Arr, Effect, Option, Predicate, Schema, SchemaGetter, SchemaIssue } from 'effect'

import { TurnInvalid } from './errors.ts'
import { answer, decide } from './holds.ts'
import { continueRun, prepareRun } from './stream.ts'
import { waiting } from './waiting.ts'

/** The transport-neutral turn carries only the client's newest input or named tool settlements. */
export const ChatTurn = Schema.TaggedUnion({
  Input: { messageId: Schema.String, text: Schema.String.check(Schema.isMinLength(1)) },
  Resume: {
    known: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    decisions: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
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
  approved: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
})
/** An invalid reason does not undo a valid decision; only string reasons have protocol meaning. */
const Approval = Schema.Struct({
  approved: Schema.Boolean,
  reason: Schema.optionalKey(Schema.Unknown),
}).pipe(
  Schema.decodeTo(ApprovalValue, {
    decode: SchemaGetter.transform((approval) =>
      Predicate.isString(approval.reason)
        ? { approved: approval.approved, reason: approval.reason }
        : { approved: approval.approved },
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
const decodePart = Schema.decodeUnknownOption(Part)
/** Malformed and unsupported parts carry no turn semantics; decode meaningful parts independently. */
const Parts = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(Schema.Array(Schema.toType(Part)), {
    decode: SchemaGetter.transform((parts) =>
      parts.flatMap((part) =>
        Option.match(decodePart(part), { onNone: () => [], onSome: (decoded) => [decoded] }),
      ),
    ),
    encode: SchemaGetter.passthroughSupertype(),
  }),
)
const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literal('user'), id: Schema.String, parts: Parts }),
  Schema.Struct({ role: Schema.Literal('assistant'), parts: Parts }),
])
const Body = Schema.Struct({ messages: Schema.Array(Schema.Unknown) })
const decodeMessage = Schema.decodeUnknownEffect(Message)

/** Derive only settlements with the complete decoded payload; generic tool parts merely name known calls. */
function resumed(parts: (typeof Message.Type)['parts']) {
  const tools = parts.filter(
    (part): part is Extract<typeof Part.Type, { toolCallId: string }> => 'toolCallId' in part,
  )
  const decisions = tools.flatMap((part) =>
    'approval' in part ? [{ callId: part.toolCallId, ...part.approval }] : [],
  )
  const outputs = tools.flatMap((part) =>
    'output' in part ? [{ callId: part.toolCallId, output: part.output }] : [],
  )
  return ChatTurn.cases.Resume.makeEffect({
    known: tools.map((part) => part.toolCallId),
    decisions,
    outputs,
  })
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
  return yield* resumed(message.parts)
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

/** Only currently waiting calls accept client settlements; finished and unstarted parts are ignored. */
const settleHolds = Effect.fn('Durable.settleHolds')(function* (
  harness: Harness,
  conversationId: ConversationId,
  turn: typeof ChatTurn.cases.Resume.Type,
  context: Context,
) {
  const held = yield* waiting(harness, conversationId, context)
  const approvable = new Set(
    held.flatMap((each) => (each.kind === 'approval' ? [each.callId] : [])),
  )
  for (const decision of turn.decisions) {
    if (approvable.has(decision.callId))
      yield* decide(harness, conversationId, decision, context).pipe(
        // Another request can settle between observation and admission; the resume remains usable.
        Effect.catchTag('CallNotWaiting', () => Effect.void),
      )
  }
  const answerable = new Set(held.flatMap((each) => (each.kind === 'answer' ? [each.callId] : [])))
  for (const output of turn.outputs) {
    if (answerable.has(output.callId))
      yield* answer(harness, conversationId, output, context).pipe(
        Effect.catchTag('CallNotWaiting', () => Effect.void),
      )
  }
})

/** Authorize the conversation outside this module; the decoded turn then starts or resumes its run. */
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
