import { Schema } from 'effect'
import { LibraryItem } from './library.js'
import { Routine } from './routines.js'
import { Thread } from './threads.js'

/** One thing the search palette can open. */
export const SearchResult = Schema.TaggedUnion({
  Thread: { thread: Thread },
  LibraryItem: { item: LibraryItem },
  Routine: { routine: Routine },
})
export type SearchResult = typeof SearchResult.Type

export const SearchRequest = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)),
})
export interface SearchRequest extends Schema.Schema.Type<typeof SearchRequest> {}

/** Results in the order the palette shows them. An empty query returns what is most recent. */
export const SearchResponse = Schema.Struct({ results: Schema.Array(SearchResult) })
export interface SearchResponse extends Schema.Schema.Type<typeof SearchResponse> {}

/**
 * A sentence the empty screen offers, taken from the Person's own work: a Routine that ran, a document they added. Choosing one puts it in the composer.
 */
export const Suggestion = Schema.Struct({
  text: Schema.String,
  /** Why this is offered: "Due today", "Added yesterday". */
  reason: Schema.String,
})
export interface Suggestion extends Schema.Schema.Type<typeof Suggestion> {}

export const SuggestionListResponse = Schema.Struct({ suggestions: Schema.Array(Suggestion) })
