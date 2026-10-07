import { Chat } from '@ai-sdk/react'
import { expect, it } from '@effect/vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import { Deferred, Effect, Schema } from 'effect'
import { z } from 'zod'
import { onTestFinished } from 'vitest'

import * as Core from '../core.ts'
import {
  attachRun,
  continueRun,
  decide,
  followRun,
  history,
  holdId,
  respond,
  streamRun,
  type Metadata,
} from '../main.ts'
import { waitForFrame } from '../fixtures/provider.ts'
import { call, consume, context, host, shop, signal } from './fixtures/host.ts'

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
    const input = chat.messages.find((message) => message.role === 'user')
    if (input === undefined) throw new Error('Expected admitted user message')
    const stored = await consume(await followRun(opened.harness, opened.root.id, input.id, context))
    expect(stored.chunks[0]).toMatchObject({ type: 'start', messageMetadata: last.metadata })
    expect(stored.chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: last.metadata })
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

/** POST continuation must retain usage from rounds before the client's newest answered call. */
it.live('retains earlier response usage after a stock client tool answer', () =>
  Effect.promise(async () => {
    const fixture = await host(
      {
        work: tool({ inputSchema: z.object({}), execute: async () => 'worked' }),
        ask: tool({ inputSchema: z.object({ question: z.string() }) }),
      },
      {},
    )
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('work', {}, 'worked'),
      call('ask', { question: 'Which?' }, 'asked'),
      fauxAssistantMessage('Answered.'),
    ])
    const completed = signal()
    const chat = new Chat<UIMessage<Metadata>>({
      transport: new DefaultChatTransport({
        api: 'http://durable.test/chat',
        fetch: (url, init) =>
          respond(opened.harness, opened.root.id, new Request(url, init), context),
      }),
      messageMetadataSchema: Schema.toStandardSchemaV1(Core.Metadata),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onFinish: ({ message }) => {
        if (message.parts.some((part) => part.type === 'text' && part.text === 'Answered.'))
          completed.resolve()
      },
      onError: (error) => completed.reject(error),
    })
    await chat.sendMessage({ text: 'Work then ask me' })
    await chat.addToolOutput({ tool: 'ask', toolCallId: 'asked', output: 'savings' })
    await completed.promise
    expect(modelIds(await parity(opened, chat, 3))).toEqual(['faux/faux-1'])
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

/** Parking is an HTTP finish while Pi remains active. Both its attachment and the ended receipt
 * carry exactly the stored usage; the facade must not silently drop metadata on either finish. */
it.live('carries metadata on parked finishes and ended approval replay', () =>
  Effect.promise(async () => {
    const fixture = await shop()
    const opened = await fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'payment'),
      fauxAssistantMessage('Paid.'),
    ])
    const initial = await consume(
      await streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Pay', requestId: 'metadata-pay' },
        context,
      ),
    )
    expect(initial.chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: initial.message.metadata,
    })
    const attached = await attachRun(opened.harness, opened.root.id, context)
    if (attached.status !== 'running') throw new Error('Expected held run')
    const replayed = await consume(attached.stream)
    expect(replayed.chunks[0]).toMatchObject({
      type: 'start',
      messageMetadata: initial.message.metadata,
    })
    expect(replayed.chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: initial.message.metadata,
    })
    const part = initial.message.parts.find(isToolUIPart)
    if (part === undefined || part.state !== 'approval-requested')
      throw new Error('Expected approval')
    await decide(
      opened.harness,
      opened.root.id,
      { holdId: holdId(part.approval.id), approved: true },
      context,
    )
    await opened.root.waitForIdle(context)
    const settled = await history(opened.harness, opened.root.id, { limit: 50 }, context)
    const assistant = settled.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected settled history')
    const tail = await consume(
      await continueRun(
        opened.harness,
        opened.root.id,
        { messageId: initial.message.id, known: new Set(['payment']) },
        context,
      ),
      initial.message,
    )
    expect(tail.chunks[0]).toMatchObject({ type: 'start', messageMetadata: assistant.metadata })
    expect(tail.chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: assistant.metadata })
    expect(tail.message.metadata).toEqual(assistant.metadata)
    expect(fixture.paid).toEqual([100])
  }),
)

/** A non-retried error is the same failure in live, every stored replay and the reloaded metadata.
 * Pending failures are kept as Option in the core and published only at terminal, not on retries. */
it.live('preserves a failed run through replay, user retry, history and restart', () =>
  Effect.promise(async () => {
    const fixture = await host({}, {}, { retry: { enabled: false, baseDelayMs: 0 } })
    const opened = await fixture.open()
    const failure = 'invalid model request'
    opened.faux.setResponses([
      fauxAssistantMessage('Half an answer.', { stopReason: 'error', errorMessage: failure }),
    ])
    const chat = client(opened)
    await chat.sendMessage({ text: 'Fail once' })
    expect(chat.status).toBe('error')
    if (chat.error === undefined || chat.lastMessage === undefined)
      throw new Error('Expected failed assistant')
    expect(chat.error.message).toBe(failure)
    expect(decodeMetadata(chat.lastMessage.metadata).failure).toBe(failure)
    const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    const saved = page.messages.find((message) => message.role === 'assistant')
    if (saved === undefined) throw new Error('Expected failed history message')
    expect(saved.parts).toEqual(chat.lastMessage.parts)
    expect(saved.metadata).toEqual(chat.lastMessage.metadata)
    const user = chat.messages[0]
    if (user === undefined || user.role !== 'user') throw new Error('Expected admitted user')
    const chunks = []
    for await (const chunk of await followRun(opened.harness, opened.root.id, user.id, context))
      chunks.push(chunk)
    expect(chunks.slice(-3)).toEqual([
      { type: 'message-metadata', messageMetadata: saved.metadata },
      { type: 'error', errorText: failure },
      { type: 'finish', messageMetadata: saved.metadata },
    ])
    const retry = client(opened)
    retry.messages = [user]
    await retry.sendMessage()
    expect(retry.status).toBe('error')
    if (retry.error === undefined) throw new Error('Expected replay failure')
    expect(retry.error.message).toBe(failure)
    expect(opened.faux.state.callCount).toBe(1)
    await fixture.close(opened.harness)
    const restarted = await fixture.open()
    const replayed = []
    for await (const chunk of await followRun(
      restarted.harness,
      restarted.root.id,
      user.id,
      context,
    ))
      replayed.push(chunk)
    expect(replayed).toEqual(chunks)
    expect(
      (await history(restarted.harness, restarted.root.id, { limit: 10 }, context)).messages,
    ).toEqual(page.messages)
  }),
)

/** An active snapshot proves the steer's first-input identity before failure; no equal failure
 * text or generation-task guess is used to associate two input receipts. */
it.live(
  'keeps a proven failed steer origin live; restart lacks its terminal-answer membership proof',
  () =>
    Effect.promise(async () => {
      const working = signal()
      const releaseWork = signal()
      const failing = signal()
      const releaseFailure = signal()
      const joined = signal()
      onTestFinished(() => {
        releaseWork.resolve()
        releaseFailure.resolve()
      })
      const fixture = await host(
        {
          work: tool({
            inputSchema: z.object({}),
            execute: async () => {
              working.resolve()
              await releaseWork.promise
              return 'worked'
            },
          }),
        },
        {},
        { retry: { enabled: false, baseDelayMs: 0 } },
      )
      const opened = await fixture.open()
      opened.faux.setResponses([
        call('work', {}, 'work'),
        async () => {
          failing.resolve()
          await releaseFailure.promise
          return fauxAssistantMessage('Failed after steer.', {
            stopReason: 'error',
            errorMessage: 'invalid model request',
          })
        },
      ])
      const first = client(opened)
      const sending = first.sendMessage({ text: 'First' })
      await working.promise
      const steered = new Chat<UIMessage<Metadata>>({
        transport: new DefaultChatTransport({
          api: 'http://durable.test/chat',
          fetch: async (url, init) => {
            const response = await respond(
              opened.harness,
              opened.root.id,
              { request: new Request(url, init), options: { whenBusy: 'steer' } },
              context,
            )
            joined.resolve()
            return response
          },
        }),
      })
      const queued = signal()
      const stop = opened.harness.subscribeCommits((publication) => {
        if (
          publication.changes.some(
            (change) => change.type === 'submission' && change.value.status === 'queued',
          )
        )
          queued.resolve()
      })
      const steering = steered.sendMessage({ text: 'Steer' })
      await queued.promise
      stop()
      releaseWork.resolve()
      await failing.promise
      await joined.promise
      releaseFailure.resolve()
      await sending
      await steering
      expect(first.status).toBe('error')
      expect(steered.status).toBe('error')
      if (first.lastMessage === undefined || steered.lastMessage === undefined)
        throw new Error('Expected failed run messages')
      expect(steered.lastMessage.id).toBe(first.lastMessage.id)
      expect(steered.lastMessage.metadata).toEqual(first.lastMessage.metadata)
      const steeredUser = steered.messages[0]
      if (steeredUser === undefined || steeredUser.role !== 'user')
        throw new Error('Expected steer input')
      const originalId = first.lastMessage.id
      await fixture.close(opened.harness)
      const restarted = await fixture.open()
      const chunks = []
      for await (const chunk of await followRun(
        restarted.harness,
        restarted.root.id,
        steeredUser.id,
        context,
      ))
        chunks.push(chunk)
      // Unanswered receipts have no shared answer entry. Without the original run_end observation,
      // Pi's public reads do not prove whether this placed user steered or began a successor run.
      const start = chunks.find((chunk) => chunk.type === 'start')
      if (start === undefined) throw new Error('Expected stored replay identity')
      expect(start.messageId).not.toBe(originalId)
      expect(chunks).toContainEqual({ type: 'error', errorText: 'invalid model request' })
    }),
)
