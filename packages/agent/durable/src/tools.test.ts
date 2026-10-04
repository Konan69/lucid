import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { readUIMessageStream, tool, type UIMessage } from 'ai'
import { expect, it } from 'vitest'
import { z } from 'zod'

import { streamRun } from './stream.ts'
import { toolsExtension } from './tools.ts'

const context = BACKGROUND_CONTEXT

/** One run on a harness whose only tools are the given AI SDK tools; returns the final message. */
async function run(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const seen: unknown[] = []
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(responses)
  const registry = createRegistry()
  registry.install(
    await toolsExtension('shop', {
      price: tool({
        description: 'Price of an item',
        inputSchema: z.object({ item: z.string(), currency: z.string().default('NGN') }),
        execute: async (input) => {
          seen.push(input)
          return { amount: 1500, currency: input.currency }
        },
      }),
    }),
  )
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } })
  const stream = await streamRun(harness, { conversationId: root.id, content: 'Price?', requestId: 'p1' }, context)
  let message: UIMessage | undefined
  for await (const next of readUIMessageStream({ stream })) message = next
  await harness.close(context)
  return { message, seen }
}

it('runs an AI SDK tool with a Zod input schema inside Pi Durable', async () => {
  const { message, seen } = await run([
    fauxAssistantMessage([fauxToolCall('price', { item: 'rice' }, { id: 'c1' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('1500 NGN.'),
  ])

  // The Zod default was applied: the tool's own validator ran, not only the JSON Schema check.
  expect(seen).toEqual([{ item: 'rice', currency: 'NGN' }])
  expect(message?.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
    toolName: 'price',
    state: 'output-available',
    output: { content: [{ type: 'text', text: '{"amount":1500,"currency":"NGN"}' }] },
  })
})

it('rejects arguments that do not match the schema before the tool runs', async () => {
  const { message, seen } = await run([
    // Pi Durable coerces a number to a string, so a wrong type is not invalid. A missing field is.
    fauxAssistantMessage([fauxToolCall('price', { currency: 'USD' }, { id: 'c2' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Sorry.'),
  ])

  expect(seen).toEqual([])
  expect(message?.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({ state: 'output-error' })
})
