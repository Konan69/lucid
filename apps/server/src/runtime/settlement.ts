import {
  readSubmissionReply,
  type FlueClient,
  type AgentConversationObservationSnapshot,
  type FlueConversationMessage,
  type FlueConversationState,
} from '@flue/sdk'
import { RunFailure, type RunId } from '@vivid/contracts'
import { Deferred, Effect, Filter, Option, Queue, Ref, Schema, Stream } from 'effect'
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
 * bound even when a restarted server sees stale content and the SDK reconnects forever.
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
 * Flue exposes host linkage only at settlement and abort cancels *all* queued and active work
 * (guide/durability). Never use conversation-wide abort for a Run deadline. The provider owns
 * scoped attempt cancellation. A queued/joined Run gets no first-token timer until its own
 * assistant response starts; host linkage, when published, counts the host's answer as content.
 */
export const observeRun = Effect.fn('Runtime.observeRun')(function* (
  client: FlueClient,
  runId: RunId,
  firstTokenMillis: number,
) {
  const states = yield* Queue.unbounded<AgentConversationObservationSnapshot>()
  const started = yield* Deferred.make<void>()
  const seen = yield* Ref.make(false)
  const observation = yield* Effect.acquireRelease(
    Effect.sync(() => client.observe({ live: 'sse' })),
    (source) => Effect.sync(() => source.close()),
  )
  /** Preserve phase even without a conversation so absence and permanent observation loss settle. */
  const changed = () => {
    Queue.offerUnsafe(states, observation.getSnapshot())
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
        if (answers.length > 0) yield* Deferred.succeed(started, undefined)
      }),
    ),
    Stream.filterMap(Filter.fromPredicateOption((snapshot) => resultOfSnapshot(snapshot, runId))),
    Stream.runHead,
    Effect.map(Option.getOrElse(() => Settlement.cases.Unknown.make({}))),
  )
  const deadline = Effect.fn('Runtime.firstTokenDeadline')(function* () {
    yield* Deferred.await(started)
    yield* Effect.sleep(firstTokenMillis)
    if (yield* Ref.get(seen)) return yield* Effect.never
    return Settlement.cases.Failed.make({ reason: 'TimedOut' })
  })
  return yield* Effect.raceFirst(outcome, deadline()).pipe(
    Effect.timeoutOrElse({
      duration: responseTimeoutMillis,
      orElse: () => Effect.succeed(Settlement.cases.Unknown.make({})),
    }),
  )
}, Effect.scoped)
