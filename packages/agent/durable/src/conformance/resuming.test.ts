import { Deferred, Effect, Fiber, Option, Predicate, Match } from 'effect'
import { runForPi } from '../pi.ts'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  isToolUIPart,
  tool,
  type UIMessage,
  type UIMessageChunk,
  type ChatTransport,
} from 'ai'
import { expect, it } from '@effect/vitest'
import { z } from 'zod'
import { waitForFrame } from '../fixtures/provider.ts'
import { resumable, ConnectionLost, connectionLostInput, closeInputs } from '../client.ts'
import { ChatTurn } from '../core.ts'
import { PlainChat, client, Decision } from '../fixtures/chat.ts'
import {
  respond,
  waiting,
  decodeTurn,
  attachRun,
  streamRun,
  history,
  TurnWaiting,
} from '../main.ts'
import { context, host, texts } from './fixtures/host.ts'
/** A later response may already be present when a disconnected client resumes from its second step. */
it.live('replays a dropped step 2 when the run has reached step 3', () =>
  Effect.gen(function* () {
    const second = yield* Deferred.make<void>()
    const third = yield* Deferred.make<void>()
    const releaseSecond = yield* Deferred.make<void>()
    const releaseThird = yield* Deferred.make<void>()
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: () => Promise.resolve('first result'),
        }),
        pause: tool({
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.gen(function* () {
                Deferred.doneUnsafe(second, Effect.void)
                yield* Deferred.await(releaseSecond)
                return 'second result'
              }),
              undefined,
            ),
        }),
        final: tool({
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.gen(function* () {
                Deferred.doneUnsafe(third, Effect.void)
                yield* Deferred.await(releaseThird)
                return 'third result'
              }),
              undefined,
            ),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    // Release provider gates before closing the harness even if a yielded operation fails.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Deferred.doneUnsafe(releaseSecond, Effect.void)
        Deferred.doneUnsafe(releaseThird, Effect.void)
      }),
    )
    opened.faux.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: 'Starting.' }, fauxToolCall('work', {}, { id: 'work' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [{ type: 'text', text: 'Fin' }, fauxToolCall('pause', {}, { id: 'pause' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [{ type: 'text', text: 'Finished.' }, fauxToolCall('final', {}, { id: 'final' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Done.'),
    ])
    const attached = yield* Deferred.make<void>()
    const chat = new PlainChat({
      transport: resumable(
        new DefaultChatTransport<UIMessage>({
          api: 'http://durable.test/chat',
          fetch: (url, init) =>
            runForPi(
              Effect.gen(function* () {
                const request = new Request(url, init)
                const response = yield* Effect.promise(() =>
                  respond(opened.harness, opened.root.id, request, context),
                )
                if (request.method === 'GET') {
                  Deferred.doneUnsafe(attached, Effect.void)
                  return response
                }
                if (response.body === null) throw new Error('Expected SSE body')
                const decoder = new TextDecoder()
                let secondText = false
                return new Response(
                  response.body.pipeThrough(
                    new TransformStream<Uint8Array, Uint8Array>({
                      transform(chunk, controller) {
                        const text = decoder.decode(chunk)
                        if (secondText && text.includes('text-end')) {
                          controller.error(new TypeError('network connection lost'))
                          return
                        }
                        if (text.includes('"delta":"Fin"')) secondText = true
                        controller.enqueue(chunk)
                      },
                    }),
                  ),
                  { headers: response.headers },
                )
              }),
              undefined,
            ),
        }),
      ),
    })
    try {
      yield* Effect.promise(() => chat.sendMessage({ text: 'Start' }))
      yield* Deferred.await(second)
      expect(chat.status).toBe('error')
      Deferred.doneUnsafe(releaseSecond, Effect.void)
      yield* Deferred.await(third)
      chat.clearError()
      const resumed = chat.resumeStream()
      yield* Deferred.await(attached)
      Deferred.doneUnsafe(releaseThird, Effect.void)
      yield* Effect.promise(() => resumed)
      expect(chat.status).toBe('ready')
      if (chat.lastMessage === undefined) throw new Error('Expected assistant')
      expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Fin', 'Finished.', 'Done.'])
      expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
        'step-start',
        'text',
        'tool-work',
        'step-start',
        'text',
        'tool-pause',
        'step-start',
        'text',
        'tool-final',
        'step-start',
        'text',
      ])
    } finally {
      Deferred.doneUnsafe(releaseSecond, Effect.void)
      Deferred.doneUnsafe(releaseThird, Effect.void)
      yield* Effect.promise(() => opened.root.waitForIdle(context))
    }
  }),
)
/** Chunk faults exercise the public transport protocol, independent of SSE packet boundaries. */
function disconnect(
  source: ReadableStream<UIMessageChunk>,
  input: {
    step: number
    marker: 'text-delta' | 'tool-input-available' | 'tool-input-delta'
  },
) {
  const reader = source.getReader()
  let step = 0
  let cut = false
  return new ReadableStream<UIMessageChunk>(
    {
      pull(controller) {
        return runForPi(
          Effect.gen(function* () {
            if (cut) {
              yield* Effect.promise(() => reader.cancel())
              controller.error(new TypeError('network connection lost'))
              return
            }
            const next = yield* Effect.promise(() => reader.read())
            if (next.done) {
              controller.close()
              return
            }
            if (next.value.type === 'start-step') step += 1
            controller.enqueue(next.value)
            if (step === input.step && next.value.type === input.marker) cut = true
          }),
          undefined,
        )
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  )
}
/** Three actual tool rounds keep the selected run attachable until the GET watch is open. */
function reconnectFixture(
  step: number,
  marker: 'text-delta' | 'tool-input-available' | 'tool-input-delta',
) {
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const gate = (index: number) =>
      tool({
        inputSchema: z.object({}),
        execute: () =>
          runForPi(
            Effect.gen(function* () {
              if (index === step) {
                Deferred.doneUnsafe(entered, Effect.void)
                yield* Deferred.await(release)
              }
              return `result ${index}`
            }),
            undefined,
          ),
      })
    const fixture = yield* host(
      { one: gate(1), two: gate(2), three: gate(3), ask: tool({ inputSchema: z.object({}) }) },
      {},
    )
    const opened = yield* fixture.open()
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
    opened.faux.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: 'S1.' }, fauxToolCall('one', {}, { id: 'one' })],
        {
          stopReason: 'toolUse',
        },
      ),
      fauxAssistantMessage(
        [{ type: 'text', text: 'S2.' }, fauxToolCall('two', {}, { id: 'two' })],
        {
          stopReason: 'toolUse',
        },
      ),
      fauxAssistantMessage(
        [{ type: 'text', text: 'S3.' }, fauxToolCall('three', {}, { id: 'three' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Done.'),
    ])
    const get = yield* Deferred.make<void>()
    let pendingGet = false
    const proceed = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(proceed, Effect.void)))
    const base: ChatTransport<UIMessage> = {
      sendMessages: (input) =>
        runForPi(
          Effect.map(
            Effect.promise(() => opened.transport.sendMessages(input)),
            (stream) => disconnect(stream, { step, marker }),
          ),
          undefined,
        ),
      reconnectToStream: (input) =>
        runForPi(
          Effect.gen(function* () {
            if (pendingGet) {
              // Install the abort listener before publishing GET: Deferred completion can resume the test synchronously.
              const stopped = Deferred.makeUnsafe<void, FixtureFailed>()
              if (input.abortSignal !== undefined)
                input.abortSignal.addEventListener(
                  'abort',
                  () =>
                    Deferred.doneUnsafe(
                      stopped,
                      Effect.fail(
                        new FixtureFailed({ cause: new DOMException('Stopped', 'AbortError') }),
                      ),
                    ),
                  { once: true },
                )
              Deferred.doneUnsafe(get, Effect.void)
              yield* Effect.raceFirst(Deferred.await(proceed), Deferred.await(stopped)).pipe(
                Effect.catchTag('FixtureFailed', (failure) => Effect.die(failure.cause)),
              )
            }
            const stream = yield* Effect.promise(() => opened.transport.reconnectToStream(input))
            Deferred.doneUnsafe(get, Effect.void)
            return stream
          }),
          undefined,
        ),
    }
    return {
      opened,
      entered,
      release,
      get,
      proceed,
      transport: resumable(base),
      delayGet: () => {
        pendingGet = true
      },
    }
  })
}
/** Each run step is rebuilt once after either a text receipt or a completed tool input. */
it.live.each([
  [1, 'text-delta'],
  [1, 'tool-input-available'],
  [2, 'text-delta'],
  [2, 'tool-input-available'],
  [3, 'text-delta'],
  [3, 'tool-input-available'],
] as const)('replaces a dropped step %s at %s with whole-run replay', ([step, marker]) =>
  Effect.gen(function* () {
    const fixture = yield* reconnectFixture(step, marker)
    const chat = new PlainChat({ transport: fixture.transport })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Start' }))
    yield* Deferred.await(fixture.entered)
    expect(chat.error).toBeInstanceOf(ConnectionLost)
    if (chat.lastMessage === undefined) throw new Error('Expected disconnected assistant')
    const identity = chat.lastMessage.id
    if (marker === 'text-delta' && chat.lastMessage !== undefined) {
      for (const part of chat.lastMessage.parts.filter(isToolUIPart)) {
        expect(part.state).not.toBe('input-streaming')
      }
    }
    chat.clearError()
    const resumed = chat.resumeStream()
    yield* Deferred.await(fixture.get)
    Deferred.doneUnsafe(fixture.release, Effect.void)
    yield* Effect.promise(() => resumed)
    expect(chat.status).toBe('ready')
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    assertWhole(chat.lastMessage)
    if (chat.lastMessage === undefined) throw new Error('Expected resumed assistant')
    const saved = yield* Effect.promise(() =>
      history(fixture.opened.harness, fixture.opened.root.id, { limit: 10 }, context),
    )
    const stored = saved.messages.findLast((message) => message.role === 'assistant')
    if (stored === undefined) throw new Error('Expected stored assistant')
    expect(chat.lastMessage.id).toBe(identity)
    expect(stored.id).toBe(identity)
  }),
)
/** A shared guard holds no claims: a fresh Chat always receives every earlier step too. */
it.live('shares a transport with a fresh Chat without losing earlier steps', () =>
  Effect.gen(function* () {
    const fixture = yield* reconnectFixture(2, 'tool-input-available')
    const first = new PlainChat({ transport: fixture.transport })
    yield* Effect.promise(() => first.sendMessage({ text: 'Start' }))
    yield* Deferred.await(fixture.entered)
    const fresh = new PlainChat({ transport: fixture.transport })
    const resumed = fresh.resumeStream()
    yield* Deferred.await(fixture.get)
    Deferred.doneUnsafe(fixture.release, Effect.void)
    yield* Effect.promise(() => resumed)
    expect(fresh.status).toBe('ready')
    assertWhole(fresh.lastMessage)
  }),
)
/** Stopping an unresolved GET must not leave a stale step claim for the subsequent resume. */
it.live.each(['text-delta', 'tool-input-available'] as const)(
  'resumes after stopping a pending GET at %s',
  (marker) =>
    Effect.gen(function* () {
      const fixture = yield* reconnectFixture(2, marker)
      const chat = new PlainChat({ transport: fixture.transport })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Start' }))
      yield* Deferred.await(fixture.entered)
      fixture.delayGet()
      chat.clearError()
      const pending = chat.resumeStream()
      yield* Deferred.await(fixture.get)
      yield* Effect.promise(() => chat.stop())
      yield* Effect.promise(() => pending)
      Deferred.doneUnsafe(fixture.proceed, Effect.void)
      const next = chat.resumeStream()
      Deferred.doneUnsafe(fixture.release, Effect.void)
      yield* Effect.promise(() => next)
      expect(chat.status).toBe('ready')
      assertWhole(chat.lastMessage)
    }),
)
/** Assert parts individually: concatenating text would conceal repeated steps or tool parts. */
function assertWhole(message: PlainChat['lastMessage']) {
  if (message === undefined) throw new Error('Expected completed assistant message')
  expect(texts(message)).toEqual(['S1.', 'S2.', 'S3.', 'Done.'])
  expect(message.parts.map((part) => part.type)).toEqual([
    'step-start',
    'text',
    'tool-one',
    'step-start',
    'text',
    'tool-two',
    'step-start',
    'text',
    'tool-three',
    'step-start',
    'text',
  ])
  expect(message.parts.filter(isToolUIPart).map((part) => part.state)).toEqual([
    'output-available',
    'output-available',
    'output-available',
  ])
}
/** A stale partial belongs to its old id; another device's active run is a separate message. */
it.live('resumes a newer run without merging it into the disconnected older message', () =>
  Effect.gen(function* () {
    const fixture = yield* reconnectFixture(2, 'tool-input-available')
    const first = new PlainChat({ transport: fixture.transport })
    yield* Effect.promise(() => first.sendMessage({ text: 'Start' }))
    yield* Deferred.await(fixture.entered)
    const old = structuredClone(first.lastMessage)
    if (old === undefined) throw new Error('Expected old partial')
    Deferred.doneUnsafe(fixture.release, Effect.void)
    yield* Effect.promise(() => fixture.opened.root.waitForIdle(context))
    fixture.opened.faux.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: 'New run.' }, fauxToolCall('ask', {}, { id: 'ask' })],
        { stopReason: 'toolUse' },
      ),
    ])
    const second = new PlainChat({ transport: fixture.opened.transport })
    yield* Effect.promise(() => second.sendMessage({ text: 'Another run' }))
    first.clearError()
    yield* Effect.promise(() => first.resumeStream())
    expect(first.status).toBe('ready')
    const assistants = first.messages.filter((message) => message.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]).toEqual(old)
    expect(first.lastMessage).toEqual(second.lastMessage)
    if (first.lastMessage === undefined) throw new Error('Expected newer message')
    expect(first.lastMessage.id).not.toBe(old.id)
  }),
)
/** Approval requests survive a drop before their delivery, using the stock automatic-send predicate. */
it.live('resumes a parked approval and approves through the SDK part', () =>
  Effect.gen(function* () {
    let paid = 0
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({}),
          execute: () => {
            paid += 1
            return Promise.resolve('paid')
          },
        }),
      },
      { approval: { pay: true } },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', {}, { id: 'pay' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Paid.'),
    ])
    let dropped = false
    const transport: ChatTransport<UIMessage> = {
      sendMessages: (input) =>
        runForPi(
          Effect.gen(function* () {
            const stream = yield* Effect.promise(() => opened.transport.sendMessages(input))
            if (dropped) return stream
            dropped = true
            return disconnect(stream, { step: 1, marker: 'tool-input-available' })
          }),
          undefined,
        ),
      reconnectToStream: (input) => opened.transport.reconnectToStream(input),
    }
    const { chat, next } = client({
      transport: resumable(transport),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
    expect(chat.status).toBe('error')
    chat.clearError()
    const resumed = next()
    yield* Effect.promise(() => chat.resumeStream())
    expect(yield* resumed).toEqual(Decision.cases.Settled.make({}))
    if (chat.lastMessage === undefined) throw new Error('Expected approval message')
    const part = chat.lastMessage.parts.find(isToolUIPart)
    if (part === undefined || part.state !== 'approval-requested')
      throw new Error('Expected request')
    const completion = next()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
    )
    expect(yield* completion).toEqual(Decision.cases.Settled.make({}))
    expect(chat.status).toBe('ready')
    expect(paid).toBe(1)
    if (chat.lastMessage === undefined) throw new Error('Expected completed message')
    expect(texts(chat.lastMessage)).toEqual(['Paid.'])
  }),
)
/** The synthetic output-error marker is not a known call and never answers or approves it. */
it.live('ignores synthetic connection errors in a real resume body', () =>
  Effect.gen(function* () {
    const fixture = yield* host({ ask: tool({ inputSchema: z.object({}) }) }, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('ask', {}, { id: 'ask' })], { stopReason: 'toolUse' }),
    ])
    const chat = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))
    if (chat.lastMessage === undefined) throw new Error('Expected answer hold')
    const rows = yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))
    const body = {
      messages: [
        {
          ...chat.lastMessage,
          parts: [
            {
              type: 'tool-ask',
              toolCallId: 'ask',
              state: 'output-error',
              errorText: connectionLostInput,
              output: 'must not settle',
            },
          ],
        },
      ],
    }
    const turn = yield* Effect.promise(() => decodeTurn(body))
    if (!ChatTurn.guards.Resume(turn)) throw new Error('Expected resume turn')
    expect(turn.known).toEqual([])
    expect(turn.outputs).toEqual([])
    expect(turn.decisions).toEqual([])
    const response = yield* Effect.promise(() =>
      respond(
        opened.harness,
        opened.root.id,
        new Request('http://durable.test/chat', { method: 'POST', body: JSON.stringify(body) }),
        context,
      ),
    )
    expect(response.status).toBe(200)
    if (response.body === null) throw new Error('Expected response stream')
    yield* Effect.promise(() => response.text())
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      rows,
    )
  }),
)
/** Retained provider JSON is interrupted locally, then replay replaces the synthetic input error. */
it.live('closes a dropped raw input and resumes its real call without repeating arguments', () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    let gated = false
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({ input: z.string() }),
          execute: (input) => Promise.resolve(input),
        }),
      },
      {},
      { progress: { partialIntervalMs: 1 } },
      {
        partialFamily: 'anthropic',
        tokenSize: { min: 1, max: 1 },
        onFrame: (event, abortSignal) => {
          if (event.type !== 'toolcall_delta' || gated) return Effect.void
          const block = event.partial.content[event.contentIndex]
          if (block === undefined || block.type !== 'toolCall')
            throw new Error('Expected tool block')
          if (!Predicate.isString(block.arguments.input) || block.arguments.input.length < 5)
            return Effect.void
          gated = true
          return waitForFrame(Deferred.await(release), abortSignal)
        },
      },
    )
    const opened = yield* fixture.open()
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
    const input = { input: 'abcdefghijklmnopqrstuvwxyz' }
    opened.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('work', input, { id: 'work' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Finished.'),
    ])
    const get = yield* Deferred.make<void>()
    const chunks: UIMessageChunk[] = []
    let posts = 0
    const base: ChatTransport<UIMessage> = {
      sendMessages: (options) =>
        runForPi(
          Effect.gen(function* () {
            posts += 1
            return disconnect(yield* Effect.promise(() => opened.transport.sendMessages(options)), {
              step: 1,
              marker: 'tool-input-delta',
            })
          }),
          undefined,
        ),
      reconnectToStream: (options) =>
        runForPi(
          Effect.gen(function* () {
            const stream = yield* Effect.promise(() => opened.transport.reconnectToStream(options))
            Deferred.doneUnsafe(get, Effect.void)
            if (stream === null) return null
            return stream.pipeThrough(
              new TransformStream<UIMessageChunk, UIMessageChunk>({
                transform(chunk, controller) {
                  chunks.push(chunk)
                  controller.enqueue(chunk)
                },
              }),
            )
          }),
          undefined,
        ),
    }
    const chat = new PlainChat({
      transport: resumable(base),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Work' }))
    expect(chat.error).toBeInstanceOf(ConnectionLost)
    if (chat.lastMessage === undefined) throw new Error('Expected interrupted message')
    expect(chat.lastMessage.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-error',
      errorText: connectionLostInput,
    })
    chat.clearError()
    const resumed = chat.resumeStream()
    yield* Deferred.await(get)
    Deferred.doneUnsafe(release, Effect.void)
    yield* Effect.promise(() => resumed)
    expect(chat.status).toBe('ready')
    expect(posts).toBe(1)
    const deltas = chunks.flatMap((chunk) =>
      chunk.type === 'tool-input-delta' ? [chunk.inputTextDelta] : [],
    )
    expect(JSON.stringify(input).startsWith(deltas.join(''))).toBe(true)
    expect(chunks.filter((chunk) => chunk.type === 'tool-input-start')).toHaveLength(1)
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    if (chat.lastMessage === undefined) throw new Error('Expected completed message')
    expect(chat.lastMessage.parts.filter(isToolUIPart)).toEqual([
      expect.objectContaining({ state: 'output-available', input, output: input }),
    ])
    expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
      'step-start',
      'tool-work',
      'step-start',
      'text',
    ])
  }),
)
/** Fetch owns AbortSignal cancellation; the guard preserves the SDK's actual isAbort finish. */
it.live('keeps stop during a stream as an abort rather than ConnectionLost', () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const visible = yield* Deferred.make<void>()
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.gen(function* () {
                yield* Deferred.await(release)
                return 'worked'
              }),
              undefined,
            ),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
    opened.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('work', {}, { id: 'work' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ])
    const finishes: {
      isAbort: boolean
      isDisconnect: boolean
      isError: boolean
    }[] = []
    const chat = new PlainChat({
      transport: resumable(
        new DefaultChatTransport({
          api: 'http://durable.test/chat',
          fetch: (url, init) =>
            runForPi(
              Effect.gen(function* () {
                const request = new Request(url, init)
                const response = yield* Effect.promise(() =>
                  respond(opened.harness, opened.root.id, request, context),
                )
                if (response.body === null) throw new Error('Expected SSE response')
                const body = response.body.pipeThrough(
                  new TransformStream<Uint8Array, Uint8Array>(),
                  {
                    signal: request.signal,
                  },
                )
                return new Response(body, { headers: response.headers })
              }),
              undefined,
            ),
        }),
      ),
      onMessage: (message) => {
        if (message.parts.some((part) => isToolUIPart(part) && part.state === 'input-available'))
          Deferred.doneUnsafe(visible, Effect.void)
      },
      onFinish: ({ isAbort, isDisconnect, isError }) => {
        finishes.push({ isAbort, isDisconnect, isError })
      },
    })
    const sending = chat.sendMessage({ text: 'Work' })
    yield* Deferred.await(visible)
    yield* Effect.promise(() => chat.stop())
    yield* Effect.promise(() => sending)
    expect(chat.status).toBe('ready')
    expect(chat.error).toBeUndefined()
    expect(finishes).toEqual([{ isAbort: true, isDisconnect: false, isError: false }])
    Deferred.doneUnsafe(release, Effect.void)
    yield* Effect.promise(() => opened.root.waitForIdle(context))
  }),
)
/** Retry attempts stay in one step; tool rounds and steers advance steps identically in both paths. */
it.live.each(['parallel', 'sequential', 'retry', 'steer'] as const)(
  'uses the live step index in the %s snapshot',
  (runKind) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const execution = runKind === 'sequential' ? 'sequential' : 'parallel'
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
          pay: tool({
            inputSchema: z.object({}),
            execute: () => Promise.resolve('paid'),
          }),
        },
        { execution, approval: { pay: true } },
        { toolExecution: execution, steeringMode: 'all' },
      )
      const opened = yield* fixture.open()
      const parked = fauxAssistantMessage(
        [{ type: 'text', text: 'Review' }, fauxToolCall('pay', {}, { id: 'pay' })],
        { stopReason: 'toolUse' },
      )
      const preceding = Match.value(runKind).pipe(
        Match.when('retry', () => [
          fauxAssistantMessage('failed attempt', {
            stopReason: 'error',
            errorMessage: '503 Service Unavailable',
          }),
        ]),
        Match.when('steer', () => [
          fauxAssistantMessage([fauxToolCall('work', {}, { id: 'work' })], {
            stopReason: 'toolUse',
          }),
        ]),
        Match.orElse(() => []),
      )
      opened.faux.setResponses([...preceding, parked])
      yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
      try {
        const live = yield* Effect.forkScoped(
          consumeReadable(
            yield* Effect.promise(() =>
              streamRun(
                opened.harness,
                { conversationId: opened.root.id, content: 'Start', requestId: runKind },
                context,
              ),
            ),
            Option.none(),
          ),
        )
        if (runKind === 'steer') {
          yield* Deferred.await(entered)
          yield* Effect.promise(() =>
            opened.root.submit(
              { type: 'input', content: 'Steer', requestId: 'steer', whenBusy: 'steer' },
              context,
            ),
          )
          Deferred.doneUnsafe(release, Effect.void)
        }
        const result = yield* Fiber.join(live)
        const steps = result.chunks.filter((chunk) => chunk.type === 'start-step').length
        expect(steps).toBe(runKind === 'steer' ? 2 : 1)
        const attached = yield* Effect.promise(() =>
          attachRun(opened.harness, opened.root.id, context),
        )
        if (attached.status === 'idle') throw new Error('Expected parked run')
        const whole = yield* consumeReadable(attached.stream, Option.none())
        expect(whole.chunks.filter((chunk) => chunk.type === 'start-step')).toHaveLength(steps)
        expect(texts(whole.message)).toEqual(texts(result.message))
        expect(whole.message.parts.map((part) => part.type)).toEqual(
          result.message.parts.map((part) => part.type),
        )
      } finally {
        Deferred.doneUnsafe(release, Effect.void)
      }
    }),
)
/** A status refusal remains actionable typed text; it must not reconnect to another person's run. */
it.live('preserves a 409 through resumable at transport acquisition', () =>
  Effect.gen(function* () {
    const opened = yield* (yield* host(
      {
        pay: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: () => Promise.resolve('paid'),
        }),
      },
      { approval: { pay: true } },
    )).open()
    opened.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', { amount: 1 }, { id: 'pay' })], {
        stopReason: 'toolUse',
      }),
    ])
    const first = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() => first.sendMessage({ text: 'First' }))
    const second = new PlainChat({ transport: resumable(opened.transport) })
    yield* Effect.promise(() => second.sendMessage({ text: 'Refused' }))
    expect(second.status).toBe('error')
    expect(second.error).not.toBeInstanceOf(ConnectionLost)
    if (second.error === undefined) throw new Error('Expected HTTP refusal')
    expect(second.error.message).toBe(new TurnWaiting({ conversationId: opened.root.id }).message)
  }),
)
/** chat.ts:437–473 replaces a known user using sendMessage({messageId, text}). Lost HTTP
 * admission is retried with that identity: absent turns are admitted once and present turns join. */
it.live.each([false, true])(
  'retries a lost POST with the SDK user identity (admitted=%s)',
  (admitted) =>
    Effect.gen(function* () {
      const opened = yield* (yield* host(
        {
          pay: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: () => Promise.resolve('paid'),
          }),
        },
        { approval: { pay: true } },
      )).open()
      opened.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('pay', { amount: 1 }, { id: 'pay' })], {
          stopReason: 'toolUse',
        }),
      ])
      let lost = false
      const chat = new PlainChat({
        transport: resumable(
          new DefaultChatTransport<UIMessage>({
            api: 'http://durable.test/chat',
            fetch: (url, init) =>
              runForPi(
                Effect.gen(function* () {
                  const request = new Request(url, init)
                  if (request.method === 'POST' && !lost) {
                    lost = true
                    if (admitted)
                      yield* Effect.flatMap(
                        Effect.promise(() =>
                          respond(opened.harness, opened.root.id, request, context),
                        ),
                        (_await0) => Effect.promise(() => _await0.text()),
                      )
                    throw new TypeError('fetch network failed')
                  }
                  return yield* Effect.promise(() =>
                    respond(opened.harness, opened.root.id, request, context),
                  )
                }),
                undefined,
              ),
          }),
        ),
      })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Pay once' }))
      expect(chat.error).toBeInstanceOf(ConnectionLost)
      const user = chat.messages[0]
      if (user === undefined || user.role !== 'user') throw new Error('Expected user')
      chat.clearError()
      yield* Effect.promise(() => chat.resumeStream())
      if (!admitted) expect(chat.messages).toEqual([user])
      yield* Effect.promise(() => chat.sendMessage({ messageId: user.id, text: 'Pay once' }))
      expect(chat.status).toBe('ready')
      expect(opened.faux.state.callCount).toBe(1)
      expect(chat.messages.filter((message) => message.role === 'user')).toEqual([user])
      expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    }),
)
/** The stock output predicate sees the synthetic terminal part as complete. Its one POST must
 * restore the missing input and request approval, instead of muting the call and looping. */
it.live.each(['pay', 'work'] as const)(
  're-presents a locally interrupted %s input when an earlier client call is answered',
  (second) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const visible = yield* Deferred.make<void>()
      const fixture = yield* host(
        {
          ask: tool({ inputSchema: z.object({}) }),
          work: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: () =>
              runForPi(
                Effect.gen(function* () {
                  yield* Deferred.await(release)
                  return 'worked'
                }),
                undefined,
              ),
          }),
          pay: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: () => Promise.resolve('paid'),
          }),
        },
        { approval: { pay: true } },
      )
      const opened = yield* fixture.open()
      yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
      opened.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('ask', {}, { id: 'ask' }),
            fauxToolCall(second, { amount: 7 }, { id: 'pay' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Finished.'),
      ])
      let posts = 0
      const finished = yield* Deferred.make<void, FixtureFailed>()
      const chat = new PlainChat({
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        onMessage: (message) => {
          if (
            posts === 2 &&
            message.parts.some(
              (part) =>
                isToolUIPart(part) && part.type === 'tool-work' && part.state === 'input-available',
            )
          )
            Deferred.doneUnsafe(visible, Effect.void)
        },
        onFinish: ({ isError }) => {
          if (posts === 2 && !isError) Deferred.doneUnsafe(finished, Effect.void)
        },
        transport: resumable({
          sendMessages: (input) =>
            runForPi(
              Effect.gen(function* () {
                posts++
                const stream = yield* Effect.promise(() => opened.transport.sendMessages(input))
                return posts === 1
                  ? disconnect(stream, { step: 1, marker: 'tool-input-available' })
                  : stream
              }),
              undefined,
            ),
          reconnectToStream: (input) => opened.transport.reconnectToStream(input),
        }),
      })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Ask then pay' }))
      expect(chat.error).toBeInstanceOf(ConnectionLost)
      chat.clearError()
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'yes' })),
      )
      if (second === 'work') {
        yield* Deferred.await(visible)
        Deferred.doneUnsafe(release, Effect.void)
      }
      yield* Deferred.await(finished)
      expect(posts).toBe(2)
      expect(chat.status).toBe('ready')
      if (chat.lastMessage === undefined) throw new Error('Expected approval')
      const pay = chat.lastMessage.parts
        .filter(isToolUIPart)
        .find((part) => part.toolCallId === 'pay')
      if (pay === undefined) throw new Error('Expected real pay input')
      expect(pay.state).toBe(second === 'pay' ? 'approval-requested' : 'output-available')
      expect(pay.input).toEqual({ amount: 7 })
      expect(
        (yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).map(
          (row) => row.callId,
        ),
      ).toEqual(second === 'pay' ? ['pay'] : [])
    }),
)
/** S-stop: the SDK does not notify the transport when stop discards its private reader. Close
 * client-held streaming inputs before bodyless replay; no step or earlier result is seeded twice. */
it.live('closes stopped step-2 inputs before resuming the same Chat', () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const streaming = yield* Deferred.make<void>()
    const attached = yield* Deferred.make<void>()
    let gated = false
    const fixture = yield* host(
      {
        one: tool({
          inputSchema: z.object({}),
          execute: () => Promise.resolve('r1'),
        }),
        two: tool({
          inputSchema: z.object({ input: z.string() }),
          execute: () => Promise.resolve('r2'),
        }),
      },
      {},
      { progress: { partialIntervalMs: 1 } },
      {
        partialFamily: 'anthropic',
        commitFrames: true,
        tokenSize: { min: 1, max: 1 },
        onFrame: (event, abortSignal) => {
          if (event.type !== 'toolcall_delta' || gated) return Effect.void
          const block = event.partial.content[event.contentIndex]
          if (block === undefined || block.type !== 'toolCall' || block.name !== 'two')
            return Effect.void
          if (!Predicate.isString(block.arguments.input) || block.arguments.input.length < 8)
            return Effect.void
          gated = true
          return waitForFrame(Deferred.await(release), abortSignal)
        },
      },
    )
    const opened = yield* fixture.open()
    yield* Effect.addFinalizer(() => Effect.sync(() => Deferred.doneUnsafe(release, Effect.void)))
    opened.faux.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: 'S1.' }, fauxToolCall('one', {}, { id: 'one' })],
        {
          stopReason: 'toolUse',
        },
      ),
      fauxAssistantMessage(
        [
          { type: 'text', text: 'S2.' },
          fauxToolCall('two', { input: 'abcdefghijklmnopqrstuvwxyz' }, { id: 'two' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Done.'),
    ])
    const base = new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: (url, init) =>
        runForPi(
          Effect.gen(function* () {
            const request = new Request(url, init)
            const response = yield* Effect.promise(() =>
              respond(opened.harness, opened.root.id, request, context),
            )
            if (response.body === null) return response
            return new Response(
              response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
                signal: request.signal,
              }),
              { headers: response.headers, status: response.status },
            )
          }),
          undefined,
        ),
    })
    const finishes: boolean[] = []
    const chat = new PlainChat({
      transport: resumable({
        sendMessages: (input) => base.sendMessages(input),
        reconnectToStream: (input) =>
          runForPi(
            Effect.gen(function* () {
              const stream = yield* Effect.promise(() => base.reconnectToStream(input))
              Deferred.doneUnsafe(attached, Effect.void)
              return stream
            }),
            undefined,
          ),
      }),
      onFinish: ({ isAbort }) => {
        finishes.push(isAbort)
      },
      onMessage: (message) => {
        if (
          message.parts.some(
            (part) =>
              isToolUIPart(part) && part.toolCallId === 'two' && part.state === 'input-streaming',
          )
        )
          Deferred.doneUnsafe(streaming, Effect.void)
      },
    })
    const sending = chat.sendMessage({ text: 'Start' })
    yield* Deferred.await(streaming)
    yield* Effect.promise(() => chat.stop())
    yield* Effect.promise(() => sending)
    expect(finishes).toEqual([true])
    chat.messages = closeInputs(chat.messages)
    const resuming = chat.resumeStream()
    yield* Deferred.await(attached)
    Deferred.doneUnsafe(release, Effect.void)
    yield* Effect.promise(() => resuming)
    expect(chat.status).toBe('ready')
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    if (chat.lastMessage === undefined) throw new Error('Expected resumed assistant')
    expect(texts(chat.lastMessage)).toEqual(['S1.', 'S2.', 'Done.'])
    expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
      'step-start',
      'text',
      'tool-one',
      'step-start',
      'text',
      'tool-two',
      'step-start',
      'text',
    ])
  }),
)
