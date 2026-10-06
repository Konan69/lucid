import { copyJson, type JsonValue } from '@earendil-works/chord'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  SnapshotEvent,
  TaskId,
  SubmissionId,
  EntryId,
} from '@earendil-works/pi-durable'
import type { UIMessageChunk } from 'ai'
import { Array as Arr, Data, Match, Option, Schema } from 'effect'

/** Pi's closed event and block types are exhaustive; an impossible branch indicates an SDK contract defect. */
const unreachable = (value: never): never => {
  throw new Error(`Unexpected Pi variant: ${String(value)}`)
}

/** Tool inputs are Pi-validated JSON; retain that guarantee instead of widening to AI SDK unknown. */
export type Chunk =
  | Exclude<UIMessageChunk, { type: 'tool-input-available' }>
  | (Omit<Extract<UIMessageChunk, { type: 'tool-input-available' }>, 'input'> & {
      readonly input: JsonValue
    })

/**
 * How far one content block of the in-flight assistant message has been reported.
 *
 * Pi Durable reports starts/deltas, non-terminal block/message replacements, and the terminal entry
 * at message_end. Recovered partials are open blocks too. Replacements never imply completion;
 * only the terminal entry closes a block. Record the emitted prefix so each identified block gets
 * one start and one terminal chunk (input error for aborted tools, never executable partial input).
 */
type Reported = Data.TaggedEnum<{ Open: { readonly length: number }; Closed: {} }>
const Reported = Data.taggedEnum<Reported>()

/**
 * Translator state for one run. A run is the turns from an input to its final answer and becomes one
 * AI SDK assistant message; each turn becomes one AI SDK step.
 */
export type RunState = {
  /** Retry entries share the same generation task and therefore the same SDK step. */
  readonly generation: Option.Option<TaskId>
  /** Durable result entries reported by this reader, across step changes and snapshot/live overlap. */
  readonly results: ReadonlySet<EntryId>
  /** Turns started in this run. */
  readonly turn: number
  /**
   * Model responses started in this run. A turn has more than one when Pi Durable retries a failed
   * request, so part ids use this counter and never collide across attempts.
   */
  readonly response: number
  /** Blocks of the current response already reported, by `contentIndex`. */
  readonly blocks: ReadonlyMap<number, Reported>
  /** Latest partial blocks, including later content waiting behind an anonymous tool identity. */
  readonly content: ReadonlyMap<number, Block>
  /** Calls opened in this response; rejected anonymous calls cannot emit orphan result chunks. */
  readonly calls: ReadonlySet<string>
  /**
   * Error text of the newest response when it failed. Pi Durable retries a failed request, so a
   * failure is reported only if the run ends with it still standing. Empty when there is none.
   */
  readonly failure: readonly string[]
}

export const initialRunState: RunState = {
  generation: Option.none(),
  turn: 0,
  response: 0,
  blocks: new Map(),
  content: new Map(),
  calls: new Set(),
  failure: [],
  results: new Set(),
}

type Block = AssistantMessage['content'][number]
export type Step = { readonly state: RunState; readonly chunks: readonly Chunk[] }

/** Part id of one block. AI SDK text and reasoning parts are matched across chunks by this id. */
const partId = (state: RunState, contentIndex: number) => `${state.response}:${contentIndex}`

/** Chunks that open a block. A tool call opens as a dynamic tool: the client holds no typed tool set. */
function openBlock(state: RunState, contentIndex: number, block: Block): readonly Chunk[] {
  const id = partId(state, contentIndex)
  switch (block.type) {
    case 'text':
      return [{ type: 'text-start', id }]
    case 'thinking':
      return [{ type: 'reasoning-start', id }]
    case 'toolCall':
      return [
        { type: 'tool-input-start', toolCallId: block.id, toolName: block.name, dynamic: true },
      ]
  }
  return unreachable(block)
}

/** OpenAI completions and Bedrock can announce a tool before either wire identity is known. */
const identified = (block: Block) =>
  block.type !== 'toolCall' || (block.id.length > 0 && block.name.length > 0)

/** Chunks that close a block whose final value is `block`. */
function closeBlock(state: RunState, contentIndex: number, block: Block): readonly Chunk[] {
  const id = partId(state, contentIndex)
  switch (block.type) {
    case 'text':
      return [{ type: 'text-end', id }]
    case 'thinking':
      return [{ type: 'reasoning-end', id }]
    case 'toolCall':
      return [
        {
          type: 'tool-input-available',
          toolCallId: block.id,
          toolName: block.name,
          input: copyJson(block.arguments),
          dynamic: true,
        },
      ]
  }
  return unreachable(block)
}

/** The text a block holds now, as one delta. Empty text gives no chunk; a tool call has none. */
function blockBody(
  state: RunState,
  contentIndex: number,
  block: Block,
  offset: number,
): readonly Chunk[] {
  const id = partId(state, contentIndex)
  if (block.type === 'text' && block.text.length > offset)
    return [{ type: 'text-delta', id, delta: block.text.slice(offset) }]
  if (block.type === 'thinking' && block.thinking.length > offset) {
    return [{ type: 'reasoning-delta', id, delta: block.thinking.slice(offset) }]
  }
  return []
}

/** UTF-16 offsets match JavaScript slice; tool arguments never enter the text reconciliation. */
function bodyLength(block: Block): number {
  switch (block.type) {
    case 'text':
      return block.text.length
    case 'thinking':
      return block.thinking.length
    case 'toolCall':
      return 0
  }
  return unreachable(block)
}

/** The whole content of a block that was never streamed, as one delta between its start and end. */
function wholeBlock(state: RunState, contentIndex: number, block: Block): readonly Chunk[] {
  return [
    ...openBlock(state, contentIndex, block),
    ...blockBody(state, contentIndex, block, 0),
    ...closeBlock(state, contentIndex, block),
  ]
}

const mark = (state: RunState, contentIndex: number, reported: Reported): RunState => ({
  ...state,
  blocks: new Map(state.blocks).set(contentIndex, reported),
})

/** Record presentation identity separately from Pi result entry deduplication. */
function recordCall(state: RunState, block: Block): RunState {
  return block.type === 'toolCall'
    ? { ...state, calls: new Set([...state.calls, block.id]) }
    : state
}

/** A new turn: one AI SDK step. */
const startTurn = (state: RunState): Step => ({
  state: {
    ...state,
    turn: state.turn + 1,
    blocks: new Map(),
    content: new Map(),
    calls: new Set(),
  },
  chunks: [{ type: 'start-step' }],
})

/**
 * A new model response begins with `partial` already in it. When the step already shows blocks of an
 * earlier attempt, they are removed first: `reset-step` drops every part added since the step began.
 */
function startResponse(state: RunState, partial: AssistantMessage): Step {
  const reset: readonly Chunk[] = state.blocks.size > 0 ? [{ type: 'reset-step' }] : []
  const fresh: RunState = {
    ...state,
    response: state.response + 1,
    blocks: new Map(),
    content: new Map(),
    calls: new Set(),
    failure: [],
  }
  return partial.content.reduce<Step>(
    (step, block, contentIndex) => join(step, updateBlock(step.state, contentIndex, block)),
    { state: fresh, chunks: reset },
  )
}

/**
 * Pi's throttled final partial may never commit. Emit the terminal value's unsent text suffix
 * before closing, opening the block first when nothing was streamed. Never duplicate its prefix.
 */
function finishBlock(state: RunState, contentIndex: number, block: Block): Step {
  // generation.js startToolRound executes offered names even with an empty id. It rejects an
  // empty name as tool_unavailable without a task. At the terminal entry use the id Pi recorded.
  if (block.type === 'toolCall' && block.name.length === 0) return { state, chunks: [] }
  const reported = state.blocks.get(contentIndex)
  if (reported !== undefined && Reported.$is('Closed')(reported)) return { state, chunks: [] }
  const chunks =
    reported !== undefined && Reported.$is('Open')(reported)
      ? [
          ...blockBody(state, contentIndex, block, reported.length),
          ...closeBlock(state, contentIndex, block),
        ]
      : wholeBlock(state, contentIndex, block)
  return { state: mark(recordCall(state, block), contentIndex, Reported.Closed()), chunks }
}

/**
 * A document replacement is only a partial update. Provider scratch buffers and signatures cause
 * Pi events.js messageChanges to emit block/message changes while the block is still streaming.
 * Keep it open; final tool arguments and approval eligibility belong solely to message_end.
 */
function reportBlock(state: RunState, contentIndex: number, block: Block): Step {
  if (!identified(block)) return { state, chunks: [] }
  const reported = state.blocks.get(contentIndex)
  if (reported !== undefined && Reported.$is('Closed')(reported)) return { state, chunks: [] }
  const chunks =
    reported === undefined
      ? [...openBlock(state, contentIndex, block), ...blockBody(state, contentIndex, block, 0)]
      : blockBody(state, contentIndex, block, reported.length)
  return {
    state: mark(
      recordCall(state, block),
      contentIndex,
      Reported.Open({ length: bodyLength(block) }),
    ),
    chunks,
  }
}

/**
 * Anonymous tools form a content-order barrier across batches. Retain latest blocks rather than
 * duplicated delta lists: earlier text keeps streaming; later starts and text wait for identity.
 * The terminal entry resolves the barrier even when Pi rejects the anonymous call.
 */
function updateBlock(state: RunState, contentIndex: number, block: Block): Step {
  const content = new Map(state.content).set(contentIndex, block)
  const replaced = replaceContent(state, content)
  return join(replaced, releaseContent(replaced.state))
}

/** Emitted SDK prefixes cannot be retracted with deltas; test the actual sent prefix, not length.
 * Missing/changed identities also require a rebuild so the client never retains an orphan part. */
function extendsReported(before: Block, after: Block, reported: Reported): boolean {
  const length = Reported.$is('Open')(reported) ? reported.length : bodyLength(before)
  switch (before.type) {
    case 'text':
      return after.type === 'text' && after.text.startsWith(before.text.slice(0, length))
    case 'thinking':
      return (
        after.type === 'thinking' && after.thinking.startsWith(before.thinking.slice(0, length))
      )
    case 'toolCall':
      return after.type === 'toolCall' && after.id === before.id && after.name === before.name
  }
}

/** An authoritative non-prefix replacement resets this response's SDK step and rebuilds it.
 * Includes equal/greater-length edits and removed blocks, retaining every earlier durable step.
 * Buffered anonymous blocks have not been reported and therefore need no client reset. */
function replaceContent(state: RunState, content: ReadonlyMap<number, Block>): Step {
  const replaced = [...state.blocks].some(([index, reported]) => {
    const before = state.content.get(index)
    const after = content.get(index)
    return before === undefined || after === undefined || !extendsReported(before, after, reported)
  })
  return replaced
    ? {
        state: { ...state, content, blocks: new Map(), calls: new Set() },
        chunks: [{ type: 'reset-step' }],
      }
    : { state: { ...state, content }, chunks: [] }
}

/** Release all newly identifiable prefixes without reading state outside the pure translator. */
function releaseContent(state: RunState): Step {
  let step: Step = { state, chunks: [] }
  for (const [index, current] of [...state.content].toSorted(([left], [right]) => left - right)) {
    if (!identified(current)) break
    step = join(step, reportBlock(step.state, index, current))
  }
  return step
}

/** Whole-message replacements update every partial block without implying a provider end. */
function updateMessage(state: RunState, message: AssistantMessage): Step {
  const replaced = replaceContent(
    state,
    new Map(message.content.map((block, index) => [index, block])),
  )
  return join(replaced, releaseContent(replaced.state))
}

/** A document append extends an already-open text/reasoning block's reported prefix. */
function appendBody(state: RunState, contentIndex: number, delta: string): Step {
  const block = state.content.get(contentIndex)
  if (block === undefined || block.type === 'toolCall')
    throw new Error('Pi appended text without a content block')
  return updateBlock(
    state,
    contentIndex,
    block.type === 'text'
      ? { ...block, text: block.text + delta }
      : { ...block, thinking: block.thinking + delta },
  )
}

/** Apply one change to the in-flight assistant message. */
function applyChange(state: RunState, change: MessageChange): Step {
  switch (change.type) {
    // Pi Durable commits partials at most every 100 ms, so a block is often first seen with text
    // already in it. A real provider showed this: dropping it cut the start off the answer.
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
      return updateBlock(state, change.contentIndex, change.block)
    case 'text_delta':
    case 'thinking_delta':
      return appendBody(state, change.contentIndex, change.delta)
    // events.js messageChanges uses this for path-local arguments string appends. Provider scratch
    // JSON also survives in block/message changes; this bridge does not stream tool arguments yet.
    case 'toolcall_delta':
      return { state, chunks: [] }
    case 'block':
      return updateBlock(state, change.contentIndex, change.block)
    case 'message':
      return updateMessage(state, change.message)
  }
  return unreachable(change)
}

/** Report every block of `message` that is not closed yet. */
function finishMessage(state: RunState, message: AssistantMessage): Step {
  return message.content.reduce<Step>(
    (step, block, contentIndex) => {
      // An aborted provider retains parsed partial arguments, never a complete executable input.
      const next =
        message.stopReason === 'aborted' && block.type === 'toolCall'
          ? abortBlock(step.state, contentIndex, block)
          : finishBlock(step.state, contentIndex, block)
      return { state: next.state, chunks: [...step.chunks, ...next.chunks] }
    },
    replaceContent(state, new Map(message.content.map((block, index) => [index, block]))),
  )
}

/** SDK tool-input-error closes unfinished input honestly; abort has no per-tool state of its own. */
function abortBlock(
  state: RunState,
  contentIndex: number,
  block: Extract<Block, { type: 'toolCall' }>,
): Step {
  if (!identified(block)) return { state, chunks: [] }
  const opened = reportBlock(state, contentIndex, block)
  return {
    state: mark(opened.state, contentIndex, Reported.Closed()),
    chunks: [
      ...opened.chunks,
      {
        type: 'tool-input-error',
        toolCallId: block.id,
        toolName: block.name,
        input: copyJson(block.arguments),
        errorText: 'Tool input was interrupted before it completed',
        dynamic: true,
      },
    ],
  }
}

/** Text of a tool result, the form an AI SDK error part carries. */
const resultText = (result: ToolResultMessage) =>
  result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

/** The tool result message of a `pi.tool-result` entry. */
function toolResult(entry: EntryRecord): Option.Option<ToolResultMessage> {
  return Option.fromNullishOr(entry.model).pipe(
    Option.flatMap(Arr.head),
    Option.filter((message): message is ToolResultMessage => message.role === 'toolResult'),
  )
}

/**
 * The end of one tool call. An absent entry means the tool task faulted or was orphaned, which the
 * model also sees as a failed call.
 */
function toolEnd(toolCallId: string, entry: Option.Option<EntryRecord>): readonly Chunk[] {
  const found = Option.flatMap(entry, toolResult)
  if (Option.isNone(found)) {
    return [
      {
        type: 'tool-output-error',
        toolCallId,
        errorText: 'The tool did not finish',
        dynamic: true,
      },
    ]
  }
  const result = found.value
  if (result.isError) {
    return [{ type: 'tool-output-error', toolCallId, errorText: resultText(result), dynamic: true }]
  }
  // A tool bridged from the AI SDK keeps its own output beside the text; the client gets that, as
  // `streamText` would give it. Any other Pi Durable tool gives what the model read, and its details.
  const output = bridgedOutput(result.details)
  return [
    Option.isNone(output)
      ? {
          type: 'tool-output-available',
          toolCallId,
          output: { content: result.content, details: result.details },
          dynamic: true,
        }
      : { type: 'tool-output-available', toolCallId, output: output.value.output },
  ]
}

/** Snapshot and live events can carry the same result. Entry identity spans steps without hiding reused call ids. */
function resultStep(state: RunState, callId: string, entry: Option.Option<EntryRecord>): Step {
  if (!state.calls.has(callId)) return { state, chunks: [] }
  if (Option.isSome(entry) && state.results.has(entry.value.id)) return { state, chunks: [] }
  return {
    state: Option.isNone(entry)
      ? state
      : { ...state, results: new Set([...state.results, entry.value.id]) },
    chunks: toolEnd(callId, entry),
  }
}

/** The output a bridged tool stored in its result details: `{ output }` and nothing else. */
const BridgedOutput = Schema.Struct({ output: Schema.Unknown })
const decodeBridgedOutput = Schema.decodeUnknownOption(BridgedOutput, { onExcessProperty: 'error' })

/** Pi details are SDK ingress; only the bridge's exact single-key envelope is recognized. */
function bridgedOutput(
  details: ToolResultMessage['details'],
): Option.Option<typeof BridgedOutput.Type> {
  return decodeBridgedOutput(details)
}

/**
 * The end of one model response: close its blocks. A failed response is remembered, not reported,
 * because Pi Durable may retry it; `run_end` reports it if nothing replaced it.
 */
function assistantEnd(state: RunState, message: AssistantMessage): Step {
  const finished = finishMessage(state, message)
  if (message.stopReason === 'error') {
    const failure = [message.errorMessage ?? 'The model request failed']
    return { state: { ...finished.state, failure }, chunks: finished.chunks }
  }
  const ending: readonly Chunk[] = message.stopReason === 'aborted' ? [{ type: 'abort' }] : []
  return { state: finished.state, chunks: [...finished.chunks, ...ending] }
}

/**
 * Translate one Pi Durable agent event into AI SDK UI message chunks.
 *
 * Pure: the same state and event always give the same chunks, so the mapping is testable without a
 * harness. Events with no AI SDK counterpart (inbox, usage, compaction, agent changes) give no
 * chunks here; they are the caller's to surface.
 */
export function translate(state: RunState, event: AgentEvent): Step {
  return Match.value(event).pipe(
    Match.when({ type: 'run_start' }, (started): Step => ({
      state: initialRunState,
      chunks: [{ type: 'start', messageId: runMessageId(started.inputs) }],
    })),
    Match.when({ type: 'run_end' }, (): Step => ({
      state,
      chunks: [
        ...state.failure.map((errorText): Chunk => ({ type: 'error', errorText })),
        { type: 'finish' },
      ],
    })),
    Match.when({ type: 'turn_start' }, () => startTurn(state)),
    Match.when({ type: 'message_start' }, (started) =>
      started.message.role === 'assistant'
        ? startResponse(state, started.message)
        : { state, chunks: [] },
    ),
    Match.when({ type: 'turn_end' }, (): Step => ({ state, chunks: [{ type: 'finish-step' }] })),
    Match.when({ type: 'message_update' }, (update) =>
      // Pi's view-op order may append trailing blocks before replacing an earlier anonymous tool.
      // Within the batch, reveal identities in provider content order; equal-index deltas stay stable.
      update.changes
        .toSorted((left, right) =>
          'contentIndex' in left && 'contentIndex' in right
            ? left.contentIndex - right.contentIndex
            : 0,
        )
        .reduce<Step>(
          (step, change) => {
            const next = applyChange(step.state, change)
            return { state: next.state, chunks: [...step.chunks, ...next.chunks] }
          },
          { state, chunks: [] },
        ),
    ),
    Match.when({ type: 'message_end' }, (ended) =>
      Option.fromNullishOr(ended.entry.model).pipe(
        Option.flatMap(Arr.head),
        Option.filter((message): message is AssistantMessage => message.role === 'assistant'),
        Option.match({
          onNone: () => ({ state, chunks: [] }),
          onSome: (message) => assistantEnd(state, message),
        }),
      ),
    ),
    Match.when({ type: 'tool_execution_end' }, (ended) =>
      resultStep(state, ended.toolCallId, Option.fromNullishOr(ended.entry)),
    ),
    Match.orElse((other) => untranslated(state, other)),
  )
}

const join = (a: Step, b: Step): Step => ({ state: b.state, chunks: [...a.chunks, ...b.chunks] })

/** Snapshot observation has bounded the entries to the first input of this run; steers are transparent. */
function runEntries(entries: readonly EntryRecord[]): readonly EntryRecord[] {
  const start = entries.findIndex((entry) => entry.kind === 'pi.user')
  return entries.slice(start + 1)
}

/** One stored entry of the run in progress, as the chunks its live events would have produced. */
export function replayEntry(state: RunState, entry: EntryRecord): Step {
  const found = Option.fromNullishOr(entry.model).pipe(Option.flatMap(Arr.head))
  if (Option.isNone(found)) return { state, chunks: [] }
  const message = found.value
  if (message.role === 'assistant') {
    // generation.js retries append another assistant entry under the same task. events.js only
    // starts a turn when that task changes, so snapshots must reset the attempt within its step.
    const same = entry.byTaskId !== undefined && Option.contains(state.generation, entry.byTaskId)
    const turn = same ? { state, chunks: [] } : startTurn(state)
    const response = startResponse(
      { ...turn.state, generation: Option.fromNullishOr(entry.byTaskId) },
      message,
    )
    return join(join(turn, response), assistantEnd(response.state, message))
  }
  if (message.role === 'toolResult')
    return resultStep(state, message.toolCallId, Option.some(entry))
  return { state, chunks: [] }
}

/** The partial response of the generation in flight: a turn, then each block with its text so far. */
function replayPartial(state: RunState, message: AssistantMessage): Step {
  const turn = state.failure.length > 0 ? { state, chunks: [] } : startTurn(state)
  return join(turn, startResponse(turn.state, message))
}

/**
 * Rebuild the chunks of the run in progress from a snapshot, for a client that attaches late or
 * reconnects. Pi Durable replays no events; it gives the current state. The result is the stream
 * prefix that brings an AI SDK reader to that state, and the translator state from which the live
 * events continue. `undefined` means no run is in progress.
 *
 * The observation adapter bounds entries to the first placed input; later steers are transparent.
 */
export function replay(snapshot: SnapshotEvent): Option.Option<Rebuilt> {
  if (snapshot.run === undefined) return Option.none()
  const started: Step = {
    state: initialRunState,
    // SDK chat.ts retains the streaming state after a network error. Its start chunk only
    // changes identity; process-ui-message-stream.ts reset-step clears the retained current step.
    chunks: [
      { type: 'start', messageId: runMessageId(snapshot.run.inputs) },
      { type: 'reset-step' },
    ],
  }
  const stored = runEntries(snapshot.entries).reduce<Step>(
    (step, entry) => join(step, replayEntry(step.state, entry)),
    started,
  )
  const partial = Option.fromNullishOr(snapshot.generation).pipe(
    Option.flatMapNullishOr((generation) => generation.message),
  )
  const step = Option.match(partial, {
    onNone: () =>
      snapshot.generation === undefined || stored.state.failure.length > 0
        ? stored
        : join(stored, startTurn(stored.state)),
    onSome: (message) => join(stored, replayPartial(stored.state, message)),
  })
  return Option.some({ ...step, origins: originsFor(runEntries(snapshot.entries), step.chunks) })
}

/** Whether `entry` is an assistant message that calls one of the tool calls in `known`. */
function callsAny(entry: EntryRecord, known: ReadonlySet<string>): boolean {
  const found = Option.fromNullishOr(entry.model).pipe(Option.flatMap(Arr.head))
  return (
    Option.isSome(found) &&
    found.value.role === 'assistant' &&
    found.value.content.some((block) => block.type === 'toolCall' && known.has(block.id))
  )
}

/**
 * Rebuild what followed a tool round, for a client that already shows the round's calls and comes
 * back after it settled a hold. `known` are the tool call ids the client has.
 *
 * selectRun has bounded these entries to the message's own run. The prefix starts after the newest
 * assistant entry that made a known call and follows that run's whole tail, including steps after
 * steer user entries. A steer extends this run; it never ends its continuation or live observation.
 * Tool results match the client's parts by call id.
 *
 * `live` says the same run is still in progress, so live events continue the prefix. `undefined`
 * means no entry made those calls.
 */
export function replayAfter(
  snapshot: SnapshotEvent,
  known: ReadonlySet<string>,
): Option.Option<{
  readonly step: Step
  readonly live: boolean
  readonly origins: ReadonlyMap<Chunk, TaskId>
}> {
  const at = snapshot.entries.findLastIndex((entry) => callsAny(entry, known))
  if (at === -1) return Option.none()
  const rest = snapshot.entries.slice(at + 1)
  const live = snapshot.run !== undefined
  const called = replayEntry(
    initialRunState,
    Option.getOrThrow(Option.fromNullishOr(snapshot.entries[at])),
  )
  const stored = rest.reduce<Step>(
    (step, entry) => join(step, replayEntry(step.state, entry)),
    // No message id: the client continues the assistant message it already has.
    {
      state: called.state,
      chunks: [
        { type: 'start' },
        ...called.chunks.filter(
          (chunk) => chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available',
        ),
      ],
    },
  )
  const partial = live
    ? Option.fromNullishOr(snapshot.generation).pipe(
        Option.flatMapNullishOr((generation) => generation.message),
      )
    : Option.none()
  const step = Option.match(partial, {
    onNone: () =>
      !live || snapshot.generation === undefined ? stored : join(stored, startTurn(stored.state)),
    onSome: (message) => join(stored, replayPartial(stored.state, message)),
  })
  return Option.some({
    step,
    live,
    origins: originsFor(snapshot.entries.slice(at), step.chunks),
  })
}

/** Events without a chunk counterpart remain exhaustive without bloating the translator's decisions. */
function untranslated(
  state: RunState,
  event: Exclude<
    AgentEvent,
    {
      type:
        | 'run_start'
        | 'run_end'
        | 'turn_start'
        | 'message_start'
        | 'turn_end'
        | 'message_update'
        | 'message_end'
        | 'tool_execution_end'
    }
  >,
): Step {
  return Match.value(event).pipe(
    Match.when(
      {
        type: Match.is(
          'snapshot',
          'tool_execution_start',
          'tool_execution_update',
          'inbox_update',
          'submission',
          'auto_retry_start',
          'auto_retry_end',
          'deferred_poll',
          'entry_appended',
          'agent_changed',
          'usage_changed',
          'task_failed',
          'compaction_start',
          'compaction_end',
        ),
      },
      () => ({ state, chunks: [] }),
    ),
    Match.exhaustive,
  )
}

/** Historical chunks retain the exact result task of their own assistant generation, even for reused ids. */
export type Rebuilt = Step & { readonly origins: ReadonlyMap<Chunk, TaskId> }

/** Index each assistant's following results separately; provider call ids only relate parts within that round. */
function resultRounds(entries: readonly EntryRecord[]) {
  const rounds: Map<string, Option.Option<TaskId>>[] = []
  for (const entry of entries) indexRound(rounds, entry)
  return rounds
}

/** One stored entry either opens a call generation or records its result task. */
function indexRound(rounds: Map<string, Option.Option<TaskId>>[], entry: EntryRecord) {
  for (const message of entry.model ?? []) {
    if (message.role === 'assistant')
      rounds.push(
        new Map(
          message.content.flatMap((block) =>
            block.type === 'toolCall' ? [[block.id, Option.none<TaskId>()] as const] : [],
          ),
        ),
      )
    else if (message.role === 'toolResult') {
      const round = rounds.at(-1)
      if (round !== undefined && round.has(message.toolCallId))
        round.set(message.toolCallId, Option.fromNullishOr(entry.byTaskId))
    }
  }
}

/** The start chunk advances one generation of a call; its available/result chunks share that task. */
export function originsFor(entries: readonly EntryRecord[], chunks: readonly Chunk[]) {
  const tasks = new Map<string, Option.Option<TaskId>[]>()
  for (const round of resultRounds(entries)) {
    for (const [callId, task] of round) tasks.set(callId, [...(tasks.get(callId) ?? []), task])
  }
  const positions = new Map<string, number>()
  const origins = new Map<Chunk, TaskId>()
  for (const chunk of chunks) {
    if (!('toolCallId' in chunk)) continue
    const callId = chunk.toolCallId
    if (chunk.type === 'tool-input-start') positions.set(callId, (positions.get(callId) ?? -1) + 1)
    const task = (tasks.get(callId) ?? [])[positions.get(callId) ?? 0]
    if (task !== undefined && Option.isSome(task)) origins.set(chunk, task.value)
  }
  return origins
}

/** Use precisely the live translator's constructors for each stored assistant step and tool result. */
export function rebuild(entries: readonly EntryRecord[]): Rebuilt {
  const step = entries.reduce<Step>(
    (current, entry) => join(current, replayEntry(current.state, entry)),
    { state: initialRunState, chunks: [] },
  )
  return { ...step, origins: originsFor(entries, step.chunks) }
}

/** Pi events.js changes runs by their first input; steer inputs never change assistant identity. */
export function runMessageId(inputs: readonly SubmissionId[]) {
  return `run:${Option.getOrThrow(Arr.head(inputs))}`
}
