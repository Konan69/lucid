import { useAtomValue } from '@effect/atom-react'
import {
  ServiceCatalog,
  Workspace,
  type LibraryShelf,
  type MeResponse,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import { LiveState, liveStateOf, type LiveQuery, type LiveResult } from '@vivid/state'
import { Effect, Option, Result, Schedule } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { VividRpcClient } from '@vivid/client-runtime'
import { change, changing, run } from './app'
import { Route, router } from './route'
import { engine } from './runtime'
import { said, sayWith } from './said'
import { theme } from './theme'

/**
 * Every screen's data, live, as Effect Atoms.
 *
 * Nothing in the web app fetches. A component reads a query with `useLive`; the query is an atom
 * over one `Watch…` subscription on the app's socket, shared by everyone reading it and kept warm
 * for half a minute after the last reader leaves, so going back to a screen shows it at once. The
 * server sends a new result when it changes, including when the Person switches workspace.
 */

const one = engine.query
/** A query the first screen needs: its last answer is kept on the device (`data/snapshot.ts`). */
const kept = engine.kept
const family = engine.family

export const live = {
  me: kept((client) => client.WatchMe()),
  settings: kept((client) => client.WatchSettings()),
  people: one((client) => client.WatchPeople()),
  threads: kept((client) => client.WatchThreads()),
  thread: family(
    (id: ThreadId) => id,
    (client, id) => client.WatchThread({ id }),
  ),
  inbox: one((client) => client.WatchInbox()),
  notifications: kept((client) => client.WatchNotifications()),
  routines: one((client) => client.WatchRoutines()),
  projects: kept((client) => client.WatchProjects()),
  library: family(
    (shelf: LibraryShelf) => shelf,
    (client, shelf) => client.WatchLibrary({ shelf }),
  ),
  connections: one((client) => client.WatchConnections()),
  /** The messaging apps a Person can text Vivid from, and where each stands for them. */
  channels: one((client) => client.WatchChannels()),
  rules: one((client) => client.WatchRules()),
  audit: one((client) => client.WatchAudit()),
  memory: one((client) => client.WatchMemory()),
  computer: one((client) => client.WatchComputer()),
  suggestions: one((client) => client.WatchSuggestions()),
  /** The Person's own computers, each with its access and whether its desktop app is listening. */
  devices: one((client) => client.WatchDevices()),
  /** What the Person has typed and not sent, on any device, where they are working. */
  drafts: kept((client) => client.WatchDrafts()),
}

/** What the Person has typed into the catalog search. Empty asks for the most-used services. */
export const serviceSearch = Atom.make('')

/**
 * One reading of the catalog for one question. The catalog is thousands of services nobody owns,
 * so it is searched on the server and never held here; see `ServiceCatalog` for why it can be
 * `Unavailable` while every Connection still lists.
 */
const catalogFor = (query: Atom.Atom<string>) =>
  engine.ask(query, (client, asked) =>
    // The catalog is read in the background by the server and is out of reach for a few seconds
    // after it starts. That is not an answer to show for good, so it is asked again for a short
    // while; only if it is still out of reach after that does the screen say so.
    client.FindServices({ query: asked }).pipe(
      Effect.repeat({
        until: ServiceCatalog.guards.Ready,
        schedule: Schedule.spaced('2 seconds'),
        times: 6,
      }),
    ),
  )

/** The part of the catalog that matches what is typed in Settings. */
export const services = catalogFor(serviceSearch)

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

// The Person's theme is theirs on every device; when their settings arrive, this device follows.
// It is adopted here and not while the shell renders: adopting it tells everything painted by
// theme (the composer's beam) to redraw, and React refuses that from inside another render.
engine.registry.subscribe(
  live.settings.atom,
  (result) => {
    if (AsyncResult.isSuccess(result)) theme.set(result.value.theme)
  },
  { immediate: true },
)

// The latest notification window for each workspace is its baseline and deduplication set.
const told = new Map<string, ReadonlySet<string>>()

/**
 * Says so when something finishes or needs the Person while they are somewhere else in the app.
 *
 * A Routine that ran, a reply that landed in another Thread, an Approval waiting: these only moved
 * a number on the bell. Each new one now says its title at the foot of the window with a way to
 * open it. What was already waiting when the page opened is not announced, it is in the bell; and
 * nothing is announced about the Thread that is on screen, which the Person is already reading.
 */
// It listens to the server's own answers, not to what the device kept from its last run: that
// copy would become the baseline, and everything that arrived while the page was closed would be
// announced at launch as if it had just happened.
engine.registry.subscribe(live.notifications.answers, (result) => {
  if (!AsyncResult.isSuccess(result) || lastWhereabouts === 'nowhere') return
  const previous = told.get(lastWhereabouts)
  const fresh = result.value.notifications.filter(
    (notice) => notice.readAt === null && (previous === undefined || !previous.has(notice.id)),
  )
  const current = new Set<string>(result.value.notifications.map((notice) => notice.id))
  told.set(lastWhereabouts, current)
  if (previous === undefined) {
    return
  }
  // A notice that was here and is gone was removed or put out of the Person's reach (access to
  // its Thread was taken away, or the Thread was deleted). Its sentence, if still showing, names
  // that Thread and offers to open it, so it leaves with the notice.
  for (const id of previous) {
    if (!current.has(id)) said.withdraw(id)
  }
  const here = router.route()
  for (const notice of fresh) {
    const threadId = notice.threadId
    if (threadId === null) {
      sayWith(notice.title, Option.none(), notice.id)
    } else if (!(Route.$is('Thread')(here) && here.id === threadId)) {
      sayWith(
        notice.title,
        Option.some({ label: 'Open', go: () => router.go(Route.Thread({ id: threadId })) }),
        notice.id,
      )
    }
  }
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

export { change, changing }

const seen = new Map<ThreadId, number>()

/** Tells the server a Thread was looked at as it now stands, once for each time it moves. */
const markSeen = (id: ThreadId, result: LiveResult<ThreadDetail>) => {
  if (!AsyncResult.isSuccess(result)) return
  const moved = result.value.thread.updatedAt
  const last = seen.get(id)
  if (last !== undefined && last >= moved) {
    seen.delete(id)
    seen.set(id, last)
    return
  }
  seen.delete(id)
  seen.set(id, moved)
  if (seen.size > 50) {
    const oldest = seen.keys().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  // Remembered at once so a burst of results reports once, and forgotten again if the report did
  // not get through, so the next result tries again instead of leaving read work marked unread.
  const forget = () => {
    if (seen.get(id) === moved) seen.delete(id)
  }
  void run(
    Effect.gen(function* () {
      const client = yield* VividRpcClient
      yield* client.MarkThreadRead({ id })
    }),
  ).then((reported) => {
    if (Result.isFailure(reported)) forget()
  }, forget)
}

/** Whether this window is the one being looked at. A tab in the background is not watching. */
const looking = Atom.make((get) => {
  const hear = () => get.setSelf(document.visibilityState === 'visible')
  document.addEventListener('visibilitychange', hear)
  get.addFinalizer(() => document.removeEventListener('visibilitychange', hear))
  return document.visibilityState === 'visible'
})

/** Whether this Person has something typed in a Thread's composer. The composer sets it. */
export const typingIn = Atom.family((_id: ThreadId) => Atom.make(false))

/**
 * "I am here" for one Thread, said for as long as its screen is open and this window is in front.
 *
 * The server keeps a Person present for fifteen seconds after they last said so, and decides from
 * that who is shown at the top of a shared Thread and who needs a notification instead. It used
 * to be said only when the Thread moved, so someone reading a quiet Thread, or writing a long
 * message, dropped out of it after fifteen seconds. A window in the background says nothing, so
 * its Person is told about what they are not looking at.
 */
export const presentIn = Atom.family((id: ThreadId) =>
  engine.beat(
    Atom.make((get) => ({ typing: get(typingIn(id)), looking: get(looking) })),
    (client, now) =>
      now.looking ? client.ReportPresence({ threadId: id, typing: now.typing }) : Effect.void,
    '5 seconds',
  ),
)

// One watched query for each Thread's own query, for as long as that one exists.
const seenQueries = new WeakMap<LiveQuery<ThreadDetail>, LiveQuery<ThreadDetail>>()

/**
 * A Thread's live detail, for the screen that shows it. Looking at a Thread is what marks it read,
 * so that happens here, in the atom, each time the Thread moves while someone has it open. It is
 * an event on the data, not something a component has to remember to do after it renders; when
 * nobody is reading the atom, nothing is reported. Being present is `presentIn`.
 *
 * The Thread's own query stays subscribed for minutes after its screen closes, so coming back is
 * instant. This atom does not: it stops the moment the screen does, or a reply that arrived after
 * the Person left would be marked read without ever being seen.
 */
export function seenThread(id: ThreadId): LiveQuery<ThreadDetail> {
  const base = live.thread.get(id)
  const existing = seenQueries.get(base)
  if (existing !== undefined) return existing
  const watched: LiveQuery<ThreadDetail> = {
    expect: base.expect,
    atom: Atom.setIdleTTL(
      Atom.readable((get) => {
        const result = get(base.atom)
        markSeen(id, result)
        return result
      }),
      0,
    ),
  }
  seenQueries.set(base, watched)
  return watched
}

export { LiveState }
