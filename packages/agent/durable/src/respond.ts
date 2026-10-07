import type { Stream } from 'effect'
import type { UIMessageChunk } from 'ai'
import type * as DurableErrors from './errors.ts'
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

import { connectionLostInput } from './client.ts'
import { HoldId, RunMissing, TurnInvalid, TurnRegenerate } from './errors.ts'
import { answerObserved, decideObserved, errorObserved } from './holds.ts'
import { isConnectionLostAnswer } from './answers.ts'
import { resolveRunIdentity } from './resume.ts'
import * as Pi from './pi.ts'
import { LiveDoc } from '@earendil-works/pi-durable'
import { completeTurn, continueRun, prepareInput } from './stream.ts'
import { waiting } from './waiting.ts'
import { InputPart, InputParts, type InputOptions, inputPolicy, type InputPolicy } from './input.ts'

/** The transport-neutral turn carries only the client's newest input or named tool settlements. */
export const ChatTurn = Schema.TaggedUnion({
  Input: { messageId: Schema.String, parts: InputParts },
  Resume: {
    messageId: Schema.optionalKey(Schema.String),
    steps: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    known: Schema.Array(Schema.String),
    decisions: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        holdId: HoldId,
        approved: Schema.Boolean,
        reason: Schema.optionalKey(Schema.String),
      }),
    ),
    outputs: Schema.Array(
      Schema.Union([
        Schema.Struct({ callId: Schema.String, output: Schema.MutableJson }),
        Schema.Struct({ callId: Schema.String, errorText: Schema.String }),
      ]),
    ),
  },
})
export type ChatTurn = typeof ChatTurn.Type
/** Group per-input host policy with the turn, keeping authority/context separate and four arguments. */
export type TurnInput = ChatTurn | { readonly turn: ChatTurn; readonly options: InputOptions }

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
  InputPart,
  // Local connection failures neither name a known call nor authorize or answer it.
  Schema.Struct({
    type: ToolName,
    toolCallId: Schema.String,
    state: Schema.Literal('output-error'),
    errorText: Schema.Literal(connectionLostInput),
  }),
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
  Schema.Struct({
    type: ToolName,
    toolCallId: Schema.String,
    state: Schema.Literal('output-error'),
    errorText: Schema.String,
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
const Body = Schema.Struct({
  messages: Schema.Array(Schema.Unknown),
  trigger: Schema.optionalKey(Schema.Literals(['submit-message', 'regenerate-message'])),
})
const decodeMessage = Schema.decodeUnknownEffect(Message)

/** Derive only settlements with the complete decoded payload; generic tool parts merely name known calls. */
function resumed(message: Extract<typeof Message.Type, { role: 'assistant' }>) {
  const { parts } = message
  const tools = parts.filter(
    (part): part is Extract<typeof Part.Type, { toolCallId: string }> => 'toolCallId' in part,
  )
  if (tools.length === 0) return Effect.fail(new TurnInvalid({}))
  const known = tools.filter(
    (part) => !('errorText' in part && isConnectionLostAnswer(part.errorText)),
  )
  const decisions = tools.flatMap((part) => {
    if (!('approval' in part)) return []
    const { id, ...decision } = part.approval
    return [{ callId: part.toolCallId, holdId: id, ...decision }]
  })
  const outputs = tools.flatMap((part): (typeof ChatTurn.cases.Resume.Type)['outputs'] => {
    if ('output' in part) return [{ callId: part.toolCallId, output: part.output }]
    // The transport's reserved marker retains call identity, but has no settlement semantics.
    if ('errorText' in part && !isConnectionLostAnswer(part.errorText))
      return [{ callId: part.toolCallId, errorText: part.errorText }]
    return []
  })
  const resume = {
    steps: parts.filter((part) => part.type === 'step-start').length,
    known: known.map((part) => part.toolCallId),
    decisions,
    outputs,
  }
  return message.id === undefined
    ? ChatTurn.cases.Resume.makeEffect(resume)
    : ChatTurn.cases.Resume.makeEffect({ ...resume, messageId: message.id })
}

/** Validate only the newest message; the historical client transcript is neither trusted nor required. */
const toTurn = Effect.fn('Durable.decodeTurn')(function* (body: typeof Body.Type) {
  if (body.trigger === 'regenerate-message') return yield* new TurnRegenerate({})
  const last = Arr.last(body.messages)
  if (Option.isNone(last)) return yield* new TurnInvalid({})
  const message = yield* decodeMessage(last.value)
  if (message.role === 'user') {
    // An incomplete file shape is invalid, rather than silently becoming a text-only turn.
    if (message.parts.some((part) => part.type === 'file' && !('url' in part)))
      return yield* new TurnInvalid({})
    const parts = message.parts.filter((part): part is InputPart => 'text' in part || 'url' in part)
    return yield* ChatTurn.cases.Input.makeEffect({ messageId: message.id, parts })
  }
  return yield* resumed(message)
})

/** One chat-body contract yields a decoded turn for both object and JSON-text ingress. */
export const TurnBody = Body.pipe(
  Schema.decodeTo(ChatTurn, {
    decode: SchemaGetter.transformEffect((body) =>
      toTurn(body).pipe(
        Effect.mapError((cause) => {
          if (cause instanceof TurnInvalid || cause instanceof TurnRegenerate)
            return new SchemaIssue.InvalidValue(
              { message: cause.message, durableTurnFailure: cause },
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
export const decodeTurn = Function.flow(
  Schema.decodeUnknownEffect(TurnBody),
  Effect.mapError(turnFailure),
)

/** Schema issue annotations carry our tagged refusal through object and JSON-string codecs.
 * Decode failures without this local annotation are malformed input; diagnostic text is never
 * a discriminator. Effect Schema Issue annotations explicitly support custom keys. */
function taggedRefusal(issue: SchemaIssue.Issue): Option.Option<TurnInvalid | TurnRegenerate> {
  if (Predicate.isTagged(issue, 'InvalidValue') && issue.annotations !== undefined) {
    const failure = issue.annotations.durableTurnFailure
    if (failure instanceof TurnInvalid || failure instanceof TurnRegenerate)
      return Option.some(failure)
  }
  if ('issue' in issue) return taggedRefusal(issue.issue)
  if ('issues' in issue) {
    for (const child of issue.issues) {
      const refusal = taggedRefusal(child)
      if (Option.isSome(refusal)) return refusal
    }
  }
  return Option.none()
}

/** Preserve local tagged refusals; failures reading or decoding a body are explicitly malformed. */
export function turnFailure(
  error: Schema.SchemaError | TurnInvalid | TurnRegenerate,
): TurnInvalid | TurnRegenerate {
  if (error instanceof TurnInvalid || error instanceof TurnRegenerate) return error
  return Option.getOrElse(taggedRefusal(error.issue), () => new TurnInvalid({}))
}

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
  if (Option.isNone(live) || live.value.run === undefined) return
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const resolved = yield* resolveRunIdentity(
    { harness, conversation, context },
    live.value.run.inputs,
  )
  if (turn.messageId !== resolved.messageId) return
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
    if (holdId === undefined) continue
    // The reconnect client's local marker is a partial-input failure, never a person's settlement.
    if ('errorText' in output && isConnectionLostAnswer(output.errorText)) continue
    const settlement =
      'output' in output
        ? answerObserved(
            harness,
            conversationId,
            { given: { holdId, output: output.output }, held },
            context,
          )
        : errorObserved(
            harness,
            conversationId,
            { given: { holdId, errorText: output.errorText }, held },
            context,
          )
    yield* settlement.pipe(Effect.catchTag('CallNotWaiting', () => Effect.void))
  }
})

type ResponseEffect = Effect.Effect<
  Effect.Success<ReturnType<typeof prepareInput>>,
  Effect.Error<ReturnType<typeof prepareInput>> | RunMissing
>

/** Authorize before calling. A stale assistant message settles nothing and still resumes observation.
 * Client outputs match call ids and require uniqueness within one run; approvals are task-scoped.
 * Ordered input parts are validated before admission; unsupported files fail without a Pi input. */
export const respond: (
  harness: Harness,
  conversationId: ConversationId,
  input: TurnInput,
  context: Context,
) => Effect.Effect<
  Stream.Stream<
    UIMessageChunk,
    | DurableErrors.ToolNameDuplicated
    | DurableErrors.PiFailed
    | DurableErrors.WatchClosed
    | DurableErrors.WatchOverflowed
    | RunMissing
  >,
  | DurableErrors.ToolNameDuplicated
  | DurableErrors.ConversationMissing
  | DurableErrors.LimitInvalid
  | DurableErrors.BusyPolicyInvalid
  | DurableErrors.TurnBusy
  | DurableErrors.TurnWaiting
  | DurableErrors.TurnConflict
  | DurableErrors.TurnWithdrawn
  | DurableErrors.WatchClosed
  | DurableErrors.WatchOverflowed
  | DurableErrors.PartTooLarge
  | DurableErrors.PartUnsupported
  | DurableErrors.PiFailed
  | RunMissing
  | TurnInvalid
> = Effect.fn('Durable.respond')(function* (
  harness: Harness,
  conversationId: ConversationId,
  input: TurnInput,
  context: Context,
) {
  const { turn, options } = 'turn' in input ? input : { turn: input, options: {} }
  const policy = yield* inputPolicy(options)
  return yield* respondWithPolicy(harness, conversationId, { turn, policy }, context)
})

/** Request ingress can validate the host policy before reading its body and pass the trusted state. */
export const respondWithPolicy: (
  harness: Harness,
  conversationId: ConversationId,
  input: { readonly turn: ChatTurn; readonly policy: InputPolicy },
  context: Context,
) => Effect.Effect<
  Effect.Success<ReturnType<typeof respond>>,
  Exclude<
    Effect.Error<ReturnType<typeof respond>>,
    DurableErrors.LimitInvalid | DurableErrors.BusyPolicyInvalid
  >
> = Effect.fn('Durable.respondWithPolicy')(function* (
  harness: Harness,
  conversationId: ConversationId,
  input: { readonly turn: ChatTurn; readonly policy: InputPolicy },
  context: Context,
) {
  const { turn, policy } = input
  return yield* ChatTurn.match(turn, {
    Input: ({ parts, messageId }): ResponseEffect =>
      prepareInput(
        harness,
        { conversationId, content: parts, requestId: messageId, options: policy },
        context,
      ),
    Resume: (resume): ResponseEffect =>
      settleHolds(harness, conversationId, resume, context).pipe(
        Effect.andThen(
          resume.messageId === undefined
            ? Effect.fail(new RunMissing({ conversationId }))
            : (resume.decisions.length === 0 && resume.outputs.length === 0
                ? completeTurn
                : continueRun)(
                harness,
                conversationId,
                { messageId: resume.messageId, steps: resume.steps, known: new Set(resume.known) },
                context,
              ),
        ),
      ),
  })
})
