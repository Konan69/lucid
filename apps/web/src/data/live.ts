import { VividRpcClient } from '@vivid/client-runtime'
import type { LibraryShelf, Task, ThreadId } from '@vivid/contracts'
import {
  createLiveFamily,
  createLiveStore,
  LiveState,
  type LiveOptions,
  type LiveStore,
} from '@vivid/state'
import { Effect, Option, Result, Stream } from 'effect'
import { useSyncExternalStore } from 'react'
import { environment, run, type ProductFailure } from './runtime'

/**
 * Every screen's data, live.
 *
 * Nothing in the web app fetches. A component reads a store with `useLive`; the store is one
 * `Watch…` subscription on the app's socket, shared by everyone reading it, kept warm for half a
 * minute after the last reader leaves so that going back to a screen shows it at once. The server
 * sends a new result when it changes, including when the Person switches workspace.
 */

type Client = VividRpcClient['Service']

/** Failures that mean "this is not yours to see", which retrying will not change. */
const FINAL = new Set(['Unauthenticated', 'Forbidden', 'NotFound', 'InvalidRequest'])
const options: LiveOptions<ProductFailure> = {
  isFinal: (failure) => FINAL.has(failure._tag),
  lingerMs: 30_000,
}

const stream = <Value>(watch: (client: Client) => Stream.Stream<Value, ProductFailure>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      return watch(yield* VividRpcClient)
    }),
  )

const one = <Value>(watch: (client: Client) => Stream.Stream<Value, ProductFailure>) =>
  createLiveStore(environment, stream(watch), options)

const family = <Argument, Value>(
  key: (argument: Argument) => string,
  watch: (client: Client, argument: Argument) => Stream.Stream<Value, ProductFailure>,
) =>
  createLiveFamily(environment, options, {
    key,
    stream: (argument: Argument) => stream((client) => watch(client, argument)),
  })

export const live = {
  me: one((client) => client.WatchMe()),
  settings: one((client) => client.WatchSettings()),
  people: one((client) => client.WatchPeople()),
  threads: one((client) => client.WatchThreads()),
  thread: family(
    (id: ThreadId) => id,
    (client, id) => client.WatchThread({ id }),
  ),
  inbox: one((client) => client.WatchInbox()),
  tasks: family(
    (status: Task['status'] | 'all') => status,
    (client, status) => client.WatchTasks(status === 'all' ? {} : { status }),
  ),
  notifications: one((client) => client.WatchNotifications()),
  routines: one((client) => client.WatchRoutines()),
  projects: one((client) => client.WatchProjects()),
  library: family(
    (shelf: LibraryShelf) => shelf,
    (client, shelf) => client.WatchLibrary({ shelf }),
  ),
  connections: one((client) => client.WatchConnections()),
  rules: one((client) => client.WatchRules()),
  audit: one((client) => client.WatchAudit()),
  memory: one((client) => client.WatchMemory()),
  skills: one((client) => client.WatchSkills()),
  computer: one((client) => client.WatchComputer()),
  suggestions: one((client) => client.WatchSuggestions()),
}

/** Reads a live query. The component re-renders when, and only when, the result changes. */
export function useLive<Value>(store: LiveStore<Value, ProductFailure>) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** The value of a live query when it has one, for lists that draw the same loading or empty. */
export function useLiveValue<Value>(store: LiveStore<Value, ProductFailure>): Option.Option<Value> {
  const state = useLive(store)
  return LiveState.$is('Ready')(state) ? Option.some(state.value) : Option.none()
}

/**
 * Makes a change: shows it at once in every live query it touches, sends it, and takes the
 * expectation back if the server refuses. On success the server's next result confirms it.
 */
export async function change<Value>(
  program: (client: Client) => Effect.Effect<Value, ProductFailure>,
  ...expectations: ReadonlyArray<() => () => void>
) {
  const takeBack = expectations.map((expectation) => expectation())
  const result = await run(
    Effect.gen(function* () {
      return yield* program(yield* VividRpcClient)
    }),
  )
  if (Result.isFailure(result)) for (const undo of takeBack) undo()
  return result
}

export { LiveState }
