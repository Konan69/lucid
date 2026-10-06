import type { Chunk } from './chunks.ts'
import { Match, Option } from 'effect'

import type { HoldId } from './errors.ts'
import { CallLookup, holdKind, type Plan } from './holds.ts'

/** What the stream must know about a conversation's tools to present their calls. */
export type Desk = {
  /** Any sequential-capable agent conservatively admits only its first generating call. */
  readonly sequential: boolean
  /** The plan of a bridged tool, by name; `undefined` for any other Pi Durable tool. */
  readonly plan: (toolName: string) => Option.Option<Plan>
  /** Every presentation uses the same task/provenance lookup as hooks and admission. */
  readonly call: (callId: string) => CallLookup
  readonly origin: (chunk: Extract<Chunk, { toolCallId: string }>) => Option.Option<CallLookup>
  readonly hold: (holdId: HoldId) => CallLookup
}

/**
 * The tool calls of the stream so far that have no result yet: `awaiting` a person, or `running`.
 */
export type Round = {
  readonly awaiting: ReadonlySet<string>
  readonly running: ReadonlySet<string>
  readonly holds: ReadonlyMap<string, HoldId>
  readonly withheld: ReadonlyMap<string, readonly Chunk[]>
  readonly started: ReadonlySet<string>
  readonly available: ReadonlySet<string>
  readonly inputs: ReadonlyMap<string, InputAvailable>
  readonly completed: ReadonlySet<string>
  readonly muted: ReadonlySet<string>
}

export const emptyRound: Round = {
  awaiting: new Set(),
  running: new Set(),
  withheld: new Map(),
  started: new Set(),
  available: new Set(),
  inputs: new Map(),
  completed: new Set(),
  muted: new Set(),
  holds: new Map(),
}

/**
 * Every open call waits for a person and nothing else runs, so the run cannot move until someone
 * answers. An AI SDK client only sends its answer once the stream has finished, so the stream
 * finishes here; the run itself stays in progress.
 */
export const parked = (round: Round) => round.awaiting.size > 0 && round.running.size === 0

type Shown = { readonly round: Round; readonly chunks: readonly Chunk[] }

const without = (set: ReadonlySet<string>, id: string) =>
  new Set([...set].filter((each) => each !== id))

const close = (round: Round, id: string): Round => ({
  ...round,
  holds: new Map([...round.holds].filter(([callId]) => callId !== id)),
  withheld: new Map([...round.withheld].filter(([callId]) => callId !== id)),
  completed: new Set([...round.completed, id]),
  inputs: new Map([...round.inputs].filter(([callId]) => callId !== id)),
  awaiting: without(round.awaiting, id),
  running: without(round.running, id),
})

type InputAvailable = Extract<Chunk, { type: 'tool-input-available' }>

/** Durable denial reasons survive replay and refresh the SDK's retained approval on continuation. */
function approvalResponse(found: Extract<CallLookup, { _tag: 'Settled' }>): Chunk {
  const response = {
    type: 'tool-approval-response',
    approvalId: found.holdId,
    approved: found.settlement.kind !== 'denied',
  } as const
  return found.settlement.kind === 'denied'
    ? { ...response, reason: found.settlement.reason }
    : response
}

/**
 * A call whose input is complete. A bridged tool is a typed tool on the client, so it loses the
 * `dynamic` mark. A call that needs approval is followed by its request, and by the response too
 * when it is already decided, which is the case for a client that attaches after the decision.
 */
function inputAvailable(round: Round, chunk: InputAvailable, desk: Desk): Shown {
  const plan = desk.plan(chunk.toolName)
  if (Option.isNone(plan)) {
    return {
      round: { ...round, running: new Set([...round.running, chunk.toolCallId]) },
      chunks: [chunk],
    }
  }
  const { dynamic: _dynamic, ...typed } = chunk
  const kind = holdKind(plan.value, chunk.input)
  const found = Option.getOrElse(desk.origin(chunk), () => desk.call(chunk.toolCallId))
  const request: readonly Chunk[] =
    Option.contains(kind, 'approval') && CallLookup.isAnyOf(['Ready', 'Settled'])(found)
      ? [
          {
            type: 'tool-approval-request',
            approvalId: found.holdId,
            toolCallId: chunk.toolCallId,
          },
        ]
      : []
  const response: readonly Chunk[] =
    Option.contains(kind, 'approval') && CallLookup.guards.Settled(found)
      ? [approvalResponse(found)]
      : []
  const waits = Option.isSome(kind) && CallLookup.guards.Ready(found)
  const holds = new Map(round.holds)
  if (CallLookup.isAnyOf(['Ready', 'Settled', 'Asked', 'Executing', 'Done'])(found))
    holds.set(chunk.toolCallId, found.holdId)
  return {
    round: waits
      ? {
          ...round,
          holds,
          awaiting: new Set([...round.awaiting, chunk.toolCallId]),
          running: without(round.running, chunk.toolCallId),
        }
      : {
          ...round,
          holds,
          running: new Set([...round.running, chunk.toolCallId]),
          awaiting: without(round.awaiting, chunk.toolCallId),
        },
    chunks: round.muted.has(chunk.toolCallId) ? [] : [typed, ...request, ...response],
  }
}

/** Present one translated chunk. */
function showVisible(round: Round, chunk: Chunk, desk: Desk): Shown {
  return Match.value(chunk).pipe(
    Match.when({ type: 'tool-input-start' }, (input): Shown => {
      if (Option.isNone(desk.plan(input.toolName))) return { round, chunks: [input] }
      const { dynamic: _dynamic, ...typed } = input
      return { round, chunks: [typed] }
    }),
    Match.when({ type: 'tool-input-available' }, (input) => inputAvailable(round, input, desk)),
    Match.when({ type: 'tool-output-available' }, (output): Shown => ({
      round: close(round, output.toolCallId),
      chunks: [output],
    })),
    Match.when({ type: 'tool-input-error' }, (input): Shown => {
      // This failed input never became executable. Keep bridged parts typed in live and history.
      const { dynamic: _dynamic, ...typed } = input
      return {
        round: close(round, input.toolCallId),
        chunks: [Option.isNone(desk.plan(input.toolName)) ? input : typed],
      }
    }),
    Match.when({ type: 'tool-output-error' }, (output): Shown => {
      // Pi's blocked result becomes the AI SDK denial state only when the durable decision denied it.
      const holdId = round.holds.get(output.toolCallId)
      const found = Option.getOrElse(desk.origin(output), () =>
        holdId === undefined ? desk.call(output.toolCallId) : desk.hold(holdId),
      )
      const denied = CallLookup.guards.Settled(found) && found.settlement.kind === 'denied'
      const response = denied && round.muted.has(output.toolCallId) ? [approvalResponse(found)] : []
      return {
        round: close(round, output.toolCallId),
        chunks: [
          ...response,
          denied ? { type: 'tool-output-denied', toolCallId: output.toolCallId } : output,
        ],
      }
    }),
    // Every other chunk, including open-ended data-* extensions, has no tool-presentation behavior.
    Match.orElse((other): Shown => ({ round, chunks: [other] })),
  )
}

/**
 * Pi generation.js startToolRound sequences all calls if any offered tool is sequential. A later
 * generating call cannot be un-shown when that round commits, so sequential-capable agents keep it
 * private until a task/result admits it. Parallel agents retain every generating call in order.
 */
function visible(chunk: Extract<Chunk, { toolCallId: string }>, desk: Desk, round: Round): boolean {
  const found = Option.getOrElse(desk.origin(chunk), () => desk.call(chunk.toolCallId))
  if (CallLookup.isAnyOf(['Queued', 'Missing'])(found)) return false
  return (
    !CallLookup.guards.Generating(found) ||
    !desk.sequential ||
    round.started.size === 0 ||
    round.started.has(chunk.toolCallId)
  )
}

/** Deduplicate each input phase and update the finite tool round before its result can close it. */
function showInput(round: Round, chunk: InputStart | InputAvailable, desk: Desk): Shown {
  const id = chunk.toolCallId
  if (round.completed.has(id)) return { round, chunks: [] }
  const seen = chunk.type === 'tool-input-start' ? round.started : round.available
  if (seen.has(id)) return { round, chunks: [] }
  const next =
    chunk.type === 'tool-input-start'
      ? { ...round, started: new Set([...round.started, id]) }
      : {
          ...round,
          available: new Set([...round.available, id]),
          inputs: new Map(round.inputs).set(id, chunk),
        }
  const shown = showVisible(next, chunk, desk)
  return { round: shown.round, chunks: round.muted.has(id) ? [] : shown.chunks }
}
type InputStart = Extract<Chunk, { type: 'tool-input-start' }>

/** Buffer complete input phases in provider order. A result itself admits and flushes its input first. */
function show(round: Round, chunk: Chunk, desk: Desk): Shown {
  if (chunk.type === 'start-step' || chunk.type === 'reset-step')
    return { round: emptyRound, chunks: [chunk] }
  if (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available') {
    const id = chunk.toolCallId
    if (round.completed.has(id)) return { round, chunks: [] }
    if (!visible(chunk, desk, round))
      return {
        round: {
          ...round,
          withheld: new Map(round.withheld).set(id, [...(round.withheld.get(id) ?? []), chunk]),
        },
        chunks: [],
      }
    const pending = release(round, id, desk)
    const current = showInput(pending.round, chunk, desk)
    return { round: current.round, chunks: [...pending.chunks, ...current.chunks] }
  }
  if (
    chunk.type === 'tool-output-available' ||
    chunk.type === 'tool-output-error' ||
    chunk.type === 'tool-input-error'
  ) {
    const pending = release(round, chunk.toolCallId, desk)
    const result = showVisible(pending.round, chunk, desk)
    return { round: result.round, chunks: [...pending.chunks, ...result.chunks] }
  }
  return showVisible(round, chunk, desk)
}

/** Release once, even if the event and live watches both observe the same allocation. */
function release(round: Round, id: string, desk: Desk): Shown {
  const chunks = round.withheld.get(id) ?? []
  const withheld = new Map(round.withheld)
  withheld.delete(id)
  return chunks.reduce<Shown>(
    (shown, chunk) => {
      if (chunk.type !== 'tool-input-start' && chunk.type !== 'tool-input-available') return shown
      const next = showInput(shown.round, chunk, desk)
      return { round: next.round, chunks: [...shown.chunks, ...next.chunks] }
    },
    { round: { ...round, withheld }, chunks: [] },
  )
}

/**
 * Present translated chunks to an AI SDK client: typed parts for bridged tools, approval requests
 * and denials, and the record of which calls are still open.
 *
 * Pure. The translator knows only Pi Durable events; this step adds what depends on the
 * conversation's tools and on the settlements, both given in `desk`.
 */
export function present(round: Round, chunks: readonly Chunk[], desk: Desk): Shown {
  const shown = chunks.reduce<Shown>(
    (accumulated, chunk) => {
      const next = show(accumulated.round, chunk, desk)
      return { round: next.round, chunks: [...accumulated.chunks, ...next.chunks] }
    },
    { round, chunks: [] },
  )
  return refresh(shown, desk)
}

/** A live-document transition can admit withheld calls without any tool execution event. */
function refresh(shown: Shown, desk: Desk): Shown {
  let round = shown.round
  const chunks: Chunk[] = [...shown.chunks]
  for (const id of shown.round.withheld.keys()) {
    const input = (shown.round.withheld.get(id) ?? []).find(
      (chunk) => chunk.type === 'tool-input-start',
    )
    if (input === undefined || input.type !== 'tool-input-start' || !visible(input, desk, round))
      continue
    const next = release(round, id, desk)
    round = next.round
    chunks.push(...next.chunks)
  }
  // A generating call is already visible, but its task-scoped approval can only be requested
  // after the tool-round commit. Refresh the hold without repeating its available input chunk.
  for (const [id, input] of round.inputs) {
    if (round.awaiting.has(id) || !CallLookup.guards.Ready(desk.call(id))) continue
    const plan = desk.plan(input.toolName)
    if (Option.isNone(plan) || Option.isNone(holdKind(plan.value, input.input))) continue
    const next = inputAvailable(round, input, desk)
    round = next.round
    chunks.push(...next.chunks.filter((chunk) => chunk.type !== 'tool-input-available'))
  }
  return { round, chunks }
}

/** Whether presenting `chunks` needs the desk. Reading it costs a document read, so text skips it. */
export const needsDesk = (chunks: readonly Chunk[]) =>
  chunks.some(
    (chunk) =>
      chunk.type === 'tool-input-start' ||
      chunk.type === 'tool-input-available' ||
      chunk.type === 'tool-input-error' ||
      chunk.type === 'tool-output-error',
  )
