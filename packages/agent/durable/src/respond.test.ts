import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from 'ai'
import { expect, it } from 'vitest'

import { respond } from './respond.ts'

const context = BACKGROUND_CONTEXT

it('answers the AI SDK default chat transport over SSE', async () => {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([fauxAssistantMessage('Paris.')])
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  )
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })

  // The unmodified transport `useChat` uses by default, with fetch routed to the handler.
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => respond(harness, root.id, new Request(url, init), context),
  })
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: 'chat-1',
    messageId: undefined,
    abortSignal: undefined,
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Capital of France?' }] }],
  })

  let message: UIMessage | undefined
  for await (const next of readUIMessageStream({ stream })) message = next
  expect(message?.parts.at(-1)).toMatchObject({ type: 'text', text: 'Paris.', state: 'done' })

  // The durable transcript holds the user turn, proving the request went through Pi Durable.
  const entries = await root.entries({}, 10, undefined, context)
  expect([...entries.items].map((entry) => entry.kind)).toContain('pi.user')
  await harness.close(context)
})
