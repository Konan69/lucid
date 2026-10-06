import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { Effect } from 'effect'

import * as Pi from './pi.ts'

/**
 * Explicitly stop Pi's ordinary conversation ownership scope, including queued follow-ups. Unlike
 * detaching the HTTP reader, this waits for durable abort settlement. Pi harness/harness.js abort
 * delegates to scheduler.abortConversation; hook waits honor the invocation's cancellation signal.
 */
export const abort: (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) => Effect.Effect<
  void,
  import('./errors.ts').ConversationMissing | import('./errors.ts').PiFailed
> = Effect.fn('Durable.abort')(function* (
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
) {
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  yield* Pi.abort(conversation, context)
})
