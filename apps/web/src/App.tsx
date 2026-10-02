import { useAtomValue } from '@effect/atom-react'
import { ThreadId, Workspace, type MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { PanelLeft } from 'lucide-react'
import { Suspense, useState, useSyncExternalStore } from 'react'
import { live, LiveState, useLive, useLiveValue } from './data/live'
import { Route, router } from './data/route'
import { link } from './data/runtime'
import { sidebar } from './data/sidebar'
import { theme } from './data/theme'
import { startThread } from './data/threads'
import { Computer } from './screen/Computer'
import { First } from './screen/First'
import { Invite } from './screen/Invite'
import { Library } from './screen/Library'
import { Notifications } from './screen/Notifications'
import { Palette } from './screen/Palette'
import { Projects } from './screen/Projects'
import { Routines } from './screen/Routines'
import { Settings } from './screen/Settings'
import { Sidebar } from './screen/Sidebar'
import { Thread } from './screen/Thread'
import { Welcome } from './screen/Welcome'
import { Face } from './ui/Face'

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

// ⌘K / Ctrl+K finds anything, from anywhere. A module-level listener, like the sidebar's ⌘B, so
// the shortcut exists for the life of the page and not for the life of a component.
addEventListener('keydown', (event) => {
  if (event.key.toLocaleLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  setOverlay(overlay === 'palette' ? 'none' : 'palette')
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
            key={scopeOf(me)}
            route={route}
            me={me}
            panel={panel}
            onTogglePanel={() => setPanel((on) => !on)}
          />
        </Suspense>
        {panel && Route.$is('Thread')(route) && <Computer onClose={() => setPanel(false)} />}
      </main>
      {Option.isSome(section) && (
        <Settings
          me={me}
          section={section.value}
          deviceCode={Route.$is('Device')(route) ? Option.getOrElse(route.code, () => '') : ''}
        />
      )}
      {floating === 'palette' && <Palette onClose={() => setOverlay('none')} />}
      {floating === 'notifications' && <Notifications onClose={() => setOverlay('none')} />}
    </div>
  )
}

/** Which workspace the Person is in, as a key: their own space, or one Company. */
const scopeOf = (me: MeResponse) =>
  Workspace.match(me.workspace, {
    Personal: () => 'personal',
    Company: ({ company }) => company.id,
  })

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
