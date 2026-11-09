import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  RuntimeSearchBody,
  SearchResult,
  Workspace,
  type SearchRequest,
  type Thread,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { libraryFailure } from '../library/failures.ts'
import { LibraryStore } from '../library/store.ts'
import { live } from '../live/query.ts'
import { ThreadStore } from '../threads/store.ts'
import { MessageSearch } from './messages.ts'
import { itemCandidate, rankResults, recentThreads, threadCandidate } from './ranking.ts'
import { loadSuggestions } from './suggestions.ts'

/** How many found messages the palette lists, after the Threads and Library items. */
const MESSAGES_MOST = 20

/**
 * The messages that match in the Person's own Threads, each with its Thread, or none when the
 * conversation runtime could not be asked. A Thread lives in its creator's cell, so only the
 * Threads this Person created are searched there; the list is the server's own, so a deleted or
 * unseen Thread is never named.
 */
const foundMessages = Effect.fn('Search.messages')(function* (
  actor: Actor,
  threads: ReadonlyArray<Thread>,
  query: string,
) {
  const own = threads.filter((thread) => thread.createdBy.id === actor.person.id)
  if (own.length === 0) return Option.some<ReadonlyArray<SearchResult>>([])
  const byId = new Map(own.map((thread) => [thread.id, thread]))
  const body = RuntimeSearchBody.make({
    query,
    threadIds: own.map((thread) => thread.id),
    limit: MESSAGES_MOST,
  })
  return yield* (yield* MessageSearch).search(actor.person.id, body).pipe(
    Effect.map((hits) =>
      Option.some(
        hits.flatMap((hit) => {
          const thread = byId.get(hit.threadId)
          return thread === undefined ? [] : [SearchResult.cases.Message.make({ thread, hit })]
        }),
      ),
    ),
    Effect.catchTag('MessagesUnreachable', () => Effect.succeedNone),
  )
})

export const searchHandlers = {
  /** Search only filters what each domain authorizes; an empty query reads Threads alone. */
  Search: Effect.fn('Rpc.Search')(function* ({ query }: SearchRequest) {
    const actor = yield* requireActor()
    const threads = yield* (yield* ThreadStore).list(actor)
    const asked = query.trim()
    if (asked.length === 0)
      return { results: recentThreads(threads), messages: 'NotAsked' as const }
    const library = yield* LibraryStore
    const mine = yield* library.list(actor, { shelf: 'Mine' }).pipe(Effect.mapError(libraryFailure))
    const shared = yield* Workspace.match(actor.workspace, {
      Personal: () => Effect.succeed({ documents: [], folders: [] }),
      Company: () =>
        library.list(actor, { shelf: 'Company' }).pipe(Effect.mapError(libraryFailure)),
    })
    const messages = yield* foundMessages(actor, threads, asked)
    const ranked = rankResults(query, [
      ...threads.map(threadCandidate),
      ...mine.documents.map(itemCandidate),
      ...shared.documents.map(itemCandidate),
    ])
    return Option.match(messages, {
      onNone: () => ({ results: ranked, messages: 'Unavailable' as const }),
      onSome: (found) => ({ results: [...ranked, ...found], messages: 'Searched' as const }),
    })
  }),
  /** Suggestions use the same Actor-scoped loader as their subscription. */
  ListSuggestions: Effect.fn('Rpc.ListSuggestions')(function* () {
    return yield* loadSuggestions(yield* requireActor())
  }),
  /** Workspace and domain changes refresh the deterministic suggestions through the change bus. */
  WatchSuggestions: () => live('WatchSuggestions', ['activity'], loadSuggestions),
}
