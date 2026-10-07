import type { Context } from '@earendil-works/chord'
import {
  ConversationBusy,
  LiveDoc,
  type AgentEvent,
  type Submission,
  type Conversation,
  type Harness,
  type ConversationId,
  type InputSubmissionDraft,
  type SubmissionRecord,
} from '@earendil-works/pi-durable'
import { Effect, Exit, Option, Scope, Stream } from 'effect'
import {
  ConversationMissing,
  ToolNameDuplicated,
  PiFailed,
  TurnBusy,
  TurnConflict,
  TurnWithdrawn,
  TurnStranded,
  TurnWaiting,
  WatchClosed,
  WatchOverflowed,
} from './errors.ts'
import * as Pi from './pi.ts'
import { validateTools } from './desk.ts'
import { isParked } from './busy.ts'

type InputReceipt = Extract<SubmissionRecord, { type: 'input' }>
type Watching = Effect.Success<ReturnType<typeof Pi.watch>>
type Admission = {
  readonly conversation: Conversation
  readonly receipt: InputReceipt
  readonly watched: Watching
}
type Draft = {
  readonly conversationId: ConversationId
  readonly draft: InputSubmissionDraft & { readonly requestId: string }
}
type AdmissionFailure =
  | ToolNameDuplicated
  | ConversationMissing
  | PiFailed
  | TurnBusy
  | TurnConflict
  | TurnWithdrawn
  | TurnWaiting
  | WatchClosed
  | WatchOverflowed

/** Only settled event boundaries can prove parking; partial text never triggers a transcript read. */
function admissionSettled(event: AgentEvent): boolean {
  return (
    event.type === 'message_end' || event.type === 'tool_execution_end' || event.type === 'turn_end'
  )
}

type ObservedInput = {
  harness: Harness
  submission: Submission
  conversationId: ConversationId
  messageId: string
  policy: 'follow' | 'admit'
}

/** An event watch is open before admission. events.js:216 emits run_end before submission
 * receipts in that commit, so re-read this receipt on run_end: placed successors proceed, but a
 * queued input is stranded (Pi README:322). The initial idle check covers following after failure.
 * No timer or mutation is part of this observer; only library admission may withdraw its input. */
export const placed: (
  watched: Watching,
  input: ObservedInput,
  context: Context,
) => Effect.Effect<
  InputReceipt,
  ConversationMissing | PiFailed | TurnWaiting | TurnStranded | WatchClosed | WatchOverflowed
> = Effect.fn('Durable.awaitPlacement')(function* (watched, input, context) {
  if (watched.snapshot.run === undefined) {
    const live = yield* Pi.snapshot(input.harness, LiveDoc, input.conversationId, context)
    if (Option.isNone(live) || live.value.run === undefined) {
      const receipt = yield* Pi.inputStatus(input.submission, context)
      if (receipt.status !== 'queued') return receipt
      return yield* new TurnStranded({ messageId: input.messageId })
    }
  }
  const arrived = yield* Stream.runHead(
    watched.stream.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          if (
            event.type === 'submission' &&
            event.record.type === 'input' &&
            event.record.id === input.submission.id &&
            event.record.status !== 'queued'
          )
            return Option.some(event.record)
          if (event.type !== 'run_end') {
            if (
              input.policy === 'admit' &&
              admissionSettled(event) &&
              (yield* isParked(input.harness, input.conversationId, context))
            ) {
              const receipt = yield* Pi.inputStatus(input.submission, context)
              if (receipt.status === 'queued')
                return yield* new TurnWaiting({ conversationId: input.conversationId })
              return Option.some(receipt)
            }
            return Option.none<InputReceipt>()
          }
          return yield* endedPlacement(input, event, context)
        }),
      ),
      Stream.filter(Option.isSome),
      Stream.map((record) => record.value),
    ),
  )
  if (Option.isNone(arrived))
    return yield* new PiFailed({
      operation: 'watch',
      cause: new Error('Submission watch ended before placement'),
    })
  return arrived.value
})

/** Unlike equal failure texts, run_end.inputs is direct membership evidence for a failed steer.
 * Carry the first input's settled receipt before replacing this watch; no transcript guessing. */
const endedOrigin = Effect.fn('Durable.endedInputOrigin')(function* (
  harness: Harness,
  event: Extract<AgentEvent, { type: 'run_end' }>,
  receipt: InputReceipt,
  context: Context,
) {
  if (!event.inputs.includes(receipt.id)) return receipt
  const first = event.inputs[0]
  if (first === undefined || first === receipt.id) return receipt
  const input = yield* Pi.submission(harness, first, context)
  if (Option.isNone(input))
    return yield* new PiFailed({
      operation: 'status',
      cause: new Error('Observed run has no first input receipt'),
    })
  return yield* Pi.inputStatus(input.value, context)
})

/** A run-end signal only strands an input while the conversation is idle. A buffered end from
 * an older run must not withdraw work queued behind its already-running successor. */
const endedPlacement = Effect.fn('Durable.endedPlacement')(function* (
  input: ObservedInput,
  event: Extract<AgentEvent, { type: 'run_end' }>,
  context: Context,
) {
  const receipt = yield* Pi.inputStatus(input.submission, context)
  if (receipt.status === 'queued') {
    // An older buffered run_end may arrive after a successor has started. Only idle
    // with this input still queued is stranded; a successor's boundary may place it.
    const live = yield* Pi.snapshot(input.harness, LiveDoc, input.conversationId, context)
    if (Option.isNone(live) || live.value.run === undefined)
      return yield* new TurnStranded({ messageId: input.messageId })
    return Option.none<InputReceipt>()
  }
  return Option.some(yield* endedOrigin(input.harness, event, receipt, context))
})

/** This is a single public Pi call, kept here because admission owns withdrawal and pi.ts is
 * outside this lane's paths. Submission.abort is serialized (submissions.js:65–79); a racing
 * placement wins and is read back, never mistaken for a withdrawn input. */
const withdrawSubmission = (submission: Submission, context: Context) =>
  Effect.tryPromise({
    try: () => submission.abort(context),
    catch: (cause) => new PiFailed({ operation: 'abort', cause }),
  })

/** A never-placed input has no Person entry to acknowledge or assistant run to replay. */
function withdrawn(receipt: InputReceipt) {
  return receipt.status === 'unanswered' && receipt.entry === undefined
}

/** A queued steer can complete between placement and the fresh snapshot. live.js endRun settles
 * every input with the same final assistant entry. Compare that immutable answer with the original
 * watch's first input receipt: equal answers prove the shared run, while a follow-up has a different
 * answer. An unanswered run has no such evidence and keeps its own receipt; no association is guessed. */
export const settledOrigin: (
  harness: Harness,
  watched: Watching,
  receipt: InputReceipt,
  context: Context,
) => Effect.Effect<InputReceipt, PiFailed> = Effect.fn('Durable.settledInputOrigin')(
  function* (harness, watched, receipt, context) {
    if (receipt.status !== 'done' || watched.snapshot.run === undefined) return receipt
    const first = watched.snapshot.run.inputs[0]
    if (first === undefined)
      return yield* new PiFailed({
        operation: 'watch',
        cause: new Error('Observed run has no first input'),
      })
    if (first === receipt.id) return receipt
    const handle = yield* Pi.submission(harness, first, context)
    if (Option.isNone(handle))
      return yield* new PiFailed({
        operation: 'status',
        cause: new Error('Observed first input has no submission receipt'),
      })
    const candidate = yield* Pi.inputStatus(handle.value, context)
    return candidate.status === 'done' && candidate.answer === receipt.answer ? candidate : receipt
  },
)

/** Receipt reacquisition owns the queued-to-terminal race, separately from stream selection.
 * Only a newly queued observer has an earlier run snapshot that can prove a completed steer's
 * common final answer. Missing admitted receipts are a Pi status-contract failure, not unknown ids. */
export const reacquireInput: (
  harness: Harness,
  observed: { readonly watched: Watching; readonly record: InputReceipt },
  context: Context,
) => Effect.Effect<InputReceipt, PiFailed> = Effect.fn('Durable.reacquireInput')(
  function* (harness, observed, context) {
    const handle = yield* Pi.submission(harness, observed.record.id, context)
    if (Option.isNone(handle))
      return yield* new PiFailed({
        operation: 'status',
        cause: new Error('Admitted input has no receipt'),
      })
    const receipt = yield* Pi.inputStatus(handle.value, context)
    return observed.record.status === 'queued'
      ? yield* settledOrigin(harness, observed.watched, receipt, context)
      : receipt
  },
)

/** An unchanged retry observes its own admitted run; only a new turn can queue behind it. */
const admitNewTurn = Effect.fn('Durable.admitNewTurn')(function* (
  harness: Harness,
  owner: { conversation: Conversation; input: Draft },
  context: Context,
) {
  const prior = yield* Pi.request(owner.conversation, owner.input.draft.requestId, context)
  if (Option.isNone(prior) && (yield* isParked(harness, owner.input.conversationId, context)))
    return yield* new TurnWaiting({ conversationId: owner.input.conversationId })
  return undefined
})

/** A captured run_end receipt is stronger than an equal final-answer comparison. */
const freshOrigin = Effect.fn('Durable.freshInputOrigin')(function* (
  harness: Harness,
  observed: { watched: Watching; before: InputReceipt; current: InputReceipt },
  context: Context,
) {
  if (observed.before.id !== observed.current.id) return observed.before
  return yield* settledOrigin(harness, observed.watched, observed.current, context)
})

/**
 * The first watch precedes admission. Queued inputs wait on their own durable receipt before a
 * response is exposed. After placement reopen an atomic snapshot/watch: it includes progress while
 * the queue was waiting, and its tail begins after that snapshot, preventing gaps or duplicate frames.
 * A steer joins an existing run without run_start, so it uses the same snapshot path. Child scopes
 * close the initial observation once replaced; cancelling observation never aborts durable work.
 */
export const admit: (
  harness: Harness,
  input: Draft,
  context: Context,
  scope: Scope.Scope,
) => Effect.Effect<Admission, AdmissionFailure> = Effect.fn('Durable.admit')(
  function* (harness, input, context, scope) {
    const conversation = yield* Pi.conversation(harness, input.conversationId, context)
    yield* validateTools({ harness, conversation, context })
    const initialScope = yield* Scope.fork(scope)
    const watched = yield* Pi.watch(harness, input.conversationId, context).pipe(
      Scope.provide(initialScope),
    )
    yield* admitNewTurn(harness, { conversation, input }, context)
    const submission = yield* Pi.submit(conversation, input.draft, context).pipe(
      Effect.mapError((error) =>
        error.cause instanceof ConversationBusy
          ? new TurnBusy({ conversationId: input.conversationId })
          : error,
      ),
    )
    yield* Pi.verifyInput(conversation, input.draft, context)
    let receipt = yield* Pi.inputStatus(submission, context)
    const queued = receipt.status === 'queued'
    if (queued)
      receipt = yield* placed(
        watched,
        {
          harness,
          submission,
          conversationId: input.conversationId,
          messageId: input.draft.requestId,
          policy: 'admit',
        },
        context,
      ).pipe(
        Effect.catchTags({
          TurnWaiting: (error) =>
            Effect.gen(function* () {
              yield* withdrawSubmission(submission, context)
              const current = yield* Pi.inputStatus(submission, context)
              if (withdrawn(current)) return yield* error
              return current
            }),
          TurnStranded: () =>
            Effect.gen(function* () {
              yield* withdrawSubmission(submission, context)
              return yield* Pi.inputStatus(submission, context)
            }),
        }),
      )
    if (withdrawn(receipt)) return yield* new TurnWithdrawn({ messageId: input.draft.requestId })
    const alreadyRunning =
      watched.snapshot.run !== undefined && watched.snapshot.run.inputs.includes(submission.id)
    const busy = watched.snapshot.run !== undefined && !alreadyRunning
    if (!queued && !busy && input.draft.whenBusy !== 'steer')
      return { conversation, receipt, watched }
    const observed = receipt
    const fresh = yield* Pi.watch(harness, input.conversationId, context).pipe(Scope.provide(scope))
    // The run may have finished between receipt delivery and the fresh snapshot; read its final status once.
    receipt = yield* Pi.inputStatus(submission, context)
    if (withdrawn(receipt)) return yield* new TurnWithdrawn({ messageId: input.draft.requestId })
    if (queued && (receipt.status === 'done' || receipt.status === 'unanswered'))
      receipt = yield* freshOrigin(
        harness,
        { watched, before: observed, current: receipt },
        context,
      )
    yield* Scope.close(initialScope, Exit.void)
    return { conversation, receipt, watched: fresh }
  },
)
