import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createProvider, envApiKeyAuth, Type } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { readUIMessageStream, type UIMessage } from 'ai'
import { expect, it } from 'vitest'

import { streamRun } from './stream.ts'

const context = BACKGROUND_CONTEXT
const baseUrl = 'https://api.experientiallabs.ai/v1'

/**
 * Claim: a real provider's streamed response, with a real tool round, arrives as a valid AI SDK
 * message. Opt in with DURABLE_LIVE=1 and EXPLABS_API_KEY; skipped otherwise.
 */
it.skipIf(process.env['DURABLE_LIVE'] !== '1')(
  'a real model calls a tool and answers through the stream',
  async () => {
    const models = createModels()
    models.setProvider(
      createProvider({
        id: 'explabs',
        name: 'Experiential Labs',
        baseUrl,
        auth: { apiKey: envApiKeyAuth('Experiential Labs API key', ['EXPLABS_API_KEY']) },
        models: [
          {
            id: 'glm-5.3-flash',
            name: 'GLM 5.3 Flash',
            api: 'openai-completions',
            provider: 'explabs',
            baseUrl,
            reasoning: true,
            input: ['text', 'image'],
            cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
            contextWindow: 1_310_720,
            maxTokens: 131_072,
          },
        ],
        api: openAICompletionsApi(),
      }),
    )
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: 'stock',
        tools: [
          defineTool({
            name: 'stock_count',
            description: 'Number of units of an item in the warehouse',
            parameters: Type.Object({ item: Type.String() }),
            execute: async () => ({ content: [{ type: 'text', text: '4127' }] }),
          }),
        ],
      }),
    )
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
    const root = await harness.root(context, {
      agent: { model: { provider: 'explabs', modelId: 'glm-5.3-flash' } },
    })

    const stream = await streamRun(
      harness,
      {
        conversationId: root.id,
        content: 'How many units of "blue widget" are in the warehouse? Use the tool, then answer.',
        requestId: 'live-1',
      },
      context,
    )
    const types = new Map<string, number>()
    const [counted, read] = stream.tee()
    const counting = (async () => {
      for await (const chunk of counted) types.set(chunk.type, (types.get(chunk.type) ?? 0) + 1)
    })()
    let message: UIMessage | undefined
    for await (const next of readUIMessageStream({ stream: read })) message = next
    await counting
    console.log('chunk counts', Object.fromEntries(types))
    console.log('parts', message?.parts.map((part) => part.type))

    expect(message?.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
      toolName: 'stock_count',
      state: 'output-available',
    })
    const text = message?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    expect(text?.replaceAll(',', '')).toContain('4127')
    await harness.close(context)
  },
  120_000,
)
