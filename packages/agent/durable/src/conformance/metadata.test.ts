import { Chat } from '@ai-sdk/react'
import { expect, it } from '@effect/vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { DefaultChatTransport, tool, type UIMessage } from 'ai'
import { Deferred, Effect, Schema } from 'effect'
import { z } from 'zod'

import * as Core from '../core.ts'
import { attachRun, history, respond, streamRun, type Metadata } from '../main.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { call, consume, context, host, signal } from './fixtures/host.ts'

type Opened = Awaited<ReturnType<Awaited<ReturnType<typeof host>>['open']>>
const decodeMetadata = Schema.decodeUnknownSync(Core.Metadata)

/** A host reads the exported metadata type without casting an SDK message or depending on internals. */
function modelIds(message: UIMessage<Metadata>) {
  if (message.metadata === undefined) throw new Error('Expected recorded assistant metadata')
  return message.metadata.models.map((model) => `${model.provider}/${model.modelId}`)
}

/** The stock client validates each incremental metadata merge through the exported Effect Schema. */
function client(opened: Opened) {
  return new Chat<UIMessage<Metadata>>({
    transport: new DefaultChatTransport({
      api: 'http://durable.test/chat',
      fetch: (url, init) =>
        respond(opened.harness, opened.root.id, new Request(url, init), context),
    }),
    messageMetadataSchema: Schema.toStandardSchemaV1(Core.Metadata),
  })
}

/** Read raw Pi responses, independently of the bridge's translator and history metadata helpers. */
async function records(opened: Opened) {
  const page = await opened.root.entries({}, 100, undefined, context)
  return page.items
    .toReversed()
    .flatMap((entry) =>
      entry.model === undefined
        ? []
        : entry.model.flatMap((message) => (message.role === 'assistant' ? [message] : [])),
    )
}

/** Usage expectations come from persisted provider responses, never scripted faux counters. */
async function parity(opened: Opened, chat: Chat<UIMessage<Metadata>>, responses: number) {
  const messages = await records(opened)
  expect(messages).toHaveLength(responses)
  const last = chat.lastMessage
  if (last === undefined) throw new Error('Expected streamed assistant')
  const page = await history(opened.harness, opened.root.id, { limit: 50 }, context)
  const assistant = page.messages.find((message) => message.role === 'assistant')
  if (assistant === undefined) throw new Error('Expected persisted assistant')
  const metadata = decodeMetadata(assistant.metadata)
  expect(last.metadata).toEqual(metadata)
  if (metadata.usage === undefined) throw new Error('Expected persisted token usage')
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
    expect(metadata.usage[key]).toBe(
      messages.reduce((total, message) => total + message.usage[key], 0),
    )
  expect(metadata.usage.totalTokens).toBeGreaterThan(0)
  expect(metadata).not.toHaveProperty('startedAt')
  expect(metadata).not.toHaveProperty('endedAt')
  return last
}

/** One response has identical typed metadata in the real SDK store and raw settled history. */
it.live('returns Pi model and usage metadata identically live and in history', () =>
  Effect.promise(async () => {
    const fixture = await host({}, {})
    const opened = await fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Recorded reply.')])
    const chat = client(opened)
    await chat.sendMessage({ text: 'Describe the records' })
    expect(chat.error).toBeUndefined()
    const last = await parity(opened, chat, 1)
    expect(modelIds(last)).toEqual(['faux/faux-1'])
    await fixture.close(opened.harness)
    const restarted = await fixture.open()
    const page = await history(restarted.harness, restarted.root.id, { limit: 50 }, context)
    const assistant = page.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected assistant after restart')
    expect(assistant.metadata).toEqual(last.metadata)
  }),
)

/** A tool boundary changes the configured model; repeated use of that model names it once. */
it.live('sums all tool-round usage and names each recorded model once', () =>
  Effect.promise(async () => {
    const entered = signal()
    const release = signal()
    const fixture = await host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: async () => {
            entered.resolve()
            await release.promise
            return 'worked'
          },
        }),
      },
      {},
      {},
      { models: [{ id: 'faux-1' }, { id: 'faux-2' }] },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('work', {}, 'first'),
      call('work', {}, 'second'),
      fauxAssistantMessage('Both completed.'),
    ])
    const chat = client(opened)
    const sending = chat.sendMessage({ text: 'Use both models' })
    try {
      await entered.promise
      await opened.root.configure({ model: { provider: 'faux', modelId: 'faux-2' } }, context)
      release.resolve()
      await sending
      expect(chat.error).toBeUndefined()
      expect(modelIds(await parity(opened, chat, 3))).toEqual(['faux/faux-1', 'faux/faux-2'])
    } finally {
      release.resolve()
      await sending
    }
  }),
)

/** A frame receipt freezes Pi's partial; the reconnect start must carry its recorded model already. */
it.live('includes captured metadata on a reconnect start in the middle of text', () =>
  Effect.gen(function* () {
    const received = signal()
    const release = yield* Deferred.make<void>()
    const fixture = yield* Effect.promise(() =>
      host(
        {},
        {},
        {},
        {
          onFrame: (event, abortSignal) =>
            event.type === 'text_delta'
              ? waitForFrame(Deferred.await(release), abortSignal)
              : Effect.void,
        },
      ),
    )
    const opened = yield* Effect.promise(() => fixture.open())
    opened.faux.setResponses([fauxAssistantMessage('A reply observed in flight.')])
    const stream = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Watch', requestId: 'metadata-mid-text' },
        context,
      ),
    )
    const sending = consume(
      stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk)
            if (chunk.type === 'text-delta') received.resolve()
          },
        }),
      ),
    )
    yield* Effect.gen(function* () {
      yield* Effect.promise(() => received.promise)
      const attached = yield* Effect.promise(() =>
        attachRun(opened.harness, opened.root.id, context),
      )
      if (attached.status !== 'running') throw new Error('Expected running reconnect')
      const reader = attached.stream.getReader()
      const first = yield* Effect.promise(() => reader.read())
      expect(first.value).toEqual({
        type: 'start',
        messageId: expect.stringMatching(/^run:/u),
        messageMetadata: { models: [{ provider: 'faux', modelId: 'faux-1' }] },
      })
      yield* Effect.promise(() => reader.cancel())
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.ensuring(Effect.promise(() => sending)),
    )
  }),
)
