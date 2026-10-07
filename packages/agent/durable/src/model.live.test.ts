import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createProvider, envApiKeyAuth, Type, type ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels } from '@earendil-works/pi-ai/models'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { Config, Console, Effect, Match, Option, Stream } from 'effect'

import { continueRun, decide, HoldId, streamRun, toolsExtension } from './core.ts'
import { tool } from 'ai'
import { z } from 'zod'
import * as Pi from './pi.ts'
import { memory } from './fixtures/harness.ts'
import { consume } from './fixtures/reading.ts'
import { runForPi } from './pi.ts'

const context = BACKGROUND_CONTEXT
const baseUrl = 'https://api.experientiallabs.ai/v1'

/** Two provider calls cover one tool round and its answer; never spend a third request on a loop. */
function budget(api: ProviderStreams): ProviderStreams {
  let requests = 0
  // Gate before dispatch, at the owned public provider boundary, rather than cancelling an HTTP call.
  function admit() {
    requests += 1
    if (requests > 2) throw new Error('Live case exceeded its two-request budget')
  }
  return {
    stream: (model, transcript, options) => {
      admit()
      return api.stream(model, transcript, options)
    },
    streamSimple: (model, transcript, options) => {
      admit()
      return api.streamSimple(model, transcript, options)
    },
  }
}

/** Reuse the opt-in provider configuration for both real transport and held-input claims. */
function explabsModels() {
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
      api: budget(openAICompletionsApi()),
    }),
  )
  return models
}

/**
 * Default EXPLABS uses openai-completions. OpenRouter owns auth and chooses the pinned catalogue's
 * API per model. anthropic-messages keeps partialJson; openai-completions keeps partialArgs.
 * Never infer the API from the model's name or read/log credentials in this fixture.
 */
const liveConfiguration = Effect.fn('Test.liveConfiguration')(function* () {
  const provider = yield* Config.Literals(['explabs', 'openrouter'], 'DURABLE_LIVE_PROVIDER').pipe(
    Config.withDefault('explabs'),
  )
  const selected = yield* Match.value(provider).pipe(
    Match.when('explabs', () => Effect.succeed({ models: explabsModels(), id: 'glm-5.3-flash' })),
    Match.when('openrouter', () =>
      Effect.gen(function* () {
        const id = yield* Config.NonEmptyString('DURABLE_LIVE_MODEL')
        const models = createModels()
        models.setProvider(openrouterProvider())
        return { models, id }
      }),
    ),
    Match.exhaustive,
  )
  const model = selected.models.getModel(provider, selected.id)
  if (model === undefined)
    throw new Error('DURABLE_LIVE_MODEL is absent from the selected provider catalogue')
  return { models: selected.models, model }
})

/**
 * Claim: a real provider's streamed response, with a real tool round, arrives as a valid AI SDK
 * message. Opt in with DURABLE_LIVE=1 and the selected provider credentials; skipped otherwise.
 */
it.live.skipIf(process.env['DURABLE_LIVE'] !== '1')(
  'a real model calls a tool and answers through the stream',
  () =>
    Effect.gen(function* () {
      const { models, model } = yield* liveConfiguration()
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
          agent: { model: { provider: model.provider, modelId: model.id } },
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

/**
 * Claim: approval is requested only for the final multi-field input recorded by a real provider.
 * Opt in with DURABLE_LIVE=1 and the selected provider credentials; no tool executes before approval or more than once.
 */
it.live.skipIf(process.env['DURABLE_LIVE'] !== '1')(
  'a real model approval presents the exact recorded arguments before executing once',
  () =>
    Effect.gen(function* () {
      const { models, model } = yield* liveConfiguration()
      const registry = createRegistry()
      const paid: { account: string; amount: number; memo: string }[] = []
      registry.install(
        yield* toolsExtension(
          'payments',
          {
            pay: tool({
              description: 'Record a payment in this isolated test',
              inputSchema: z.object({
                account: z.string(),
                amount: z.number(),
                memo: z.string().describe('A free-text payment memo of about 150 words'),
              }),
              execute: (arguments_) => {
                paid.push(arguments_)
                return Promise.resolve(arguments_)
              },
            }),
          },
          { approval: { pay: true } },
        ),
      )
      const harness = yield* memory(models, registry, {
        progress: { partialIntervalMs: 1 },
        retry: { enabled: false },
        stream: { maxRetries: 0 },
      })
      const root = yield* Effect.promise(() =>
        harness.root(context, {
          agent: { model: { provider: model.provider, modelId: model.id } },
        }),
      )
      const watched = yield* Pi.watch(harness, root.id, context)
      const first = yield* consume(
        streamRun(
          harness,
          {
            conversationId: root.id,
            content:
              'Call pay exactly once with account savings, amount 12345, and a free-text memo of about 150 words explaining the payment. Then report the result without calling another tool.',
            requestId: 'live-approval',
          },
          context,
        ),
        Option.none(),
      )
      const inputs = first.chunks.filter((chunk) => chunk.type === 'tool-input-available')
      expect(inputs).toHaveLength(1)
      const input = inputs[0]
      if (input === undefined) throw new Error('Expected final input')
      const recorded = (yield* Pi.view(root, context)).entries
        .flatMap((entry) => entry.model ?? [])
        .flatMap((message) => (message.role === 'assistant' ? message.content : []))
        .find((block) => block.type === 'toolCall' && block.id === input.toolCallId)
      if (recorded === undefined || recorded.type !== 'toolCall')
        throw new Error('Expected recorded call')
      // A real endpoint need not persist a truncated block. Report that observation without
      // weakening final-input equality or claiming the live run reproduced N1 when it did not.
      const observed = yield* Stream.runCollect(
        watched.stream.pipe(
          Stream.takeUntil(
            (event) => event.type === 'message_end' && event.entry.kind === 'pi.assistant',
          ),
        ),
      )
      const partials = observed
        .flatMap((event) => (event.type === 'message_update' ? event.changes : []))
        .flatMap((change) =>
          change.type === 'block' && change.block.type === 'toolCall' ? [change.block] : [],
        )
      const truncated = partials.some(
        (block) =>
          block.id === input.toolCallId &&
          (block.arguments.account !== recorded.arguments.account ||
            block.arguments.amount !== recorded.arguments.amount ||
            block.arguments.memo !== recorded.arguments.memo),
      )
      yield* Console.log(
        `truncated-updates-observed: ${truncated}; tool-call-block-changes: ${partials.length}; partialJson-present: ${partials.some((block) => 'partialJson' in block)}; partialArgs-present: ${partials.some((block) => 'partialArgs' in block)}`,
      )
      expect(input.input).toEqual(recorded.arguments)
      expect(input.input).toEqual({ account: 'savings', amount: 12345, memo: expect.any(String) })
      const approval = first.chunks.find((chunk) => chunk.type === 'tool-approval-request')
      if (approval === undefined) throw new Error('Expected approval request')
      expect(first.chunks.indexOf(approval)).toBeGreaterThan(first.chunks.indexOf(input))
      expect(paid).toEqual([])
      yield* decide(
        harness,
        root.id,
        { holdId: yield* HoldId.makeEffect(approval.approvalId), approved: true },
        context,
      )
      yield* consume(
        yield* continueRun(
          harness,
          root.id,
          { messageId: first.message.id, known: new Set([input.toolCallId]) },
          context,
        ),
        Option.some(first.message),
      )
      expect(paid).toEqual([recorded.arguments])
    }),
  120_000,
)
