import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { Tool } from 'ai'
import { lastAssistantMessageIsCompleteWithToolCalls, tool } from 'ai'
import { PlainChat } from '../fixtures/chat.ts'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { z } from 'zod'

import { answer, history, streamRun, waiting } from '../main.ts'
import { call, consume, context, host, signal, texts } from './fixtures/host.ts'

type ModelOutput = Awaited<
  ReturnType<NonNullable<Tool<unknown, unknown, unknown>['toModelOutput']>>
>
const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII='
const image = { type: 'image' as const, data, mimeType: 'image/png' }
const bytes = Uint8Array.from(Buffer.from(data, 'base64'))
const supported: {
  name: string
  output: ModelOutput
  content: NonNullable<Extract<Message, { role: 'toolResult' }>['content']>
}[] = [
  {
    name: 'text',
    output: { type: 'text', value: 'Model-facing summary' },
    content: [{ type: 'text', text: 'Model-facing summary' }],
  },
  {
    name: 'json',
    output: { type: 'json', value: { visible: 7 } },
    content: [{ type: 'text', text: '{"visible":7}' }],
  },
  {
    name: 'image-data',
    output: {
      type: 'content',
      value: [
        { type: 'text', text: 'Picture' },
        { type: 'image-data', data, mediaType: 'image/png' },
      ],
    },
    content: [{ type: 'text', text: 'Picture' }, image],
  },
  {
    name: 'file-data',
    output: { type: 'content', value: [{ type: 'file-data', data, mediaType: 'image/png' }] },
    content: [image],
  },
  {
    name: 'inline base64',
    output: {
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data }, mediaType: 'image/png' }],
    },
    content: [image],
  },
  {
    name: 'inline bytes',
    output: {
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data: bytes }, mediaType: 'image/png' }],
    },
    content: [image],
  },
  {
    name: 'inline buffer',
    output: {
      type: 'content',
      value: [
        {
          type: 'file',
          data: { type: 'data', data: Buffer.from(data, 'base64') },
          mediaType: 'image/png',
        },
      ],
    },
    content: [image],
  },
  {
    name: 'inline ArrayBuffer',
    output: {
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data: bytes.buffer }, mediaType: 'image/png' }],
    },
    content: [image],
  },
  ...[
    { mediaType: 'image/jpeg', bytes: [255, 216, 255, 0] },
    { mediaType: 'image/gif', bytes: [71, 73, 70, 56, 57, 97] },
    { mediaType: 'image/webp', bytes: [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80] },
  ].map((sample) => {
    const encoded = Buffer.from(sample.bytes).toString('base64')
    return {
      name: sample.mediaType,
      output: {
        type: 'content' as const,
        value: [{ type: 'image-data' as const, data: encoded, mediaType: sample.mediaType }],
      },
      content: [{ type: 'image' as const, data: encoded, mimeType: sample.mediaType }],
    }
  }),
]

/** Observe the next actual Pi model request, the stock SDK reader and public persisted history. */
for (const sample of supported)
  it.live(`converts ${sample.name} for the model while preserving JSON`, () =>
    Effect.promise(async () => {
      let model: readonly Message[] = []
      const conversion: {
        toolCallId: string
        input: { amount: number }
        output: { private: string }
      }[] = []
      const fixture = await host(
        {
          project: tool({
            inputSchema: z.object({ amount: z.number().transform((value) => value * 2) }),
            execute: async () => ({ private: 'retained JSON' }),
            toModelOutput: (options) => {
              conversion.push(options)
              return sample.output
            },
          }),
        },
        {},
        {},
        { models: [{ id: 'faux-1', input: ['text', 'image'] }] },
      )
      const opened = await fixture.open()
      opened.faux.setResponses([
        call('project', { amount: 3 }, 'projection'),
        (request) => {
          model = request.messages
          return fauxAssistantMessage('Done.')
        },
      ])
      const result = await consume(
        await streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Project', requestId: sample.name },
          context,
        ),
      )
      expect(model.at(-1)).toMatchObject({ role: 'toolResult', content: sample.content })
      const final = model.at(-1)
      if (final === undefined) throw new Error('Expected model tool result')
      expect(JSON.stringify(final.content)).not.toContain('retained JSON')
      expect(conversion).toEqual([
        { toolCallId: 'projection', input: { amount: 6 }, output: { private: 'retained JSON' } },
      ])
      expect(result.message.parts.find((part) => part.type === 'tool-project')).toMatchObject({
        state: 'output-available',
        output: { private: 'retained JSON' },
      })
      const stored = await history(opened.harness, opened.root.id, { limit: 20 }, context)
      expect(
        stored.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === 'tool-project'),
      ).toMatchObject({ output: { private: 'retained JSON' } })
    }),
  )

const unsupported: { name: string; output: ModelOutput }[] = [
  {
    name: 'SVG image',
    output: {
      type: 'content',
      value: [
        {
          type: 'image-data',
          mediaType: 'image/svg+xml',
          data: Buffer.from('<svg/>').toString('base64'),
        },
      ],
    },
  },
  {
    name: 'malformed image base64',
    output: {
      type: 'content',
      value: [{ type: 'image-data', mediaType: 'image/png', data: 'not base64 !!!' }],
    },
  },
  {
    name: 'mismatched image signature',
    output: { type: 'content', value: [{ type: 'image-data', mediaType: 'image/jpeg', data }] },
  },
  {
    name: 'invalid image padding',
    output: {
      type: 'content',
      value: [{ type: 'file-data', mediaType: 'image/png', data: data + '=' }],
    },
  },
  {
    name: 'noncanonical image pad bits',
    output: {
      type: 'content',
      value: [{ type: 'file-data', mediaType: 'image/png', data: 'iVBORw0KGgp=' }],
    },
  },
  {
    name: 'empty image data',
    output: { type: 'content', value: [{ type: 'image-data', mediaType: 'image/png', data: '' }] },
  },
  {
    name: 'truncated image signature',
    output: {
      type: 'content',
      value: [{ type: 'image-data', mediaType: 'image/png', data: 'iVBO' }],
    },
  },
  {
    name: 'mismatched image bytes',
    output: {
      type: 'content',
      value: [{ type: 'file', mediaType: 'image/webp', data: { type: 'data', data: bytes } }],
    },
  },

  { name: 'model error text', output: { type: 'error-text', value: 'model-only failure' } },
  {
    name: 'model error JSON',
    output: { type: 'error-json', value: { error: 'model-only failure' } },
  },
  {
    name: 'model-only execution denial',
    output: { type: 'execution-denied', reason: 'model-only denial' },
  },

  {
    name: 'non-image file',
    output: { type: 'content', value: [{ type: 'file-data', data, mediaType: 'application/pdf' }] },
  },
  {
    name: 'modern non-image file',
    output: {
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data }, mediaType: 'audio/wav' }],
    },
  },
  {
    name: 'file URL',
    output: {
      type: 'content',
      value: [
        { type: 'file-url', url: 'https://durable.test/remote.pdf', mediaType: 'application/pdf' },
      ],
    },
  },
  {
    name: 'image URL',
    output: {
      type: 'content',
      value: [{ type: 'image-url', url: 'https://durable.test/remote.png' }],
    },
  },
  {
    name: 'modern URL',
    output: {
      type: 'content',
      value: [
        {
          type: 'file',
          data: { type: 'url', url: new URL('https://durable.test/remote.png') },
          mediaType: 'image/png',
        },
      ],
    },
  },
  { name: 'file id', output: { type: 'content', value: [{ type: 'file-id', fileId: 'remote' }] } },
  {
    name: 'image id',
    output: { type: 'content', value: [{ type: 'image-file-id', fileId: 'remote' }] },
  },
  {
    name: 'file reference',
    output: {
      type: 'content',
      value: [{ type: 'file-reference', providerReference: { openai: 'remote' } }],
    },
  },
  {
    name: 'image reference',
    output: {
      type: 'content',
      value: [{ type: 'image-file-reference', providerReference: { openai: 'remote' } }],
    },
  },
  {
    name: 'modern reference',
    output: {
      type: 'content',
      value: [
        {
          type: 'file',
          data: { type: 'reference', reference: { openai: 'remote' } },
          mediaType: 'image/png',
        },
      ],
    },
  },
  {
    name: 'inline text document',
    output: {
      type: 'content',
      value: [{ type: 'file', data: { type: 'text', text: 'document' }, mediaType: 'text/plain' }],
    },
  },
  { name: 'custom part', output: { type: 'content', value: [{ type: 'custom' }] } },
]

/** Include a valid part before the unsupported one to prove conversion never silently drops a part. */
for (const sample of unsupported)
  it.live(`reports ${sample.name} as a tool output error`, () =>
    Effect.promise(async () => {
      let model: readonly Message[] = []
      const fixture = await host(
        {
          project: tool({
            inputSchema: z.object({}),
            execute: async () => ({ kept: true }),
            toModelOutput: () =>
              sample.output.type === 'content'
                ? {
                    type: 'content',
                    value: [{ type: 'text', text: 'Keep me' }, ...sample.output.value],
                  }
                : sample.output,
          }),
        },
        {},
      )
      const opened = await fixture.open()
      opened.faux.setResponses([
        call('project', {}, 'unsupported'),
        (request) => {
          model = request.messages
          return fauxAssistantMessage('Recovered.')
        },
      ])
      const result = await consume(
        await streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Project', requestId: sample.name },
          context,
        ),
      )
      expect(result.message.parts.find((part) => part.type === 'tool-project')).toMatchObject({
        state: 'output-error',
      })
      expect(model.at(-1)).toMatchObject({ role: 'toolResult', isError: true })
      expect(texts(result.message)).toEqual(['Recovered.'])
    }),
  )

/** Person-supplied output uses the same model projection as execute, preserving the original answer. */
it.live('projects a person-supplied answer through SDK Chat', () =>
  Effect.promise(async () => {
    let model: readonly Message[] = []
    const fixture = await host(
      {
        ask: tool({
          inputSchema: z.object({}),
          outputSchema: z.object({ answer: z.string() }),
          toModelOutput: ({ output }) => ({ type: 'text', value: `Answer: ${output.answer}` }),
        }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('ask', {}, 'answer'),
      (request) => {
        model = request.messages
        return fauxAssistantMessage('Done.')
      },
    ])
    let completion = signal()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onFinish: () => completion.resolve(),
      onError: (error) => completion.reject(error),
    })
    await chat.sendMessage({ text: 'Ask' })
    completion = signal()
    await chat.addToolOutput({ tool: 'ask', toolCallId: 'answer', output: { answer: 'savings' } })
    await completion.promise
    expect(model.at(-1)).toMatchObject({ content: [{ type: 'text', text: 'Answer: savings' }] })
    if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
    expect(chat.lastMessage.parts.find((part) => part.type === 'tool-ask')).toMatchObject({
      output: { answer: 'savings' },
    })
  }),
)

/** The bridge's acknowledgement is not the tool author's output; a late answer is separate user input. */
it.live('keeps later acknowledgements out of toModelOutput and admits the later answer', () =>
  Effect.promise(async () => {
    const converted: { answer: string }[] = []
    let model: readonly Message[] = []
    const received = signal()
    const fixture = await host(
      {
        ask: tool({
          inputSchema: z.object({}),
          outputSchema: z.object({ answer: z.string() }),
          toModelOutput: ({ output }) => {
            converted.push(output)
            return { type: 'text', value: output.answer.toUpperCase() }
          },
        }),
      },
      { answers: { ask: 'later' } },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('ask', {}, 'later'),
      (request) => {
        model = request.messages
        return fauxAssistantMessage('Waiting for the answer.')
      },
    ])
    const result = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Ask', requestId: 'later' },
        context,
      ),
    )
    expect(result.message.parts.find((part) => part.type === 'tool-ask')).toMatchObject({
      state: 'output-available',
      output: { status: 'asked' },
    })
    expect(model.at(-1)).toMatchObject({
      role: 'toolResult',
      content: [{ type: 'text', text: expect.stringContaining('"status":"asked"') }],
    })
    expect(converted).toEqual([])
    const rows = await waiting(opened.harness, opened.root.id, context)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row === undefined) throw new Error('Expected later question')
    opened.faux.setResponses([
      (request) => {
        model = request.messages
        received.resolve()
        return fauxAssistantMessage('Answer received.')
      },
    ])
    await answer(
      opened.harness,
      opened.root.id,
      { holdId: row.holdId, output: { answer: 'yes' } },
      context,
    )
    await received.promise
    expect(model.at(-1)).toMatchObject({
      role: 'user',
      content: '[answer to ask] {"answer":"yes"}',
    })
    expect(converted).toEqual([])
    expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  }),
)
