import type { Chunk } from './chunks.ts'
import { Match, Option } from 'effect'

import type { HoldId } from './errors.ts'
import { CallLookup, holdKind, type Plan } from './holds.ts'

/** What the stream must know about a conversation's tools to present their calls. */
export type Desk = {
  /** The plan of a bridged tool, by name; `undefined` for any other Pi Durable tool. */
  readonly plan: (toolName: string) => Option.Option<Plan>
  /** Every presentation uses the same task/provenance lookup as hooks and admission. */
  readonly call: (callId: string) => CallLookup
  readonly hold: (holdId: HoldId) => CallLookup
}

/**
 * The tool calls of the stream so far that have no result yet: `awaiting` a person, or `running`.
 */
export type Round = {
  readonly awaiting: ReadonlySet<string>
  readonly running: ReadonlySet<string>
  readonly holds: ReadonlyMap<string, HoldId>
  readonly unrequested: ReadonlyMap<string, InputAvailable>
}

export const emptyRound: Round = {
  awaiting: new Set(),
  running: new Set(),
  unrequested: new Map(),
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
  holds: new Map([...round.holds].filter(([callId]) => callId !== id)),
  unrequested: new Map([...round.unrequested].filter(([callId]) => callId !== id)),
  awaiting: without(round.awaiting, id),
  running: without(round.running, id),
})

type InputAvailable = Extract<Chunk, { type: 'tool-input-available' }>

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
  const found = desk.call(chunk.toolCallId)
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
      ? [
          {
            type: 'tool-approval-response',
            approvalId: found.holdId,
            approved: found.settlement.kind !== 'denied',
          },
        ]
      : []
  const waits = Option.isSome(kind) && CallLookup.isAnyOf(['Ready', 'Queued'])(found)
  const holds = new Map(round.holds)
  if (CallLookup.isAnyOf(['Ready', 'Settled', 'Asked', 'Executing', 'Done'])(found))
    holds.set(chunk.toolCallId, found.holdId)
  const unrequested = new Map(round.unrequested)
  if (Option.isSome(kind) && CallLookup.guards.Queued(found))
    unrequested.set(chunk.toolCallId, typed)
  else unrequested.delete(chunk.toolCallId)
  return {
    round: waits
      ? { ...round, holds, unrequested, awaiting: new Set([...round.awaiting, chunk.toolCallId]) }
      : { ...round, holds, unrequested, running: new Set([...round.running, chunk.toolCallId]) },
    chunks: [typed, ...request, ...response],
  }
}

/** Present one translated chunk. */
function show(round: Round, chunk: Chunk, desk: Desk): Shown {
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
    Match.when({ type: 'tool-output-error' }, (output): Shown => {
      // Pi's blocked result becomes the AI SDK denial state only when the durable decision denied it.
      const holdId = round.holds.get(output.toolCallId)
      const found = holdId === undefined ? desk.call(output.toolCallId) : desk.hold(holdId)
      const denied = CallLookup.guards.Settled(found) && found.settlement.kind === 'denied'
      return {
        round: close(round, output.toolCallId),
        chunks: [denied ? { type: 'tool-output-denied', toolCallId: output.toolCallId } : output],
      }
    }),
    // Every other chunk, including open-ended data-* extensions, has no tool-presentation behavior.
    Match.orElse((other): Shown => ({ round, chunks: [other] })),
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

/** Partial input can precede task allocation. Present its hold only after the shared lookup admits it. */
function refresh(shown: Shown, desk: Desk): Shown {
  let round = shown.round
  const chunks: Chunk[] = [...shown.chunks]
  for (const [id, input] of shown.round.unrequested) {
    const found = desk.call(id)
    if (CallLookup.isAnyOf(['Queued', 'Missing'])(found)) continue
    const next = inputAvailable(close(round, id), input, desk)
    round = next.round
    // The input was already sent; only its newly admitted approval is presented again.
    chunks.push(...next.chunks.slice(1))
  }
  return { round, chunks }
}

/** Whether presenting `chunks` needs the desk. Reading it costs a document read, so text skips it. */
export const needsDesk = (chunks: readonly Chunk[]) =>
  chunks.some(
    (chunk) =>
      chunk.type === 'tool-input-start' ||
      chunk.type === 'tool-input-available' ||
      chunk.type === 'tool-output-error',
  )
