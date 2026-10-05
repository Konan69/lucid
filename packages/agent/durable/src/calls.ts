import type { UIMessageChunk } from 'ai'

import { holdKind, type Plan, type Settlement } from './holds.ts'

/** What the stream must know about a conversation's tools to present their calls. */
export type Desk = {
  /** The plan of a bridged tool, by name; `undefined` for any other Pi Durable tool. */
  readonly plan: (toolName: string) => Plan | undefined
  /** Settlements committed so far, by tool call id. */
  readonly settled: Readonly<Record<string, Settlement>>
}

/**
 * The tool calls of the stream so far that have no result yet: `awaiting` a person, or `running`.
 */
export type Round = {
  readonly awaiting: ReadonlySet<string>
  readonly running: ReadonlySet<string>
}

export const emptyRound: Round = { awaiting: new Set(), running: new Set() }

/**
 * Every open call waits for a person and nothing else runs, so the run cannot move until someone
 * answers. An AI SDK client only sends its answer once the stream has finished, so the stream
 * finishes here; the run itself stays in progress.
 */
export const parked = (round: Round) => round.awaiting.size > 0 && round.running.size === 0

type Shown = { readonly round: Round; readonly chunks: readonly UIMessageChunk[] }

const without = (set: ReadonlySet<string>, id: string) =>
  new Set([...set].filter((each) => each !== id))

const close = (round: Round, id: string): Round => ({
  awaiting: without(round.awaiting, id),
  running: without(round.running, id),
})

type InputAvailable = Extract<UIMessageChunk, { type: 'tool-input-available' }>

/**
 * A call whose input is complete. A bridged tool is a typed tool on the client, so it loses the
 * `dynamic` mark. A call that needs approval is followed by its request, and by the response too
 * when it is already decided, which is the case for a client that attaches after the decision.
 */
function inputAvailable(round: Round, chunk: InputAvailable, desk: Desk): Shown {
  const plan = desk.plan(chunk.toolName)
  if (plan === undefined) {
    return {
      round: { ...round, running: new Set([...round.running, chunk.toolCallId]) },
      chunks: [chunk],
    }
  }
  const { dynamic: _dynamic, ...typed } = chunk
  const kind = holdKind(plan, chunk.input)
  const settled = desk.settled[chunk.toolCallId]
  const request: readonly UIMessageChunk[] =
    kind === 'approval'
      ? [
          {
            type: 'tool-approval-request',
            approvalId: chunk.toolCallId,
            toolCallId: chunk.toolCallId,
          },
        ]
      : []
  const response: readonly UIMessageChunk[] =
    kind === 'approval' && settled !== undefined
      ? [
          {
            type: 'tool-approval-response',
            approvalId: chunk.toolCallId,
            approved: settled.kind !== 'denied',
          },
        ]
      : []
  const waits = kind !== undefined && settled === undefined
  return {
    round: waits
      ? { ...round, awaiting: new Set([...round.awaiting, chunk.toolCallId]) }
      : { ...round, running: new Set([...round.running, chunk.toolCallId]) },
    chunks: [typed, ...request, ...response],
  }
}

/** Present one translated chunk. */
function show(round: Round, chunk: UIMessageChunk, desk: Desk): Shown {
  switch (chunk.type) {
    case 'tool-input-start': {
      if (desk.plan(chunk.toolName) === undefined) return { round, chunks: [chunk] }
      const { dynamic: _dynamic, ...typed } = chunk
      return { round, chunks: [typed] }
    }
    case 'tool-input-available':
      return inputAvailable(round, chunk, desk)
    case 'tool-output-available':
      return { round: close(round, chunk.toolCallId), chunks: [chunk] }
    case 'tool-output-error': {
      // Pi Durable reports a denied call as a blocked call, which is an error result. The AI SDK
      // has a state of its own for it.
      const denied = desk.settled[chunk.toolCallId]?.kind === 'denied'
      return {
        round: close(round, chunk.toolCallId),
        chunks: [denied ? { type: 'tool-output-denied', toolCallId: chunk.toolCallId } : chunk],
      }
    }
    default:
      return { round, chunks: [chunk] }
  }
}

/**
 * Present translated chunks to an AI SDK client: typed parts for bridged tools, approval requests
 * and denials, and the record of which calls are still open.
 *
 * Pure. The translator knows only Pi Durable events; this step adds what depends on the
 * conversation's tools and on the settlements, both given in `desk`.
 */
export function present(round: Round, chunks: readonly UIMessageChunk[], desk: Desk): Shown {
  return chunks.reduce<Shown>(
    (shown, chunk) => {
      const next = show(shown.round, chunk, desk)
      return { round: next.round, chunks: [...shown.chunks, ...next.chunks] }
    },
    { round, chunks: [] },
  )
}

/** Whether presenting `chunks` needs the desk. Reading it costs a document read, so text skips it. */
export const needsDesk = (chunks: readonly UIMessageChunk[]) =>
  chunks.some(
    (chunk) =>
      chunk.type === 'tool-input-start' ||
      chunk.type === 'tool-input-available' ||
      chunk.type === 'tool-output-error',
  )
