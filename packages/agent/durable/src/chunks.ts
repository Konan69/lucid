import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  SnapshotEvent,
} from '@earendil-works/pi-durable'
import type { UIMessageChunk } from 'ai'
import { Array as Arr, Match, Option, Schema } from 'effect'

/** Pi's closed event and block types are exhaustive; an impossible branch indicates an SDK contract defect. */
const unreachable = (value: never): never => {
  throw new Error(`Unexpected Pi variant: ${String(value)}`)
}

/**
 * How far one content block of the in-flight assistant message has been reported.
 *
 * Pi Durable reports a block three ways: streamed (`*_start`, `*_delta`, then `block`), whole in one
 * `block` change, or only inside the final entry at `message_end` (a provider that does not stream,
 * and every recovered partial). The translator must emit exactly one start and one end per block in
 * all three, so it records what it has already sent.
 */
type Reported = 'open' | 'closed'

/**
 * Translator state for one run. A run is the turns from an input to its final answer and becomes one
 * AI SDK assistant message; each turn becomes one AI SDK step.
 */
export type RunState = {
  /** Turns started in this run. */
  readonly turn: number
  /**
   * Model responses started in this run. A turn has more than one when Pi Durable retries a failed
   * request, so part ids use this counter and never collide across attempts.
   */
  readonly response: number
  /** Blocks of the current response already reported, by `contentIndex`. */
  readonly blocks: ReadonlyMap<number, Reported>
  /**
   * Error text of the newest response when it failed. Pi Durable retries a failed request, so a
   * failure is reported only if the run ends with it still standing. Empty when there is none.
   */
  readonly failure: readonly string[]
}

export const initialRunState: RunState = { turn: 0, response: 0, blocks: new Map(), failure: [] }

type Block = AssistantMessage['content'][number]
export type Step = { readonly state: RunState; readonly chunks: readonly UIMessageChunk[] }

/** Part id of one block. AI SDK text and reasoning parts are matched across chunks by this id. */
const partId = (state: RunState, contentIndex: number) => `${state.response}:${contentIndex}`

/** Chunks that open a block. A tool call opens as a dynamic tool: the client holds no typed tool set. */
function openBlock(state: RunState, contentIndex: number, block: Block): readonly UIMessageChunk[] {
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

/** Chunks that close a block whose final value is `block`. */
function closeBlock(
  state: RunState,
  contentIndex: number,
  block: Block,
): readonly UIMessageChunk[] {
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
          input: block.arguments,
          dynamic: true,
        },
      ]
  }
  return unreachable(block)
}

/** The text a block holds now, as one delta. Empty text gives no chunk; a tool call has none. */
function blockBody(state: RunState, contentIndex: number, block: Block): readonly UIMessageChunk[] {
  const id = partId(state, contentIndex)
  if (block.type === 'text' && block.text !== '')
    return [{ type: 'text-delta', id, delta: block.text }]
  if (block.type === 'thinking' && block.thinking !== '') {
    return [{ type: 'reasoning-delta', id, delta: block.thinking }]
  }
  return []
}

/** The whole content of a block that was never streamed, as one delta between its start and end. */
function wholeBlock(
  state: RunState,
  contentIndex: number,
  block: Block,
): readonly UIMessageChunk[] {
  return [
    ...openBlock(state, contentIndex, block),
    ...blockBody(state, contentIndex, block),
    ...closeBlock(state, contentIndex, block),
  ]
}

const mark = (state: RunState, contentIndex: number, reported: Reported): RunState => ({
  ...state,
  blocks: new Map(state.blocks).set(contentIndex, reported),
})

/** A new turn: one AI SDK step. */
const startTurn = (state: RunState): Step => ({
  state: { ...state, turn: state.turn + 1, blocks: new Map() },
  chunks: [{ type: 'start-step' }],
})

/**
 * A new model response begins with `partial` already in it. When the step already shows blocks of an
 * earlier attempt, they are removed first: `reset-step` drops every part added since the step began.
 */
function startResponse(state: RunState, partial: AssistantMessage): Step {
  const reset: readonly UIMessageChunk[] = state.blocks.size > 0 ? [{ type: 'reset-step' }] : []
  const fresh: RunState = { ...state, response: state.response + 1, blocks: new Map(), failure: [] }
  return partial.content.reduce<Step>(
    (step, block, contentIndex) => ({
      state: mark(step.state, contentIndex, 'open'),
      chunks: [
        ...step.chunks,
        ...openBlock(step.state, contentIndex, block),
        ...blockBody(step.state, contentIndex, block),
      ],
    }),
    { state: fresh, chunks: reset },
  )
}

/** Finish a block with its final value, opening it first when nothing was streamed. */
function finishBlock(state: RunState, contentIndex: number, block: Block): Step {
  const reported = state.blocks.get(contentIndex)
  if (reported === 'closed') return { state, chunks: [] }
  const chunks =
    reported === 'open'
      ? closeBlock(state, contentIndex, block)
      : wholeBlock(state, contentIndex, block)
  return { state: mark(state, contentIndex, 'closed'), chunks }
}

/** Apply one change to the in-flight assistant message. */
function applyChange(state: RunState, change: MessageChange): Step {
  switch (change.type) {
    // Pi Durable commits partials at most every 100 ms, so a block is often first seen with text
    // already in it. A real provider showed this: dropping it cut the start off the answer.
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
      return {
        state: mark(state, change.contentIndex, 'open'),
        chunks: [
          ...openBlock(state, change.contentIndex, change.block),
          ...blockBody(state, change.contentIndex, change.block),
        ],
      }
    case 'text_delta':
      return {
        state,
        chunks: [
          { type: 'text-delta', id: partId(state, change.contentIndex), delta: change.delta },
        ],
      }
    case 'thinking_delta':
      return {
        state,
        chunks: [
          { type: 'reasoning-delta', id: partId(state, change.contentIndex), delta: change.delta },
        ],
      }
    // Argument text arrives as appends at a path inside the arguments object, not as raw JSON text,
    // so it cannot feed `tool-input-delta`. The finished arguments are sent when the block closes.
    case 'toolcall_delta':
      return { state, chunks: [] }
    case 'block':
      return finishBlock(state, change.contentIndex, change.block)
    case 'message':
      return finishMessage(state, change.message)
  }
  return unreachable(change)
}

/** Report every block of `message` that is not closed yet. */
function finishMessage(state: RunState, message: AssistantMessage): Step {
  return message.content.reduce<Step>(
    (step, block, contentIndex) => {
      const next = finishBlock(step.state, contentIndex, block)
      return { state: next.state, chunks: [...step.chunks, ...next.chunks] }
    },
    { state, chunks: [] },
  )
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
function toolEnd(toolCallId: string, entry: Option.Option<EntryRecord>): readonly UIMessageChunk[] {
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
  const ending: readonly UIMessageChunk[] =
    message.stopReason === 'aborted' ? [{ type: 'abort' }] : []
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
      chunks: [{ type: 'start', messageId: `run:${started.inputs.join('+')}` }],
    })),
    Match.when({ type: 'run_end' }, (): Step => ({
      state,
      chunks: [
        ...state.failure.map((errorText): UIMessageChunk => ({ type: 'error', errorText })),
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
      update.changes.reduce<Step>(
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
    Match.when({ type: 'tool_execution_end' }, (ended) => ({
      state,
      chunks: toolEnd(ended.toolCallId, Option.fromNullishOr(ended.entry)),
    })),
    Match.orElse((other) => untranslated(state, other)),
  )
}

const join = (a: Step, b: Step): Step => ({ state: b.state, chunks: [...a.chunks, ...b.chunks] })

/** Entries of the run in progress: everything after the newest user entry of the active transcript. */
function runEntries(entries: readonly EntryRecord[]): readonly EntryRecord[] {
  const start = entries.findLastIndex((entry) => entry.kind === 'pi.user')
  return entries.slice(start + 1)
}

/** One stored entry of the run in progress, as the chunks its live events would have produced. */
function replayEntry(state: RunState, entry: EntryRecord): Step {
  const found = Option.fromNullishOr(entry.model).pipe(Option.flatMap(Arr.head))
  if (Option.isNone(found)) return { state, chunks: [] }
  const message = found.value
  if (message.role === 'assistant') {
    const turn = startTurn(state)
    const response: RunState = { ...turn.state, response: turn.state.response + 1, failure: [] }
    return join(turn, assistantEnd(response, message))
  }
  if (message.role === 'toolResult')
    return { state, chunks: toolEnd(message.toolCallId, Option.some(entry)) }
  return { state, chunks: [] }
}

/** The partial response of the generation in flight: a turn, then each block with its text so far. */
function replayPartial(state: RunState, message: AssistantMessage): Step {
  const turn = startTurn(state)
  return join(turn, startResponse(turn.state, message))
}

/**
 * Rebuild the chunks of the run in progress from a snapshot, for a client that attaches late or
 * reconnects. Pi Durable replays no events; it gives the current state. The result is the stream
 * prefix that brings an AI SDK reader to that state, and the translator state from which the live
 * events continue. `undefined` means no run is in progress.
 *
 * Limit: a steer adds a user entry inside a run, so the prefix then starts at the steer.
 */
export function replay(snapshot: SnapshotEvent): Option.Option<Step> {
  if (snapshot.run === undefined) return Option.none()
  const started: Step = {
    state: initialRunState,
    chunks: [{ type: 'start', messageId: `run:${snapshot.run.inputs.join('+')}` }],
  }
  const stored = runEntries(snapshot.entries).reduce<Step>(
    (step, entry) => join(step, replayEntry(step.state, entry)),
    started,
  )
  const partial = Option.fromNullishOr(snapshot.generation).pipe(
    Option.flatMapNullishOr((generation) => generation.message),
  )
  return Option.some(
    Option.match(partial, {
      onNone: () => stored,
      onSome: (message) => join(stored, replayPartial(stored.state, message)),
    }),
  )
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
 * The prefix starts after the newest assistant entry that made one of those calls and stops at the
 * next user input, so it carries the tool results, the later steps, and the partial in flight, and
 * nothing the client already shows. Tool results match the client's parts by call id.
 *
 * `live` says the same run is still in progress, so live events continue the prefix. `undefined`
 * means no entry made those calls.
 */
export function replayAfter(
  snapshot: SnapshotEvent,
  known: ReadonlySet<string>,
): Option.Option<{ readonly step: Step; readonly live: boolean }> {
  const at = snapshot.entries.findLastIndex((entry) => callsAny(entry, known))
  if (at === -1) return Option.none()
  const rest = snapshot.entries.slice(at + 1)
  const nextInput = rest.findIndex((entry) => entry.kind === 'pi.user')
  const live = nextInput === -1 && snapshot.run !== undefined
  const stored = (nextInput === -1 ? rest : rest.slice(0, nextInput)).reduce<Step>(
    (step, entry) => join(step, replayEntry(step.state, entry)),
    // No message id: the client continues the assistant message it already has.
    { state: initialRunState, chunks: [{ type: 'start' }] },
  )
  const partial = live
    ? Option.fromNullishOr(snapshot.generation).pipe(
        Option.flatMapNullishOr((generation) => generation.message),
      )
    : Option.none()
  return Option.some({
    step: Option.match(partial, {
      onNone: () => stored,
      onSome: (message) => join(stored, replayPartial(stored.state, message)),
    }),
    live,
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
