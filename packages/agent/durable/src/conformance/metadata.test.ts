import { request, runForPi } from '../pi.ts'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable, ReadFailed } from '../fixtures/reading.ts'
import { Chat } from '@ai-sdk/react'
import { expect, it } from '@effect/vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import { Deferred, Effect, Schema, Fiber, Stream, Exit, Option } from 'effect'

import { z } from 'zod'

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
import { call, context, host, shop } from './fixtures/host.ts'

import type { Opened } from './fixtures/host.ts'
const decodeMetadata = Schema.decodeUnknownSync(Core.Metadata)

/** The real provider path cannot deliver malformed counts to recordMetadata: generation.js:523
 * records usage before appending the assistant, and chord/json.js:14–18 rejects non-finite JSON.
 * Faux itself overwrites scripted usage with finite estimates, so the public afterResponse hook
 * supplies the invalid terminal report. Pin this upstream limitation rather than claim that the
 * metadata guard alone can make Pi accept it. The committed, valid partial remains reloadable. */
it.live.each([NaN, Infinity])(
  'Pi rejects non-finite provider usage (%s) before metadata',
  (count) =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {}, {}, { commitFrames: true })
      const opened = yield* fixture.open([
        defineExtension({
          name: 'invalid-provider-usage',
          hooks: [
            hook(GenerationTask, {
              afterResponse: (message) => {
                message.usage.input = count
              },
            }),
          ],
        }),
      ])
      opened.faux.setResponses([fauxAssistantMessage('The partial text survives.')])
      const chat = client(opened)
      yield* Effect.promise(() => chat.sendMessage({ text: 'Go' }))
      yield* Effect.promise(() => opened.root.waitForIdle(context))
      expect(chat.status).toBe('ready')
      const input = chat.messages.find((message) => message.role === 'user')
      if (input === undefined) throw new Error('Expected admitted user input')
      const receipt = yield* request(opened.root, input.id, context)
      if (Option.isNone(receipt)) throw new Error('Expected provider input receipt')
      expect(receipt.value).toMatchObject({
        status: 'unanswered',
        reason: 'faulted',
        detail: 'Value contains a non-finite number and is not strict JSON',
      })
      const saved = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 50 }, context),
      )
      const assistant = saved.messages.find((message) => message.role === 'assistant')
      if (assistant === undefined) throw new Error('Expected the valid committed partial')
      const streamed = chat.lastMessage
      if (streamed === undefined) throw new Error('Expected streamed partial')
      expect(streamed.parts).toContainEqual({
        type: 'text',
        text: 'The partial text survives.',
        state: 'done',
      })
      expect(assistant.parts).toEqual(streamed.parts)
      expect(assistant.metadata).toEqual(streamed.metadata)
      expect(decodeMetadata(assistant.metadata).models).toEqual([
        { provider: 'faux', modelId: 'faux-1' },
      ])
    }),
)

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
const records = Effect.fn('Test.records')(function* (opened: Opened) {
  const page = yield* Effect.promise(() =>
    Promise.resolve(opened.root.entries({}, 100, undefined, context)),
  )
  return page.items
    .toReversed()
    .flatMap((entry) =>
      entry.model === undefined
        ? []
        : entry.model.flatMap((message) => (message.role === 'assistant' ? [message] : [])),
    )
})

/** Usage expectations come from persisted provider responses, never scripted faux counters. */
const parity = Effect.fn('Test.parity')(function* (
  opened: Opened,
  chat: Chat<UIMessage<Metadata>>,
  responses: number,
) {
  const messages = yield* records(opened)
  expect(messages).toHaveLength(responses)
  const last = chat.lastMessage
  if (last === undefined) throw new Error('Expected streamed assistant')
  const page = yield* Effect.promise(() =>
    Promise.resolve(history(opened.harness, opened.root.id, { limit: 50 }, context)),
  )
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
})

/** One response has identical typed metadata in the real SDK store and raw settled history. */
it.live('returns Pi model and usage metadata identically live and in history', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Recorded reply.')])
    const chat = client(opened)
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'Describe the records' })))
    expect(chat.error).toBeUndefined()
    const last = yield* parity(opened, chat, 1)
    expect(modelIds(last)).toEqual(['faux/faux-1'])
    const input = chat.messages.find((message) => message.role === 'user')
    if (input === undefined) throw new Error('Expected admitted user message')
    const stored = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(followRun(opened.harness, opened.root.id, input.id, context)),
      ),
      Option.none(),
    )
    expect(stored.chunks[0]).toMatchObject({ type: 'start', messageMetadata: last.metadata })
    expect(stored.chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: last.metadata })
    yield* fixture.close(opened.harness)
    const restarted = yield* fixture.open()
    const page = yield* Effect.promise(() =>
      Promise.resolve(history(restarted.harness, restarted.root.id, { limit: 50 }, context)),
    )
    const assistant = page.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected assistant after restart')
    expect(assistant.metadata).toEqual(last.metadata)
  }),
)

/** A tool boundary changes the configured model; repeated use of that model names it once. */
it.live('sums all tool-round usage and names each recorded model once', () =>
  Effect.gen(function* () {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.gen(function* () {
                Deferred.doneUnsafe(entered, Effect.void)
                yield* Deferred.await(release)
                return 'worked'
              }),
              undefined,
            ),
        }),
      },
      {},
      {},
      { models: [{ id: 'faux-1' }, { id: 'faux-2' }] },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('work', {}, 'first'),
      call('work', {}, 'second'),
      fauxAssistantMessage('Both completed.'),
    ])
    const chat = client(opened)
    const sending = chat.sendMessage({ text: 'Use both models' })
    try {
      yield* Deferred.await(entered)
      yield* Effect.promise(() =>
        Promise.resolve(
          opened.root.configure({ model: { provider: 'faux', modelId: 'faux-2' } }, context),
        ),
      )
      Deferred.doneUnsafe(release, Effect.void)
      yield* Effect.promise(() => Promise.resolve(sending))
      expect(chat.error).toBeUndefined()
      expect(modelIds(yield* parity(opened, chat, 3))).toEqual(['faux/faux-1', 'faux/faux-2'])
    } finally {
      Deferred.doneUnsafe(release, Effect.void)
      yield* Effect.promise(() => Promise.resolve(sending))
    }
  }),
)

/** POST continuation must retain usage from rounds before the client's newest answered call. */
it.live('retains earlier response usage after a stock client tool answer', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: () => {
            return Promise.resolve('worked')
          },
        }),
        ask: tool({ inputSchema: z.object({ question: z.string() }) }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('work', {}, 'worked'),
      call('ask', { question: 'Which?' }, 'asked'),
      fauxAssistantMessage('Answered.'),
    ])
    const completed = Deferred.makeUnsafe<void, FixtureFailed>()
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
          Deferred.doneUnsafe(completed, Effect.void)
      },
      onError: (error) =>
        Deferred.doneUnsafe(completed, Effect.fail(new FixtureFailed({ cause: error }))),
    })
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'Work then ask me' })))
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolOutput({ tool: 'ask', toolCallId: 'asked', output: 'savings' })),
    )
    yield* Deferred.await(completed)
    expect(modelIds(yield* parity(opened, chat, 3))).toEqual(['faux/faux-1'])
  }),
)

/** A frame receipt freezes Pi's partial; the reconnect start must carry its recorded model already. */
it.live('includes captured metadata on a reconnect start in the middle of text', () =>
  Effect.gen(function* () {
    const received = Deferred.makeUnsafe<void>()
    const release = yield* Deferred.make<void>()
    const fixture = yield* host(
      {},
      {},
      {},
      {
        onFrame: (event, abortSignal) =>
          event.type === 'text_delta'
            ? waitForFrame(Deferred.await(release), abortSignal)
            : Effect.void,
      },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('A reply observed in flight.')])
    const stream = yield* Effect.promise(() =>
      streamRun(
        opened.harness,
        { conversationId: opened.root.id, content: 'Watch', requestId: 'metadata-mid-text' },
        context,
      ),
    )
    const sending = yield* Effect.forkScoped(
      consumeReadable(
        stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk)
              if (chunk.type === 'text-delta') Deferred.doneUnsafe(received, Effect.void)
            },
          }),
        ),
        Option.none(),
      ),
    )
    yield* Effect.gen(function* () {
      yield* Deferred.await(received)
      const attached = yield* Effect.promise(() =>
        attachRun(opened.harness, opened.root.id, context),
      )
      if (attached.status !== 'running') throw new Error('Expected running reconnect')
      const reader = attached.stream.getReader()
      const first = yield* Effect.promise(() => reader.read())
      expect(first.value).toEqual({
        type: 'start',
        messageId: expect.stringMatching(/^gen:/u),
        messageMetadata: { models: [{ provider: 'faux', modelId: 'faux-1' }] },
      })
      yield* Effect.promise(() => reader.cancel())
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      // Reader failure during cleanup remains a test failure, as the old hot Promise did.
      Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Fiber.await(sending)
          if (Exit.isFailure(result)) return yield* Effect.die(result.cause)
          return undefined
        }),
      ),
    )
  }),
)

/** Parking is an HTTP finish while Pi remains active. Both its attachment and the ended receipt
 * carry exactly the stored usage; the facade must not silently drop metadata on either finish. */
it.live('carries metadata on parked finishes and ended approval replay', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('pay', { amount: 100 }, 'payment'),
      fauxAssistantMessage('Paid.'),
    ])
    const initial = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Pay', requestId: 'metadata-pay' },
            context,
          ),
        ),
      ),
      Option.none(),
    )
    expect(initial.chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: initial.message.metadata,
    })
    const attached = yield* Effect.promise(() =>
      Promise.resolve(attachRun(opened.harness, opened.root.id, context)),
    )
    if (attached.status !== 'running') throw new Error('Expected held run')
    const replayed = yield* consumeReadable(attached.stream, Option.none())
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
    yield* Effect.promise(() =>
      Promise.resolve(
        decide(
          opened.harness,
          opened.root.id,
          { holdId: holdId(part.approval.id), approved: true },
          context,
        ),
      ),
    )
    yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
    const settled = yield* Effect.promise(() =>
      Promise.resolve(history(opened.harness, opened.root.id, { limit: 50 }, context)),
    )
    const assistant = settled.messages.find((message) => message.role === 'assistant')
    if (assistant === undefined) throw new Error('Expected settled history')
    const tail = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(
          continueRun(
            opened.harness,
            opened.root.id,
            { messageId: initial.message.id, known: new Set(['payment']) },
            context,
          ),
        ),
      ),
      Option.some(initial.message),
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
  Effect.gen(function* () {
    const fixture = yield* host({}, {}, { retry: { enabled: false, baseDelayMs: 0 } })
    const opened = yield* fixture.open()
    const failure = 'invalid model request'
    opened.faux.setResponses([
      fauxAssistantMessage('Half an answer.', { stopReason: 'error', errorMessage: failure }),
    ])
    const chat = client(opened)
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'Fail once' })))
    expect(chat.status).toBe('error')
    if (chat.error === undefined || chat.lastMessage === undefined)
      throw new Error('Expected failed assistant')
    expect(chat.error.message).toBe(failure)
    expect(decodeMetadata(chat.lastMessage.metadata).failure).toBe(failure)
    const page = yield* Effect.promise(() =>
      Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
    )
    const saved = page.messages.find((message) => message.role === 'assistant')
    if (saved === undefined) throw new Error('Expected failed history message')
    expect(saved.parts).toEqual(chat.lastMessage.parts)
    expect(saved.metadata).toEqual(chat.lastMessage.metadata)
    const user = chat.messages[0]
    if (user === undefined || user.role !== 'user') throw new Error('Expected admitted user')
    const chunks = yield* Stream.runCollect(
      Stream.fromAsyncIterable(
        yield* Effect.promise(() =>
          Promise.resolve(followRun(opened.harness, opened.root.id, user.id, context)),
        ),
        (cause) => new ReadFailed({ cause }),
      ),
    )
    expect(chunks.slice(-3)).toEqual([
      { type: 'message-metadata', messageMetadata: saved.metadata },
      { type: 'error', errorText: failure },
      { type: 'finish', messageMetadata: saved.metadata },
    ])
    const retry = client(opened)
    retry.messages = [user]
    yield* Effect.promise(() => Promise.resolve(retry.sendMessage()))
    expect(retry.status).toBe('error')
    if (retry.error === undefined) throw new Error('Expected replay failure')
    expect(retry.error.message).toBe(failure)
    expect(opened.faux.state.callCount).toBe(1)
    yield* fixture.close(opened.harness)
    const restarted = yield* fixture.open()
    const replayed = yield* Stream.runCollect(
      Stream.fromAsyncIterable(
        yield* Effect.promise(() =>
          Promise.resolve(followRun(restarted.harness, restarted.root.id, user.id, context)),
        ),
        (cause) => new ReadFailed({ cause }),
      ),
    )
    expect(replayed).toEqual(chunks)
    expect(
      (yield* Effect.promise(() =>
        Promise.resolve(history(restarted.harness, restarted.root.id, { limit: 10 }, context)),
      )).messages,
    ).toEqual(page.messages)
  }),
)

/** An active snapshot proves the steer's first-input identity before failure; no equal failure
 * text or generation-task guess is used to associate two input receipts. */
it.live(
  'keeps a proven failed steer origin live; restart lacks its terminal-answer membership proof',
  () =>
    Effect.gen(function* () {
      const working = Deferred.makeUnsafe<void>()
      const releaseWork = Deferred.makeUnsafe<void>()
      const failing = Deferred.makeUnsafe<void>()
      const releaseFailure = Deferred.makeUnsafe<void>()
      const joined = Deferred.makeUnsafe<void>()
      const fixture = yield* host(
        {
          work: tool({
            inputSchema: z.object({}),
            execute: () =>
              runForPi(
                Effect.gen(function* () {
                  Deferred.doneUnsafe(working, Effect.void)
                  yield* Deferred.await(releaseWork)
                  return 'worked'
                }),
                undefined,
              ),
          }),
        },
        {},
        { retry: { enabled: false, baseDelayMs: 0 } },
      )
      const opened = yield* fixture.open()
      // Scoped shutdown cannot join a tool/provider that is still parked on either gate.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Deferred.doneUnsafe(releaseWork, Effect.void)
          Deferred.doneUnsafe(releaseFailure, Effect.void)
        }),
      )
      opened.faux.setResponses([
        call('work', {}, 'work'),
        () =>
          runForPi(
            Effect.gen(function* () {
              Deferred.doneUnsafe(failing, Effect.void)
              yield* Deferred.await(releaseFailure)
              return fauxAssistantMessage('Failed after steer.', {
                stopReason: 'error',
                errorMessage: 'invalid model request',
              })
            }),
            undefined,
          ),
      ])
      const first = client(opened)
      const sending = first.sendMessage({ text: 'First' })
      yield* Deferred.await(working)
      const steered = new Chat<UIMessage<Metadata>>({
        transport: new DefaultChatTransport({
          api: 'http://durable.test/chat',
          fetch: (url, init) =>
            runForPi(
              Effect.gen(function* () {
                const response = yield* Effect.promise(() =>
                  Promise.resolve(
                    respond(
                      opened.harness,
                      opened.root.id,
                      { request: new Request(url, init), options: { whenBusy: 'steer' } },
                      context,
                    ),
                  ),
                )
                Deferred.doneUnsafe(joined, Effect.void)
                return response
              }),
              undefined,
            ),
        }),
      })
      const queued = Deferred.makeUnsafe<void>()
      const stop = opened.harness.subscribeCommits((publication) => {
        if (
          publication.changes.some(
            (change) => change.type === 'submission' && change.value.status === 'queued',
          )
        )
          Deferred.doneUnsafe(queued, Effect.void)
      })
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      const steering = steered.sendMessage({ text: 'Steer' })
      yield* Deferred.await(queued)
      stop()
      Deferred.doneUnsafe(releaseWork, Effect.void)
      yield* Deferred.await(failing)
      yield* Deferred.await(joined)
      Deferred.doneUnsafe(releaseFailure, Effect.void)
      yield* Effect.promise(() => Promise.resolve(sending))
      yield* Effect.promise(() => Promise.resolve(steering))
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
      yield* fixture.close(opened.harness)
      const restarted = yield* fixture.open()
      const chunks = yield* Stream.runCollect(
        Stream.fromAsyncIterable(
          yield* Effect.promise(() =>
            Promise.resolve(
              followRun(restarted.harness, restarted.root.id, steeredUser.id, context),
            ),
          ),
          (cause) => new ReadFailed({ cause }),
        ),
      )
      // Unanswered receipts have no shared answer entry. Without the original run_end observation,
      // Pi's public reads do not prove whether this placed user steered or began a successor run.
      const start = chunks.find((chunk) => chunk.type === 'start')
      if (start === undefined) throw new Error('Expected stored replay identity')
      expect(start.messageId).not.toBe(originalId)
      expect(chunks).toContainEqual({ type: 'error', errorText: 'invalid model request' })
    }),
)
