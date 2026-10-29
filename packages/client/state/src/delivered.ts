import { VividRpcClient } from '@vivid/client-runtime'
import {
  RunOutcome,
  type ConversationState,
  type PersonId,
  type Run,
  type RunId,
  type ThreadId,
} from '@vivid/contracts'
import { Effect, Exit, Result } from 'effect'
import * as Atom from 'effect/reactivity/Atom'
import type { LiveEngine } from './live.js'

/**
 * A Run's delivery receipt, decided once for web, phone and desktop: the Person a Run acted for
 * acknowledges its final response (`AcknowledgeRunDelivery`) once their screen has drawn the
 * message that is that response, and only while they are looking at the Thread. The Run list
 * alone is not this: a completed Run says a reply exists, not that anyone saw it.
 */

/** What the server is told for one Run: the Run and the response that answered it. */
export interface DeliveryReceipt {
  readonly runId: RunId
  readonly responseId: RunId
}

/**
 * The messages that are final responses this Person has not acknowledged, by message id, each
 * with the Runs it answers (Runs that joined one reply share it).
 *
 * The response is found from the conversation itself: the Run's delivery (`Run.submissionId`)
 * settled as answered by a submission (`answeredBy`), and that submission's last visible message
 * from Vivid is the reply. Another member's Runs in a shared Thread are theirs to acknowledge.
 */
export const answersAwaiting = (input: {
  readonly runs: ReadonlyArray<Run>
  readonly conversation: Pick<ConversationState, 'messages' | 'settlements'>
  readonly me: PersonId
}): ReadonlyMap<string, ReadonlyArray<DeliveryReceipt>> => {
  const answeredBy = new Map(
    input.conversation.settlements.flatMap((settlement) =>
      settlement.answeredBy === undefined ? [] : [[settlement.submissionId, settlement.answeredBy]],
    ),
  )
  const replyOf = new Map<string, string>()
  for (const message of input.conversation.messages)
    if (
      message.role === 'assistant' &&
      message.display === 'visible' &&
      message.submissionId !== undefined
    )
      replyOf.set(message.submissionId, message.id)
  const awaiting = new Map<string, ReadonlyArray<DeliveryReceipt>>()
  for (const run of input.runs) {
    if (run.origin.person.id !== input.me || run.submissionId === undefined) continue
    if (run.outcome === null || !RunOutcome.guards.Completed(run.outcome)) continue
    const answering = answeredBy.get(run.submissionId)
    const message = answering === undefined ? undefined : replyOf.get(answering)
    if (message === undefined) continue
    const receipt = { runId: run.id, responseId: run.outcome.responseId }
    const joined = awaiting.get(message)
    awaiting.set(message, joined === undefined ? [receipt] : [...joined, receipt])
  }
  return awaiting
}

/** A Thread holds at most this many Runs on the wire (`RunStore.list`), so this covers a Thread. */
const REMEMBERED = 200

/** What an app supplies: its live engine, whether it is in front, and how it starts a program. */
export interface DeliveryInput {
  readonly engine: Pick<LiveEngine, 'run'>
  /** The same "in front" signal the app's presence reads (`presentIn`). */
  readonly front: Atom.Atom<boolean>
  /** Starts a described program on the app's runtime; its handle is not used. */
  readonly launch: (program: Effect.Effect<void>) => void
}

/**
 * The app's delivery ledger. A screen reports a final response it drew (`drawn`) and mounts
 * `watching` for a Thread only while its Person is looking at it; an acknowledgement goes out
 * when both hold, once per Run. One that does not get through is released and sent again the next
 * time that reply is drawn while looked at.
 */
export function makeDelivery(input: DeliveryInput) {
  const sent = new Set<RunId>()
  /** Drawn and not yet acknowledged, by Thread: drawn while nobody was looking waits here. */
  const waiting = new Map<ThreadId, Map<RunId, DeliveryReceipt>>()
  const looked = new Set<ThreadId>()

  const claim = (id: RunId): boolean => {
    if (sent.has(id)) return false
    sent.add(id)
    if (sent.size > REMEMBERED) {
      const oldest = sent.values().next()
      if (oldest.done !== true) sent.delete(oldest.value)
    }
    return true
  }

  const acknowledge = (receipt: DeliveryReceipt) =>
    input.engine
      .run(
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          yield* client.AcknowledgeRunDelivery(receipt)
        }),
      )
      .pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (!(Exit.isSuccess(exit) && Result.isSuccess(exit.value))) sent.delete(receipt.runId)
          }),
        ),
        Effect.asVoid,
      )

  /** Sends what a looked-at Thread has drawn and not yet acknowledged. */
  const flush = (thread: ThreadId) => {
    const drawn = waiting.get(thread)
    if (drawn === undefined || !looked.has(thread)) return
    waiting.delete(thread)
    for (const receipt of drawn.values())
      if (claim(receipt.runId)) input.launch(acknowledge(receipt))
  }

  /** The screen drew the message these Runs were answered by. */
  const drawn = (thread: ThreadId, receipts: ReadonlyArray<DeliveryReceipt>) => {
    const before = waiting.get(thread)
    const drawnHere = before === undefined ? new Map<RunId, DeliveryReceipt>() : before
    for (const receipt of receipts) drawnHere.set(receipt.runId, receipt)
    waiting.set(thread, drawnHere)
    flush(thread)
  }

  /**
   * Held by a Thread's screen only while its Person is looking at it, as presence is. While the
   * app is also in front, what that screen drew is acknowledged.
   */
  const watching = Atom.family((thread: ThreadId) =>
    Atom.make((get) => {
      const front = get(input.front)
      get.addFinalizer(() => looked.delete(thread))
      if (!front) return false
      looked.add(thread)
      flush(thread)
      return true
    }),
  )

  return { drawn, watching }
}

export type Delivery = ReturnType<typeof makeDelivery>
