import {
  type FlueClient,
  type AgentConversationObservationSnapshot,
  type FlueConversationMessage,
  type FlueConversationState,
} from '@flue/sdk'
import { RunFailure, RunId, textOf } from '@vivid/contracts'
import { Effect, Filter, Option, Queue, Schema, Stream } from 'effect'
import {
  classifyFailure,
  decodeFailureEvidence,
  ProviderStatus,
  providerStatusOf,
} from './failure.ts'

/** The runtime verdict includes the classified reason before any product persistence or publishing. */
export const Settlement = Schema.TaggedUnion({
  Completed: { reply: Schema.String, responseId: RunId },
  Failed: { reason: RunFailure, providerStatus: Schema.optionalKey(ProviderStatus) },
  Stopped: {},
  Unknown: {},
})
export type Settlement = typeof Settlement.Type

/** A SDK-decoded assistant response is meaningful only when it contains words or tools. */
const meaningful = (message: FlueConversationMessage): boolean =>
  message.parts.some((part) =>
    part.type === 'text' ? part.text.trim().length > 0 : part.type === 'dynamic-tool',
  )

/**
 * The reply is the host's last answer, the message Flue 2.2.2 `readSubmissionReply` picks for a
 * joined submission too. Preserve its response identity so outbound transports claim that answer
 * once, even when several Runs end. An empty final text remains legal after real tool work.
 *
 * `textOf` joins canonical text blocks as paragraphs for screens and outbound replies alike.
 * The runtime reconciles with history in the batch that publishes the first settlement.
 */
const resultOf = (state: FlueConversationState, runId: RunId): Option.Option<Settlement> => {
  const settled = state.settlements.find((candidate) => candidate.submissionId === runId)
  if (settled === undefined) return Option.none()
  if (settled.outcome === 'aborted') return Option.some(Settlement.cases.Stopped.make({}))
  if (settled.outcome === 'failed') {
    const evidence = decodeFailureEvidence(settled.error)
    const reason = classifyFailure(evidence)
    return Option.some(
      Option.match(providerStatusOf(evidence), {
        onNone: () => Settlement.cases.Failed.make({ reason }),
        onSome: (providerStatus) => Settlement.cases.Failed.make({ reason, providerStatus }),
      }),
    )
  }
  const host = hostOf(state, runId)
  const answer = state.messages.filter(
    (message) => message.role === 'assistant' && message.submissionId === host,
  )
  const reply = answer.at(-1)
  if (reply === undefined || !answer.some(meaningful))
    return Option.some(Settlement.cases.Failed.make({ reason: 'NoAnswer' }))
  return Option.some(
    Settlement.cases.Completed.make({
      reply: textOf(reply),
      responseId: RunId.make(host),
    }),
  )
}

/** Joined submissions read the same host identity as readSubmissionReply, never a guessed owner. */
const hostOf = (state: FlueConversationState, runId: RunId): string => {
  const settled = state.settlements.find((candidate) => candidate.submissionId === runId)
  if (settled === undefined || settled.answeredBySubmissionId === undefined) return runId
  return settled.answeredBySubmissionId
}

/**
 * SDK 2.1 scheduleRetry publishes connecting while recovery is possible, error only on permanent
 * 400 or exhausted auth retries. A saved terminal settlement outranks a subsequent transport loss.
 */
const resultOfSnapshot = (snapshot: AgentConversationObservationSnapshot, runId: RunId) => {
  if (snapshot.conversation !== undefined) {
    const result = resultOf(snapshot.conversation, runId)
    if (Option.isSome(result)) return result
  }
  if (snapshot.phase === 'absent' || snapshot.phase === 'closed' || snapshot.phase === 'error')
    return Option.some(Settlement.cases.Unknown.make({}))
  return Option.none()
}

/**
 * Wait for Flue's own settlement of the Run. Flue settles every admitted submission exactly once
 * (`flue docs guide/durability`, Flue 2.2.2) and enforces the Run's deadline itself
 * (`Vivid.durability.timeoutMs`, runtime `src/agents/vivid.ts`), so this sets no timer of its own.
 * A product deadline here once ended the Run in Vivid's records after 90 s without content or
 * without the runtime's stream, while Flue kept working; every later tool call was then refused
 * because the Run was no longer `working`. A dropped stream is reopened by the SDK by itself
 * (`scheduleRetry`); only a phase Flue never leaves (`absent`, `closed`, `error`) answers Unknown.
 */
export const observeRun = Effect.fn('Runtime.observeRun')(function* (
  client: FlueClient,
  runId: RunId,
) {
  const states = yield* Queue.unbounded<AgentConversationObservationSnapshot>()
  const observation = yield* Effect.acquireRelease(
    Effect.sync(() => client.observe({ live: 'sse' })),
    (source) => Effect.sync(() => source.close()),
  )
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      observation.subscribe(() => Queue.offerUnsafe(states, observation.getSnapshot())),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  )
  Queue.offerUnsafe(states, observation.getSnapshot())
  return yield* Stream.fromQueue(states).pipe(
    Stream.filterMap(Filter.fromPredicateOption((snapshot) => resultOfSnapshot(snapshot, runId))),
    Stream.runHead,
    Effect.map(Option.getOrElse(() => Settlement.cases.Unknown.make({}))),
  )
}, Effect.scoped)
