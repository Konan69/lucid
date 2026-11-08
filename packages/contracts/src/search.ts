import { Schema } from 'effect'
import { ThreadId } from './identity.js'
import { LibraryItem } from './library.js'
import { Thread } from './threads.js'

/** Whose words a found message holds: the Person's own, or Vivid's reply. */
export const MessageAuthor = Schema.Literals(['Person', 'Vivid'])
export type MessageAuthor = typeof MessageAuthor.Type

/**
 * One message of a Person's own conversations that matches a search, as the runtime finds it in
 * the Thread's Pi transcript (`packages/agent/runtime/src/recall.ts`). `messageId` is the id the
 * Thread's conversation state gives the same message (`ConversationMessage.id`), so a screen opens
 * the Thread on it. `at` is the message's ISO 8601 instant, absent where the conversation stamps
 * none. `snippet` is the words around the first match. Ported from Muse's chat search
 * (`muse/docs/client-surfaces.md:133`: a short snippet and the chat each hit came from).
 */
export const MessageHit = Schema.Struct({
  threadId: ThreadId,
  messageId: Schema.String,
  author: MessageAuthor,
  at: Schema.optionalKey(Schema.String),
  snippet: Schema.String,
})
export interface MessageHit extends Schema.Schema.Type<typeof MessageHit> {}

/** One thing the search palette can open. A `Message` opens its Thread at that message. */
export const SearchResult = Schema.TaggedUnion({
  Thread: { thread: Thread },
  LibraryItem: { item: LibraryItem },
  Message: { thread: Thread, hit: MessageHit },
})
export type SearchResult = typeof SearchResult.Type

export const SearchRequest = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)),
})
export interface SearchRequest extends Schema.Schema.Type<typeof SearchRequest> {}

/**
 * Whether the words of the Person's conversations were searched. They live in the Person's
 * conversation runtime, not the product database, so they can be out of reach while Threads and
 * the Library answer: `Unavailable` lets a screen say so instead of passing silence off as no
 * match. `NotAsked` is the empty query, which lists recent Threads only.
 */
export const MessagesSearched = Schema.Literals(['Searched', 'NotAsked', 'Unavailable'])
export type MessagesSearched = typeof MessagesSearched.Type

/** Results in the order the palette shows them. An empty query returns what is most recent. */
export const SearchResponse = Schema.Struct({
  results: Schema.Array(SearchResult),
  messages: MessagesSearched,
})
export interface SearchResponse extends Schema.Schema.Type<typeof SearchResponse> {}

/**
 * A sentence the empty screen offers, taken from the Person's own work: a document they added. Choosing one puts it in the composer.
 */
export const Suggestion = Schema.Struct({
  text: Schema.String,
  /** Why this is offered: "Due today", "Added yesterday". */
  reason: Schema.String,
})
export interface Suggestion extends Schema.Schema.Type<typeof Suggestion> {}

export const SuggestionListResponse = Schema.Struct({ suggestions: Schema.Array(Suggestion) })
