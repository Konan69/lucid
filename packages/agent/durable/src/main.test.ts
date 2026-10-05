import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'

import { ConversationMissing, decide } from './main.ts'

const context = BACKGROUND_CONTEXT

/** The facade rejects with the original typed class, even though the failure crossed Effect.runPromise. */
it('preserves ConversationMissing as the Promise rejection', async () => {
  const options = { models: createModels(), registry: createRegistry() }
  const owner = await Harness.open(new MemoryStorage(), options, context)
  const empty = await Harness.open(new MemoryStorage(), options, context)
  try {
    const conversation = await owner.root(context)
    await expect(
      decide(empty, conversation.id, { callId: 'missing', approved: true }, context),
    ).rejects.toBeInstanceOf(ConversationMissing)
  } finally {
    await empty.close(context)
    await owner.close(context)
  }
})
