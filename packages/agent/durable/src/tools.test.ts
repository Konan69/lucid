import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry } from '@earendil-works/pi-durable'
import { tool } from 'ai'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { z } from 'zod'

import { streamRun, toolsExtension, ToolSchemaFailed } from './core.ts'
import { memory } from './fixtures/harness.ts'
import { consume } from './fixtures/reading.ts'

const context = BACKGROUND_CONTEXT

/** One run on a harness whose only tools are the given AI SDK tools; returns the final message. */
const run = Effect.fn('Test.runTool')(function* (
  responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
) {
  const seen: { item: string; currency: string }[] = []
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(responses)
  const registry = createRegistry()
  registry.install(
    yield* toolsExtension(
      'shop',
      {
        price: tool({
          description: 'Price of an item',
          inputSchema: z.object({ item: z.string(), currency: z.string().default('NGN') }),
          execute: async (input) => {
            seen.push(input)
            return { amount: 1500, currency: input.currency }
          },
        }),
      },
      {},
    ),
  )
  const harness = yield* memory(models, registry)
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  const { message } = yield* consume(
    streamRun(harness, { conversationId: root.id, content: 'Price?', requestId: 'p1' }, context),
    Option.none(),
  )
  return { message, seen }
})

it.live('runs an AI SDK tool with a Zod input schema inside Pi Durable', () =>
  Effect.gen(function* () {
    const { message, seen } = yield* run([
      fauxAssistantMessage([fauxToolCall('price', { item: 'rice' }, { id: 'c1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('1500 NGN.'),
    ])

    // The Zod default was applied: the tool's own validator ran, not only the JSON Schema check.
    expect(seen).toEqual([{ item: 'rice', currency: 'NGN' }])
    // A bridged tool is a typed part with the tool's own output, as `streamText` would give it.
    expect(message.parts.find((part) => part.type === 'tool-price')).toMatchObject({
      state: 'output-available',
      input: { item: 'rice' },
      output: { amount: 1500, currency: 'NGN' },
    })
  }),
)

it.live('rejects arguments that do not match the schema before the tool runs', () =>
  Effect.gen(function* () {
    const { message, seen } = yield* run([
      // Pi Durable coerces a number to a string, so a wrong type is not invalid. A missing field is.
      fauxAssistantMessage([fauxToolCall('price', { currency: 'USD' }, { id: 'c2' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Sorry.'),
    ])

    expect(seen).toEqual([])
    expect(message.parts.find((part) => part.type === 'tool-price')).toMatchObject({
      state: 'output-error',
    })
  }),
)

/** Registration identifies the exact tool whose schema cannot be represented as JSON Schema. */
it.live('names a tool whose SDK schema cannot be built', () =>
  Effect.gen(function* () {
    const failed = yield* Effect.flip(
      toolsExtension(
        'unsupported',
        {
          symbolic: tool({
            description: 'Requires a symbol',
            inputSchema: z.object({ value: z.symbol() }),
          }),
        },
        {},
      ),
    )
    expect(failed).toBeInstanceOf(ToolSchemaFailed)
    expect(failed.toolName).toBe('symbolic')
  }),
)

/** Rejected SDK execution and invalid durable output are separate failures, both reported as tool errors. */
it.live('presents SDK rejection and serialization failure as tool output errors', () =>
  Effect.gen(function* () {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('broken', {}, { id: 'reject' }),
          fauxToolCall('unserializable', {}, { id: 'json' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('The tools failed.'),
    ])
    const registry = createRegistry()
    registry.install(
      yield* toolsExtension(
        'failures',
        {
          broken: tool({
            description: 'Rejects execution',
            inputSchema: z.object({}),
            execute: async (): Promise<string> => {
              throw new Error('ledger offline')
            },
          }),
          unserializable: tool({
            description: 'Returns a non JSON number',
            inputSchema: z.object({}),
            execute: async () => ({ amount: 1n }),
          }),
        },
        {},
      ),
    )
    const harness = yield* memory(models, registry)
    const root = yield* Effect.promise(() =>
      harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } }),
    )
    const { message } = yield* consume(
      streamRun(
        harness,
        { conversationId: root.id, content: 'Try both', requestId: 'failures' },
        context,
      ),
      Option.none(),
    )
    expect(message.parts.find((part) => part.type === 'tool-broken')).toMatchObject({
      state: 'output-error',
      errorText: expect.stringContaining('ledger offline'),
    })
    expect(message.parts.find((part) => part.type === 'tool-unserializable')).toMatchObject({
      state: 'output-error',
    })
  }),
)

/** A void SDK execute is a successful null result, with explicit text for the model. */
it.live('persists null for a void tool and gives the model explicit null text', () =>
  Effect.gen(function* () {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const registry = createRegistry()
    let executions = 0
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('notify', {}, { id: 'void' })], { stopReason: 'toolUse' }),
      (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: 'toolResult',
          content: [{ type: 'text', text: 'null' }],
        })
        return fauxAssistantMessage('Notified.')
      },
    ])
    registry.install(
      yield* toolsExtension(
        'void',
        {
          notify: tool({
            inputSchema: z.object({}),
            execute: async () => {
              executions++
            },
          }),
        },
        {},
      ),
    )
    const harness = yield* memory(models, registry)
    const root = yield* Effect.promise(() =>
      harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } }),
    )
    const { message } = yield* consume(
      streamRun(
        harness,
        { conversationId: root.id, content: 'Notify', requestId: 'void' },
        context,
      ),
      Option.none(),
    )
    expect(executions).toBe(1)
    expect(message.parts.find((part) => part.type === 'tool-notify')).toMatchObject({
      state: 'output-available',
      output: null,
    })
    expect(message.parts.at(-1)).toMatchObject({ type: 'text', text: 'Notified.' })
  }),
)
