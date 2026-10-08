import { Deferred, Effect, Option } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable, hold } from '../fixtures/reading.ts'
import { runForPi } from '../pi.ts'
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
  createUIMessageStreamResponse,
  isToolUIPart,
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
} from 'ai'
import { expect, it } from '@effect/vitest'
import { z } from 'zod'
import { resumable } from '../client.ts'
import { PlainChat, client, Decision } from '../fixtures/chat.ts'
import { answer, attachRun, continueRun, decide, respond, streamRun, waiting } from '../main.ts'
import { call, context, host, modelText, shop, texts } from './fixtures/host.ts'
/** The stock app echoes the approval identity supplied in its actual SDK message part. */
function approvalId(chat: PlainChat, callId: string) {
  if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
  const part = chat.lastMessage.parts.find(
    (candidate) => isToolUIPart(candidate) && candidate.toolCallId === callId,
  )
  if (part === undefined || !isToolUIPart(part) || part.state !== 'approval-requested')
    throw new Error('Expected approval request')
  return part.approval.id
}
// AI SDK packages/ai/src/ui-message-stream/ui-message-chunks.test.ts: returns UI message chunks; accepts reset-step chunks.
// consume validates all chunks with uiMessageChunkSchema before folding; exercise each bridge lifecycle.
it.live.each(['text', 'reasoning', 'approval', 'answer', 'denial', 'retry'] as const)(
  'emits a valid SDK UI stream for %s',
  (kind) =>
    Effect.gen(function* () {
      const fixture = yield* shop()
      const opened = yield* fixture.open()
      switch (kind) {
        case 'text':
          opened.faux.setResponses([fauxAssistantMessage('Done.')])
          break
        case 'reasoning':
          opened.faux.setResponses([
            fauxAssistantMessage([fauxThinking('Checking.'), { type: 'text', text: 'Done.' }]),
          ])
          break
        case 'approval':
        case 'denial':
          opened.faux.setResponses([
            call('pay', { amount: 500 }, 'held'),
            fauxAssistantMessage('Done.'),
          ])
          break
        case 'answer':
          opened.faux.setResponses([
            call('ask', { question: 'Which?' }, 'held'),
            fauxAssistantMessage('Done.'),
          ])
          break
        case 'retry':
          opened.faux.setResponses([
            fauxAssistantMessage('Partial.', {
              stopReason: 'error',
              errorMessage: '503 Service Unavailable',
            }),
            fauxAssistantMessage('Done.'),
          ])
          break
      }
      const first = yield* consumeReadable(
        yield* Effect.promise(() =>
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: 'Do it', requestId: kind },
            context,
          ),
        ),
        Option.none(),
      )
      if (kind === 'approval' || kind === 'denial' || kind === 'answer') {
        const resolved1 = yield* hold(opened.harness, opened.root.id, 'held', context)
        const resolved2 = yield* hold(opened.harness, opened.root.id, 'held', context)
        if (kind === 'answer')
          yield* Effect.promise(() =>
            answer(
              opened.harness,
              opened.root.id,
              { holdId: resolved1, output: 'savings' },
              context,
            ),
          )
        else
          yield* Effect.promise(() =>
            decide(
              opened.harness,
              opened.root.id,
              {
                holdId: resolved2,
                approved: kind === 'approval',
                reason: 'No budget',
              },
              context,
            ),
          )
        const stream = yield* Effect.promise(() =>
          continueRun(
            opened.harness,
            opened.root.id,
            { messageId: first.message.id, known: new Set(['held']) },
            context,
          ),
        )
        if (stream === undefined) throw new Error('Expected a continuation')
        const result = yield* consumeReadable(stream, Option.some(first.message))
        expect(texts(result.message)).toEqual(['Done.'])
        if (kind === 'answer')
          expect(
            result.chunks.filter(
              (chunk) => chunk.type === 'tool-output-available' && chunk.toolCallId === 'held',
            ),
          ).toHaveLength(1)
      } else expect(texts(first.message)).toEqual(['Done.'])
      expect(first.chunks.at(0)).toMatchObject({ type: 'start' })
      expect(first.chunks.at(-1)).toMatchObject({ type: 'finish' })
    }),
)
// AI SDK packages/ai/src/ui/chat.test.ts: addToolApprovalResponse > approved with automatic sending > should update tool invocation to show the approval response.
it.live('addToolApprovalResponse automatically resumes one assistant message', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: 'Checking.' }, fauxToolCall('pay', { amount: 500 }, { id: 'pay' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Paid.'),
    ])
    const { chat, next } = client({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    })
    const initial = next()
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))

    expect(yield* initial).toEqual(Decision.cases.Settled.make({}))
    expect(chat.status).toBe('ready')
    const parked = chat.lastMessage
    if (parked === undefined) throw new Error('Expected the held message')
    const id = parked.id
    expect(fixture.paid).toEqual([])
    const finished = next()
    yield* Effect.promise(() =>
      Promise.resolve(
        chat.addToolApprovalResponse({
          id: approvalId(chat, 'pay'),
          approved: true,
        }),
      ),
    )
    expect(yield* finished).toEqual(Decision.cases.Settled.make({}))
    expect(chat.status).toBe('ready')
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
    expect(chat.lastMessage.id).toBe(id)
    expect(texts(chat.lastMessage)).toEqual(['Checking.', 'Paid.'])
    expect(chat.lastMessage.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'output-available',
      output: { receipt: 500 },
    })
    expect(fixture.paid).toEqual([500])
  }),
)
// AI SDK packages/ai/src/ui/chat.test.ts: sendAutomaticallyWhen > should send message when a tool output is submitted.
it.live('addToolOutput automatically resumes one assistant message', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      call('ask', { question: 'Which account?' }, 'ask'),
      (request) => fauxAssistantMessage(`Using ${modelText(request.messages).split('\n').at(-1)}.`),
    ])
    const { chat, next } = client({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    })
    const initial = next()
    yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))

    expect(yield* initial).toEqual(Decision.cases.Settled.make({}))
    const parked = chat.lastMessage
    if (parked === undefined) throw new Error('Expected the held message')
    expect(parked.parts.find((part) => part.type === 'tool-ask')).toMatchObject({
      state: 'input-available',
      input: { question: 'Which account?' },
    })
    const id = parked.id
    const finished = next()
    yield* Effect.promise(() =>
      Promise.resolve(chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'savings' })),
    )
    expect(yield* finished).toEqual(Decision.cases.Settled.make({}))
    expect(chat.status).toBe('ready')
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
    expect(chat.lastMessage.id).toBe(id)
    expect(texts(chat.lastMessage)).toEqual(['Using savings.'])
    expect(chat.lastMessage.parts.find((part) => part.type === 'tool-ask')).toMatchObject({
      state: 'output-available',
      output: 'savings',
    })
  }),
)
// AI SDK packages/ai/src/ui/last-assistant-message-is-complete-with-approval-responses.test.ts: should return false if some tools still have approval-requested state.
it.live('the stock approval predicate waits for both decisions before posting', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('pay', { amount: 100 }, { id: 'one' }),
          fauxToolCall('pay', { amount: 200 }, { id: 'two' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Resolved.'),
    ])
    const { chat, next } = client({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    })
    const initial = next()
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay both' }))

    expect(yield* initial).toEqual(Decision.cases.Settled.make({}))
    yield* Effect.promise(() =>
      Promise.resolve(
        chat.addToolApprovalResponse({
          id: approvalId(chat, 'one'),
          approved: true,
        }),
      ),
    )
    expect(chat.status).toBe('ready')
    expect(fixture.paid).toEqual([])
    expect(
      yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
    ).toHaveLength(2)
    const finished = next()
    yield* Effect.promise(() =>
      Promise.resolve(
        chat.addToolApprovalResponse({
          id: approvalId(chat, 'two'),
          approved: false,
          reason: 'Budget',
        }),
      ),
    )
    expect(yield* finished).toEqual(Decision.cases.Settled.make({}))
    expect(fixture.paid).toEqual([100])
    if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
    expect(
      chat.lastMessage.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'two'),
    ).toMatchObject({ state: 'output-denied' })
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
  }),
)
// Installed ai/src/ui/last-assistant-message-is-complete-with-approval-responses.ts:35–40
// requires all presented tools to have responses. Withholding unstarted calls lets c1 authorize
// the next request, then the live document watch presents c2 when its task is allocated.
it.live(
  'the stock approval predicate advances after withholding an unstarted sequential call',
  () =>
    Effect.gen(function* () {
      const paid: number[] = []
      const fixture = yield* host(
        {
          pay: tool({
            inputSchema: z.object({ amount: z.number() }),
            execute: ({ amount }) =>
              runForPi(
                Effect.sync(() => {
                  paid.push(amount)
                  return amount
                }),
                undefined,
              ),
          }),
        },
        { execution: 'sequential', approval: { pay: true } },
        { toolExecution: 'sequential' },
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
            fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Done.'),
      ])
      const { chat, next } = client({
        transport: opened.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      })
      const initial = next()
      yield* Effect.promise(() => chat.sendMessage({ text: 'Pay both' }))

      expect(yield* initial).toEqual(Decision.cases.Settled.make({}))
      expect(
        yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
      ).toMatchObject([{ callId: 'c1' }])
      if (chat.lastMessage === undefined) throw new Error('Expected the sequential message')
      expect(
        chat.lastMessage.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'c2'),
      ).toBeUndefined()
      const completed = next()
      yield* Effect.promise(() =>
        Promise.resolve(
          chat.addToolApprovalResponse({
            id: approvalId(chat, 'c1'),
            approved: true,
          }),
        ),
      )
      expect(yield* completed).toEqual(Decision.cases.Settled.make({}))
      expect(paid).toEqual([1])
      expect(
        chat.lastMessage.parts.find((part) => 'toolCallId' in part && part.toolCallId === 'c2'),
      ).toMatchObject({ state: 'approval-requested' })
      const finished = next()
      yield* Effect.promise(() =>
        Promise.resolve(
          chat.addToolApprovalResponse({
            id: approvalId(chat, 'c2'),
            approved: true,
          }),
        ),
      )
      expect(yield* finished).toEqual(Decision.cases.Settled.make({}))
      expect(paid).toEqual([1, 2])
      expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    }),
)
// AI SDK packages/ai/src/ui/chat.test.ts: sendAutomaticallyWhen > should submit a client tool output when completed text follows the tool call.
it.live(
  'the stock tool predicate submits an output even when completed text follows the call',
  () =>
    Effect.gen(function* () {
      const fixture = yield* shop()
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('ask', { question: 'Which account?' }, { id: 'ask' }),
            { type: 'text', text: 'Waiting for your answer.' },
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Answered.'),
      ])
      const { chat, next } = client({
        transport: opened.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      })
      const initial = next()
      yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))

      expect(yield* initial).toEqual(Decision.cases.Settled.make({}))
      const finished = next()
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'savings' })),
      )
      expect(yield* finished).toEqual(Decision.cases.Settled.make({}))
      expect(chat.status).toBe('ready')
      expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      if (chat.lastMessage === undefined) throw new Error('Expected an assistant message')
      expect(texts(chat.lastMessage)).toEqual(['Waiting for your answer.', 'Answered.'])
    }),
)
/** Keep a real tool running while reconnect attaches; release is a tool completion, not a clock. */
const running = Effect.fn('Test.running')(function* () {
  const entered = yield* Deferred.make<void, FixtureFailed>()
  const release = yield* Deferred.make<void, FixtureFailed>()
  const fixture = yield* host(
    {
      work: tool({
        description: 'Build a report',
        inputSchema: z.object({}),
        execute: () =>
          runForPi(
            Effect.gen(function* () {
              Deferred.doneUnsafe(entered, Effect.void)
              yield* Deferred.await(release)
              return '12 pages'
            }),
            undefined,
          ),
      }),
    },
    {},
  )
  const opened = yield* fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [{ type: 'text', text: 'Starting.' }, fauxToolCall('work', {}, { id: 'work' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Finished.'),
  ])
  const original = yield* Effect.promise(() =>
    streamRun(
      opened.harness,
      { conversationId: opened.root.id, content: 'Build', requestId: 'build' },
      context,
    ),
  )
  yield* Deferred.await(entered)
  yield* Effect.promise(() => original.cancel())
  return { ...opened, release }
})
// AI SDK packages/ai/src/ui/chat.test.ts: should not copy the previous assistant message when resuming a stream.
// The host maps GET to public attachRun; the separate tests below exercise respond's GET support.
it.live('a host reconnect route streams the active run through the stock transport', () =>
  Effect.gen(function* () {
    const opened = yield* running()
    const attached = yield* Deferred.make<void, FixtureFailed>()
    const transport = new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: (url, init) =>
        runForPi(
          Effect.gen(function* () {
            const request = new Request(url, init)
            if (request.method !== 'GET')
              return yield* Effect.promise(() =>
                respond(opened.harness, opened.root.id, request, context),
              )
            const attachedRun = yield* Effect.promise(() =>
              attachRun(opened.harness, opened.root.id, context),
            )
            if (attachedRun.status === 'idle') return new Response(null, { status: 204 })
            Deferred.doneUnsafe(attached, Effect.void)
            return createUIMessageStreamResponse({ stream: attachedRun.stream })
          }),
          undefined,
        ),
    })
    const chat = new PlainChat({ transport })
    // PlainChat's existing state starts empty; hydrate through AbstractChat's public setter.
    chat.messages = [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'Build' }] }]
    const resumed = chat.resumeStream()
    yield* Deferred.await(attached)
    Deferred.doneUnsafe(opened.release, Effect.void)
    yield* Effect.promise(() => resumed)
    expect(chat.status).toBe('ready')
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    if (chat.lastMessage === undefined) throw new Error('Expected the resumed message')
    expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Finished.'])
    expect(chat.lastMessage.parts.find((part) => part.type === 'tool-work')).toMatchObject({
      state: 'output-available',
      output: '12 pages',
    })
  }),
)
// AI SDK packages/ai/src/ui/chat.test.ts: should continue an active text part when resuming after a disconnect.
// Replaying a snapshot resets the SDK's retained current step before emitting its durable contents.
it.live('step 1 snapshot reconnect after a network interruption does not duplicate text', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void, FixtureFailed>()
    const release = yield* Deferred.make<void, FixtureFailed>()
    const fixture = yield* host(
      {
        work: tool({
          description: 'Build a report',
          inputSchema: z.object({}),
          execute: () =>
            runForPi(
              Effect.gen(function* () {
                Deferred.doneUnsafe(entered, Effect.void)
                yield* Deferred.await(release)
                return '12 pages'
              }),
              undefined,
            ),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: 'Starting.' }, fauxToolCall('work', {}, { id: 'work' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Finished.'),
    ])
    const attached = yield* Deferred.make<void, FixtureFailed>()
    const transport = new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: (url, init) =>
        runForPi(
          Effect.gen(function* () {
            const request = new Request(url, init)
            if (request.method === 'GET') {
              const response = yield* Effect.promise(() =>
                respond(opened.harness, opened.root.id, request, context),
              )
              Deferred.doneUnsafe(attached, Effect.void)
              return response
            }
            const response = yield* Effect.promise(() =>
              respond(opened.harness, opened.root.id, request, context),
            )
            if (response.body === null) throw new Error('Expected an SSE body')
            const decoder = new TextDecoder()
            // Fault the transport after receiving real text, leaving Pi and its stream translator intact.
            const dropped = response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  if (decoder.decode(chunk).includes('tool-input-available')) {
                    controller.error(new TypeError('network connection lost'))
                    return
                  }
                  controller.enqueue(chunk)
                },
              }),
            )
            return new Response(dropped, { headers: response.headers })
          }),
          undefined,
        ),
    })
    const chat = new PlainChat({ transport: resumable(transport) })
    yield* Effect.gen(function* () {
      yield* Effect.promise(() => chat.sendMessage({ text: 'Build' }))
      yield* Deferred.await(entered)
      expect(chat.status).toBe('error')
      if (chat.lastMessage === undefined) throw new Error('Expected the disconnected message')
      expect(texts(chat.lastMessage)).toEqual(['Starting.'])
      chat.clearError()
      const resumed = chat.resumeStream()
      yield* Deferred.await(attached)
      Deferred.doneUnsafe(release, Effect.void)
      yield* Effect.promise(() => resumed)
      expect(chat.status).toBe('ready')
      expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
      if (chat.lastMessage === undefined) throw new Error('Expected the resumed message')
      expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Finished.'])
      expect(chat.lastMessage.parts.filter((part) => part.type === 'step-start')).toHaveLength(2)
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          Deferred.doneUnsafe(release, Effect.void)
          yield* Effect.promise(() => opened.root.waitForIdle(context))
        }),
      ),
    )
  }),
)
// AI SDK packages/ai/src/ui/chat.test.ts: should continue an active text part when resuming after a disconnect.
// The GET receipt opens observation before the held tool is released.
it.live('resumeStream reconnects to an in-progress run through respond', () =>
  Effect.gen(function* () {
    const opened = yield* running()
    const attached = yield* Deferred.make<void, FixtureFailed>()
    const transport = new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: (url, init) =>
        runForPi(
          Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              respond(opened.harness, opened.root.id, new Request(url, init), context),
            )
            Deferred.doneUnsafe(attached, Effect.void)
            return response
          }),
          undefined,
        ),
    })
    const chat = new PlainChat({ transport })
    yield* Effect.gen(function* () {
      const resumed = chat.resumeStream()
      yield* Deferred.await(attached)
      Deferred.doneUnsafe(opened.release, Effect.void)
      yield* Effect.promise(() => resumed)
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          Deferred.doneUnsafe(opened.release, Effect.void)
          yield* Effect.promise(() => opened.root.waitForIdle(context))
        }),
      ),
    )
    expect(chat.status).toBe('ready')
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    if (chat.lastMessage === undefined) throw new Error('Expected the resumed message')
    expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Finished.'])
  }),
)
// AI SDK packages/ai/src/ui/chat.test.ts: should not copy the previous assistant message when resuming a stream (reconnectToStream transport seam).
// The Promise handler serves the bodyless GET through the public attachment seam.
it.live('reconnectToStream returns the in-progress run through respond', () =>
  Effect.gen(function* () {
    const opened = yield* running()
    yield* Effect.gen(function* () {
      const stream = yield* Effect.promise(() =>
        opened.transport.reconnectToStream({
          chatId: 'chat',
          abortSignal: undefined,
        }),
      )
      Deferred.doneUnsafe(opened.release, Effect.void)
      if (stream === null) throw new Error('Expected the in-progress stream')
      const result = yield* consumeReadable(stream, Option.none())
      expect(texts(result.message)).toEqual(['Starting.', 'Finished.'])
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          Deferred.doneUnsafe(opened.release, Effect.void)
          yield* Effect.promise(() => opened.root.waitForIdle(context))
        }),
      ),
    )
  }),
)
// A retained step 2 needs a step-scoped prefix: reset-step cannot remove earlier SDK steps.
it.live.each(['text-end', 'tool-input-start', 'tool-input-available'])(
  'step 2 retained-state reconnect cut at %s preserves earlier text and tools exactly once',
  (cut) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void, FixtureFailed>()
      const release = yield* Deferred.make<void, FixtureFailed>()
      const fixture = yield* host(
        {
          work: tool({
            inputSchema: z.object({}),
            execute: () => runForPi(Effect.succeed('12 pages'), undefined),
          }),
          pause: tool({
            inputSchema: z.object({}),
            execute: () =>
              runForPi(
                Effect.gen(function* () {
                  Deferred.doneUnsafe(entered, Effect.void)
                  yield* Deferred.await(release)
                  return 'continued'
                }),
                undefined,
              ),
          }),
        },
        {},
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        fauxAssistantMessage(
          [{ type: 'text', text: 'Starting.' }, fauxToolCall('work', {}, { id: 'work' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(
          [{ type: 'text', text: 'Fin' }, fauxToolCall('pause', {}, { id: 'pause' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Finished.'),
      ])
      const attached = yield* Deferred.make<void, FixtureFailed>()
      const transport = new DefaultChatTransport<UIMessage>({
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
              if (response.body === null) throw new Error('Expected an SSE body')
              const decoder = new TextDecoder()
              // Fault before closing step 2's text, retaining step 1 and the second partial text.
              let secondText = false
              const dropped = response.body.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    const text = decoder.decode(chunk)
                    if (secondText && text.includes(cut)) {
                      controller.error(new TypeError('network connection lost'))
                      return
                    }
                    if (text.includes('text-delta') && text.includes('"delta":"Fin"'))
                      secondText = true
                    controller.enqueue(chunk)
                  },
                }),
              )
              return new Response(dropped, { headers: response.headers })
            }),
            undefined,
          ),
      })
      const chat = new PlainChat({ transport: resumable(transport) })
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => chat.sendMessage({ text: 'Build in steps' }))
        yield* Deferred.await(entered)
        expect(chat.status).toBe('error')
        if (chat.lastMessage === undefined) throw new Error('Expected the retained message')
        expect(texts(chat.lastMessage)).toEqual(['Starting.', 'Fin'])
        expect(chat.lastMessage.parts.filter((part) => part.type === 'tool-work')).toHaveLength(1)
        const id = chat.lastMessage.id
        chat.clearError()
        const resumed = chat.resumeStream()
        yield* Deferred.await(attached)
        Deferred.doneUnsafe(release, Effect.void)
        yield* Effect.promise(() => resumed)
        expect(chat.status).toBe('ready')
        expect(chat.lastMessage.parts.map((part) => part.type)).toEqual([
          'step-start',
          'text',
          'tool-work',
          'step-start',
          'text',
          'tool-pause',
          'step-start',
          'text',
        ])
        expect(chat.lastMessage.id).toBe(id)
        expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
        expect({
          text: texts(chat.lastMessage),
          tools: chat.lastMessage.parts.filter((part) => part.type === 'tool-work').length,
        }).toEqual({ text: ['Starting.', 'Fin', 'Finished.'], tools: 1 })
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            Deferred.doneUnsafe(release, Effect.void)
            yield* Effect.promise(() => opened.root.waitForIdle(context))
          }),
        ),
      )
    }),
)
