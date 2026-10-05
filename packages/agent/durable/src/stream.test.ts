import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { Deferred, Effect, Option, Stream } from 'effect'

import { attachRun, streamRun } from './core.ts'
import { memory } from './fixtures/harness.ts'
import { consume } from './fixtures/reading.ts'
import { runForPi } from './pi.ts'

const context = BACKGROUND_CONTEXT

/** A real harness on memory storage with pi's faux provider standing in for the model. */
const openHarness = Effect.fn('Test.openHarness')(function* () {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(
    defineExtension({
      name: 'weather',
      tools: [
        defineTool({
          name: 'weather',
          description: 'Weather in a city',
          parameters: Type.Object({ city: Type.String() }),
          execute: (args, _api, callbackContext) =>
            runForPi(
              Effect.succeed({
                content: [{ type: 'text' as const, text: `Sunny in ${args.city}` }],
              }),
              callbackContext.abortSignal,
            ),
        }),
        defineTool({
          name: 'broken',
          description: 'Always fails',
          parameters: Type.Object({}),
          execute: (_args, _api, callbackContext) =>
            runForPi(Effect.fail(new Error('no route to host')), callbackContext.abortSignal),
        }),
      ],
    }),
  )
  const harness = yield* memory(models, registry)
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  return { faux, harness, root }
})

describe('streamRun', () => {
  it.live('streams a text answer the AI SDK reader accepts', () =>
    Effect.gen(function* () {
      const { faux, harness, root } = yield* openHarness()
      faux.setResponses([fauxAssistantMessage('Paris.')])

      const stream = streamRun(
        harness,
        { conversationId: root.id, content: 'Capital of France?', requestId: 'q1' },
        context,
      )
      const { chunks, message } = yield* consume(stream, Option.none())

      expect(Option.getOrThrow(Option.fromNullishOr(chunks.at(0))).type).toBe('start')
      expect(Option.getOrThrow(Option.fromNullishOr(chunks.at(-1))).type).toBe('finish')
      expect(message.role).toBe('assistant')
      expect(message.parts.filter((part) => part.type === 'text')).toEqual([
        expect.objectContaining({ type: 'text', text: 'Paris.', state: 'done' }),
      ])
    }),
  )

  it.live('streams reasoning, a tool call and its result, then the answer of the next step', () =>
    Effect.gen(function* () {
      const { faux, harness, root } = yield* openHarness()
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxThinking('Need the weather.'),
            fauxToolCall('weather', { city: 'Lagos' }, { id: 'call-1' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxText('It is sunny in Lagos.')]),
      ])

      const stream = streamRun(
        harness,
        { conversationId: root.id, content: 'Weather in Lagos?', requestId: 'q2' },
        context,
      )
      const { chunks, message } = yield* consume(stream, Option.none())

      expect(chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(2)
      expect(message.parts.map((part) => part.type)).toEqual([
        'step-start',
        'reasoning',
        'dynamic-tool',
        'step-start',
        'text',
      ])
      expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
        toolName: 'weather',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { city: 'Lagos' },
        output: { content: [{ type: 'text', text: 'Sunny in Lagos' }] },
      })
    }),
  )

  it.live('reports a thrown tool as an output error', () =>
    Effect.gen(function* () {
      const { faux, harness, root } = yield* openHarness()
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('broken', {}, { id: 'call-2' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('That failed.'),
      ])

      const stream = streamRun(
        harness,
        { conversationId: root.id, content: 'Try it', requestId: 'q3' },
        context,
      )
      const { message } = yield* consume(stream, Option.none())

      expect(message.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
        toolCallId: 'call-2',
        state: 'output-error',
        errorText: expect.stringContaining('no route to host'),
      })
    }),
  )
})

/** Stopping observation never cancels the underlying durable run or its executing tool. */
it.live('detaches a stopped consumer while the durable tool finishes', () =>
  Effect.gen(function* () {
    const running = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('report', {}, { id: 'call-detach' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Finished after detachment.'),
    ])
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: 'report',
        tools: [
          defineTool({
            name: 'report',
            description: 'Build a report',
            parameters: Type.Object({}),
            execute: (_args, _api, callbackContext) =>
              runForPi(
                Deferred.succeed(running, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ content: [{ type: 'text' as const, text: 'Ready' }] }),
                ),
                callbackContext.abortSignal,
              ),
          }),
        ],
      }),
    )
    const harness = yield* memory(models, registry)
    const root = yield* Effect.promise(() =>
      harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } }),
    )
    const first = yield* streamRun(
      harness,
      { conversationId: root.id, content: 'Build', requestId: 'detach' },
      context,
    ).pipe(Stream.take(1), Stream.runCollect)
    expect(first.map((chunk) => chunk.type)).toEqual(['start'])
    yield* Deferred.await(running)
    yield* Deferred.succeed(release, undefined)
    yield* Effect.promise(() => root.waitForIdle(context))
    expect(Option.isNone(yield* attachRun(harness, root.id, context))).toBe(true)
    const transcript = yield* Effect.promise(() => root.context(context))
    expect(transcript.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [expect.objectContaining({ type: 'text', text: 'Finished after detachment.' })],
    })
  }),
)
