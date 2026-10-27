import { ConversationState, RuntimeUnavailable, type ThreadId } from '@vivid/contracts'
import { Effect, Option } from 'effect'
import { HttpClientResponse } from 'effect/http'
import { findThread } from '../threads/access.ts'
import type { RuntimeService } from './client.ts'

/** Decode canonical conversation state once before server consumers attribute it to product Runs. */
export const readThreadHistory = Effect.fn('Runtime.history')(function* (
  runtime: Pick<RuntimeService, 'read'>,
  threadId: ThreadId,
) {
  const thread = yield* findThread(threadId)
  if (Option.isNone(thread))
    return yield* RuntimeUnavailable.make({ message: 'History Thread not found' })
  const response = yield* runtime.read({
    threadId,
    suffix: '',
  })
  if (response.status < 200 || response.status >= 300)
    return yield* RuntimeUnavailable.make({ message: 'Conversation history could not be read' })
  const state = yield* HttpClientResponse.schemaBodyJson(ConversationState)(response).pipe(
    Effect.mapError(() => RuntimeUnavailable.make({ message: 'Conversation history is invalid' })),
  )
  return state
})
