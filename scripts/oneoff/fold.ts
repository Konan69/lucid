import * as NodeCrypto from 'node:crypto'
import type {
  ThreadId,
  ThreadOrigin,
  RuntimeHistoryDraft,
} from '../../packages/contracts/src/index.ts'
type ModelMessage = NonNullable<typeof RuntimeHistoryDraft.Type.model>[number]
type AssistantMessage = Extract<ModelMessage, { role: 'assistant' }>
type UserMessage = Extract<ModelMessage, { role: 'user' }>
type ToolResultMessage = Extract<ModelMessage, { role: 'toolResult' }>
type AssistantContent = AssistantMessage['content'][number]
type TextContent = Extract<AssistantContent, { type: 'text' }>
type ThinkingContent = Extract<AssistantContent, { type: 'thinking' }>
type ToolCall = Extract<AssistantContent, { type: 'toolCall' }>
type ImageContent = Extract<ToolResultMessage['content'][number], { type: 'image' }>
import { Array as Arr, Data, Option, Order, Result, Schema } from 'effect'
import { signalText, type SignalData } from '../../packages/agent/runtime/src/delivery.ts'
import type { ResponseData } from '../../packages/agent/runtime/src/response.ts'
import { ContentBlock, FlueRecord, type AttachmentRef } from './records.ts'

/**
 * A response's metadata as the fold knows it: everything `vivid.response` holds but `inputs`,
 * which name Pi's submission and entry ids and so are added by the carry once it has them.
 */
type Measured = Omit<ResponseData, 'inputs'>

/** How a Flue submission ended (`submission_settled.outcome`), the runtime's `ResponseData.outcome`. */
type Outcome = 'completed' | 'failed' | 'aborted'

/** A delivery the response answered, by its Flue submission id, and how that submission settled. */
interface Input {
  readonly submission: string
  readonly outcome: Outcome
}

/**
 * One thing a Thread's transcript holds, in the order Flue committed it, as the Pi runtime writes
 * it (`threads.ts`, `delivery.ts`, `response.ts`): a Person's words (`pi.user`), a signal the
 * server sent (`vivid.signal`), a run's record of its deliveries (`vivid.run`), a model message
 * (`pi.assistant`), a tool's result (`pi.tool-result`), and what a response cost, when it ran and
 * how each of its deliveries ended (`vivid.response`).
 *
 * A delivery names its Flue submission when that submission settled; the carry makes it a Pi
 * submission placed at the delivery's entry, so the imported history has the shape a native one
 * has. A delivery whose submission never settled names none and stays a bare entry, as it was
 * left: nothing in the store may wait on it.
 */
export type Item = Data.TaggedEnum<{
  Said: { readonly message: UserMessage; readonly submission: Option.Option<string> }
  Signalled: {
    readonly data: SignalData
    readonly message: UserMessage
    readonly submission: Option.Option<string>
  }
  /** The run's deliveries so far, host first, written before a model message as `joinHooks` does. */
  Ran: { readonly inputs: ReadonlyArray<string> }
  Replied: { readonly message: AssistantMessage }
  Answered: { readonly message: ToolResultMessage }
  /** `inputs` is empty only for a response no delivery began; it is then written without inputs. */
  Responded: { readonly data: Measured; readonly inputs: ReadonlyArray<Input> }
}>
export const Item = Data.taggedEnum<Item>()

/** A Thread's Flue history, folded: who started it and everything to write, oldest first. */
export interface Carried {
  readonly threadId: ThreadId
  readonly origin: ThreadOrigin
  readonly items: ReadonlyArray<Item>
}

/** A file Flue kept (`flue_attachments`): its type and its bytes, by attachment id. */
interface Kept {
  readonly mimeType: string
  readonly bytes: Uint8Array
}
export type Attachments = ReadonlyMap<string, Kept>

/** The stream does not begin with its root conversation's birth, so it names no creator. */
class StreamStartMissing extends Schema.TaggedError<StreamStartMissing>()(
  'StreamStartMissing',
  { threadId: Schema.String },
  { title: 'Flue stream does not begin with its conversation' },
) {
  override get message() {
    return `The stream of Thread ${this.threadId} does not begin with its conversation`
  }
}

/** A block's deltas are not numbered 0, 1, 2… or not as many as its completion says. */
class DeltaGap extends Schema.TaggedError<DeltaGap>()(
  'DeltaGap',
  { recordId: Schema.String, blockId: Schema.String, expected: Schema.Int, found: Schema.Int },
  { title: 'Flue block deltas are not contiguous' },
) {
  override get message() {
    return `Block ${this.blockId} expected delta ${this.expected} and found ${this.found} (record ${this.recordId})`
  }
}

/** Why a record cannot be placed where it stands; Flue's own fold refused each of these. */
const Misplacement = Schema.Literals([
  'second conversation',
  'another conversation',
  'message unknown',
  'message repeated',
  'block unknown',
  'block repeated',
  'block incomplete',
  'call unknown',
  'outcome unknown',
  'metadata without submission',
  'delivery repeated',
  'join unknown',
])

/** A record that does not follow from the ones before it in the log. */
class RecordOutOfPlace extends Schema.TaggedError<RecordOutOfPlace>()(
  'RecordOutOfPlace',
  { recordId: Schema.String, recordType: Schema.String, rule: Misplacement },
  { title: 'Flue record does not follow its log' },
) {
  override get message() {
    return `Record ${this.recordId} (${this.recordType}) is out of place: ${this.rule}`
  }
}

/** A message names a file that was not kept for this stream and conversation. */
class AttachmentMissing extends Schema.TaggedError<AttachmentMissing>()(
  'AttachmentMissing',
  { attachmentId: Schema.String },
  { title: 'Flue attachment is missing' },
) {
  override get message() {
    return `Attachment ${this.attachmentId} is not kept`
  }
}

/** A kept file's size or SHA-256 digest differs from the reference to it. */
class AttachmentMismatch extends Schema.TaggedError<AttachmentMismatch>()(
  'AttachmentMismatch',
  { attachmentId: Schema.String, check: Schema.Literals(['size', 'digest']) },
  { title: 'Flue attachment does not match its reference' },
) {
  override get message() {
    return `Attachment ${this.attachmentId} fails its ${this.check} check`
  }
}

/** A file that is not a picture. Pi's messages carry pictures only (pi-ai `ImageContent`). */
class AttachmentUnsupported extends Schema.TaggedError<AttachmentUnsupported>()(
  'AttachmentUnsupported',
  { attachmentId: Schema.String, mimeType: Schema.String },
  { title: 'Flue attachment is not a picture' },
) {
  override get message() {
    return `Attachment ${this.attachmentId} is ${this.mimeType}, not a picture`
  }
}

/**
 * An application signal whose tag is absent or differs from its type. The server always sent one
 * type as both (`modelDelivery`), and the runtime's entry keeps one (`SignalData.type`), so such a
 * signal could not be written without choosing between them.
 */
class SignalUnreadable extends Schema.TaggedError<SignalUnreadable>()(
  'SignalUnreadable',
  { recordId: Schema.String, signalType: Schema.String },
  { title: 'Flue signal has no matching tag' },
) {
  override get message() {
    return `Signal ${this.recordId} of type ${this.signalType} has no tag of the same name`
  }
}

/**
 * Flue kept a reply a stream cut short in the model's context when the adjacent
 * `stream_interrupted`/`stream_continued` signals confirmed it (`dispatch-*.mjs` 955, 2412). Pi
 * has no such pair and would drop the partial, so a Thread holding either signal is not carried
 * rather than carried without it. None of production's Threads has one.
 */
class RecoveryPairUnsupported extends Schema.TaggedError<RecoveryPairUnsupported>()(
  'RecoveryPairUnsupported',
  { recordId: Schema.String, signalType: Schema.String },
  { title: 'Flue stream recovery pair is not carried' },
) {
  override get message() {
    return `Signal ${this.recordId} (${this.signalType}) marks a recovered partial reply, which the import does not carry`
  }
}

/**
 * Flue ran a tool batch from a message that stopped with `stop` or `length` and showed its calls
 * (`dispatch-*.mjs` 1033, 2448); Pi runs and shows tool calls only under `toolUse`, so the calls
 * would vanish from the screen. None of production's Threads has one.
 */
class ToolBatchUnderStop extends Schema.TaggedError<ToolBatchUnderStop>()(
  'ToolBatchUnderStop',
  { recordId: Schema.String, stopReason: Schema.String },
  { title: 'Flue tool batch under a stop reason Pi does not run' },
) {
  override get message() {
    return `Record ${this.recordId} completed a message with tool calls under stop reason ${this.stopReason}`
  }
}

/**
 * A submission settled `completed` with no model message to be its answer. Pi settles a done
 * input with the entry that answered it (`SubmissionSettlement.answer`), so there is none to name.
 */
class AnswerMissing extends Schema.TaggedError<AnswerMissing>()(
  'AnswerMissing',
  { submissionId: Schema.String },
  { title: 'Flue submission completed without a reply' },
) {
  override get message() {
    return `Submission ${this.submissionId} completed without a model message`
  }
}

export type FoldFailure =
  | StreamStartMissing
  | RecoveryPairUnsupported
  | ToolBatchUnderStop
  | AnswerMissing
  | DeltaGap
  | RecordOutOfPlace
  | AttachmentMissing
  | AttachmentMismatch
  | AttachmentUnsupported
  | SignalUnreadable

/**
 * Signal types that are Flue's plumbing, not a delivery: what it told the model about resources,
 * instructions and environment, and its notes of an aborted or interrupted reply
 * (`classifySignal`). The ending of a reply is the settlement's (`submission_settled`), which the
 * carry turns into the run's own settlement, so the screens draw the same advisory.
 */
const PLUMBING = new Set([
  'resources',
  'instructions',
  'environment',
  'submission_aborted',
  'submission_interrupted',
])

/** Flue's stream recovery signals; see `RecoveryPairUnsupported`. */
const RECOVERY = new Set(['stream_interrupted', 'stream_continued'])

type Of<T extends FlueRecord['type']> = Extract<FlueRecord, { readonly type: T }>
type Started = Of<'assistant_message_started'>
type Held = Of<'tool_outcome'>

/** A text or thinking block being received, or a tool call, which Flue stored whole. */
type Block =
  | {
      readonly kind: 'text' | 'thinking'
      readonly index: number
      readonly deltas: Array<string>
      finished: Option.Option<TextContent | ThinkingContent>
    }
  | { readonly kind: 'call'; readonly index: number; readonly call: ToolCall }

/** A model message between its start and its completion. */
interface Building {
  readonly started: Started
  readonly blocks: Map<string, Block>
  readonly indexes: Set<number>
}

/**
 * What is known of one response until its host submission settles. A response is named by the
 * submission that began it (the host); deliveries that joined it are its later `inputs`.
 */
interface Answering {
  /** Flue submission ids of the deliveries it answers, in the order they were placed, host first. */
  readonly inputs: Array<string>
  /** How many of `inputs` the last `Ran` item named. */
  announced: number
  /** Joined deliveries' own settlements, which Flue writes before the host's. */
  readonly outcomes: Map<string, Outcome>
  deliveredAt: Option.Option<number>
  startedAt: Option.Option<number>
  finishedAt: Option.Option<number>
  toolCallCount: Option.Option<number>
  /** Tool results committed for its model messages: the calls that ran. */
  committedCalls: number
  readonly replies: Array<AssistantMessage>
}

/** The fold's running state. Records are applied in log order and never revisited. */
interface Folding {
  readonly root: string
  readonly items: Array<Item>
  readonly attachments: Attachments
  readonly building: Map<string, Building>
  /** Completed model messages by Flue's message id, which tool outcomes name. */
  readonly replies: Map<string, AssistantMessage>
  /** Tool outcomes waiting for the commit that names them, by record id. */
  readonly outcomes: Map<string, Held>
  /** Responses not yet settled, by host submission. */
  readonly answering: Map<string, Answering>
  /** A joined delivery's submission to the host whose response it joined. */
  readonly joined: Map<string, string>
  /** An attempt to the host submission a model message started under it names, read first. */
  readonly attempts: ReadonlyMap<string, string>
  /** A completed model message to the submission whose response it belongs to. */
  readonly owners: Map<string, string>
}

type Step = Option.Option<FoldFailure>
const ok: Step = Option.none()
const failed = (failure: FoldFailure): Step => Option.some(failure)

const millis = (timestamp: string) => Date.parse(timestamp)

/** `base` with one more property when the value is there, and without it when it is not. */
function including<T extends object, K extends string, V>(
  base: T,
  key: K,
  value: Option.Option<V>,
): T & { readonly [P in K]?: V } {
  return Option.match(value, {
    onNone: () => base,
    onSome: (present) => ({ ...base, [key]: present }),
  })
}

const outOfPlace = (record: FlueRecord, rule: typeof Misplacement.Type): Step =>
  failed(new RecordOutOfPlace({ recordId: record.id, recordType: record.type, rule }))

/** The host of a submission's response: itself, unless its delivery joined another's. */
const hostOf = (state: Folding, submission: string) => state.joined.get(submission) ?? submission

/** The response being written for a host submission, begun the first time the log names it. */
function answeringOf(state: Folding, submission: string): Answering {
  const host = hostOf(state, submission)
  const known = state.answering.get(host)
  if (known !== undefined) return known
  const fresh: Answering = {
    inputs: [],
    announced: 0,
    outcomes: new Map(),
    deliveredAt: Option.none(),
    startedAt: Option.none(),
    finishedAt: Option.none(),
    toolCallCount: Option.none(),
    committedCalls: 0,
    replies: [],
  }
  state.answering.set(host, fresh)
  return fresh
}

/**
 * A delivery is placed: it begins a response of its own, or joins the one its attempt is running.
 * Flue writes a joined delivery under its own submission and the host's attempt, and the attempt's
 * host is known before the delivery is placed (`hostsByAttempt`): on a resumed attempt the joined
 * delivery may be the attempt's first record, so the delivery itself never names the host. Under
 * an attempt no model message started, the host is not known, so the delivery stands alone: its
 * own response, settled by its own settlement, answered by nothing the records do not name. A
 * delivery with no submission belongs to no response.
 */
function delivered(state: Folding, record: Of<'user_message' | 'signal'>): Step {
  const own = record.submissionId
  if (own === undefined) return ok
  const attempt = record.attemptId
  const host = attempt === undefined ? own : (state.attempts.get(attempt) ?? own)
  if (host !== own) {
    if (!state.answering.has(host)) return outOfPlace(record, 'join unknown')
    state.joined.set(own, host)
  }
  const answering = answeringOf(state, own)
  if (answering.inputs.includes(own)) return outOfPlace(record, 'delivery repeated')
  answering.inputs.push(own)
  if (Option.isNone(answering.deliveredAt))
    answering.deliveredAt = Option.some(millis(record.timestamp))
  return ok
}

/**
 * A kept file as the picture Pi carries in the message itself, after the checks Flue made on
 * every read (`verifyAttachmentBytes`: size, then the lowercase hex SHA-256 of the bytes).
 */
function picture(state: Folding, ref: AttachmentRef): Result.Result<ImageContent, FoldFailure> {
  const kept = state.attachments.get(ref.id)
  if (kept === undefined) return Result.fail(new AttachmentMissing({ attachmentId: ref.id }))
  if (kept.bytes.byteLength !== ref.size)
    return Result.fail(new AttachmentMismatch({ attachmentId: ref.id, check: 'size' }))
  const digest = NodeCrypto.createHash('sha256').update(kept.bytes).digest('hex')
  if (digest !== ref.digest)
    return Result.fail(new AttachmentMismatch({ attachmentId: ref.id, check: 'digest' }))
  if (!ref.mimeType.startsWith('image/'))
    return Result.fail(new AttachmentUnsupported({ attachmentId: ref.id, mimeType: ref.mimeType }))
  return Result.succeed({
    type: 'image',
    data: Buffer.from(kept.bytes).toString('base64'),
    mimeType: ref.mimeType,
  })
}

/** Flue's content with each file reference replaced by its picture, as Flue's model view did. */
function contentOf(state: Folding, blocks: ReadonlyArray<ContentBlock>) {
  return Result.all(
    blocks.map((block) =>
      ContentBlock.match(block, {
        text: (text): Result.Result<TextContent | ImageContent, FoldFailure> =>
          Result.succeed({ type: 'text', text: text.text }),
        attachment: (attached) => picture(state, attached.attachment),
      }),
    ),
  )
}

/**
 * A Person's words. Words alone are the plain string the runtime places (`placement`); words with
 * pictures keep Flue's block order.
 */
function said(state: Folding, record: Of<'user_message'>): Step {
  const content = contentOf(state, record.content)
  if (Result.isFailure(content)) return failed(content.failure)
  const placed = delivered(state, record)
  if (Option.isSome(placed)) return placed
  const [only] = content.success
  const words = content.success.length === 1 && only !== undefined && only.type === 'text'
  state.items.push(
    Item.Said({
      message: {
        role: 'user',
        content: words ? only.text : [...content.success],
        timestamp: millis(record.timestamp),
      },
      submission: Option.fromUndefinedOr(record.submissionId),
    }),
  )
  return ok
}

/**
 * A signal the server sent, written as the runtime places one: the type, attributes and body for
 * a screen, and Flue's rendering (`signalText`) as what the model reads. Plumbing is skipped.
 */
function signalled(state: Folding, record: Of<'signal'>): Step {
  if (RECOVERY.has(record.signalType))
    return failed(
      new RecoveryPairUnsupported({ recordId: record.id, signalType: record.signalType }),
    )
  if (PLUMBING.has(record.signalType)) return ok
  if (record.tagName !== record.signalType)
    return failed(new SignalUnreadable({ recordId: record.id, signalType: record.signalType }))
  const attributes = record.attributes === undefined ? {} : { ...record.attributes }
  const data = { type: record.signalType, attributes, body: record.content }
  const text = signalText({
    kind: 'signal',
    type: record.signalType,
    tagName: record.signalType,
    body: record.content,
    attributes,
  })
  const placed = delivered(state, record)
  if (Option.isSome(placed)) return placed
  state.items.push(
    Item.Signalled({
      data,
      message: { role: 'user', content: text, timestamp: millis(record.timestamp) },
      submission: Option.fromUndefinedOr(record.submissionId),
    }),
  )
  return ok
}

/** A model message begins; main stamped its response's start time on the first one. */
function started(state: Folding, record: Started): Step {
  if (state.building.has(record.messageId) || state.replies.has(record.messageId))
    return outOfPlace(record, 'message repeated')
  state.building.set(record.messageId, { started: record, blocks: new Map(), indexes: new Set() })
  const at = record.responseMetadata === undefined ? undefined : record.responseMetadata.startedAt
  if (record.submissionId === undefined || at === undefined) return ok
  const answering = answeringOf(state, record.submissionId)
  if (Option.isNone(answering.startedAt)) answering.startedAt = Option.some(at)
  return ok
}

/** A block opens at its place in the message; a place or an id is used once. */
function opened(
  state: Folding,
  record: Of<'assistant_text_started' | 'assistant_reasoning_started' | 'assistant_tool_call'>,
  block: Block,
): Step {
  const building = state.building.get(record.messageId)
  if (building === undefined) return outOfPlace(record, 'message unknown')
  if (building.blocks.has(record.blockId) || building.indexes.has(record.blockIndex))
    return outOfPlace(record, 'block repeated')
  building.blocks.set(record.blockId, block)
  building.indexes.add(record.blockIndex)
  return ok
}

/** The block a delta or completion names, while it is still receiving words of that kind. */
function streaming(
  state: Folding,
  record: Of<
    | 'assistant_text_delta'
    | 'assistant_reasoning_delta'
    | 'assistant_text_completed'
    | 'assistant_reasoning_completed'
  >,
  kind: 'text' | 'thinking',
) {
  const building = state.building.get(record.messageId)
  if (building === undefined) return Result.fail(outOfPlace(record, 'message unknown'))
  const block = building.blocks.get(record.blockId)
  if (block === undefined || block.kind !== kind || Option.isSome(block.finished))
    return Result.fail(outOfPlace(record, 'block unknown'))
  return Result.succeed(block)
}

/** Deltas are numbered from 0 within their block and arrive in that order (Flue `appendDelta`). */
function appended(
  state: Folding,
  record: Of<'assistant_text_delta' | 'assistant_reasoning_delta'>,
  kind: 'text' | 'thinking',
): Step {
  const block = streaming(state, record, kind)
  if (Result.isFailure(block)) return block.failure
  if (record.sequence !== block.success.deltas.length)
    return failed(
      new DeltaGap({
        recordId: record.id,
        blockId: record.blockId,
        expected: block.success.deltas.length,
        found: record.sequence,
      }),
    )
  block.success.deltas.push(record.delta)
  return ok
}

/** A block is complete when its completion counts exactly the deltas received (`completeBlock`). */
function finishing(
  state: Folding,
  record: Of<'assistant_text_completed' | 'assistant_reasoning_completed'>,
  kind: 'text' | 'thinking',
) {
  const block = streaming(state, record, kind)
  if (Result.isFailure(block)) return block
  if (record.deltaCount !== block.success.deltas.length)
    return Result.fail(
      failed(
        new DeltaGap({
          recordId: record.id,
          blockId: record.blockId,
          expected: record.deltaCount,
          found: block.success.deltas.length,
        }),
      ),
    )
  return block
}

function textCompleted(state: Folding, record: Of<'assistant_text_completed'>): Step {
  const block = finishing(state, record, 'text')
  if (Result.isFailure(block)) return block.failure
  const text: TextContent = { type: 'text', text: block.success.deltas.join('') }
  block.success.finished = Option.some(
    including(text, 'textSignature', Option.fromUndefinedOr(record.textSignature)),
  )
  return ok
}

/** Flue's `encrypted` is the opaque payload pi-ai keeps as `thinkingSignature` (`materializeAssistantBlock`). */
function reasoningCompleted(state: Folding, record: Of<'assistant_reasoning_completed'>): Step {
  const block = finishing(state, record, 'thinking')
  if (Result.isFailure(block)) return block.failure
  const thinking: ThinkingContent = { type: 'thinking', thinking: block.success.deltas.join('') }
  block.success.finished = Option.some(
    including(
      including(thinking, 'thinkingSignature', Option.fromUndefinedOr(record.encrypted)),
      'redacted',
      Option.fromUndefinedOr(record.redacted),
    ),
  )
  return ok
}

function toolCalled(state: Folding, record: Of<'assistant_tool_call'>): Step {
  const call: ToolCall = {
    type: 'toolCall',
    id: record.toolCallId,
    name: record.name,
    arguments: { ...record.arguments },
  }
  return opened(state, record, {
    kind: 'call',
    index: record.blockIndex,
    call: including(call, 'thoughtSignature', Option.fromUndefinedOr(record.thoughtSignature)),
  })
}

const byPlace = Order.mapInput(Order.Number, (block: Block) => block.index)

/** The blocks in their places, each complete; the first one still receiving fails the message. */
function blocksOf(building: Building) {
  const ordered = Arr.sort(building.blocks.values(), byPlace)
  const content: Array<TextContent | ThinkingContent | ToolCall> = []
  for (const block of ordered) {
    if (block.kind === 'call') content.push(block.call)
    else if (Option.isSome(block.finished)) content.push(block.finished.value)
    else return Option.none()
  }
  return Option.some(content)
}

/**
 * A model message is committed: its blocks by place, the model it came from, how it stopped, and
 * the time it began (Flue `assistant_message_completed`, whatever the stop reason).
 */
function completed(state: Folding, record: Of<'assistant_message_completed'>): Step {
  const building = state.building.get(record.messageId)
  if (building === undefined) return outOfPlace(record, 'message unknown')
  const content = blocksOf(building)
  if (Option.isNone(content)) return outOfPlace(record, 'block incomplete')
  const calls = content.value.some((block) => block.type === 'toolCall')
  if (calls && (record.stopReason === 'stop' || record.stopReason === 'length'))
    return failed(new ToolBatchUnderStop({ recordId: record.id, stopReason: record.stopReason }))
  const info = building.started.modelInfo
  const base: AssistantMessage = {
    role: 'assistant',
    content: content.value,
    api: info.api,
    provider: info.provider,
    model: info.model,
    usage: record.usage,
    stopReason: record.stopReason,
    timestamp: millis(building.started.timestamp),
  }
  const message = including(
    including(
      including(base, 'responseModel', Option.fromUndefinedOr(info.responseModel)),
      'responseId',
      Option.fromUndefinedOr(info.responseId),
    ),
    'errorMessage',
    Option.fromUndefinedOr(record.error),
  )
  state.building.delete(record.messageId)
  state.replies.set(record.messageId, message)
  const submission = building.started.submissionId
  if (submission !== undefined) {
    const answering = answeringOf(state, submission)
    announce(state, answering)
    answering.replies.push(message)
    state.owners.set(record.messageId, submission)
  }
  state.items.push(Item.Replied({ message }))
  return ok
}

/**
 * The run's record of its deliveries before a model message, when deliveries have been placed
 * since the last one: the runtime writes it before every model request and again when more have
 * joined (`joinHooks` `describe`), and the screens group a reply by it.
 */
function announce(state: Folding, answering: Answering) {
  if (answering.inputs.length === answering.announced) return
  answering.announced = answering.inputs.length
  state.items.push(Item.Ran({ inputs: [...answering.inputs] }))
}

/** A tool's result is held until committed; it must answer a call its message made. */
function outcome(state: Folding, record: Held): Step {
  const reply = state.replies.get(record.assistantMessageId)
  const asked =
    reply !== undefined &&
    reply.content.some(
      (block) =>
        block.type === 'toolCall' &&
        block.id === record.toolCallId &&
        block.name === record.toolName,
    )
  if (!asked) return outOfPlace(record, 'call unknown')
  state.outcomes.set(record.id, record)
  return ok
}

/**
 * A tool result as Pi writes one (`appendToolResult`): the content, and a structured output under
 * `details.output`, which is where a screen reads it (`outputOf` in `state/project.ts`).
 */
function resultOf(state: Folding, held: Held): Result.Result<ToolResultMessage, FoldFailure> {
  return Result.map(contentOf(state, held.content), (content) => {
    const base: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: held.toolCallId,
      toolName: held.toolName,
      content: [...content],
      isError: held.isError,
      timestamp: millis(held.timestamp),
    }
    return including(
      including(
        base,
        'details',
        Option.map(Option.fromUndefinedOr(held.output), (output) => ({ output })),
      ),
      'durationMs',
      Option.fromUndefinedOr(held.durationMs),
    )
  })
}

/** The commit that turns held outcomes into results, in the order it names them. */
function committed(state: Folding, record: Of<'tool_results_committed'>): Step {
  for (const outcomeId of record.outcomeIds) {
    const held = state.outcomes.get(outcomeId)
    if (held === undefined || held.assistantMessageId !== record.assistantMessageId)
      return outOfPlace(record, 'outcome unknown')
    const result = resultOf(state, held)
    if (Result.isFailure(result)) return failed(result.failure)
    state.outcomes.delete(outcomeId)
    state.items.push(Item.Answered({ message: result.success }))
  }
  const owner = state.owners.get(record.assistantMessageId)
  if (owner !== undefined) answeringOf(state, owner).committedCalls += record.outcomeIds.length
  return ok
}

/** What main's finish hook recorded for the response. */
function metadata(state: Folding, record: Of<'message_metadata'>): Step {
  if (record.submissionId === undefined) return outOfPlace(record, 'metadata without submission')
  const answering = answeringOf(state, record.submissionId)
  const { finishedAt, toolCallCount } = record.metadata
  if (finishedAt !== undefined) answering.finishedAt = Option.some(finishedAt)
  if (toolCallCount !== undefined) answering.toolCallCount = Option.some(toolCallCount)
  return ok
}

const NO_USAGE: ResponseData['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
}

/**
 * A response's metadata entry, as `recordResponse` writes one. Its `inputs` are Pi's submission
 * and entry ids, which exist only once the carry has written them, so the carry adds them. Times
 * are main's own where it recorded them.
 */
function responseOf(answering: Answering, record: Of<'submission_settled'>): Measured {
  const settledAt = millis(record.timestamp)
  const timed: Measured = {
    outcome: record.outcome,
    startedAt: Option.getOrElse(
      Option.orElse(answering.startedAt, () => answering.deliveredAt),
      () => settledAt,
    ),
    finishedAt: Option.getOrElse(answering.finishedAt, () => settledAt),
    // Without main's count, the calls that ran: the results Flue committed.
    toolCallCount: Option.getOrElse(answering.toolCallCount, () => answering.committedCalls),
    usage: answering.replies.reduce(
      (total, message) => ({
        input: total.input + message.usage.input,
        output: total.output + message.usage.output,
        cacheRead: total.cacheRead + message.usage.cacheRead,
        cacheWrite: total.cacheWrite + message.usage.cacheWrite,
        totalTokens: total.totalTokens + message.usage.totalTokens,
        cost: total.cost + message.usage.cost.total,
      }),
      NO_USAGE,
    ),
  }
  const last = Option.fromUndefinedOr(answering.replies.at(-1))
  return including(
    timed,
    'model',
    Option.map(last, (message) => `${message.provider}/${message.model}`),
  )
}

/**
 * A submission settles. A joined delivery's settlement is kept for its host's response; Flue
 * writes it first, with the host's outcome (`settleJoinedSubmissions`). A delivery that stands
 * alone (`delivered`) is its own host, so its settlement ends its own response. The host's settlement
 * ends the response: a message it never completed is dropped, as Flue dropped it, and the
 * response is written after its last entry when it placed or wrote anything, with every input's
 * settlement. A joined delivery whose settlement had not come by then takes the host's outcome,
 * as Flue's settle fan-out gives it; one that comes after adds nothing.
 */
function settled(state: Folding, record: Of<'submission_settled'>): Step {
  const host = state.joined.get(record.submissionId)
  if (host !== undefined) {
    const joined = state.answering.get(host)
    if (joined !== undefined) joined.outcomes.set(record.submissionId, record.outcome)
    return ok
  }
  for (const [messageId, building] of state.building)
    if (building.started.submissionId === record.submissionId) state.building.delete(messageId)
  const answering = state.answering.get(record.submissionId)
  state.answering.delete(record.submissionId)
  if (answering === undefined) return ok
  if (answering.inputs.length === 0 && answering.replies.length === 0) return ok
  if (
    record.outcome === 'completed' &&
    answering.inputs.length > 0 &&
    answering.replies.length === 0
  )
    return failed(new AnswerMissing({ submissionId: record.submissionId }))
  const inputs = answering.inputs.map((submission) => ({
    submission,
    outcome: answering.outcomes.get(submission) ?? record.outcome,
  }))
  state.items.push(Item.Responded({ data: responseOf(answering, record), inputs }))
  return ok
}

/**
 * The items with every trace of a response that never settled taken out of the submission
 * model: its deliveries name no submission and its `Ran` records are dropped, so the carry
 * creates nothing in the store that is placed and never settled (which a store would resume).
 */
function withoutUnsettled(state: Folding): Array<Item> {
  const open = new Set([...state.answering.values()].flatMap((answering) => answering.inputs))
  if (open.size === 0) return state.items
  const bare = (submission: Option.Option<string>) =>
    Option.filter(submission, (id) => !open.has(id))
  return state.items.flatMap((item): Array<Item> => {
    if (Item.$is('Said')(item)) return [Item.Said({ ...item, submission: bare(item.submission) })]
    if (Item.$is('Signalled')(item))
      return [Item.Signalled({ ...item, submission: bare(item.submission) })]
    if (Item.$is('Ran')(item)) return item.inputs.some((id) => open.has(id)) ? [] : [item]
    return [item]
  })
}

/**
 * Which host submission each attempt ran, read from the whole log before any delivery is placed,
 * exactly as Flue reads it for its settlements (`assistantSubmissionByAttempt`, `dispatch-*.mjs`
 * 2945): a model message is started only by the host's response, so its start names the attempt's
 * host, the last one winning as in Flue. Nothing else names a host. A delivery or a start-hook
 * marker does not: on a resumed attempt the first records are a joined delivery's own
 * (`runAgentStartHooks` skips the host's marker when its step exists, 1620, and marks the joined
 * delivery's under its submission, 1641). Nor does the order of settlements: Flue appends each
 * joined settlement and then the host's as separate writes (`conversation-stream-store-2-*.mjs`
 * 5299, 5214, 5383), so a log cut between them ends with a joined delivery's settlement, and
 * reading the last one as the host's names the wrong host. An attempt no model message started
 * has no host here, and every delivery placed under it stands alone.
 */
function hostsByAttempt(records: ReadonlyArray<FlueRecord>): ReadonlyMap<string, string> {
  const startedBy = new Map<string, string>()
  for (const record of records)
    if (
      record.type === 'assistant_message_started' &&
      record.attemptId !== undefined &&
      record.submissionId !== undefined
    )
      startedBy.set(record.attemptId, record.submissionId)
  return startedBy
}

/** One record applied to the state. Every handled type is named, so a new one fails typecheck. */
const apply = (state: Folding, record: FlueRecord): Step =>
  FlueRecord.match(record, {
    conversation_created: (born) => outOfPlace(born, 'second conversation'),
    user_message: (message) => said(state, message),
    signal: (signal) => signalled(state, signal),
    assistant_message_started: (start) => started(state, start),
    assistant_text_started: (open) =>
      opened(state, open, {
        kind: 'text',
        index: open.blockIndex,
        deltas: [],
        finished: Option.none(),
      }),
    assistant_reasoning_started: (open) =>
      opened(state, open, {
        kind: 'thinking',
        index: open.blockIndex,
        deltas: [],
        finished: Option.none(),
      }),
    assistant_text_delta: (delta) => appended(state, delta, 'text'),
    assistant_reasoning_delta: (delta) => appended(state, delta, 'thinking'),
    assistant_text_completed: (done) => textCompleted(state, done),
    assistant_reasoning_completed: (done) => reasoningCompleted(state, done),
    assistant_tool_call: (call) => toolCalled(state, call),
    assistant_message_completed: (done) => completed(state, done),
    tool_outcome: (held) => outcome(state, held),
    tool_results_committed: (commit) => committed(state, commit),
    submission_settled: (settlement) => settled(state, settlement),
    message_metadata: (data) => metadata(state, data),
    // Flue's resource bookkeeping and start-hook marker: nothing a transcript holds.
    resource_snapshot: () => ok,
    agent_start_run: () => ok,
  })

/**
 * Fold one Thread's records, in log order (batch `seq`, then array order), into what the runtime
 * writes for it. This is Flue 2.2.2's own fold (`@flue/runtime` `dist/dispatch-*.mjs`,
 * `applyRecord`) for the root conversation, with its refusals kept as typed failures: a record of
 * another conversation, a block out of order, a delta missing, a file that is not the one named.
 * What the log leaves unfinished is left out as Flue's projection left it: a model message no
 * completion committed, and a tool outcome no commit named. Joined deliveries are grouped with
 * the response they joined when a model message started under their attempt names its host, and
 * otherwise stand alone; each settled response names its deliveries and their outcomes,
 * so the carry can write the submissions and run records the runtime writes. What Pi cannot hold
 * (a recovered partial reply, a tool batch under `stop` or `length`) fails the Thread by name.
 * Pure: the same records and files give the same result.
 */
export function fold(
  threadId: ThreadId,
  records: ReadonlyArray<FlueRecord>,
  attachments: Attachments,
): Result.Result<Carried, FoldFailure> {
  const [birth, ...rest] = records
  if (birth === undefined || !FlueRecord.guards.conversation_created(birth))
    return Result.fail(new StreamStartMissing({ threadId }))
  const state: Folding = {
    root: birth.conversationId,
    items: [],
    attachments,
    building: new Map(),
    replies: new Map(),
    outcomes: new Map(),
    answering: new Map(),
    joined: new Map(),
    attempts: hostsByAttempt(rest),
    owners: new Map(),
  }
  for (const record of rest) {
    if (record.conversationId !== state.root)
      return Result.fail(
        new RecordOutOfPlace({
          recordId: record.id,
          recordType: record.type,
          rule: 'another conversation',
        }),
      )
    const step = apply(state, record)
    if (Option.isSome(step)) return Result.fail(step.value)
  }
  return Result.succeed({ threadId, origin: birth.initialData, items: withoutUnsettled(state) })
}
