import { Deferred, Effect, Option } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { runForPi } from '../pi.ts'
import { expect, it } from '@effect/vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  dynamicTool,
  isToolUIPart,
  tool,
  type UIMessage,
  type ChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { abort, history, waiting } from '../main.ts'
import { PiFailed } from '../errors.ts'
import { Delivery } from '../delivery.ts'
import { Holds } from '../holds.ts'
import { connectionLostInput } from '../client.ts'
import { call, context, host, modelText, texts } from './fixtures/host.ts'
/** Explicitly submit the SDK-owned messages so a repeated settlement really crosses HTTP again. */
const post = Effect.fn('Test.post')(function* (
  chat: PlainChat,
  transport: ChatTransport<UIMessage>,
  message: UIMessage,
) {
  const stream = yield* Effect.promise(() =>
    transport.sendMessages({
      chatId: chat.id,
      abortSignal: undefined,
      trigger: 'submit-message',
      messages: chat.messages,
      messageId: message.id,
    }),
  )
  return yield* consumeReadable(stream, Option.some(message))
})
for (const kind of ['static', 'dynamic'] as const)
  for (const repeat of [false, true])
    it.live(`settles ${kind} client output-error and repeat=${repeat}`, () =>
      Effect.gen(function* () {
        const definition = { title: 'Account choice', inputSchema: z.object({}) }
        const fixture = yield* host(
          { ask: kind === 'dynamic' ? dynamicTool(definition) : tool(definition) },
          {},
        )
        const opened = yield* fixture.open()
        opened.faux.setResponses([
          call('ask', {}, 'ask'),
          (request) => {
            expect(request.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true })
            expect(modelText(request.messages)).toContain('Person could not answer')
            return fauxAssistantMessage('Handled failure.')
          },
        ])
        const chat = new PlainChat({ transport: opened.transport })
        yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))
        yield* Effect.promise(() =>
          Promise.resolve(
            chat.addToolOutput({
              state: 'output-error',
              tool: 'ask',
              toolCallId: 'ask',
              errorText: 'Person could not answer',
            }),
          ),
        )
        if (chat.lastMessage === undefined) throw new Error('Expected SDK message')
        const result = yield* post(chat, opened.transport, chat.lastMessage)
        expect(texts(result.message)).toEqual(['Handled failure.'])
        expect(result.message.parts.find(isToolUIPart)).toMatchObject({
          type: kind === 'dynamic' ? 'dynamic-tool' : 'tool-ask',
          title: 'Account choice',
          state: 'output-error',
          errorText: expect.stringContaining('Person could not answer'),
        })
        expect(
          yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context)),
        ).toEqual([])
        yield* Effect.promise(() => opened.root.waitForIdle(context))
        const settled = yield* Effect.promise(() =>
          opened.harness.snapshot(Holds, opened.root.id, context),
        )
        if (settled === undefined) throw new Error('Expected durable error settlement')
        expect(Object.values(settled.settled)).toHaveLength(1)
        expect(Object.values(settled.settled)[0]).toMatchObject({
          settlement: { kind: 'errored', errorText: 'Person could not answer' },
        })
        if (repeat) {
          yield* post(chat, opened.transport, chat.lastMessage)
          expect(
            yield* Effect.promise(() => opened.harness.snapshot(Holds, opened.root.id, context)),
          ).toEqual(settled)
          expect(opened.faux.state.callCount).toBe(2)
        }
        const saved = yield* Effect.promise(() =>
          history(opened.harness, opened.root.id, { limit: 10 }, context),
        )
        const assistant = saved.messages.at(-1)
        if (assistant === undefined) throw new Error('Expected history')
        expect(assistant.parts.find(isToolUIPart)).toEqual(result.message.parts.find(isToolUIPart))
      }),
    )
for (const kind of ['static', 'dynamic'] as const)
  it.live(`does not settle ${kind} approval as a client error answer`, () =>
    Effect.gen(function* () {
      const definition = {
        inputSchema: z.object({}),
        execute: () => runForPi(Effect.succeed('paid'), undefined),
      }
      const fixture = yield* host(
        { pay: kind === 'dynamic' ? dynamicTool(definition) : tool(definition) },
        { approval: { pay: true } },
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([call('pay', {}, 'pay')])
      const chat = new PlainChat({ transport: opened.transport })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
      const before = yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))
      yield* Effect.promise(() =>
        Promise.resolve(
          chat.addToolOutput({
            state: 'output-error',
            tool: 'pay',
            toolCallId: 'pay',
            errorText: 'Not an approval',
          }),
        ),
      )
      if (chat.lastMessage === undefined) throw new Error('Expected SDK message')
      yield* post(chat, opened.transport, chat.lastMessage)
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        before,
      )
      expect(opened.faux.state.callCount).toBe(1)
      const receipts = yield* Effect.promise(() =>
        opened.harness.snapshot(Holds, opened.root.id, context),
      )
      expect(receipts === undefined ? [] : Object.values(receipts.settled)).toEqual([])
      yield* Effect.promise(() => abort(opened.harness, opened.root.id, context))
      yield* Effect.promise(() => opened.root.waitForIdle(context))
    }),
  )
for (const kind of ['static', 'dynamic'] as const)
  it.live(`keeps ${kind} connection-loss error pending until a real answer arrives`, () =>
    Effect.gen(function* () {
      const definition = { inputSchema: z.object({}) }
      const fixture = yield* host(
        { ask: kind === 'dynamic' ? dynamicTool(definition) : tool(definition) },
        {},
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([call('ask', {}, 'ask'), fauxAssistantMessage('Answered.')])
      const chat = new PlainChat({ transport: opened.transport })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))
      const before = yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))
      yield* Effect.promise(() =>
        Promise.resolve(
          chat.addToolOutput({
            state: 'output-error',
            tool: 'ask',
            toolCallId: 'ask',
            errorText: connectionLostInput,
          }),
        ),
      )
      if (chat.lastMessage === undefined) throw new Error('Expected SDK message')
      yield* post(chat, opened.transport, chat.lastMessage)
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        before,
      )
      expect(opened.faux.state.callCount).toBe(1)
      const receipts = yield* Effect.promise(() =>
        opened.harness.snapshot(Holds, opened.root.id, context),
      )
      expect(receipts === undefined ? [] : Object.values(receipts.settled)).toEqual([])
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'Savings' })),
      )
      if (chat.lastMessage === undefined) throw new Error('Expected answer message')
      const result = yield* post(chat, opened.transport, chat.lastMessage)
      expect(texts(result.message)).toEqual(['Answered.'])
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        [],
      )
    }),
  )
/** Similar text is a real client error; only byte-for-byte equality reserves the transport marker. */
for (const errorText of [connectionLostInput.toUpperCase(), `${connectionLostInput} (person)`])
  it.live(`settles a non-reserved diagnostic ${errorText}`, () =>
    Effect.gen(function* () {
      const fixture = yield* host({ ask: tool({ inputSchema: z.object({}) }) }, {})
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        call('ask', {}, 'ask'),
        (request) => {
          expect(request.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true })
          expect(modelText(request.messages)).toContain(errorText)
          return fauxAssistantMessage('Handled.')
        },
      ])
      const chat = new PlainChat({ transport: opened.transport })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))
      yield* Effect.promise(() =>
        Promise.resolve(
          chat.addToolOutput({ state: 'output-error', tool: 'ask', toolCallId: 'ask', errorText }),
        ),
      )
      if (chat.lastMessage === undefined) throw new Error('Expected SDK message')
      expect(texts((yield* post(chat, opened.transport, chat.lastMessage)).message)).toEqual([
        'Handled.',
      ])
      expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
        [],
      )
    }),
  )
/** The SDK's ordinary automatic completion predicate treats output-error as a finished tool call. */
it.live('automatically resumes stock Chat after a client tool error', () =>
  Effect.gen(function* () {
    const fixture = yield* host({ ask: tool({ inputSchema: z.object({}) }) }, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('ask', {}, 'ask'), fauxAssistantMessage('Handled.')])
    const finished = yield* Deferred.make<void, FixtureFailed>()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onFinish: () => {
        if (opened.faux.state.callCount === 2) Deferred.doneUnsafe(finished, Effect.void)
      },
      onError: (error) =>
        Deferred.doneUnsafe(finished, Effect.fail(new FixtureFailed({ cause: error }))),
    })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))
    yield* Effect.promise(() =>
      Promise.resolve(
        chat.addToolOutput({
          state: 'output-error',
          tool: 'ask',
          toolCallId: 'ask',
          errorText: 'Person unavailable',
        }),
      ),
    )
    yield* Deferred.await(finished)
    expect(chat.status).toBe('ready')
    if (chat.lastMessage === undefined) throw new Error('Expected final SDK message')
    expect(texts(chat.lastMessage)).toEqual(['Handled.'])
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)
/** A corrupt durable receipt is an authority failure, not an untyped Effect defect. */
it.live('reports a missing late-answer receipt through waiting as a typed failure', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      { ask: tool({ inputSchema: z.object({}) }) },
      { answers: { ask: 'later' } },
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('ask', {}, 'ask'), fauxAssistantMessage('Asked.')])
    const chat = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Ask' }))
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const rows = yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))
    const held = rows[0]
    if (held === undefined) throw new Error('Expected question')
    const other = yield* host({}, {})
    const foreign = yield* other.open()
    foreign.faux.setResponses([fauxAssistantMessage('One.'), fauxAssistantMessage('Two.')])
    yield* Effect.promise(() => foreign.root.submit({ type: 'input', content: 'One' }, context))
    yield* Effect.promise(() => foreign.root.waitForIdle(context))
    const absent = yield* Effect.promise(() =>
      foreign.root.submit({ type: 'input', content: 'Two' }, context),
    )
    yield* Effect.promise(() => foreign.root.waitForIdle(context))
    expect(
      yield* Effect.promise(() => opened.harness.submission(absent.id, context)),
    ).toBeUndefined()
    yield* Effect.promise(() =>
      opened.root.commit(
        (tx) =>
          runForPi(
            Effect.gen(function* () {
              const document = yield* Effect.promise(() => tx.doc(Holds, opened.root.id))
              const question = document.asked[held.holdId]
              if (question === undefined) throw new Error('Expected retained question')
              question.delivery = Delivery.cases.Submitted.make({
                attempt: 0,
                output: 'retained',
                submissionId: absent.id,
              })
            }),
            undefined,
          ),
        context,
      ),
    )
    const failed = waiting(opened.harness, opened.root.id, context)
    const rejection1 = yield* Effect.tryPromise({
      try: () => failed,
      catch: (cause) => new FixtureFailed({ cause }),
    }).pipe(Effect.flip)
    expect(rejection1.cause).toBeInstanceOf(PiFailed)
    const rejection2 = yield* Effect.tryPromise({
      try: () => failed,
      catch: (cause) => new FixtureFailed({ cause }),
    }).pipe(Effect.flip)
    expect(rejection2.cause).toMatchObject({
      operation: 'submission',
      message: expect.stringContaining('Recorded answer submission is missing'),
    })
  }),
)
