import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import {
  InvalidRequest,
  type ConversationFrame,
  type SendToThreadRequest,
  type ThreadId,
} from '@vivid/contracts'

/**
 * The conversation a Person's client reads and sends to, whichever runtime holds the Thread.
 *
 * Contract stubs for the two-backend move (plan: `~/agency/vivid-lanes/briefs/two-backends-plan.md`).
 * `watchConversation` checks the Person and the Thread, then sends one `Whole` built from the
 * Thread's runtime and every later change. `sendToThread` validates the pictures as the gateway's
 * send does and admits the delivery through `Conversation.admit`, answering with the Run.
 */
export const watchConversation = (
  _request: { readonly threadId: ThreadId },
): Stream.Stream<ConversationFrame, InvalidRequest> =>
  Stream.fail(InvalidRequest.make({ message: 'WatchConversation is not implemented yet.' }))

export const sendToThread = Effect.fn('Rpc.SendToThread')(function* (
  _request: SendToThreadRequest,
) {
  return yield* InvalidRequest.make({ message: 'SendToThread is not implemented yet.' })
})
