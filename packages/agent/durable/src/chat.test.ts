import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  tool,
  type UIMessage,
} from 'ai'
import { expect, it } from 'vitest'
import { z } from 'zod'

import { PlainChat } from './fixtures/chat.ts'
import { respond } from './respond.ts'
import { toolsExtension } from './tools.ts'

const context = BACKGROUND_CONTEXT

/** A harness with one approval tool and one person-answered tool, behind the HTTP handler. */
async function server(paid: unknown[]) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(
    await toolsExtension(
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
  )
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  // The unmodified transport `useChat` uses by default, with fetch routed to the handler.
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) => respond(harness, root.id, new Request(url, init), context),
  })
  return { faux, harness, transport }
}

/** A client whose `finished()` resolves at the end of the next response it receives. */
function client(
  transport: DefaultChatTransport<UIMessage>,
  sendAutomaticallyWhen: (options: { messages: UIMessage[] }) => boolean,
) {
  const waiters: (() => void)[] = []
  const chat = new PlainChat({
    transport,
    sendAutomaticallyWhen,
    onFinish: () => {
      waiters.shift()?.()
    },
  })
  const finished = () => new Promise<void>((resolve) => waiters.push(resolve))
  return { chat, finished }
}

const lastText = (messages: readonly Message[]) => {
  const last = messages.at(-1)
  if (last === undefined) return ''
  return typeof last.content === 'string'
    ? last.content
    : last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

it('lets an AI SDK chat client approve a call and continues the same message', async () => {
  const paid: unknown[] = []
  const { faux, harness, transport } = await server(paid)
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('pay', { amount: 500 }, { id: 'call-pay' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Paid.'),
  ])
  const { chat, finished } = client(transport, lastAssistantMessageIsCompleteWithApprovalResponses)

  await chat.sendMessage({ text: 'Pay the invoice' })
  expect(chat.status).toBe('ready')
  expect(chat.messages.at(-1)?.parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'approval-requested',
  })
  expect(paid).toEqual([])

  // What an Approve button does. The client resubmits by itself and reads the continuation.
  const continued = finished()
  await chat.addToolApprovalResponse({ id: 'call-pay', approved: true })
  await continued

  expect(paid).toEqual([{ amount: 500 }])
  expect(chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  const parts = chat.messages.at(-1)?.parts ?? []
  expect(parts.find((part) => part.type === 'tool-pay')).toMatchObject({
    state: 'output-available',
    output: { receipt: 'paid 500' },
  })
  expect(parts.filter((part) => part.type === 'text')).toEqual([
    expect.objectContaining({ text: 'Paid.' }),
  ])
  await harness.close(context)
})

it('lets an AI SDK chat client answer a tool that has no server execute', async () => {
  const { faux, harness, transport } = await server([])
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

  await chat.sendMessage({ text: 'Pay the invoice' })
  expect(chat.messages.at(-1)?.parts.find((part) => part.type === 'tool-ask_person')).toMatchObject(
    {
      state: 'input-available',
      input: { question: 'Which account?' },
    },
  )

  const continued = finished()
  await chat.addToolOutput({ tool: 'ask_person', toolCallId: 'call-ask', output: 'savings' })
  await continued

  const parts = chat.messages.at(-1)?.parts ?? []
  expect(parts.find((part) => part.type === 'tool-ask_person')).toMatchObject({
    state: 'output-available',
    output: 'savings',
  })
  expect(parts.filter((part) => part.type === 'text')).toEqual([
    expect.objectContaining({ text: 'Using savings.' }),
  ])
  await harness.close(context)
})
