// @vitest-environment jsdom
import { Chat as ChatState, useChat } from '@ai-sdk/react'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, onTestFinished } from 'vitest'

import { context, shop, signal, texts } from '../conformance/fixtures/host.ts'
import { history, respond } from '../main.ts'

// React only flushes effects inside `act` when the environment says it is a test.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Chat = ChatState<UIMessage>

/**
 * The transport a browser app would configure, with `fetch` answered in process by `respond`.
 *
 * The request is built without the hook's abort signal: jsdom installs its own `AbortSignal`, which
 * Node's `Request` does not accept. A real browser has one implementation of both.
 */
function transport(harness: Harness, conversationId: ConversationId) {
  return new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: async (url, init) =>
      respond(harness, conversationId, new Request(url, { ...init, signal: null }), context),
  })
}

type Mounted = {
  /** The chat the hook is subscribed to. */
  readonly chat: () => Chat
  /** Do `action` and wait until the response stream it causes has finished: the hook's `onFinish`. */
  readonly until: (action: (chat: Chat) => void | PromiseLike<void>) => Promise<void>
  /** Wait for the stream the mount itself opened (`resume`). */
  readonly resumed: () => Promise<void>
  /** What the component rendered. */
  readonly text: () => string
}

/**
 * Mount a component that uses the stock `useChat` hook and renders its text parts.
 *
 * The test waits on `onFinish`, the hook's own signal that a stream ended, never on a clock.
 */
async function mount(options: {
  readonly transport: DefaultChatTransport<UIMessage>
  /** What the page starts with: nothing for a new chat, the loaded history for a reload. */
  readonly messages: UIMessage[]
  /** Reconnect on mount to the run in progress, as a reloaded page does. */
  readonly resume: boolean
}): Promise<Mounted> {
  let waiter = signal()
  // The chat state lives outside the component, as in an app that shares one chat between
  // components; the hook subscribes to it and owns the reconnect on mount.
  const state = new ChatState<UIMessage>({
    id: 'thread',
    transport: options.transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      const settled = waiter
      waiter = signal()
      settled.resolve()
    },
    messages: options.messages,
  })
  function Probe() {
    const chat = useChat({ chat: state, resume: options.resume })
    return (
      <ol>
        {chat.messages.map((message) => (
          <li key={message.id} data-role={message.role}>
            {texts(message).join(' | ')}
          </li>
        ))}
      </ol>
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  onTestFinished(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
  const opening = waiter.promise
  await act(async () => {
    root.render(<Probe />)
  })
  return {
    chat: () => state,
    // One `act` per step: React does not support overlapping ones.
    until: (action) =>
      act(async () => {
        const pending = waiter.promise
        await action(state)
        await pending
      }),
    resumed: () =>
      act(async () => {
        await opening
      }),
    text: () =>
      [...container.querySelectorAll('li')]
        .map((item) => `${item.dataset['role']}: ${item.textContent}`)
        .join('\n'),
  }
}

/** The `pay` call of the last message, which must be waiting for approval. */
function heldPay(chat: Chat) {
  const last = chat.messages.at(-1)
  if (last === undefined) throw new Error('Expected an assistant message')
  const part = last.parts.find((each) => each.type === 'tool-pay')
  if (part === undefined || part.type !== 'tool-pay' || part.state !== 'approval-requested')
    throw new Error('Expected the pay call to wait for approval')
  return part
}

it('useChat streams a durable run into one rendered assistant message', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([fauxAssistantMessage('Hello from Pi.')])
  const mounted = await mount({
    transport: transport(opened.harness, opened.root.id),
    messages: [],
    resume: false,
  })

  await mounted.until((chat) => chat.sendMessage({ text: 'Hi' }))

  expect(mounted.chat().status).toBe('ready')
  expect(mounted.text()).toBe('user: Hi\nassistant: Hello from Pi.')
})

it('useChat approves a held tool from the message part and the run continues by itself', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [{ type: 'text', text: 'Checking.' }, fauxToolCall('pay', { amount: 500 }, { id: 'pay' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Paid.'),
  ])
  const mounted = await mount({
    transport: transport(opened.harness, opened.root.id),
    messages: [],
    resume: false,
  })

  await mounted.until((chat) => chat.sendMessage({ text: 'Pay the invoice' }))
  // The stream finished because the run waits for a person; the tool has not run.
  expect(fixture.paid).toEqual([])
  const held = heldPay(mounted.chat())

  // An app does exactly this: the id comes from the part, and the hook resubmits on its own.
  await mounted.until((chat) =>
    chat.addToolApprovalResponse({ id: held.approval.id, approved: true }),
  )

  expect(fixture.paid).toEqual([500])
  expect(mounted.chat().status).toBe('ready')
  expect(mounted.text()).toBe('user: Pay the invoice\nassistant: Checking. | Paid.')
})

it('a reloaded page shows history and resumes the run that waits for approval', async () => {
  const fixture = await shop()
  const opened = await fixture.open()
  opened.faux.setResponses([
    fauxAssistantMessage(
      [{ type: 'text', text: 'Checking.' }, fauxToolCall('pay', { amount: 70 }, { id: 'pay' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Paid.'),
  ])
  const first = await mount({
    transport: transport(opened.harness, opened.root.id),
    messages: [],
    resume: false,
  })
  await first.until((chat) => chat.sendMessage({ text: 'Pay 70' }))

  // The reload: a new page loads the settled transcript, then `resume` reconnects to the run.
  const page = await history(opened.harness, opened.root.id, { limit: 50 }, context)
  const reloaded = await mount({
    transport: transport(opened.harness, opened.root.id),
    messages: [...page.messages],
    resume: true,
  })
  await reloaded.resumed()
  expect(reloaded.text()).toBe('user: Pay 70\nassistant: Checking.')
  const held = heldPay(reloaded.chat())

  await reloaded.until((chat) =>
    chat.addToolApprovalResponse({ id: held.approval.id, approved: true }),
  )
  expect(fixture.paid).toEqual([70])
  expect(reloaded.text()).toBe('user: Pay 70\nassistant: Checking. | Paid.')
})
