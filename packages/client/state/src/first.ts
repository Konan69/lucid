import { Option } from 'effect'

/**
 * The fields of a conversation message that a Thread's first words are matched and drawn with.
 * The shape is `ConversationMessage` (`@vivid/contracts`), named structurally. Only text and
 * reasoning parts carry `text`.
 */
export interface Worded {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

/** A message's words as they were typed: its text parts, a paragraph each. */
const wordsOf = (message: Worded): string =>
  message.parts
    .flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : []))
    .join('\n\n')

/** Only a Person's message saying the first words can replace their stand-in row. */
const saysWords = (message: Worded, words: string): boolean =>
  message.role === 'user' && wordsOf(message).trim() === words.trim()

/**
 * A Thread's conversation with its first words in it from the moment they were sent, on every
 * surface that starts a Thread before the server has it.
 *
 * `first` is the words drawn as a Person's own message (`standIn`), under a key of the surface's
 * choosing. The words come back from the server as a Person's message that says the same thing,
 * and that message takes the stand-in's key: the list then keeps the row it already drew, so the
 * words neither blink nor rise twice. This is what T3 Code mobile does for a message that is not
 * yet with the server (`appendPendingThreadMessages`, `pending-thread-feed.ts`) and what a
 * Thread's sending does for the messages it sends (`drawing`, `sending.ts`: the server's message
 * takes the local id).
 *
 * Until that message is there and the conversation's history has not been read (`ready`), the
 * words stand at the head of whatever the conversation holds. That matters when the Person says
 * something more before the history arrives: their second message is then in the conversation
 * alone, and it must not be taken for the first.
 *
 * Once the history has been read and nothing in it says the same words, the Person's first
 * message is taken to be them, so the words are never drawn twice. A conversation that then has
 * no message from a Person is returned as it is.
 */
export const withFirst = <Message extends Worded>(
  first: Option.Option<Message>,
  conversation: { readonly messages: ReadonlyArray<Message>; readonly ready: boolean },
): ReadonlyArray<Message> =>
  Option.match(first, {
    onNone: () => conversation.messages,
    onSome: (standIn) => {
      const { messages, ready } = conversation
      const words = wordsOf(standIn)
      const mine = (message: Message) => message.role === 'user'
      const same = messages.findIndex((message) => saysWords(message, words))
      if (same === -1 && !ready) return [standIn, ...messages]
      const echo = same === -1 ? messages.findIndex(mine) : same
      return messages.map((message, index) =>
        index === echo ? { ...message, id: standIn.id } : message,
      )
    },
  })
