import {
  readSubmissionReply,
  type FlueClient,
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

/** A SDK-decoded assistant response is meaningful only when it contains words, reasoning, or tools. */
const meaningful = (message: FlueConversationMessage): boolean =>
  message.parts.some((part) =>
    part.type === 'text' || part.type === 'reasoning'
      ? part.text.trim().length > 0
      : part.type === 'dynamic-tool',
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
  const host = settled.answeredBySubmissionId === undefined ? runId : settled.answeredBySubmissionId
  const answer = state.messages.filter(
    (message) => message.role === 'assistant' && message.submissionId === host,
  )
  const hasAnswer = answer.some((message) =>
    message.parts.some((part) =>
      part.type === 'text' ? part.text.trim().length > 0 : part.type === 'dynamic-tool',
    ),
  )
  if (!hasAnswer) return Option.some(Settlement.cases.Failed.make({ reason: 'NoAnswer' }))
  return Option.some(
    Settlement.cases.Completed.make({ reply: readSubmissionReply(state, runId).text }),
  )
}

/**
 * One public Flue observation owns history catch-up and live delivery. The deadline stops waiting
 * after actual content, not a placeholder start; cleanup closes the observation on every ending.
 */
export const observeRun = Effect.fn('Runtime.observeRun')(function* (
  client: FlueClient,
  runId: RunId,
  firstTokenMillis: number,
) {
  const states = yield* Queue.unbounded<FlueConversationState>()
  const seen = yield* Ref.make(false)
  const expired = yield* Ref.make(false)
  const observation = yield* Effect.acquireRelease(
    Effect.sync(() => client.observe({ live: 'sse' })),
    (source) => Effect.sync(() => source.close()),
  )
  /** The SDK callback hands its already materialized state across the synchronous queue boundary. */
  const changed = () => {
    const current = observation.getSnapshot().conversation
    if (current !== undefined) Queue.offerUnsafe(states, current)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => observation.subscribe(changed)),
    (unsubscribe) => Effect.sync(unsubscribe),
  )
  changed()
  const outcome = Stream.fromQueue(states).pipe(
    Stream.tap((state) => {
      const spoke = state.messages.some(
        (message) =>
          message.submissionId === runId && message.role === 'assistant' && meaningful(message),
      )
      return spoke ? Ref.set(seen, true) : Effect.void
    }),
    Stream.filterMap(Filter.fromPredicateOption((state) => resultOf(state, runId))),
    Stream.runHead,
    Effect.map(Option.getOrElse(() => Settlement.cases.Unknown.make({}))),
  )
  const deadline = Effect.fn('Runtime.firstTokenDeadline')(function* () {
    yield* Effect.sleep(firstTokenMillis)
    if (yield* Ref.get(seen)) return yield* Effect.never
    yield* Ref.set(expired, true)
    // Aborting Flue is best effort and bounded; the authoritative Run still becomes TimedOut.
    yield* Effect.tryPromise({
      try: (signal) => client.abort({ signal }),
      catch: () => new AbortUnavailable(),
    }).pipe(Effect.timeoutOption('1 second'), Effect.ignore)
    return Settlement.cases.Failed.make({ reason: 'TimedOut' })
  })
  const result = yield* Effect.raceFirst(outcome, deadline())
  // A cancellation receipt can win the race; deadline ownership still means TimedOut, not Stopped.
  return (yield* Ref.get(expired)) ? Settlement.cases.Failed.make({ reason: 'TimedOut' }) : result
}, Effect.scoped)

/** A failed cancellation does not erase the deadline outcome or imply another attempt is safe. */
class AbortUnavailable extends Schema.TaggedError<AbortUnavailable>()(
  'AbortUnavailable',
  {},
  { title: 'Runtime cancellation unavailable' },
) {}
