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
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from '@earendil-works/pi-durable'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { describe, expect, it } from 'vitest'

import { streamRun } from './main.ts'

const context = BACKGROUND_CONTEXT

/** A real harness on memory storage with pi's faux provider standing in for the model. */
async function openHarness() {
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
          execute: async (args) => ({ content: [{ type: 'text', text: `Sunny in ${args.city}` }] }),
        }),
        defineTool({
          name: 'broken',
          description: 'Always fails',
          parameters: Type.Object({}),
          execute: async () => {
            throw new Error('no route to host')
          },
        }),
      ],
    }),
  )
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  return { faux, harness, root }
}

/** Every chunk of a stream, and the last message the AI SDK's own reader builds from them. */
async function consume(stream: ReadableStream<UIMessageChunk>) {
  const [forChunks, forMessage] = stream.tee()
  const chunks: UIMessageChunk[] = []
  const collecting = (async () => {
    for await (const chunk of forChunks) chunks.push(chunk)
  })()
  let message: UIMessage | undefined
  for await (const next of readUIMessageStream({ stream: forMessage })) message = next
  await collecting
  return { chunks, message }
}

describe('streamRun', () => {
  it('streams a text answer the AI SDK reader accepts', async () => {
    const { faux, harness, root } = await openHarness()
    faux.setResponses([fauxAssistantMessage('Paris.')])

    const stream = await streamRun(
      harness,
      { conversationId: root.id, content: 'Capital of France?', requestId: 'q1' },
      context,
    )
    const { chunks, message } = await consume(stream)

    expect(chunks.at(0)?.type).toBe('start')
    expect(chunks.at(-1)?.type).toBe('finish')
    expect(message?.role).toBe('assistant')
    expect(message?.parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ type: 'text', text: 'Paris.', state: 'done' }),
    ])
    await harness.close(context)
  })

  it('streams reasoning, a tool call and its result, then the answer of the next step', async () => {
    const { faux, harness, root } = await openHarness()
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

    const stream = await streamRun(
      harness,
      { conversationId: root.id, content: 'Weather in Lagos?', requestId: 'q2' },
      context,
    )
    const { chunks, message } = await consume(stream)

    expect(chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(2)
    expect(message?.parts.map((part) => part.type)).toEqual([
      'step-start',
      'reasoning',
      'dynamic-tool',
      'step-start',
      'text',
    ])
    expect(message?.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
      toolName: 'weather',
      toolCallId: 'call-1',
      state: 'output-available',
      input: { city: 'Lagos' },
      output: { content: [{ type: 'text', text: 'Sunny in Lagos' }] },
    })
    await harness.close(context)
  })

  it('reports a thrown tool as an output error', async () => {
    const { faux, harness, root } = await openHarness()
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('broken', {}, { id: 'call-2' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('That failed.'),
    ])

    const stream = await streamRun(
      harness,
      { conversationId: root.id, content: 'Try it', requestId: 'q3' },
      context,
    )
    const { message } = await consume(stream)

    expect(message?.parts.find((part) => part.type === 'dynamic-tool')).toMatchObject({
      toolCallId: 'call-2',
      state: 'output-error',
      errorText: expect.stringContaining('no route to host'),
    })
    await harness.close(context)
  })
})
