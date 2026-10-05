import * as NodeEvents from 'node:events'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry } from '@earendil-works/pi-durable'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
} from 'ai'
import { expect, it } from '@effect/vitest'
import { Array as Arr, Effect, Option, Predicate } from 'effect'
import { z } from 'zod'

import { PlainChat } from './fixtures/chat.ts'
import { respond } from './main.ts'
import {
  decodeTurn,
  respondTurn,
  TurnInvalid,
  toolsExtension,
  ConversationMissing,
  decide,
  attachRun,
  waiting,
  streamRun,
  RunMissing,
  continueRun,
} from './main.ts'
import { memory } from './fixtures/harness.ts'
import { read } from './fixtures/reading.ts'

const context = BACKGROUND_CONTEXT

/** A harness with one approval tool and one person-answered tool, behind the HTTP handler. */
const server = Effect.fn('Test.promiseServer')(function* (paid: { amount: number }[]) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(
    yield* Effect.promise(() =>
      toolsExtension(
        'shop',
        {
          pay: tool({
            description: 'Pay an invoice',
            inputSchema: z.object({ amount: z.number() }),
            execute: async (input) => {
              paid.push(input)
              return { receipt: `paid ${input.amount}` }
            },
          }),
          ask_person: tool({
            description: 'Ask the person',
            inputSchema: z.object({ question: z.string() }),
          }),
        },
        { approval: { pay: true } },
      ),
    ),
  )
  const harness = yield* memory(models, registry)
  const root = yield* Effect.promise(() =>
    harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    }),
  )
  // The unmodified transport `useChat` uses by default, with fetch routed to the handler.
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => respond(harness, root.id, new Request(url, init), context),
  })
  return { faux, harness, transport, root }
})

/** A client whose `finished()` resolves at the end of the next response it receives. */
function client(
  transport: DefaultChatTransport<UIMessage>,
  sendAutomaticallyWhen: (options: { messages: UIMessage[] }) => boolean,
) {
  const events = new NodeEvents.EventEmitter()
  const chat = new PlainChat({
    transport,
    sendAutomaticallyWhen,
    onFinish: () => events.emit('finished'),
    onError: (error) => events.emit('error', error),
  })
  const finished = () => NodeEvents.EventEmitter.once(events, 'finished')
  return { chat, finished }
}

const lastText = (messages: readonly Message[]) => {
  const last = Option.getOrThrow(Arr.last(messages))
  return Predicate.isString(last.content)
    ? last.content
    : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

it.live('lets an AI SDK chat client approve a call and continues the same message', () =>
  Effect.gen(function* () {
    const paid: { amount: number }[] = []
    const { faux, transport } = yield* server(paid)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', { amount: 500 }, { id: 'call-pay' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Paid.'),
    ])
    const { chat, finished } = client(
      transport,
      lastAssistantMessageIsCompleteWithApprovalResponses,
    )

    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay the invoice' }))
    expect(chat.status).toBe('ready')
    expect(
      Option.getOrThrow(Arr.last(chat.messages)).parts.find((part) => part.type === 'tool-pay'),
    ).toMatchObject({
      state: 'approval-requested',
    })
    expect(paid).toEqual([])

    // What an Approve button does. The client resubmits by itself and reads the continuation.
    const continued = finished()
    yield* Effect.promise(async () =>
      chat.addToolApprovalResponse({ id: 'call-pay', approved: true }),
    )
    yield* Effect.promise(() => continued)

    expect(paid).toEqual([{ amount: 500 }])
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    const parts = Option.getOrThrow(Arr.last(chat.messages)).parts
    expect(parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'output-available',
      output: { receipt: 'paid 500' },
    })
    expect(parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'Paid.' }),
    ])
  }),
)

it.live('lets an AI SDK chat client answer a tool that has no server execute', () =>
  Effect.gen(function* () {
    const { faux, transport } = yield* server([])
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('ask_person', { question: 'Which account?' }, { id: 'call-ask' })],
        {
          stopReason: 'toolUse',
        },
      ),
      (request) => fauxAssistantMessage(`Using ${lastText(request.messages)}.`),
    ])
    const { chat, finished } = client(transport, lastAssistantMessageIsCompleteWithToolCalls)

    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay the invoice' }))
    expect(
      Option.getOrThrow(Arr.last(chat.messages)).parts.find(
        (part) => part.type === 'tool-ask_person',
      ),
    ).toMatchObject({
      state: 'input-available',
      input: { question: 'Which account?' },
    })

    const continued = finished()
    yield* Effect.promise(async () =>
      chat.addToolOutput({ tool: 'ask_person', toolCallId: 'call-ask', output: 'savings' }),
    )
    yield* Effect.promise(() => continued)

    const parts = Option.getOrThrow(Arr.last(chat.messages)).parts
    expect(parts.find((part) => part.type === 'tool-ask_person')).toMatchObject({
      state: 'output-available',
      output: 'savings',
    })
    expect(parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'Using savings.' }),
    ])
  }),
)

/** Direct Promise calls preserve tagged failures; HTTP ingress maps missing conversations to 404. */
it.live('preserves ConversationMissing as the Promise rejection', () =>
  Effect.gen(function* () {
    const owner = yield* memory(createModels(), createRegistry())
    const empty = yield* memory(createModels(), createRegistry())
    const conversation = yield* Effect.promise(() => owner.root(context))
    yield* Effect.promise(() =>
      expect(
        decide(empty, conversation.id, { callId: 'missing', approved: true }, context),
      ).rejects.toBeInstanceOf(ConversationMissing),
    )
    yield* Effect.promise(() =>
      expect(
        streamRun(
          empty,
          { conversationId: conversation.id, content: 'Missing', requestId: 'missing' },
          context,
        ),
      ).rejects.toBeInstanceOf(ConversationMissing),
    )
    const request = new Request('http://durable.test/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', id: 'm1', parts: [{ type: 'text', text: 'Missing' }] }],
      }),
    })
    const post = yield* Effect.promise(() => respond(empty, conversation.id, request, context))
    expect(post.status).toBe(404)
    expect(yield* Effect.promise(() => post.text())).toBe('Conversation not found')
    const get = yield* Effect.promise(() =>
      respond(empty, conversation.id, new Request('http://durable.test/chat'), context),
    )
    expect(get.status).toBe(404)
    expect(yield* Effect.promise(() => get.text())).toBe('Conversation not found')
    const turn = yield* Effect.promise(() =>
      decodeTurn({
        messages: [
          {
            role: 'user',
            id: 'decoded-missing',
            parts: [{ type: 'text', text: 'Missing' }],
          },
        ],
      }),
    )
    expect(
      (yield* Effect.promise(() => respondTurn(empty, conversation.id, turn, context))).status,
    ).toBe(404)
  }),
)

/** Full DefaultChatTransport/AbstractChat text round trip uses the root's Promise HTTP response. */
it.live('answers the default SDK chat transport end to end', () =>
  Effect.gen(function* () {
    const { faux, transport, root } = yield* server([])
    faux.setResponses([fauxAssistantMessage('Paris.')])
    const { chat } = client(transport, () => false)
    yield* Effect.promise(() => chat.sendMessage({ text: 'Capital of France?' }))
    expect(Option.getOrThrow(Arr.last(chat.messages)).parts.at(-1)).toMatchObject({
      type: 'text',
      text: 'Paris.',
      state: 'done',
    })
    const entries = yield* Effect.promise(() => root.entries({}, 10, undefined, context))
    expect([...entries.items].map((entry) => entry.kind)).toContain('pi.user')
  }),
)

/** Attachment distinguishes absence from a parked live run, whose replay leaves the tool held. */
it.live('attaches idle and running conversations through the Promise facade', () =>
  Effect.gen(function* () {
    const { faux, harness, root, transport } = yield* server([])
    expect(yield* Effect.promise(() => attachRun(harness, root.id, context))).toEqual({
      status: 'idle',
    })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', { amount: 500 }, { id: 'call-pay' })], {
        stopReason: 'toolUse',
      }),
    ])
    const { chat } = client(transport, () => false)
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
    const attached = yield* Effect.promise(() => attachRun(harness, root.id, context))
    expect(attached.status).toBe('running')
    if (attached.status === 'idle') throw new Error('Expected a running attachment')
    const message = yield* read(attached.stream, Option.none())
    expect(message.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
      state: 'approval-requested',
    })
    expect(yield* Effect.promise(() => waiting(harness, root.id, context))).toMatchObject([
      { kind: 'approval', callId: 'call-pay' },
    ])
  }),
)

/** Only malformed turns and missing resume runs become HTTP statuses; typed resume failures still reject directly. */
it.live('maps invalid turns to 400 and missing resumes to 409', () =>
  Effect.gen(function* () {
    const { harness, root } = yield* server([])
    const invalid = yield* Effect.promise(() =>
      respond(
        harness,
        root.id,
        new Request('http://durable.test/chat', { method: 'POST', body: '{' }),
        context,
      ),
    )
    expect(invalid.status).toBe(400)
    expect(yield* Effect.promise(() => invalid.text())).toBe(
      'Expected a user message or a message with tool calls',
    )
    const missing = yield* Effect.promise(() =>
      respond(
        harness,
        root.id,
        new Request('http://durable.test/chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'assistant', parts: [{ type: 'tool-pay', toolCallId: 'missing' }] }],
          }),
        }),
        context,
      ),
    )
    expect(missing.status).toBe(409)
    expect(yield* Effect.promise(() => missing.text())).toBe('No run made these tool calls')
    yield* Effect.promise(() =>
      expect(continueRun(harness, root.id, new Set(['missing']), context)).rejects.toBeInstanceOf(
        RunMissing,
      ),
    )
  }),
)

/** Ingress rejects unusable latest messages rather than admitting a run or trusting prior history. */
it.live.each([
  { label: 'missing messages', body: '{}' },
  { label: 'empty transcript', body: '{"messages":[]}' },
  {
    label: 'empty input',
    body: '{"messages":[{"role":"user","id":"m1","parts":[{"type":"text","text":""}]}]}',
  },
  {
    label: 'missing input identity',
    body: '{"messages":[{"role":"user","parts":[{"type":"text","text":"Hello"}]}]}',
  },
  {
    label: 'assistant without calls',
    body: '{"messages":[{"role":"assistant","parts":[{"type":"text","text":"Hello"}]}]}',
  },
])('rejects $label as an invalid HTTP turn', ({ body }) =>
  Effect.gen(function* () {
    const { harness, root } = yield* server([])
    const response = yield* Effect.promise(() =>
      respond(
        harness,
        root.id,
        new Request('http://durable.test/chat', { method: 'POST', body }),
        context,
      ),
    )
    expect(response.status).toBe(400)
    const entries = yield* Effect.promise(() => root.entries({}, 10, undefined, context))
    expect([...entries.items].some((entry) => entry.kind === 'pi.user')).toBe(false)
  }),
)

/** A real consumed Request rejects body reading; the facade refuses it without admitting a run. */
it.live('maps a failed request body read to an invalid HTTP turn', () =>
  Effect.gen(function* () {
    const { harness, root } = yield* server([])
    const request = new Request('http://durable.test/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', id: 'unreadable', parts: [{ type: 'text', text: 'Hello' }] }],
      }),
    })
    yield* Effect.promise(() => request.text())
    const response = yield* Effect.promise(() => respond(harness, root.id, request, context))
    expect(response.status).toBe(400)
    expect(yield* Effect.promise(() => response.text())).toBe(
      'Expected a user message or a message with tool calls',
    )
    const entries = yield* Effect.promise(() => root.entries({}, 10, undefined, context))
    expect([...entries.items].some((entry) => entry.kind === 'pi.user')).toBe(false)
  }),
)

/** The Promise decoder ignores malformed parts and serves the decoded turn through the same core. */
it.live('ignores malformed parts while preserving a valid input turn', () =>
  Effect.gen(function* () {
    const { faux, harness, root } = yield* server([])
    faux.setResponses([fauxAssistantMessage('Decoded.')])
    const turn = yield* Effect.promise(() =>
      decodeTurn({
        messages: [
          {
            role: 'user',
            id: 'decode',
            parts: [null, 7, {}, { type: 4 }, { type: 'text', text: 'Hello' }],
          },
        ],
      }),
    )
    expect(turn).toMatchObject({ text: 'Hello' })
    const response = yield* Effect.promise(() => respondTurn(harness, root.id, turn, context))
    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => response.text())).toContain('Decoded.')
    yield* Effect.promise(() =>
      expect(decodeTurn({ messages: [] })).rejects.toBeInstanceOf(TurnInvalid),
    )
  }),
)

/** Dropping an invalid reason must preserve the approval and unblock the real waiting tool. */
it.live('keeps an approval decision whose reason is not a string', () =>
  Effect.gen(function* () {
    const paid: { amount: number }[] = []
    const { faux, harness, root, transport } = yield* server(paid)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', { amount: 42 }, { id: 'reason' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Paid.'),
    ])
    const { chat } = client(transport, () => false)
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
    const turn = yield* Effect.promise(() =>
      decodeTurn({
        messages: [
          {
            role: 'assistant',
            parts: [
              false,
              {
                type: 'tool-pay',
                toolCallId: 'reason',
                state: 'approval-responded',
                approval: { approved: true, reason: 9 },
              },
            ],
          },
        ],
      }),
    )
    expect(turn).toMatchObject({
      decisions: [{ callId: 'reason', approved: true }],
    })
    expect('decisions' in turn && turn.decisions[0]).not.toHaveProperty('reason')
    const response = yield* Effect.promise(() => respondTurn(harness, root.id, turn, context))
    yield* Effect.promise(() => response.text())
    expect(paid).toEqual([{ amount: 42 }])
  }),
)

/** Stock HttpChatTransport treats the Promise handler's bodyless 204 response as no active stream. */
it.live('returns no active stream for an idle SDK reconnect GET', () =>
  Effect.gen(function* () {
    const { transport } = yield* server([])
    const reconnected = yield* Effect.promise(() =>
      transport.reconnectToStream({ chatId: 'idle', abortSignal: undefined }),
    )
    expect(reconnected).toBeNull()
  }),
)

/** Unsupported methods fail before reading a body or looking up the conversation. */
it.live('accepts only GET and POST at chat ingress', () =>
  Effect.gen(function* () {
    const { harness, root } = yield* server([])
    for (const method of ['HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = yield* Effect.promise(() =>
        respond(harness, root.id, new Request('http://durable.test/chat', { method }), context),
      )
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET, POST')
    }
  }),
)
