import { useAtomValue } from '@effect/atom-react'
import { workspaceKey } from '@vivid/state'
import type { MeResponse, Thread as ThreadRecord } from '@vivid/contracts'
import { Array as Arr, Option, Order } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { PanelLeft } from 'lucide-react'
import { Outlet, rootRouteId, useMatch, useMatches, useSearch } from '@tanstack/react-router'
import { Fragment, lazy, Suspense } from 'react'
import { create } from 'zustand'
import { live, LiveState, useLive, useLiveValue } from './data/live'
import { panel, usePanel } from './data/panel'
import { Me } from './data/me'
import { warm } from './data/warm'
import { router, threadOnScreen } from './router'
import type { FileRoutesById } from './tree.gen'
import { engine, link } from './data/runtime'
import { sidebar, sidebarShown, useSidebar } from './data/sidebar'
import { Palette } from './screen/Palette'
import { Sidebar } from './screen/Sidebar'
import { Welcome } from './screen/Welcome'
import { IconButton } from './ui/button'
import { Face } from './ui/Face'
import { Sayings } from './ui/Sayings'

// The screens a Person may not open in a session, each in its own file on the wire: the Thread
// is what loads first, and the Computer's screen client alone is a third of everything else.
// Each is fetched when it is first drawn, and all of them are fetched once the first screen is
// up and the browser is idle, so opening one later does not wait on the network. Routines, the
// Library and Projects are places, so the router holds their files (`src/routes`) and is asked
// to make them ready; the Computer and Settings open over a place and are held here.
const overlays = {
  Computer: () => import('./screen/Computer'),
  Settings: () => import('./screen/Settings'),
}
const Computer = lazy(() => overlays.Computer().then((module) => ({ default: module.Computer })))
const Settings = lazy(() => overlays.Settings().then((module) => ({ default: module.Settings })))

const afterFirst = () => {
  for (const load of Object.values(overlays)) void load()
  void router.preloadRoute({ to: '/routines' })
  void router.preloadRoute({ to: '/library' })
  void router.preloadRoute({ to: '/projects/{-$id}', params: { id: undefined } })
}
if ('requestIdleCallback' in globalThis) requestIdleCallback(afterFirst)
else setTimeout(afterFirst, 2000)

// The lists of the places beside Threads are begun the moment it is known who is signed in, and
// held open from then on: a Person who goes to Routines a fifth of a second after the page shows
// should find it drawn. It is heard from the query itself, so it happens once and before any
// screen asks. What it begins is a few small subscriptions on the socket `me` came over.
const stopWaiting = engine.registry.subscribe(
  live.me.atom,
  (me) => {
    if (!AsyncResult.isSuccess(me)) return
    // A turn later: on a device that kept `me`, this is heard as the subscription is being made,
    // before there is a way to end it.
    queueMicrotask(() => {
      stopWaiting()
      warm.places()
    })
  },
  { immediate: true },
)

/** What floats over the app. One at a time, because each takes the keyboard. */
type Overlay = 'none' | 'palette'

/** Which overlay is up. A store, because the shortcuts below open and close it from no component. */
const useOverlay = create<{ readonly overlay: Overlay }>(() => ({ overlay: 'none' }))
const setOverlay = (overlay: Overlay) => useOverlay.setState({ overlay })

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
  const at = Option.match(threadOnScreen(), {
    onNone: () => -1,
    onSome: (here) => threads.findIndex((thread) => thread.id === here),
  })
  const next = Option.fromUndefinedOr(
    threads[at === -1 ? 0 : Math.min(Math.max(at + by, 0), threads.length - 1)],
  )
  if (Option.isSome(next)) void router.navigate({ to: '/t/$id', params: { id: next.value.id } })
}

/** Whether a modal is open: Settings, a confirmation, the palette. */
const inDialog = () => document.querySelector('[aria-modal="true"]') !== null

/**
 * Whether going somewhere else now would throw away something being written. The shortcuts that
 * change the screen stand down inside a dialog and while the keyboard is in a field of an editor
 * (a Routine, a Library item, a rule): leaving unmounts it with whatever was typed. The Thread's
 * own composer is the exception, because what is typed there is kept for its place.
 */
const leavingWouldLose = (event: KeyboardEvent) => {
  if (inDialog()) return true
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  const editing = target.isContentEditable || target.matches('input, textarea, select')
  return editing && target.closest('[data-keeps-draft]') === null
}

// The shortcuts that work from anywhere. They are module-level listeners, like the sidebar's ⌘B,
// so they exist for the life of the page and not for the life of a component.
//   ⌘K          find anything, do anything
//   ⌘⇧O         new thread
//   ⌘⇧[  ⌘⇧]    the thread before, the thread after
/** ⌘K: opens the palette over the app, and always closes it. */
const togglePalette = (event: KeyboardEvent) => {
  // Over a dialog that is already open (Settings, a confirmation) the palette would be a second
  // modal on top of the first; it only opens over the app itself.
  const { overlay } = useOverlay.getState()
  if (overlay !== 'palette' && inDialog()) return
  event.preventDefault()
  setOverlay(overlay === 'palette' ? 'none' : 'palette')
}

/** ⌘⇧O and ⌘⇧[ ]: the shortcuts that change the screen, which stand down over unsaved writing. */
const goElsewhere = (event: KeyboardEvent) => {
  if (leavingWouldLose(event)) return
  if (event.key.toLocaleLowerCase() === 'o') {
    event.preventDefault()
    setOverlay('none')
    void router.navigate({ to: '/' })
    return
  }
  // By position on the keyboard, not by character: with Shift held the key reads "{" or "}".
  if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
    event.preventDefault()
    step(event.code === 'BracketLeft' ? -1 : 1)
  }
}

addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return
  // Not while an input method is composing, and not for a key something else already used.
  if (event.defaultPrevented || event.isComposing) return
  if (event.shiftKey) goElsewhere(event)
  else if (event.key.toLocaleLowerCase() === 'k') togglePalette(event)
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
      className="pointer-events-none fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full px-3 py-1 text-meta text-ink-2 lift glass transition-opacity delay-1000 duration-(--dur-base) starting:opacity-0"
    >
      Reconnecting…
    </p>
  )
}

function Shell({ me }: { me: MeResponse }) {
  // Each of these re-renders the shell only when its own answer changes, not on every move.
  const onThread = useMatch({ from: '/t/$id', shouldThrow: false, select: () => true }) === true
  const section = Option.fromUndefinedOr(useSearch({ from: rootRouteId }).settings)
  // The deepest match is the place; the root alone is on screen only while an unknown address
  // is being corrected.
  const screen = useMatches({
    select: (matches) =>
      matches.reduce<(typeof SCREEN)[keyof typeof SCREEN]>(
        (_, match) => SCREEN[match.routeId],
        SCREEN.__root__,
      ),
  })
  const sidebarOpen = useSidebar(sidebarShown)
  const floating = useOverlay((state) => state.overlay)
  const beside = usePanel((state) => state.open)
  const notices = useLiveValue(live.notifications)

  return (
    <div className="group/shell relative flex size-full" data-rail={sidebarOpen ? 'open' : 'shut'}>
      <Sidebar
        me={me}
        open={sidebarOpen}
        onHide={sidebar.toggle}
        onSearch={() => setOverlay('palette')}
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
        // The way back to a hidden sidebar, in the corner its own "Hide sidebar (⌘B)" button
        // stood in. Its label names the shortcut too, as that one does, and is what the tooltip says.
        <IconButton
          label="Show sidebar (⌘B)"
          onClick={sidebar.show}
          className="absolute top-2 left-2 z-30"
        >
          <PanelLeft className="size-4" />
        </IconButton>
      )}
      <main className="relative flex min-w-0 flex-1">
        <Suspense fallback={<Splash />}>
          {/* A new element for each screen, so its arrival plays; see `SCREEN`. */}
          <div key={screen} className="flex min-w-0 flex-1 motion-screen">
            {/* A screen holds things that belong to the workspace it was opened in: the folder it
                is in, the item it has open, a half-written Routine. Changing workspace starts each
                screen again, so nothing of one Company is left on screen under another's name. */}
            <Fragment key={workspaceKey(me.workspace)}>
              {/* The screen the address names (`src/routes`, `src/place`). */}
              <Me value={Option.some(me)}>
                <Outlet />
              </Me>
            </Fragment>
          </div>
        </Suspense>
        {beside && onThread && (
          <Suspense fallback={null}>
            <Computer onClose={panel.hide} />
          </Suspense>
        )}
      </main>
      {Option.isSome(section) && (
        <Suspense fallback={null}>
          <Settings
            // What is half-typed in Settings belongs to the workspace it was opened in.
            key={workspaceKey(me.workspace)}
            me={me}
            section={section.value}
          />
        </Suspense>
      )}
      {floating === 'palette' && <Palette onClose={() => setOverlay('none')} />}
    </div>
  )
}

/**
 * Which screen a place is, for the moment one screen takes over from another. Going from one
 * Thread to the next, or from the first screen into the Thread it started, is the same screen
 * with different words in it and changes at once: it is done a hundred times a day, and the
 * shortcuts that do it are the keyboard's. Going to Routines, the Library or Projects is a
 * different screen, and that one arrives (`motion-screen`).
 *
 * Every route is named, the root too (it is the deepest match while an unknown address is being
 * corrected), so a route added to the tree does not typecheck until it is given a screen here.
 */
const SCREEN = {
  __root__: 'thread',
  '/': 'thread',
  '/t/$id': 'thread',
  '/invite/$id': 'thread',
  '/routines': 'routines',
  '/library': 'library',
  '/projects/{-$id}': 'projects',
} as const satisfies Record<keyof FileRoutesById, string>
