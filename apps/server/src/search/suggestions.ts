import { Array as Arr, Order, Result } from 'effect'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import {
  ConnectionState,
  type Connection,
  Suggestion,
  type LibraryItem,
  type Routine,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { libraryFailure } from '../library/failures.ts'
import { LibraryStore } from '../library/store.ts'
import { RoutineStore } from '../routines/store.ts'
import { ConnectionStore } from '../connections/store.ts'
import { manifest } from '@vivid/skills'

const DAY_MS = 86_400_000
/** Offer connected procedures only when every required service group has a ready account.
 * Unknown service names do not imply a capability; the four starters can explain missing access. */
export const procedureSuggestions = (connections: ReadonlyArray<Connection>) => {
  const ready = new Set(
    Arr.filterMap(connections, (connection) =>
      ConnectionState.guards.Ready(connection.state)
        ? Result.succeed(connection.serviceName.toLowerCase())
        : Result.failVoid,
    ),
  )
  const connected = manifest.filter(
    (procedure) =>
      procedure.connections.length > 0 &&
      procedure.connections.every((group) =>
        group.some((service) => ready.has(service.toLowerCase())),
      ),
  )
  const offered =
    connected.length > 0 ? connected : manifest.filter((procedure) => procedure.starter)
  return offered.slice(0, 4).map((procedure) =>
    Suggestion.make({
      text: procedure.displayName,
      reason: procedure.about,
    }),
  )
}

/** Recently added documents precede failed Routines but never include the shared Company shelf. */
const librarySuggestions = (items: ReadonlyArray<LibraryItem>, now: number) =>
  Arr.sort(
    items.filter((item) => item.createdAt >= now - DAY_MS && item.createdAt <= now),
    (left: LibraryItem, right: LibraryItem) => Order.Number(right.createdAt, left.createdAt),
  ).map((item) =>
    Suggestion.make({ text: `Summarise ${item.name}`, reason: 'Added in the last day' }),
  )

/** Runs need not arrive sorted; only a failed latest Occurrence warrants investigation. */
const routineSuggestions = (routines: ReadonlyArray<Routine>) => {
  const failed = Arr.filterMap(routines, (routine) => {
    const latest = Arr.sort(
      routine.runs,
      (left: Routine['runs'][number], right: Routine['runs'][number]) =>
        Order.Number(right.startedAt, left.startedAt),
    )[0]
    if (latest === undefined || latest.status !== 'failed') return Result.failVoid
    return Result.succeed({ routine, at: latest.startedAt })
  })
  return Arr.sort(failed, (left: (typeof failed)[number], right: (typeof failed)[number]) =>
    Order.Number(right.at, left.at),
  ).map(({ routine }) =>
    Suggestion.make({ text: `Look at why ${routine.name} failed`, reason: 'Your last run failed' }),
  )
}

/** Fixed rules offer at most four useful next messages, with starters only when no work qualifies. */
export const suggest = (
  data: {
    readonly items: ReadonlyArray<LibraryItem>
    readonly routines: ReadonlyArray<Routine>
  },
  now: number,
  starters: ReadonlyArray<Suggestion>,
): ReadonlyArray<Suggestion> => {
  const suggestions = [...librarySuggestions(data.items, now), ...routineSuggestions(data.routines)]
  return suggestions.length === 0 ? starters : suggestions.slice(0, 4)
}

/** Each domain store supplies only the acting Person’s authorized records. */
export const loadSuggestions = Effect.fn('Suggestions.load')(function* (actor: Actor) {
  const library = yield* (yield* LibraryStore)
    .list(actor, { shelf: 'Mine' })
    .pipe(Effect.mapError(libraryFailure))
  const routines = yield* (yield* RoutineStore).list(actor)
  const now = yield* Clock.currentTimeMillis
  const { connections } = yield* (yield* ConnectionStore).list(actor)
  const suggestions = suggest(
    {
      items: library.documents,
      routines,
    },
    now,
    procedureSuggestions(connections),
  )
  return { suggestions }
})
