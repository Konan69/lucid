import type { Context } from '@earendil-works/chord'
import {
  ConversationBusy,
  type AgentEvent,
  type Conversation,
  type Harness,
  type ConversationId,
  type InputSubmissionDraft,
  type SubmissionId,
  type SubmissionRecord,
} from '@earendil-works/pi-durable'
import { Effect, Exit, Option, Scope, Stream } from 'effect'
import {
  ConversationMissing,
  PiFailed,
  TurnBusy,
  TurnConflict,
  TurnWithdrawn,
  WatchClosed,
  WatchOverflowed,
} from './errors.ts'
import * as Pi from './pi.ts'

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
  | ConversationMissing
  | PiFailed
  | TurnBusy
  | TurnConflict
  | TurnWithdrawn
  | WatchClosed
  | WatchOverflowed

/** events.js:218–219 publishes submission receipts before run_start. Observe the submitted input's
 * own placement or settlement, including all unanswered reasons (types.d.ts:318–348); abort of a
 * queued input is unanswered/aborted without an entry (inbox.js:85–93). No run_start is required. */
export const placed = Effect.fn('Durable.awaitPlacement')(function* (
  watched: Watching,
  submissionId: SubmissionId,
) {
  const arrived = yield* Stream.runHead(
    Stream.filter(
      watched.stream,
      (
        event,
      ): event is Extract<AgentEvent, { type: 'submission' }> & { readonly record: InputReceipt } =>
        event.type === 'submission' &&
        event.record.type === 'input' &&
        event.record.id === submissionId &&
        event.record.status !== 'queued',
    ),
  )
  if (Option.isNone(arrived))
    return yield* new PiFailed({
      operation: 'watch',
      cause: new Error('Submission observation ended before its receipt settled'),
    })
  return arrived.value.record
})

/** A never-placed input has no Person entry to acknowledge or assistant run to replay. */
function withdrawn(receipt: InputReceipt) {
  return receipt.status === 'unanswered' && receipt.entry === undefined
}

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
    const initialScope = yield* Scope.fork(scope)
    const watched = yield* Pi.watch(harness, input.conversationId, context).pipe(
      Scope.provide(initialScope),
    )
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
    if (queued) receipt = yield* placed(watched, submission.id)
    if (withdrawn(receipt)) return yield* new TurnWithdrawn({ messageId: input.draft.requestId })
    const alreadyRunning =
      watched.snapshot.run !== undefined && watched.snapshot.run.inputs.includes(submission.id)
    const busy = watched.snapshot.run !== undefined && !alreadyRunning
    if (!queued && !busy && input.draft.whenBusy !== 'steer')
      return { conversation, receipt, watched }
    const fresh = yield* Pi.watch(harness, input.conversationId, context).pipe(Scope.provide(scope))
    yield* Scope.close(initialScope, Exit.void)
    // The run may have finished between receipt delivery and the fresh snapshot; read its final status once.
    receipt = yield* Pi.inputStatus(submission, context)
    if (withdrawn(receipt)) return yield* new TurnWithdrawn({ messageId: input.draft.requestId })
    return { conversation, receipt, watched: fresh }
  },
)
