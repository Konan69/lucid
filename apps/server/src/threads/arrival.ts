import { Effect } from 'effect'
import { OpenFirstThreadResult } from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Conversation, DeliveryMessage, DeliverySpeaker, StoredRunOrigin } from './conversation.ts'
import { ThreadStore } from './store.ts'

/**
 * Only the transaction's creator admits a Run. Its constant key belongs to this unique Thread;
 * Conversation persists Run attribution and Flue keeps all conversation words. Neither a
 * repeated call nor an older Person's arrival submits a message or a signal.
 */
export const openFirstThread = Effect.fn('Threads.openFirst')(function* (actor: Actor) {
  const threads = yield* ThreadStore
  const result = yield* threads.openFirst(actor)
  if (OpenFirstThreadResult.guards.Opened(result)) {
    yield* (yield* Conversation)
      .deliver({
        threadId: result.thread,
        personId: actor.person.id,
        speaker: DeliverySpeaker.cases.Vivid.make({}),
        libraryFolder: null,
        message: DeliveryMessage.cases.FirstConversation.make({}),
        origin: StoredRunOrigin.cases.FirstConversation.make({}),
        idempotencyKey: 'first-conversation',
      })
      .pipe(
        // Compensation must not replace the delivery's typed failure if SQL is also unavailable.
        // A failed transaction retains its receipt; log that precise failure for repair.
        Effect.tapError(() =>
          threads
            .releaseFirst(actor.person.id, result.thread)
            .pipe(
              Effect.catch((error) =>
                Effect.logError('First Thread compensation failed', error._tag),
              ),
            ),
        ),
      )
  }
  return result
})
