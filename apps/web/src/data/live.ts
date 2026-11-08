import { useAtomValue } from '@effect/atom-react'
import { Workspace, type LibraryShelf, type MeResponse, type ThreadId } from '@vivid/contracts'
import {
  LiveState,
  liveStateOf,
  makeSeenThread,
  remembering,
  type LiveQuery,
  type LiveResult,
} from '@vivid/state'
import { Option, Stream } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { change, changing, start } from './app'
import { showOnDesktop } from './notifying'
import { router, threadOnScreen } from '../router'
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
  /** The build of the server answering, for Settings beside the page's own (`build.ts`). */
  build: one((client) => client.WatchBuild()),
  people: one((client) => client.WatchPeople()),
  threads: kept((client) => client.WatchThreads()),
  thread: family(
    (id: ThreadId) => id,
    (client, id) => client.WatchThread({ id }),
  ),
  inbox: one((client) => client.WatchInbox()),
  notifications: kept((client) => client.WatchNotifications()),
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
  computer: one((client) => client.WatchComputer()),
  /** What egress is doing for the Person right now (`screen/settings/Egress.tsx`). */
  egress: one((client) => client.WatchEgress()),
  suggestions: one((client) => client.WatchSuggestions()),
  /** The Person's own computers, each with its access and whether its desktop app is listening. */
  devices: one((client) => client.WatchDevices()),
  /** What Vivid's own work in background Threads brings the Person: the Feed (`screen/Feed.tsx`). */
  feed: one((client) => client.WatchFeed()),
  /** Who owes the Person what, which Vivid keeps and chases (`screen/feed/Owed.tsx`). */
  owed: one((client) => client.WatchOwed()),
  /** The Person's own to-do list, which Vivid adds to and ticks off (`screen/feed/Todos.tsx`). */
  todos: one((client) => client.WatchTodos()),
  /** What the Person has typed and not sent, on any device, where they are working. */
  drafts: kept((client) => client.WatchDrafts()),
}

/**
 * What Vivid remembers about the Person, read from their cell. There is no watch on it: each
 * opening of Settings begins a new reading (`warm.ts`), and the Memory section draws it.
 */
export const memory = remembering.make(engine)

/** What the Person has typed into the catalog search. Empty asks for the most-used services. */
export const serviceSearch = Atom.make('')

/**
 * The part of the catalog that matches what is typed in Settings. The catalog is thousands of
 * services nobody owns, so it is searched on the server and never held here; see `ServiceCatalog`
 * for why it can be `Unavailable` while every Connection still lists. It is asked once for each
 * question: the server answers when its copy of the catalog is ready, waiting for its first
 * download after a start (`connections/catalog.ts` `retainCatalog`).
 */
export const services = engine.ask(serviceSearch, (client, query) => client.FindServices({ query }))

/**
 * How deeply Settings checks Vivid's Computer: every part, each time the panel asks. A check
 * never wakes a sleeping Computer (`GetComputerHealth`), so opening Settings costs it nothing.
 */
const healthDepth = Atom.make<'Deep'>('Deep')

/** How Vivid's Computer is doing, part by part (`screen/settings/Computers.tsx`). */
export const computerHealth = engine.ask(healthDepth, (client, depth) =>
  client.GetComputerHealth({ depth }),
)

/** The newest step Vivid took to fix its Computer, read beside its health. */
export const computerRecovery = engine.ask(healthDepth, (client) => client.GetComputerRecovery())

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
 * A reply that landed in another Thread, an Approval waiting: these only moved
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
  const here = threadOnScreen()
  for (const notice of fresh) {
    // The desktop app also shows it as the system's own, while its window is not in front.
    showOnDesktop(notice)
    const threadId = notice.threadId
    if (threadId === null) {
      sayWith(notice.title, Option.none(), notice.id)
    } else if (!Option.contains(here, threadId)) {
      sayWith(
        notice.title,
        Option.some({
          label: 'Open',
          go: () => void router.navigate({ to: '/t/$id', params: { id: threadId } }),
        }),
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
 * "I am here" for one Thread, held for as long as its screen is open and this window is in front.
 *
 * The server shows who holds it at the top of a shared Thread, and does not notify someone about
 * what they are looking at. It is one call kept open, not something said on a timer: the server
 * hears this window leave when the call closes, when the socket closes, or when the socket goes
 * quiet (`apps/server/src/rpc/link.ts`). A window in the background holds nothing, so its Person
 * is told about what they are not looking at.
 */
export const presentIn = Atom.family((id: ThreadId) =>
  engine.hold(
    Atom.make((get) => ({ typing: get(typingIn(id)), looking: get(looking) })),
    (client, now) =>
      now.looking ? client.BePresent({ threadId: id, typing: now.typing }) : Stream.never,
  ),
)

/**
 * A Thread's live detail, for the screen that shows it. Looking at a Thread is what marks it read,
 * and the query does it each time the Thread moves while someone has it open (`@vivid/state`
 * `seen.ts`, shared with the phone). Being present is `presentIn`.
 */
export const seenThread = makeSeenThread({
  engine,
  threads: live.thread,
  me: live.me,
  launch: start,
})

export { LiveState }
