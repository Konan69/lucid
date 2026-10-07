import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
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
import { call, consume, context, host, modelText, texts, signal } from './fixtures/host.ts'

/** Explicitly submit the SDK-owned messages so a repeated settlement really crosses HTTP again. */
async function post(chat: PlainChat, transport: ChatTransport<UIMessage>, message: UIMessage) {
  const stream = await transport.sendMessages({
    chatId: chat.id,
    abortSignal: undefined,
    trigger: 'submit-message',
    messages: chat.messages,
    messageId: message.id,
  })
  return consume(stream, message)
}

for (const kind of ['static', 'dynamic'] as const)
  for (const repeat of [false, true])
    it.live(`settles ${kind} client output-error and repeat=${repeat}`, () =>
      Effect.promise(async () => {
        const definition = { title: 'Account choice', inputSchema: z.object({}) }
        const fixture = await host(
          { ask: kind === 'dynamic' ? dynamicTool(definition) : tool(definition) },
          {},
        )
        const opened = await fixture.open()
        opened.faux.setResponses([
          call('ask', {}, 'ask'),
          (request) => {
            expect(request.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true })
            expect(modelText(request.messages)).toContain('Person could not answer')
            return fauxAssistantMessage('Handled failure.')
          },
        ])
        const chat = new PlainChat({ transport: opened.transport })
        await chat.sendMessage({ text: 'Ask' })
        await chat.addToolOutput({
          state: 'output-error',
          tool: 'ask',
          toolCallId: 'ask',
          errorText: 'Person could not answer',
        })
        if (chat.lastMessage === undefined) throw new Error('Expected SDK message')
        const result = await post(chat, opened.transport, chat.lastMessage)
        expect(texts(result.message)).toEqual(['Handled failure.'])
        expect(result.message.parts.find(isToolUIPart)).toMatchObject({
          type: kind === 'dynamic' ? 'dynamic-tool' : 'tool-ask',
          title: 'Account choice',
          state: 'output-error',
          errorText: expect.stringContaining('Person could not answer'),
        })
        expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
        await opened.root.waitForIdle(context)
        const settled = await opened.harness.snapshot(Holds, opened.root.id, context)
        if (settled === undefined) throw new Error('Expected durable error settlement')
        expect(Object.values(settled.settled)).toHaveLength(1)
        expect(Object.values(settled.settled)[0]).toMatchObject({
          settlement: { kind: 'errored', errorText: 'Person could not answer' },
        })
        if (repeat) {
          await post(chat, opened.transport, chat.lastMessage)
          expect(await opened.harness.snapshot(Holds, opened.root.id, context)).toEqual(settled)
          expect(opened.faux.state.callCount).toBe(2)
        }
        const saved = await history(opened.harness, opened.root.id, { limit: 10 }, context)
        const assistant = saved.messages.at(-1)
        if (assistant === undefined) throw new Error('Expected history')
        expect(assistant.parts.find(isToolUIPart)).toEqual(result.message.parts.find(isToolUIPart))
      }),
    )

for (const kind of ['static', 'dynamic'] as const)
  it.live(`does not settle ${kind} approval as a client error answer`, () =>
    Effect.promise(async () => {
      const definition = { inputSchema: z.object({}), execute: async () => 'paid' }
      const fixture = await host(
        { pay: kind === 'dynamic' ? dynamicTool(definition) : tool(definition) },
        { approval: { pay: true } },
      )
      const opened = await fixture.open()
      opened.faux.setResponses([call('pay', {}, 'pay')])
      const chat = new PlainChat({ transport: opened.transport })
      await chat.sendMessage({ text: 'Pay' })
      const before = await waiting(opened.harness, opened.root.id, context)
      await chat.addToolOutput({
        state: 'output-error',
        tool: 'pay',
        toolCallId: 'pay',
        errorText: 'Not an approval',
      })
      if (chat.lastMessage === undefined) throw new Error('Expected SDK message')
      await post(chat, opened.transport, chat.lastMessage)
      expect(await waiting(opened.harness, opened.root.id, context)).toEqual(before)
      expect(opened.faux.state.callCount).toBe(1)
      const receipts = await opened.harness.snapshot(Holds, opened.root.id, context)
      expect(receipts === undefined ? [] : Object.values(receipts.settled)).toEqual([])
      await abort(opened.harness, opened.root.id, context)
      await opened.root.waitForIdle(context)
    }),
  )

for (const kind of ['static', 'dynamic'] as const)
  it.live(`keeps ${kind} connection-loss error pending until a real answer arrives`, () =>
    Effect.promise(async () => {
      const definition = { inputSchema: z.object({}) }
      const fixture = await host(
        { ask: kind === 'dynamic' ? dynamicTool(definition) : tool(definition) },
        {},
      )
      const opened = await fixture.open()
      opened.faux.setResponses([call('ask', {}, 'ask'), fauxAssistantMessage('Answered.')])
      const chat = new PlainChat({ transport: opened.transport })
      await chat.sendMessage({ text: 'Ask' })
      const before = await waiting(opened.harness, opened.root.id, context)
      await chat.addToolOutput({
        state: 'output-error',
        tool: 'ask',
        toolCallId: 'ask',
        errorText: connectionLostInput,
      })
      if (chat.lastMessage === undefined) throw new Error('Expected SDK message')
      await post(chat, opened.transport, chat.lastMessage)
      expect(await waiting(opened.harness, opened.root.id, context)).toEqual(before)
      expect(opened.faux.state.callCount).toBe(1)
      const receipts = await opened.harness.snapshot(Holds, opened.root.id, context)
      expect(receipts === undefined ? [] : Object.values(receipts.settled)).toEqual([])
      await chat.addToolOutput({ tool: 'ask', toolCallId: 'ask', output: 'Savings' })
      if (chat.lastMessage === undefined) throw new Error('Expected answer message')
      const result = await post(chat, opened.transport, chat.lastMessage)
      expect(texts(result.message)).toEqual(['Answered.'])
      expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
    }),
  )

/** Similar text is a real client error; only byte-for-byte equality reserves the transport marker. */
for (const errorText of [connectionLostInput.toUpperCase(), `${connectionLostInput} (person)`])
  it.live(`settles a non-reserved diagnostic ${errorText}`, () =>
    Effect.promise(async () => {
      const fixture = await host({ ask: tool({ inputSchema: z.object({}) }) }, {})
      const opened = await fixture.open()
      opened.faux.setResponses([
        call('ask', {}, 'ask'),
        (request) => {
          expect(request.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true })
          expect(modelText(request.messages)).toContain(errorText)
          return fauxAssistantMessage('Handled.')
        },
      ])
      const chat = new PlainChat({ transport: opened.transport })
      await chat.sendMessage({ text: 'Ask' })
      await chat.addToolOutput({ state: 'output-error', tool: 'ask', toolCallId: 'ask', errorText })
      if (chat.lastMessage === undefined) throw new Error('Expected SDK message')
      expect(texts((await post(chat, opened.transport, chat.lastMessage)).message)).toEqual([
        'Handled.',
      ])
      expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
    }),
  )

/** The SDK's ordinary automatic completion predicate treats output-error as a finished tool call. */
it.live('automatically resumes stock Chat after a client tool error', () =>
  Effect.promise(async () => {
    const fixture = await host({ ask: tool({ inputSchema: z.object({}) }) }, {})
    const opened = await fixture.open()
    opened.faux.setResponses([call('ask', {}, 'ask'), fauxAssistantMessage('Handled.')])
    const finished = signal()
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onFinish: () => {
        if (opened.faux.state.callCount === 2) finished.resolve()
      },
      onError: (error) => finished.reject(error),
    })
    await chat.sendMessage({ text: 'Ask' })
    await chat.addToolOutput({
      state: 'output-error',
      tool: 'ask',
      toolCallId: 'ask',
      errorText: 'Person unavailable',
    })
    await finished.promise
    expect(chat.status).toBe('ready')
    if (chat.lastMessage === undefined) throw new Error('Expected final SDK message')
    expect(texts(chat.lastMessage)).toEqual(['Handled.'])
    expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  }),
)

/** A corrupt durable receipt is an authority failure, not an untyped Effect defect. */
it.live('reports a missing late-answer receipt through waiting as a typed failure', () =>
  Effect.promise(async () => {
    const fixture = await host(
      { ask: tool({ inputSchema: z.object({}) }) },
      { answers: { ask: 'later' } },
    )
    const opened = await fixture.open()
    opened.faux.setResponses([call('ask', {}, 'ask'), fauxAssistantMessage('Asked.')])
    const chat = new PlainChat({ transport: opened.transport })
    await chat.sendMessage({ text: 'Ask' })
    await opened.root.waitForIdle(context)
    const rows = await waiting(opened.harness, opened.root.id, context)
    const held = rows[0]
    if (held === undefined) throw new Error('Expected question')
    const other = await host({}, {})
    const foreign = await other.open()
    foreign.faux.setResponses([fauxAssistantMessage('One.'), fauxAssistantMessage('Two.')])
    await foreign.root.submit({ type: 'input', content: 'One' }, context)
    await foreign.root.waitForIdle(context)
    const absent = await foreign.root.submit({ type: 'input', content: 'Two' }, context)
    await foreign.root.waitForIdle(context)
    expect(await opened.harness.submission(absent.id, context)).toBeUndefined()
    await opened.root.commit(async (tx) => {
      const document = await tx.doc(Holds, opened.root.id)
      const question = document.asked[held.holdId]
      if (question === undefined) throw new Error('Expected retained question')
      question.delivery = Delivery.cases.Submitted.make({
        attempt: 0,
        output: 'retained',
        submissionId: absent.id,
      })
    }, context)
    const failed = waiting(opened.harness, opened.root.id, context)
    await expect(failed).rejects.toBeInstanceOf(PiFailed)
    await expect(failed).rejects.toMatchObject({
      operation: 'submission',
      message: expect.stringContaining('Recorded answer submission is missing'),
    })
  }),
)
