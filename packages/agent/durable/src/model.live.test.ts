import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createProvider, envApiKeyAuth, Type } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { streamRun } from './core.ts'
import { memory } from './fixtures/harness.ts'
import { consume } from './fixtures/reading.ts'
import { runForPi } from './pi.ts'

const context = BACKGROUND_CONTEXT
const baseUrl = 'https://api.experientiallabs.ai/v1'

/**
 * Claim: a real provider's streamed response, with a real tool round, arrives as a valid AI SDK
 * message. Opt in with DURABLE_LIVE=1 and EXPLABS_API_KEY; skipped otherwise.
 */
it.live.skipIf(process.env['DURABLE_LIVE'] !== '1')(
  'a real model calls a tool and answers through the stream',
  () =>
    Effect.gen(function* () {
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
              execute: (_args, _api, callbackContext) =>
                runForPi(
                  Effect.succeed({ content: [{ type: 'text' as const, text: '4127' }] }),
                  callbackContext.abortSignal,
                ),
            }),
          ],
        }),
      )
      const harness = yield* memory(models, registry)
      const root = yield* Effect.promise(() =>
        harness.root(context, {
          agent: { model: { provider: 'explabs', modelId: 'glm-5.3-flash' } },
        }),
      )

      const stream = streamRun(
        harness,
        {
          conversationId: root.id,
          content:
            'How many units of "blue widget" are in the warehouse? Use the tool, then answer.',
          requestId: 'live-1',
        },
        context,
      )
      const { message } = yield* consume(stream, Option.none())

      expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
        toolName: 'stock_count',
        state: 'output-available',
      })
      const text = message.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
      expect(text.replaceAll(',', '')).toContain('4127')
    }),
  120_000,
)
