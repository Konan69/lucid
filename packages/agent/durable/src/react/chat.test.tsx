// @vitest-environment jsdom
import * as NodeEvents from 'node:events'
import { Effect, type Scope } from 'effect'
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
import { expect, it } from '@effect/vitest'
import { context, shop, texts } from '../conformance/fixtures/host.ts'
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
    fetch: (url, init) =>
      respond(harness, conversationId, new Request(url, { ...init, signal: null }), context),
  })
}
type Mounted = {
  /** The chat the hook is subscribed to. */
  readonly chat: () => Chat
  /** Do `action` and wait until the response stream it causes has finished: the hook's `onFinish`. */
  readonly until: (action: (chat: Chat) => void | PromiseLike<void>) => Effect.Effect<void>
  /** Wait for the stream the mount itself opened (`resume`). */
  readonly resumed: () => Effect.Effect<void>
  /** What the component rendered. */
  readonly text: () => string
}
/**
 * Mount a component that uses the stock `useChat` hook and renders its text parts.
 *
 * The test waits on `onFinish`, the hook's own signal that a stream ended, never on a clock.
 * React's `act` takes a callback that returns a thenable and flushes updates until it settles, so
 * the wait must be a native Promise made inside that callback: `events.once` on an emitter that
 * `onFinish` fires gives one for the next finish, with no hand-built Promise and no second runtime.
 *
 * The unmount is a finalizer of the case's scope. The fixture's harness is acquired earlier in the
 * same scope and scopes release in reverse order, so the hook is gone before its harness closes.
 */
function mount(options: {
  readonly transport: DefaultChatTransport<UIMessage>
  /** What the page starts with: nothing for a new chat, the loaded history for a reload. */
  readonly messages: UIMessage[]
  /** Reconnect on mount to the run in progress, as a reloaded page does. */
  readonly resume: boolean
}): Effect.Effect<Mounted, never, Scope.Scope> {
  return Effect.gen(function* () {
    const finished = new NodeEvents.EventEmitter()
    /** Settles at the next `onFinish` after this call; register it before causing the stream. */
    const nextFinish = () => NodeEvents.EventEmitter.once(finished, 'finish').then(() => {})
    // The chat state lives outside the component, as in an app that shares one chat between
    // components; the hook subscribes to it and owns the reconnect on mount.
    const state = new ChatState<UIMessage>({
      id: 'thread',
      transport: options.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
      onFinish: () => {
        finished.emit('finish')
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
    const { container, root } = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const element = document.createElement('div')
        document.body.append(element)
        return { container: element, root: createRoot(element) }
      }),
      (mounted) =>
        Effect.promise(() =>
          Promise.resolve(
            act(() => {
              mounted.root.unmount()
            }),
          ),
        ).pipe(Effect.andThen(Effect.sync(() => mounted.container.remove()))),
    )
    const opening = nextFinish()
    yield* Effect.promise(() =>
      Promise.resolve(
        act(() => {
          root.render(<Probe />)
        }),
      ),
    )
    return {
      chat: () => state,
      // One `act` per step: React does not support overlapping ones.
      until: (action) =>
        Effect.promise(() =>
          Promise.resolve(
            act(() => {
              const pending = nextFinish()
              return Promise.resolve(action(state)).then(() => pending)
            }),
          ),
        ),
      resumed: () => Effect.promise(() => Promise.resolve(act(() => opening))),
      text: () =>
        [...container.querySelectorAll('li')]
          .map((item) => `${item.dataset['role']}: ${item.textContent}`)
          .join('\n'),
    }
  })
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
it.live('useChat streams a durable run into one rendered assistant message', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([fauxAssistantMessage('Hello from Pi.')])
    const mounted = yield* mount({
      transport: transport(opened.harness, opened.root.id),
      messages: [],
      resume: false,
    })
    yield* mounted.until((chat) => chat.sendMessage({ text: 'Hi' }))
    expect(mounted.chat().status).toBe('ready')
    expect(mounted.text()).toBe('user: Hi\nassistant: Hello from Pi.')
  }),
)
it.live('useChat approves a held tool from the message part and the run continues by itself', () =>
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
    const mounted = yield* mount({
      transport: transport(opened.harness, opened.root.id),
      messages: [],
      resume: false,
    })
    yield* mounted.until((chat) => chat.sendMessage({ text: 'Pay the invoice' }))
    // The stream finished because the run waits for a person; the tool has not run.
    expect(fixture.paid).toEqual([])
    const held = heldPay(mounted.chat())
    // An app does exactly this: the id comes from the part, and the hook resubmits on its own.
    yield* mounted.until((chat) =>
      chat.addToolApprovalResponse({ id: held.approval.id, approved: true }),
    )
    expect(fixture.paid).toEqual([500])
    expect(mounted.chat().status).toBe('ready')
    expect(mounted.text()).toBe('user: Pay the invoice\nassistant: Checking. | Paid.')
  }),
)
it.live('a reloaded page shows history and resumes the run that waits for approval', () =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage(
        [{ type: 'text', text: 'Checking.' }, fauxToolCall('pay', { amount: 70 }, { id: 'pay' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Paid.'),
    ])
    const first = yield* mount({
      transport: transport(opened.harness, opened.root.id),
      messages: [],
      resume: false,
    })
    yield* first.until((chat) => chat.sendMessage({ text: 'Pay 70' }))
    // The reload: a new page loads the settled transcript, then `resume` reconnects to the run.
    const page = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 50 }, context),
    )
    const reloaded = yield* mount({
      transport: transport(opened.harness, opened.root.id),
      messages: [...page.messages],
      resume: true,
    })
    yield* reloaded.resumed()
    expect(reloaded.text()).toBe('user: Pay 70\nassistant: Checking.')
    const held = heldPay(reloaded.chat())
    yield* reloaded.until((chat) =>
      chat.addToolApprovalResponse({ id: held.approval.id, approved: true }),
    )
    expect(fixture.paid).toEqual([70])
    expect(reloaded.text()).toBe('user: Pay 70\nassistant: Checking. | Paid.')
  }),
)
