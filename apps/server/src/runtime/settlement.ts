import {
  readSubmissionReply,
  type FlueClient,
  type AgentConversationObservationSnapshot,
  type FlueConversationMessage,
  type FlueConversationState,
} from '@flue/sdk'
import { RunFailure, type RunId } from '@vivid/contracts'
import { Effect, Filter, Option, Queue, Ref, Schema, Stream } from 'effect'
import { classifyFailure, decodeFailureEvidence } from './failure.ts'

/** The runtime verdict includes the classified reason before any product persistence or publishing. */
export const Settlement = Schema.TaggedUnion({
  Completed: { reply: Schema.String },
  Failed: { reason: RunFailure },
  Stopped: {},
  Unknown: {},
})
export type Settlement = typeof Settlement.Type

/** A SDK-decoded assistant response is meaningful only when it contains words or tools. */
const meaningful = (message: FlueConversationMessage): boolean =>
  message.parts.some((part) =>
    part.type === 'text' ? part.text.trim().length > 0 : part.type === 'dynamic-tool',
  )

/** Settlement linkage preserves joined submissions; an empty final text is legal after real tool work. */
const resultOf = (state: FlueConversationState, runId: RunId): Option.Option<Settlement> => {
  const settled = state.settlements.find((candidate) => candidate.submissionId === runId)
  if (settled === undefined) return Option.none()
  if (settled.outcome === 'aborted') return Option.some(Settlement.cases.Stopped.make({}))
  if (settled.outcome === 'failed')
    return Option.some(
      Settlement.cases.Failed.make({
        reason: classifyFailure(decodeFailureEvidence(settled.error)),
      }),
    )
  const host = hostOf(state, runId)
  const answer = state.messages.filter(
    (message) => message.role === 'assistant' && message.submissionId === host,
  )
  const hasAnswer = answer.some(meaningful)
  if (!hasAnswer) return Option.some(Settlement.cases.Failed.make({ reason: 'NoAnswer' }))
  return Option.some(
    Settlement.cases.Completed.make({ reply: readSubmissionReply(state, runId).text }),
  )
}

/**
 * Vivid.durability.timeoutMs is one hour (runtime src/agents/vivid.ts), matching Flue 2.1's
 * DURABILITY_DEFAULT_TIMEOUT_MS in conversation-stream-store. Observation has the same finite
 * bound for a live runtime producing content. Transport loss has its own shorter bound.
 */
export const responseTimeoutMillis = 60 * 60 * 1000

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
 * Observe transport loss for at most the first-content budget (90 s by default), even if SDK
 * retries clear their error between hydrates. Only reaching live resets this window. The content
 * deadline starts at observation, including a restarted observer with no assistant message.
 * Flue abort cancels all queued/active work; a product deadline must never abort the conversation.
 */
export const observeRun = Effect.fn('Runtime.observeRun')(function* (
  client: FlueClient,
  runId: RunId,
  firstTokenMillis: number,
) {
  const states = yield* Queue.unbounded<AgentConversationObservationSnapshot>()
  const connectivity = yield* Queue.unbounded<boolean>()
  const seen = yield* Ref.make(false)
  const observation = yield* Effect.acquireRelease(
    Effect.sync(() => client.observe({ live: 'sse' })),
    (source) => Effect.sync(() => source.close()),
  )
  /** Preserve phase even without a conversation so absence and permanent observation loss settle. */
  const changed = () => {
    const snapshot = observation.getSnapshot()
    Queue.offerUnsafe(states, snapshot)
    Queue.offerUnsafe(connectivity, snapshot.phase === 'live')
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => observation.subscribe(changed)),
    (unsubscribe) => Effect.sync(unsubscribe),
  )
  changed()
  const outcome = Stream.fromQueue(states).pipe(
    Stream.tap(
      Effect.fn('Runtime.content')(function* (snapshot) {
        const state = snapshot.conversation
        if (state === undefined) return
        const host = hostOf(state, runId)
        const answers = state.messages.filter(
          (message) => message.submissionId === host && message.role === 'assistant',
        )
        if (answers.some(meaningful)) yield* Ref.set(seen, true)
      }),
    ),
    Stream.filterMap(Filter.fromPredicateOption((snapshot) => resultOfSnapshot(snapshot, runId))),
    Stream.runHead,
    Effect.map(Option.getOrElse(() => Settlement.cases.Unknown.make({}))),
  )
  const deadline = Effect.fn('Runtime.firstTokenDeadline')(function* () {
    yield* Effect.sleep(firstTokenMillis)
    if (yield* Ref.get(seen)) return yield* Effect.never
    if (observation.getSnapshot().phase !== 'live') return Settlement.cases.Unknown.make({})
    return Settlement.cases.Failed.make({ reason: 'TimedOut' })
  })
  // Repeated connecting/loading updates cannot renew the recovery window; a real live phase can.
  const unavailable = Stream.fromQueue(connectivity).pipe(
    Stream.changes,
    Stream.switchMap((live) =>
      live
        ? Stream.never
        : Stream.fromEffect(
            Effect.sleep(firstTokenMillis).pipe(Effect.as(Settlement.cases.Unknown.make({}))),
          ),
    ),
    Stream.runHead,
    Effect.map(Option.getOrElse(() => Settlement.cases.Unknown.make({}))),
  )
  return yield* Effect.raceAll([outcome, deadline(), unavailable]).pipe(
    Effect.timeoutOrElse({
      duration: responseTimeoutMillis,
      orElse: () => Effect.succeed(Settlement.cases.Unknown.make({})),
    }),
  )
}, Effect.scoped)
