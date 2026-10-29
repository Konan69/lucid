import { copyJson, type JsonRepresentation, type JsonValue } from '@earendil-works/chord'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import type { ConversationState } from '@vivid/contracts'
import { Array as Arr, Option, Order, Predicate, Schema } from 'effect'
import type * as Types from 'effect/Types'
import { withoutCorrections } from '../correction.ts'
import { CONTINUATION_ENTRY, continued } from '../continuity.ts'
import { isDeliveryEntry, MessageData, PlacedSignal, SIGNAL_ENTRY, signalShown } from '../delivery.ts'
import { RESPONSE_ENTRY, ResponseData, RUN_ENTRY, RunData } from '../response.ts'

/**
 * The state as strict JSON. It is the contract's `ConversationState` with its unknown payloads
 * (a tool's input and output) typed as JSON and its arrays plain, which is the form Chord's delta
 * functions diff and apply. Nothing in it is ever `undefined`: an absent field is an absent key.
 */
export type Projected = JsonRepresentation<ConversationState>
type Message = Projected['messages'][number]
type Part = Message['parts'][number]

/**
 * What the projection reads of a conversation: transcript entries and Pi's built-in documents by
 * kind. It is Pi's `ConversationView` without the conversation record, so a literal is enough to
 * test with. The link passes every entry it knows of, not only the view's (`link.ts`).
 */
export interface Viewed {
  readonly entries: ReadonlyArray<EntryRecord>
  readonly docs: Readonly<Record<string, JsonObject>>
  /**
   * How submissions ended, by Pi's own record of each (`SubmissionRecord.status`), for those the
   * reader looked up. Pi's view carries no submission records, so the link reads them
   * (`link.ts`); a literal view may leave them out, and then only what the transcript's own
   * `vivid.response` entries say is known.
   */
  readonly outcomes?: ReadonlyMap<number, Outcome>
}

/** How a delivery ended. */
export type Outcome = 'completed' | 'failed' | 'aborted'

const decodeSignal = Schema.decodeUnknownOption(PlacedSignal)
const decodeMessage = Schema.decodeUnknownOption(MessageData)
const decodeResponseData = Schema.decodeUnknownOption(ResponseData)
const decodeRun = Schema.decodeUnknownOption(RunData)

/** An entry is immutable, so what its data decodes to is read once for as long as the entry lives. */
const responses = new WeakMap<EntryRecord, Option.Option<ResponseData>>()
const decodeResponse = (entry: EntryRecord) => {
  const before = responses.get(entry)
  if (before !== undefined) return before
  const decoded = decodeResponseData(entry.data)
  responses.set(entry, decoded)
  return decoded
}

/** One block of a model message Pi is still receiving, as `pi.live` holds it (plain JSON). */
const Block = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('thinking'), thinking: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('toolCall'),
    id: Schema.String,
    name: Schema.String,
    arguments: Schema.Json,
  }),
])

/**
 * The two fields of `pi.live` the state is drawn from (Pi `src/harness/live.ts`, `LiveState`):
 * `run` is present exactly while a run is answering and lists its inputs' submissions in the
 * order they were placed; `generation.message` is the committed partial of the response being
 * received; `generation.retry` is present only while Pi backs off after a failed attempt, and is
 * gone the moment the next request begins (`generation.ts`, the `retry` and `request` phases). A block this reading does not know (a kind a later Pi adds) is left out, not failed on.
 */
const Live = Schema.Struct({
  run: Schema.optionalKey(
    Schema.Struct({ inputs: Schema.Array(Schema.Finite), taskId: Schema.optionalKey(Schema.Int) }),
  ),
  generation: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Schema.Struct({ content: Schema.Array(Schema.Unknown) })),
      retry: Schema.optionalKey(Schema.Unknown),
    }),
  ),
})
const decodeLive = Schema.decodeUnknownOption(Live)
const decodeBlock = Schema.decodeUnknownOption(Block)

/** `pi.inbox` (Pi `src/harness/inbox.ts`): a queued delivery is an item that is not a write. */
const Inbox = Schema.Struct({ items: Schema.Array(Schema.Struct({ mode: Schema.String })) })
const decodeInbox = Schema.decodeUnknownOption(Inbox)

/** Details that carry a tool's own output, which is what a screen reads (`tools/tool.ts` `toolResult`). */
const Receipt = Schema.Struct({ output: Schema.Json })
const decodeReceipt = Schema.decodeUnknownOption(Receipt)

/** Pi's ids ascend in the order entries were written. */
const oldestFirst = Order.mapInput(Order.Number, (entry: EntryRecord) => entry.id)

const iso = (millis: number) => new Date(millis).toISOString()
const done = (text: string): Part => ({ type: 'text', text, state: 'done' })

/** The transcript kinds a delivery is placed as: a Person's words, or a signal the server sent. */
const isInput = (entry: EntryRecord) => isDeliveryEntry(entry.kind)

const userOf = (entry: EntryRecord): Option.Option<UserMessage> => {
  const message = entry.model === undefined ? undefined : entry.model[0]
  return message !== undefined && message.role === 'user' ? Option.some(message) : Option.none()
}
const assistantOf = (entry: EntryRecord): Option.Option<AssistantMessage> => {
  const message = entry.model === undefined ? undefined : entry.model[0]
  return message !== undefined && message.role === 'assistant'
    ? Option.some(message)
    : Option.none()
}
const resultOf = (entry: EntryRecord): Option.Option<ToolResultMessage> => {
  const message = entry.model === undefined ? undefined : entry.model[0]
  return message !== undefined && message.role === 'toolResult'
    ? Option.some(message)
    : Option.none()
}

/**
 * Where a picture's bytes are read, relative to the Thread: the entry it was sent in and its
 * place among that message's content. The runtime serves it (`pictures.ts`); the bytes
 * themselves never enter the state.
 */
export const pictureId = (entry: number, index: number) => `${entry}-${index}`

/** Draw a Person's words and pictures with the sending client's key from `vivid.message`. */
function personMessage(
  entry: EntryRecord,
  message: UserMessage,
  submission: Option.Option<number>,
) {
  const parts: Part[] = Predicate.isString(message.content)
    ? [done(message.content)]
    : message.content.map((block, index) =>
        block.type === 'text'
          ? done(block.text)
          : {
              type: 'file' as const,
              mediaType: block.mimeType,
              url: `attachments/${pictureId(entry.id, index)}`,
            },
      )
  const base = {
    id: `entry-${entry.id}`,
    role: 'user' as const,
    purpose: 'user' as const,
    display: 'visible' as const,
    timestamp: iso(message.timestamp),
    parts,
  }
  const keyed = Option.match(
    Option.map(decodeMessage(entry.data), (data) => data.key),
    {
      onNone: () => base,
      onSome: (key) => ({ ...base, key }),
    },
  )
  return Option.match(submission, {
    onNone: (): Message => keyed,
    onSome: (id): Message => ({ ...keyed, submissionId: String(id) }),
  })
}

/** Draw a server delivery as a diagnostic dispatch with its tag, attributes and body.
 * Clients classify shared messages, Routines and internal signals from these fields. */
function dispatchMessage(
  entry: EntryRecord,
  signal: PlacedSignal,
  submission: Option.Option<number>,
) {
  const placed = Option.map(userOf(entry), (message) => iso(message.timestamp))
  const shown = signalShown(signal)
  const base = {
    id: `entry-${entry.id}`,
    role: 'system' as const,
    purpose: 'dispatch' as const,
    display: 'diagnostic' as const,
    signal: { tagName: shown.tagName, attributes: { ...shown.attributes } },
    parts: [done(shown.body)],
  }
  const timed = Option.match(placed, {
    onNone: () => base,
    onSome: (timestamp) => ({ ...base, timestamp }),
  })
  const keyed = signal.key === undefined ? timed : { ...timed, key: signal.key }
  return Option.match(submission, {
    onNone: (): Message => keyed,
    onSome: (id): Message => ({ ...keyed, submissionId: String(id) }),
  })
}

/** The message a delivery's entry is drawn as, when the entry is one this projection can read. */
function inputMessage(entry: EntryRecord, submission: Option.Option<number>) {
  if (entry.kind === SIGNAL_ENTRY)
    return Option.map(decodeSignal(entry.data), (signal) =>
      dispatchMessage(entry, signal, submission),
    )
  return Option.map(userOf(entry), (message) => personMessage(entry, message, submission))
}

/** Join a tool result's text blocks into its error message, one block per line. */
const wordsOf = (result: ToolResultMessage) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

/** Vivid receipts expose their structured `output`; other tools expose a lone text block
 * as a string or multiple content blocks as a list. Pictures retain their kind and MIME type
 * here. Their bytes remain in the transcript and never enter client state. */
function outputOf(result: ToolResultMessage): JsonValue {
  const receipt = decodeReceipt(result.details)
  if (Option.isSome(receipt)) return copyJson(receipt.value.output)
  const [only] = result.content
  if (result.content.length === 1 && only !== undefined && only.type === 'text') return only.text
  return result.content.map((block): JsonValue =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', mimeType: block.mimeType },
  )
}

/** One tool call, by what is known of it: asked, answered, or failed. */
function toolPart(
  call: { readonly id: string; readonly name: string; readonly input: JsonValue },
  result: Option.Option<ToolResultMessage>,
): Part {
  const asked = {
    type: 'dynamic-tool' as const,
    toolName: call.name,
    toolCallId: call.id,
    input: call.input,
  }
  if (Option.isNone(result)) return { ...asked, state: 'input-available' }
  const answered = result.value
  const ended = answered.isError
    ? { ...asked, state: 'output-error' as const, errorText: wordsOf(answered) }
    : { ...asked, state: 'output-available' as const, output: outputOf(answered) }
  return answered.durationMs === undefined ? ended : { ...ended, durationMs: answered.durationMs }
}

/**
 * The parts of the response Pi is still receiving: the same reading with words and thinking
 * marked `streaming`, so a screen sees them arrive, and a tool call shown as asked.
 */
function liveParts(content: ReadonlyArray<unknown>): Part[] {
  return content.flatMap((raw): Part[] => {
    const block = decodeBlock(raw)
    if (Option.isNone(block)) return []
    const value = block.value
    if (value.type === 'text')
      return value.text.length === 0 ? [] : [{ type: 'text', text: value.text, state: 'streaming' }]
    if (value.type === 'thinking')
      return value.thinking.length === 0
        ? []
        : [{ type: 'reasoning', text: value.thinking, state: 'streaming' }]
    return [
      toolPart({ id: value.id, name: value.name, input: copyJson(value.arguments) }, Option.none()),
    ]
  })
}

/** One run: the deliveries it answered and everything Vivid wrote answering them. */
interface Run {
  /** The entry that began it; a run is named by it for as long as the conversation lives. */
  readonly start: number
  readonly inputs: Array<EntryRecord>
  /** Model messages and tool results, in transcript order. */
  readonly written: Array<EntryRecord>
  response: Option.Option<{ readonly entry: EntryRecord; readonly data: ResponseData }>
}

/** What is known about the transcript's deliveries beyond their entries. */
interface Known {
  /** Entry id of a delivery that joined a run already going, so it does not begin one. */
  readonly joined: Set<number>
  /** Entry id of a delivery to its submission. */
  readonly submissions: Map<number, number>
  /** Submission to how it ended: Pi's record where the reader has it, else the response entry's. */
  readonly outcomes: Map<number, Outcome>
  /** A run's first entry to its response entry. */
  readonly responses: Map<number, { readonly entry: EntryRecord; readonly data: ResponseData }>
  /** Response entries that name no inputs (written before inputs were recorded), oldest first. */
  readonly unnamed: Array<{ readonly entry: EntryRecord; readonly data: ResponseData }>
}

/** The run's own record of its deliveries, written while it runs (`response.ts`). */
function learnRun(known: Known, entry: EntryRecord) {
  const inputs = Option.match(decodeRun(entry.data), {
    onNone: () => [],
    onSome: (run) => run.inputs,
  })
  for (const input of inputs) known.submissions.set(input.entry, input.submission)
  for (const input of inputs.slice(1)) known.joined.add(input.entry)
}

/** An ended run's entry: its times, and the same deliveries with how they ended. */
function learnResponse(known: Known, entry: EntryRecord) {
  const data = decodeResponse(entry)
  if (Option.isNone(data)) return
  const inputs = data.value.inputs === undefined ? [] : data.value.inputs
  const [first, ...rest] = inputs
  if (first === undefined) {
    known.unnamed.push({ entry, data: data.value })
    return
  }
  known.responses.set(first.entry, { entry, data: data.value })
  for (const input of inputs) {
    known.submissions.set(input.entry, input.submission)
    if (data.value.outcome !== undefined) known.outcomes.set(input.submission, data.value.outcome)
  }
  for (const input of rest) known.joined.add(input.entry)
}

/**
 * Read which delivery began which run. A run records its own deliveries in a `vivid.run` entry
 * before it first asks the model, and again when more have joined, so the grouping a screen saw
 * while the run was live is the grouping it sees after, with no moment between. An ended run's
 * `vivid.response` entry says the same. Before the first of those is written, the run answering
 * now is read from `pi.live.run`: its inputs are the newest deliveries of the transcript, because
 * runs do not overlap, so its submissions are matched to the last entries from the end. A
 * delivery nothing names began a run of its own.
 */
function know(
  entries: ReadonlyArray<EntryRecord>,
  running: ReadonlyArray<number>,
  outcomes: ReadonlyMap<number, Outcome>,
): Known {
  const known: Known = {
    joined: new Set(),
    submissions: new Map(),
    outcomes: new Map(),
    responses: new Map(),
    unnamed: [],
  }
  for (const entry of entries) {
    if (entry.kind === RUN_ENTRY) learnRun(known, entry)
    else if (entry.kind === RESPONSE_ENTRY) learnResponse(known, entry)
  }
  const deliveries = entries.filter(isInput)
  const live = deliveries.slice(Math.max(0, deliveries.length - running.length))
  const submissions = running.slice(running.length - live.length)
  live.forEach((entry, index) => {
    const submission = submissions[index]
    if (submission !== undefined) known.submissions.set(entry.id, submission)
    if (index > 0) known.joined.add(entry.id)
  })
  // Pi's record of a submission is the authority on how it ended; it is read last so it wins.
  for (const [submission, outcome] of outcomes) known.outcomes.set(submission, outcome)
  return known
}

/**
 * The submissions a transcript names whose ending it does not itself record: those of the run
 * answering now, and those of a run whose `vivid.response` entry is not there (not yet written,
 * or lost to a kill). A reader looks these up in Pi's own records and passes what it finds back
 * as `outcomes`.
 */
export function unsettled(view: Viewed): ReadonlyArray<number> {
  const live: typeof Live.Type = Option.getOrElse(decodeLive(view.docs['pi.live']), () => ({}))
  const known = know(
    withoutCorrections(Arr.sort(view.entries, oldestFirst)),
    live.run === undefined ? [] : live.run.inputs,
    new Map(),
  )
  const named = new Set([
    ...known.submissions.values(),
    ...(live.run === undefined ? [] : live.run.inputs),
  ])
  return [...named].filter((submission) => !known.outcomes.has(submission))
}

/** Walk the transcript once, oldest first, gathering each run's deliveries and writing. */
function runsOf(entries: ReadonlyArray<EntryRecord>, known: Known): Array<Run> {
  const runs: Array<Run> = []
  const begin = (entry: EntryRecord): Run => {
    const run: Run = {
      start: entry.id,
      inputs: [],
      written: [],
      response: Option.fromUndefinedOr(known.responses.get(entry.id)),
    }
    runs.push(run)
    return run
  }
  const unnamed = [...known.unnamed]
  for (const entry of entries) {
    const current = runs.at(-1)
    if (isInput(entry)) {
      const run = current === undefined || !known.joined.has(entry.id) ? begin(entry) : current
      run.inputs.push(entry)
    } else if (['pi.assistant', 'pi.tool-result', CONTINUATION_ENTRY].includes(entry.kind)) {
      // Writing with no delivery before it in what is known (the transcript's start was not
      // read) is still a reply, and is drawn as a run that begins there.
      const run = current === undefined ? begin(entry) : current
      run.written.push(entry)
    } else if (unnamed[0] !== undefined && unnamed[0].entry === entry && current !== undefined) {
      // An entry that names no inputs describes the run it follows.
      if (Option.isNone(current.response)) current.response = Option.fromUndefinedOr(unnamed[0])
      unnamed.shift()
    }
  }
  return runs
}

/** A model message that did not finish: the provider failed, or a stop cut it short. */
const unfinished = (message: AssistantMessage) =>
  message.stopReason === 'error' || message.stopReason === 'aborted'

/** The words and thinking of one model message, and its tool calls when Pi ran them. */
function saidParts(message: AssistantMessage): Part[] {
  return message.content.flatMap((block): Part[] => {
    if (block.type === 'text')
      return block.text.length === 0 ? [] : [{ type: 'text', text: block.text, state: 'done' }]
    if (block.type === 'thinking')
      return block.thinking.length === 0
        ? []
        : [{ type: 'reasoning', text: block.thinking, state: 'done' }]
    // Pi runs tool calls only from a message that stopped to use tools (`generation.ts`
    // `classify`). A call in any other message was never run and never will be, so it is not a
    // step, and a `show` among them is not something Vivid showed.
    if (message.stopReason !== 'toolUse') return []
    return [
      toolPart({ id: block.id, name: block.name, input: copyJson(block.arguments) }, Option.none()),
    ]
  })
}

/**
 * Put a tool's result on the call it answers: the newest call with that id still waiting. Pi
 * names a call by its model message and its id together, and a provider may use an id again in a
 * later round, so a result is matched in transcript order and never reaches back over a call that
 * already has its own.
 */
function answer(parts: Array<Part>, result: ToolResultMessage) {
  const waiting = Arr.findLastIndex(
    parts,
    (part) =>
      part.type === 'dynamic-tool' &&
      part.state === 'input-available' &&
      part.toolCallId === result.toolCallId,
  )
  if (Option.isNone(waiting)) return
  const call = parts[waiting.value]
  if (call === undefined || call.type !== 'dynamic-tool') return
  parts[waiting.value] = toolPart(
    { id: call.toolCallId, name: call.toolName, input: call.input },
    Option.some(result),
  )
}

/** Keep an adopted prefix and its suffix in one text part. Clients separate distinct parts
 * with paragraphs, which would split a word or Markdown construct cut off by recovery. */
const continuedParts = () => {
  const parts: Part[] = []
  let prefix = Option.none<Types.Mutable<Extract<Part, { type: 'text' }>>>()
  return {
    parts,
    append(next: ReadonlyArray<Part>, continuing: boolean) {
      for (const part of next) {
        if (part.type !== 'text') {
          parts.push(part)
          if (part.type === 'dynamic-tool') prefix = Option.none()
        } else if (Option.isNone(prefix)) {
          const text = { ...part }
          parts.push(text)
          if (continuing) prefix = Option.some(text)
        } else {
          prefix.value.text += part.text
          prefix.value.state = part.state
          if (!continuing) prefix = Option.none()
        }
      }
    },
  }
}

/** Walk committed reply parts and the live tail in order. Recovery keeps adopted words;
 * other unfinished attempts are visible until another message or request replaces them. */
function replyParts(written: ReadonlyArray<EntryRecord>, tail: Tail) {
  const adopted = continued(written)
  const arriving = liveParts(tail.partial)
  const last = Arr.findLast(written, (entry) => Option.isSome(assistantOf(entry)))
  const joined = continuedParts()
  for (const entry of written) {
    const result = resultOf(entry)
    if (Option.isSome(result)) answer(joined.parts, result.value)
    const message = assistantOf(entry)
    if (Option.isNone(message)) continue
    const resuming =
      message.value.stopReason === 'aborted' &&
      (adopted.has(entry.id) || (Option.isSome(tail.task) && entry.byTaskId === tail.task.value))
    if (!resuming && unfinished(message.value) && (!Option.contains(last, entry) || tail.replacing))
      continue
    joined.append(saidParts(message.value), resuming)
  }
  joined.append(arriving, false)
  return joined.parts
}

/**
 * Vivid's reply for one run: one message, whatever number of model turns and tool rounds it
 * took, as the screens have always drawn a reply with its steps inside. Its id is the run's, not
 * an entry's, so the message a screen watched being written is the same message once it is
 * committed, and across every later change to it.
 */
function replyMessage(
  run: Run,
  tail: Tail,
  submission: Option.Option<number>,
): Option.Option<Message> {
  const parts = replyParts(run.written, tail)
  if (parts.length === 0) return Option.none()
  const first = run.written.flatMap((entry) => Option.toArray(assistantOf(entry)))[0]
  const base = {
    id: `run-${run.start}`,
    role: 'assistant' as const,
    purpose: 'assistant' as const,
    display: 'visible' as const,
    parts,
  }
  const timed = first === undefined ? base : { ...base, timestamp: iso(first.timestamp) }
  const owned = Option.match(submission, {
    onNone: () => timed,
    onSome: (id) => ({ ...timed, submissionId: String(id) }),
  })
  return Option.some(
    Option.match(run.response, {
      onNone: (): Message => owned,
      onSome: ({ data }): Message => ({
        ...owned,
        metadata: { startedAt: data.startedAt, finishedAt: data.finishedAt },
      }),
    }),
  )
}

/** A failed or stopped reply produces a diagnostic advisory. Clients read its settlement
 * outcome and choose their own wording; provider failure text never reaches the client. */
function advisory(
  run: Run,
  submission: Option.Option<number>,
  known: Known,
): Option.Option<Message> {
  const outcome = Option.flatMap(submission, (id) => Option.fromUndefinedOr(known.outcomes.get(id)))
  if (Option.isNone(outcome) || outcome.value === 'completed') return Option.none()
  const base = {
    id: `end-${run.start}`,
    role: 'system' as const,
    purpose: 'advisory' as const,
    display: 'diagnostic' as const,
    settlement: { outcome: outcome.value },
    parts: [
      done(outcome.value === 'failed' ? 'The reply was not finished.' : 'The reply was stopped.'),
    ],
  }
  // When it ended is known only from the response entry, which may not be there.
  const timed = Option.match(run.response, {
    onNone: () => base,
    onSome: ({ data }) => ({ ...base, timestamp: iso(data.finishedAt) }),
  })
  return Option.some(
    Option.match(submission, {
      onNone: (): Message => timed,
      onSome: (id): Message => ({ ...timed, submissionId: String(id) }),
    }),
  )
}

/**
 * One run's messages in the order a screen reads them: each delivery where it was placed, the
 * reply after the delivery that began it (and before a delivery that joined later, which was
 * placed after the reply had begun), and the advisory last.
 */
function runMessages(run: Run, tail: Tail, known: Known): Array<Message> {
  const submissionOf = (entry: number) => Option.fromUndefinedOr(known.submissions.get(entry))
  const owner = submissionOf(run.start)
  const firstWritten = run.written[0]
  const reply = replyMessage(run, tail, owner)
  const before: Array<Message> = []
  const after: Array<Message> = []
  for (const entry of run.inputs) {
    const message = inputMessage(entry, submissionOf(entry.id))
    if (Option.isNone(message)) continue
    if (firstWritten !== undefined && entry.id > firstWritten.id) after.push(message.value)
    else before.push(message.value)
  }
  return [
    ...before,
    ...Option.toArray(reply),
    ...after,
    ...Option.toArray(advisory(run, owner, known)),
  ]
}

/**
 * How each of a run's deliveries ended. Every delivery of a run that was answered was answered
 * by that run's reply, which is named by the delivery that began it; so the answerer of a
 * delivery that joined is the run's first, and of the first, itself.
 */
function settlementsOf(run: Run, known: Known): Projected['settlements'] {
  const answerer = known.submissions.get(run.start)
  return run.inputs.flatMap((entry) => {
    const submission = known.submissions.get(entry.id)
    const outcome = submission === undefined ? undefined : known.outcomes.get(submission)
    if (submission === undefined || outcome === undefined) return []
    const ended = { submissionId: String(submission), outcome }
    return outcome === 'completed' && answerer !== undefined
      ? [{ ...ended, answeredBy: String(answerer) }]
      : [ended]
  })
}

/** A run's messages and what they were made from, kept so an unchanged run is not made again. */
interface Kept {
  readonly from: ReadonlyArray<unknown>
  readonly messages: Array<Message>
}

/**
 * What `pi.live` adds to the run answering now: the partial of the response arriving, and
 * whether Pi has begun a request after the last message it committed.
 */
interface Tail {
  readonly partial: ReadonlyArray<unknown>
  readonly replacing: boolean
  readonly task: Option.Option<number>
}

/** No tail: one value, so a run that is not answering compares equal to itself. */
const NO_PARTIAL: ReadonlyArray<unknown> = []
const NO_TAIL: Tail = { partial: NO_PARTIAL, replacing: false, task: Option.none() }

const same = (left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>) =>
  left.length === right.length && left.every((value, index) => value === right[index])

/**
 * A projector that remembers. Each call projects the whole view, but a run whose entries,
 * response, submissions and live tail are the same objects and values as last time gives back
 * the messages it gave then. Pi's entries are immutable and shared between revisions of a view,
 * so in a long Thread every commit rebuilds only the run being written; and because unchanged
 * messages are the same objects, the diff that follows passes over them by identity.
 */
export function projector() {
  const kept = new Map<number, Kept>()
  return (view: Viewed): Projected => {
    const entries = withoutCorrections(Arr.sort(view.entries, oldestFirst))
    const live: typeof Live.Type = Option.getOrElse(decodeLive(view.docs['pi.live']), () => ({}))
    const inbox = decodeInbox(view.docs['pi.inbox'])
    const running =
      live.run === undefined ? Option.none<ReadonlyArray<number>>() : Option.some(live.run.inputs)
    const known = know(
      entries,
      Option.getOrElse(running, () => []),
      view.outcomes === undefined ? new Map() : view.outcomes,
    )
    const runs = runsOf(entries, known)
    const lastRun = runs.at(-1)
    const partial =
      live.generation === undefined || live.generation.message === undefined
        ? NO_PARTIAL
        : live.generation.message.content
    // A generation with no `retry` is a request in progress; with one, Pi is waiting to try again.
    const replacing = live.generation !== undefined && live.generation.retry === undefined
    const task = Option.flatMap(Option.fromUndefinedOr(live.run), (run) =>
      Option.fromUndefinedOr(run.taskId),
    )
    const seen = new Set<number>()
    const messages = runs.flatMap((run) => {
      // Only the run that is answering has a tail: a partial left in `pi.live` is its own.
      const answering = Option.isSome(running) && run === lastRun
      const tail = answering ? { partial, replacing, task } : NO_TAIL
      const submissions = run.inputs.map((entry) => known.submissions.get(entry.id))
      const from = [
        ...run.inputs,
        ...run.written,
        Option.getOrUndefined(Option.map(run.response, (response) => response.entry)),
        tail.partial,
        tail.replacing,
        Option.getOrUndefined(tail.task),
        ...submissions,
        ...submissions.map((submission) =>
          submission === undefined ? undefined : known.outcomes.get(submission),
        ),
      ]
      seen.add(run.start)
      const before = kept.get(run.start)
      if (before !== undefined && same(before.from, from)) return before.messages
      const made = runMessages(run, tail, known)
      kept.set(run.start, { from, messages: made })
      return made
    })
    for (const start of kept.keys()) if (!seen.has(start)) kept.delete(start)
    return {
      messages,
      settlements: runs.flatMap((run) => settlementsOf(run, known)),
      working: Option.isSome(running),
      queued: Option.match(inbox, {
        onNone: () => 0,
        onSome: ({ items }) => items.filter((item) => item.mode !== 'write').length,
      }),
    }
  }
}

/**
 * A conversation as a screen reads it. Pure: the same view gives the same state. The system
 * prompt (`pi.system`), resets and compaction summaries, and every document but `pi.live` and
 * `pi.inbox` are never read, so the instruction, the context kept for a delivery and the record
 * of who started the Thread cannot reach a screen from here. What a Person, the model or a tool
 * wrote is copied as written; this does not read it for what it says.
 */
export const project = (view: Viewed): Projected => projector()(view)
