// A chat client with the AI SDK's own logic and no React. `useChat` is this class plus a React
// store: `@ai-sdk/react`'s `Chat` extends `AbstractChat` the same way, so a test that drives this
// drives the request, stream reading, approval and resubmission code a `useChat` app runs.
import { AbstractChat, type ChatInit, type ChatState, type ChatStatus, type UIMessage } from 'ai'

class PlainState implements ChatState<UIMessage> {
  /** Publish actual SDK store writes for deterministic tests of in-flight message states. */
  constructor(readonly onMessage: (message: UIMessage) => void) {}

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
