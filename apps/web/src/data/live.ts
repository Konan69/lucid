import { useAtomValue } from '@effect/atom-react'
import type { LibraryShelf, Task, ThreadDetail, ThreadId } from '@vivid/contracts'
import { LiveState, liveStateOf, type LiveQuery, type LiveResult } from '@vivid/state'
import { Effect, Option } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { VividRpcClient } from '@vivid/client-runtime'
import { engine, run } from './runtime'

/**
 * Every screen's data, live, as Effect Atoms.
 *
 * Nothing in the web app fetches. A component reads a query with `useLive`; the query is an atom
 * over one `Watch…` subscription on the app's socket, shared by everyone reading it and kept warm
 * for half a minute after the last reader leaves, so going back to a screen shows it at once. The
 * server sends a new result when it changes, including when the Person switches workspace.
 */

const one = engine.query
const family = engine.family

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

/** What the Person has typed into the catalog search. Empty asks for the most-used services. */
export const serviceSearch = Atom.make('')

/**
 * The part of the catalog that matches the search. The catalog is thousands of services nobody
 * owns, so it is searched on the server and never held here; see `ServiceCatalog` for why it can
 * be `Unavailable` while every Connection still lists.
 */
export const services = engine.ask(serviceSearch, (client, query) => client.FindServices({ query }))

/** Reads a live query. The component re-renders when, and only when, the result changes. */
export function useLive<Value>(query: LiveQuery<Value>): LiveState<Value> {
  return liveStateOf(useAtomValue(query.atom))
}

/** The value of a live query when it has one, for lists that draw the same loading or empty. */
export function useLiveValue<Value>(query: LiveQuery<Value>): Option.Option<Value> {
  const state = useLive(query)
  return LiveState.$is('Ready')(state) ? Option.some(state.value) : Option.none()
}

/**
 * Makes a change: shows it at once in every live query it touches, sends it, and takes the
 * expectation back if the server refuses. On success the server's next result confirms it.
 */
export const change = engine.change

const seen = new Map<ThreadId, number>()

/** Tells the server a Thread was looked at as it now stands, once for each time it moves. */
const markSeen = (id: ThreadId, result: LiveResult<ThreadDetail>) => {
  if (!AsyncResult.isSuccess(result)) return
  const moved = result.value.thread.updatedAt
  const last = seen.get(id)
  if (last !== undefined && last >= moved) return
  seen.set(id, moved)
  void run(
    Effect.gen(function* () {
      const client = yield* VividRpcClient
      yield* client.MarkThreadRead({ id })
      yield* client.ReportPresence({ threadId: id, typing: false })
    }),
  )
}

const seenQueries = new Map<ThreadId, LiveQuery<ThreadDetail>>()

/**
 * A Thread's live detail, for the screen that shows it. Looking at a Thread is what marks it read
 * and what makes a Person present in it, so both happen here, in the atom, each time the Thread
 * moves while someone has it open. They are events on the data, not something a component has to
 * remember to do after it renders; when nobody is reading the atom, nothing is reported.
 */
export function seenThread(id: ThreadId): LiveQuery<ThreadDetail> {
  const existing = seenQueries.get(id)
  if (existing !== undefined) return existing
  const base = live.thread.get(id)
  const watched: LiveQuery<ThreadDetail> = {
    expect: base.expect,
    atom: Atom.readable((get) => {
      const result = get(base.atom)
      markSeen(id, result)
      return result
    }),
  }
  seenQueries.set(id, watched)
  return watched
}

export { LiveState }
