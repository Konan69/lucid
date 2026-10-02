import { useAtomValue } from '@effect/atom-react'
import { workspaceKey } from '@vivid/state'
import { ThreadId, type MeResponse, type Thread as ThreadRecord } from '@vivid/contracts'
import { Array as Arr, Option, Order } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { PanelLeft } from 'lucide-react'
import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { live, LiveState, useLive, useLiveValue } from './data/live'
import { Route, router } from './data/route'
import { engine, link } from './data/runtime'
import { sidebar } from './data/sidebar'
import { theme } from './data/theme'
import { startThread } from './data/threads'
import { First } from './screen/First'
import { Invite } from './screen/Invite'
import { Notifications } from './screen/Notifications'
import { Palette } from './screen/Palette'
import { Sidebar } from './screen/Sidebar'
import { Thread } from './screen/Thread'
import { Welcome } from './screen/Welcome'
import { Face } from './ui/Face'
import { Sayings } from './ui/Sayings'

// The screens a Person may not open in a session, each in its own file on the wire: the Thread
// is what loads first, and the Computer's screen client alone is a third of everything else.
// Each is fetched when it is first drawn, and all of them are fetched once the first screen is
// up and the browser is idle, so opening one later does not wait on the network.
const screens = {
  Computer: () => import('./screen/Computer'),
  Library: () => import('./screen/Library'),
  Projects: () => import('./screen/Projects'),
  Routines: () => import('./screen/Routines'),
  Settings: () => import('./screen/Settings'),
}
const Computer = lazy(async () => ({ default: (await screens.Computer()).Computer }))
const Library = lazy(async () => ({ default: (await screens.Library()).Library }))
const Projects = lazy(async () => ({ default: (await screens.Projects()).Projects }))
const Routines = lazy(async () => ({ default: (await screens.Routines()).Routines }))
const Settings = lazy(async () => ({ default: (await screens.Settings()).Settings }))

const warm = () => {
  for (const load of Object.values(screens)) void load()
}
if ('requestIdleCallback' in globalThis) requestIdleCallback(warm)
else setTimeout(warm, 2000)

/** What floats over the app. One at a time, because each takes the keyboard. */
type Overlay = 'none' | 'palette' | 'notifications'

const overlayListeners = new Set<() => void>()
let overlay: Overlay = 'none'
const setOverlay = (next: Overlay) => {
  overlay = next
  for (const listener of overlayListeners) listener()
}
const subscribeOverlay = (listener: () => void) => {
  overlayListeners.add(listener)
  return () => {
    overlayListeners.delete(listener)
  }
}

/** The Threads still in play, newest first: the order ⌘⇧[ and ⌘⇧] walk through. */
const inPlay = () => {
  const result = engine.registry.get(live.threads.atom)
  return AsyncResult.isSuccess(result)
    ? Arr.sort(
        result.value.threads.filter((thread) => !thread.archived),
        Order.mapInput(Order.flip(Order.Number), (thread: ThreadRecord) => thread.updatedAt),
      )
    : []
}

/** Goes to the Thread before or after the one on screen; from anywhere else, to the newest. */
const step = (by: -1 | 1) => {
  const threads = inPlay()
  const here = router.route()
  const at = Route.$is('Thread')(here) ? threads.findIndex((thread) => thread.id === here.id) : -1
  const next = Option.fromUndefinedOr(
    threads[at === -1 ? 0 : Math.min(Math.max(at + by, 0), threads.length - 1)],
  )
  if (Option.isSome(next)) router.go(Route.Thread({ id: next.value.id }))
}

// The shortcuts that work from anywhere. They are module-level listeners, like the sidebar's ⌘B,
// so they exist for the life of the page and not for the life of a component.
//   ⌘K          find anything, do anything
//   ⌘⇧O         new thread
//   ⌘⇧[  ⌘⇧]    the thread before, the thread after
addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return
  const key = event.key.toLocaleLowerCase()
  if (key === 'k' && !event.shiftKey) {
    event.preventDefault()
    setOverlay(overlay === 'palette' ? 'none' : 'palette')
    return
  }
  if (!event.shiftKey) return
  if (key === 'o') {
    event.preventDefault()
    setOverlay('none')
    router.go(Route.New())
    return
  }
  // By position on the keyboard, not by character: with Shift held the key reads "{" or "}".
  if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
    event.preventDefault()
    step(event.code === 'BracketLeft' ? -1 : 1)
  }
})

/**
 * The app. Who is signed in decides everything else, and that is one live query: while it is on
 * its way there is a quiet splash, when there is nobody there is the welcome, and when there is
 * someone there is the shell around wherever the address says they are.
 */
export default function App() {
  const me = useLive(live.me)
  const reach = useAtomValue(link.atom)
  return LiveState.$match(me, {
    Loading: () => <Splash unreachable={reach === 'lost'} />,
    Failed: () => <Welcome returnTo={`${location.pathname}${location.search}`} />,
    Ready: ({ value }) => (
      <>
        <Shell me={value} />
        {reach === 'lost' && <Reconnecting />}
        <Sayings />
      </>
    ),
  })
}

/**
 * The first moment of the page. A server that cannot be reached used to look exactly like this
 * for as long as it lasted; now it says so, under the face, and keeps trying.
 */
function Splash({ unreachable = false }: { unreachable?: boolean }) {
  return (
    <main
      className="flex size-full flex-col items-center justify-center gap-4 bg-surface-1"
      aria-busy
    >
      <Face size={40} mood="thinking" />
      {unreachable && (
        <p role="status" className="animate-fade-in text-label text-ink-3">
          Can’t reach Vivid. Trying again…
        </p>
      )}
    </main>
  )
}

/**
 * Said over the app while its connection is down. What is on screen stays, since it is the last
 * thing the server said, and this is the note that it may be behind. It waits a second before it
 * shows: most drops are over before anyone could read it, and a pill that flashes on every one
 * of them would be noise.
 */
function Reconnecting() {
  return (
    <p
      role="status"
      className="pointer-events-none fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full px-3 py-1 text-meta text-ink-2 smooth-shadow-ring-sm glass transition-opacity delay-1000 duration-(--dur-base) starting:opacity-0"
    >
      Reconnecting…
    </p>
  )
}

function Shell({ me }: { me: MeResponse }) {
  const route = useSyncExternalStore(router.subscribe, router.route)
  const section = useSyncExternalStore(router.subscribe, router.settings)
  const sidebarOpen = useSyncExternalStore(sidebar.subscribe, sidebar.isOpen)
  const floating = useSyncExternalStore(subscribeOverlay, () => overlay)
  const [panel, setPanel] = useState(false)
  const notices = useLiveValue(live.notifications)
  const settings = useLiveValue(live.settings)
  // The Person's theme is theirs on every device; when their settings arrive, this device follows.
  if (Option.isSome(settings)) theme.set(settings.value.theme)

  return (
    <div className="group/shell relative flex size-full" data-rail={sidebarOpen ? 'open' : 'shut'}>
      <Sidebar
        me={me}
        route={route}
        open={sidebarOpen}
        onHide={sidebar.toggle}
        onSearch={() => setOverlay('palette')}
        onNotifications={() => setOverlay('notifications')}
        unread={Option.match(notices, { onNone: () => 0, onSome: (value) => value.unreadCount })}
      />
      {sidebarOpen ? (
        // Under the drawer on a narrow window: the rest of the page, dimmed, closes it.
        <button
          aria-label="Close sidebar"
          tabIndex={-1}
          onClick={sidebar.hide}
          className="fixed inset-0 z-30 animate-fade-in cursor-default bg-scrim md:hidden"
        />
      ) : (
        <button
          aria-label="Show sidebar"
          title="Show sidebar (⌘B)"
          onClick={sidebar.show}
          className="absolute top-2 left-2 z-30 inline-flex size-8 cursor-pointer items-center justify-center rounded-control text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
        >
          <PanelLeft className="size-4" />
        </button>
      )}
      <main className="flex min-w-0 flex-1">
        <Suspense fallback={<Splash />}>
          <Place
            // A screen holds things that belong to the workspace it was opened in: the folder it
            // is in, the item it has open, a half-written Routine. Changing workspace starts each
            // screen again, so nothing of one Company is left on screen under another's name.
            key={workspaceKey(me.workspace)}
            route={route}
            me={me}
            panel={panel}
            onTogglePanel={() => setPanel((on) => !on)}
          />
        </Suspense>
        {panel && Route.$is('Thread')(route) && (
          <Suspense fallback={null}>
            <Computer onClose={() => setPanel(false)} />
          </Suspense>
        )}
      </main>
      {Option.isSome(section) && (
        <Suspense fallback={null}>
          <Settings
            me={me}
            section={section.value}
            deviceCode={Route.$is('Device')(route) ? Option.getOrElse(route.code, () => '') : ''}
          />
        </Suspense>
      )}
      {floating === 'palette' && <Palette onClose={() => setOverlay('none')} />}
      {floating === 'notifications' && <Notifications onClose={() => setOverlay('none')} />}
    </div>
  )
}

const openThread = (id: string) => router.go(Route.Thread({ id: ThreadId.make(id) }))

/** The screen the address names. */
function Place({
  route,
  me,
  panel,
  onTogglePanel,
}: {
  route: Route
  me: MeResponse
  panel: boolean
  onTogglePanel: () => void
}) {
  return Route.$match(route, {
    New: () => <First me={me} />,
    Thread: ({ id }) => <Thread id={id} me={me} panelOpen={panel} onTogglePanel={onTogglePanel} />,
    Routines: () => <Routines onOpenConversation={(thread) => openThread(thread.id)} />,
    Library: () => (
      <Library
        onAsk={(document) =>
          startThread(`Read “${document.name}” in the Library and tell me what matters in it.`)
        }
      />
    ),
    Projects: () => <Projects onOpenThread={(id) => router.go(Route.Thread({ id }))} />,
    Invite: ({ id }) => <Invite id={id} />,
    // A device waiting to be signed in is approved in Settings, with its code already filled in.
    Device: () => <First me={me} />,
  })
}
