// A chat client with the AI SDK's own logic and no React. `useChat` is this class plus a React
// store: `@ai-sdk/react`'s `Chat` extends `AbstractChat` the same way, so a test that drives this
// drives the request, stream reading, approval and resubmission code a `useChat` app runs.
import { Deferred, Effect, Predicate, Schema } from 'effect'
import { FixtureFailed } from './harness.ts'
import {
  DefaultChatTransport,
  type ChatTransport,
  AbstractChat,
  type ChatInit,
  type ChatState,
  type ChatStatus,
  type UIMessage,
} from 'ai'

class PlainState implements ChatState<UIMessage> {
  readonly onMessage: (message: UIMessage) => void

  /** Publish actual SDK store writes for deterministic tests of in-flight message states. */
  constructor(onMessage: (message: UIMessage) => void) {
    this.onMessage = onMessage
  }

  status: ChatStatus = 'ready'
  error: ChatState<UIMessage>['error'] = undefined
  messages: UIMessage[] = []
  pushMessage = (message: UIMessage) => {
    this.messages = [...this.messages, message]
    this.onMessage(message)
  }
  popMessage = () => {
    this.messages = this.messages.slice(0, -1)
  }
  replaceMessage = (index: number, message: UIMessage) => {
    this.messages = [
      ...this.messages.slice(0, index),
      structuredClone(message),
      ...this.messages.slice(index + 1),
    ]
    this.onMessage(message)
  }
  snapshot = <T>(thing: T): T => structuredClone(thing)
}

export class PlainChat extends AbstractChat<UIMessage> {
  constructor(init: ChatInit<UIMessage> & { readonly onMessage?: (message: UIMessage) => void }) {
    const { onMessage = () => {}, ...chat } = init
    super({ ...chat, state: new PlainState(onMessage) })
  }
}

/** The response is finished only after stock Chat decides whether to automatically POST again. */
export const Decision = Schema.TaggedUnion({ Settled: {}, Resending: {} })
export type Decision = typeof Decision.Type

type ClientInit = Omit<ChatInit<UIMessage>, 'transport' | 'onFinish' | 'onError'> & {
  readonly onMessage?: (message: UIMessage) => void
} & ({ readonly fetch: typeof globalThis.fetch } | { readonly transport: ChatTransport<UIMessage> })

/**
 * AI SDK 7.0.127 ui/chat.ts:1034–1063 calls onFinish before its automatic-send predicate.
 * Observe that decision, not onFinish's earlier callback. Calls made by addToolOutput or
 * addToolApprovalResponse before a request pass through without settling the response wait.
 * Arm next() before the action; each wait observes one response, including intermediate resends.
 * A supplied fetch counts actual POSTs; custom transports retain their public extension points.
 */
export function client(init: ClientInit) {
  let completion = Deferred.makeUnsafe<Decision, FixtureFailed>()
  let awaitingDecision = false
  let posts = 0
  const predicate = init.sendAutomaticallyWhen
  const transport =
    'fetch' in init
      ? new DefaultChatTransport<UIMessage>({
          api: 'http://durable.test/chat',
          fetch: (url, options) => {
            if (new Request(url, options).method === 'POST') posts++
            return init.fetch(url, options)
          },
        })
      : init.transport
  /** Capture this response's wait before an asynchronous host predicate can settle. */
  const decide = (input: { messages: UIMessage[] }) => {
    if (predicate === undefined) return false
    if (!awaitingDecision) return predicate(input)
    awaitingDecision = false
    const pending = completion
    const result = predicate(input)
    const settle = (resending: boolean) => {
      const decision = resending
        ? Decision.cases.Resending.make({})
        : Decision.cases.Settled.make({})
      Deferred.doneUnsafe(pending, Effect.succeed(decision))
      return resending
    }
    return Predicate.isBoolean(result) ? settle(result) : Promise.resolve(result).then(settle)
  }
  const chat = new PlainChat({
    ...init,
    transport,
    sendAutomaticallyWhen: predicate === undefined ? undefined : decide,
    onFinish: ({ isError }) => {
      if (isError) return
      if (predicate === undefined)
        Deferred.doneUnsafe(completion, Effect.succeed(Decision.cases.Settled.make({})))
      else awaitingDecision = true
    },
    onError: (cause) => {
      awaitingDecision = false
      Deferred.doneUnsafe(completion, Effect.fail(new FixtureFailed({ cause })))
    },
  })
  return {
    chat,
    /** Reset eagerly so SDK callbacks cannot race the Effect's evaluation. */
    next: () => {
      completion = Deferred.makeUnsafe<Decision, FixtureFailed>()
      return Deferred.await(completion)
    },
    get posts() {
      return posts
    },
  }
}
