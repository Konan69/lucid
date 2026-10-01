import { useAtomValue } from '@effect/atom-react'
import {
  Workspace,
  type LibraryShelf,
  type MeResponse,
  type Task,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import { LiveState, liveStateOf, type LiveQuery, type LiveResult } from '@vivid/state'
import { Effect, Option, Result } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { VividRpcClient } from '@vivid/client-runtime'
import { change, run } from './app'
import { engine } from './runtime'

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

/** What the Person has typed into "find anything". */
export const findQuery = Atom.make('')

/**
 * What "find anything" found. Asked on the server, so the answer is exactly what this Person may
 * see; asked again only once the typing rests, with the previous answer kept up meanwhile, and a
 * newer question always replaces an older one that is still on its way.
 */
export const findings = engine.ask(findQuery, (client, query) => client.Search({ query }))

/** The workspace a `WatchMe` result puts the Person in, as one comparable word. */
const whereabouts = (result: LiveResult<MeResponse>) =>
  AsyncResult.isSuccess(result)
    ? Workspace.match(result.value.workspace, {
        Personal: () => `personal:${result.value.person.id}`,
        Company: ({ company }) => `company:${company.id}`,
      })
    : 'nowhere'

let lastWhereabouts = 'nowhere'

// A query that ended because it was not the Person's to see ("people", in their own space) was
// answered for where they were. When they move, it is asked again; nothing else would ask it.
engine.registry.subscribe(live.me.atom, (result) => {
  const now = whereabouts(result)
  if (now === lastWhereabouts) return
  lastWhereabouts = now
  engine.reopen()
})

/** Reads a live query. The component re-renders when, and only when, the result changes. */
export function useLive<Value>(query: LiveQuery<Value>): LiveState<Value> {
  return liveStateOf(useAtomValue(query.atom))
}

/** The value of a live query when it has one, for lists that draw the same loading or empty. */
export function useLiveValue<Value>(query: LiveQuery<Value>): Option.Option<Value> {
  const state = useLive(query)
  return LiveState.$is('Ready')(state) ? Option.some(state.value) : Option.none()
}

export { change }

const seen = new Map<ThreadId, number>()

/** Tells the server a Thread was looked at as it now stands, once for each time it moves. */
const markSeen = (id: ThreadId, result: LiveResult<ThreadDetail>) => {
  if (!AsyncResult.isSuccess(result)) return
  const moved = result.value.thread.updatedAt
  const last = seen.get(id)
  if (last !== undefined && last >= moved) return
  seen.set(id, moved)
  // Remembered at once so a burst of results reports once, and forgotten again if the report did
  // not get through, so the next result tries again instead of leaving read work marked unread.
  const forget = () => {
    if (seen.get(id) === moved) seen.delete(id)
  }
  void run(
    Effect.gen(function* () {
      const client = yield* VividRpcClient
      yield* client.MarkThreadRead({ id })
      yield* client.ReportPresence({ threadId: id, typing: false })
    }),
  ).then((reported) => {
    if (Result.isFailure(reported)) forget()
  }, forget)
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
