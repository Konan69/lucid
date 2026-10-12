import * as Effect from 'effect/Effect'
import { Workspace, type SearchRequest } from '@vivid/contracts'
import { requireActor } from '../auth/access.ts'
import { libraryFailure } from '../library/failures.ts'
import { LibraryStore } from '../library/store.ts'
import { live } from '../live/query.ts'
import { RoutineStore } from '../routines/store.ts'
import { ThreadStore } from '../threads/store.ts'
import {
  itemCandidate,
  rankResults,
  recentThreads,
  routineCandidate,
  threadCandidate,
} from './ranking.ts'
import { loadSuggestions } from './suggestions.ts'

export const searchHandlers = {
  /** Search only filters what each domain authorizes; an empty query reads Threads alone. */
  Search: Effect.fn('Rpc.Search')(function* ({ query }: SearchRequest) {
    const actor = yield* requireActor()
    const threads = yield* (yield* ThreadStore).list(actor)
    if (query.trim().length === 0) return { results: recentThreads(threads) }
    const routines = yield* (yield* RoutineStore).list(actor)
    const library = yield* LibraryStore
    const mine = yield* library.list(actor, { shelf: 'Mine' }).pipe(Effect.mapError(libraryFailure))
    const shared = yield* Workspace.match(actor.workspace, {
      Personal: () => Effect.succeed({ documents: [], folders: [] }),
      Company: () =>
        library.list(actor, { shelf: 'Company' }).pipe(Effect.mapError(libraryFailure)),
    })
    return {
      results: rankResults(query, [
        ...threads.map(threadCandidate),
        ...routines.map(routineCandidate),
        ...mine.documents.map(itemCandidate),
        ...shared.documents.map(itemCandidate),
      ]),
    }
  }),
  /** Suggestions use the same Actor-scoped loader as their subscription. */
  ListSuggestions: Effect.fn('Rpc.ListSuggestions')(function* () {
    return yield* loadSuggestions(yield* requireActor())
  }),
  /** Workspace and domain changes refresh the deterministic suggestions through the change bus. */
  WatchSuggestions: () => live('WatchSuggestions', loadSuggestions),
}
