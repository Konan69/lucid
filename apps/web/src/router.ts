import { createRouter } from '@tanstack/react-router'
import type { ThreadId } from '@vivid/contracts'
import { Array as Arr, Option } from 'effect'
import type { SettingsSection } from './data/route'
import { routeTree } from './tree.gen'

/**
 * The app's one router. The address bar is the source of truth, so a link can be sent, a refresh
 * lands in the same place, and the back button works.
 *
 * Ported from T3 Code web (`apps/web/src/router.ts`): TanStack Router over a generated route
 * tree, with `defaultPreload: 'intent'` so a link's route is made ready while the pointer is
 * still on it. T3 builds its router in a function because its desktop shell needs hash history;
 * Vivid's desktop app loads the same origin as the browser, so there is one router and it uses
 * the browser's history.
 *
 * This module imports the route tree and nothing else of the app. The data modules import it to
 * go somewhere, and the route tree imports one of them back (`routes/thread.tsx` warms a Thread's
 * query), so they form a circle. A circle is safe exactly as long as every use across it happens
 * later, inside a function: nothing but this module touches `router` while a module is being
 * evaluated, and this module touches no data module at all. What has to happen on every arrival
 * (`sidebar.tuck`, `arrival.consider`) is subscribed in `main.tsx`, after everything exists. An
 * earlier version imported `arrival` here: the built app drew a blank page, because `arrival`
 * reads `live` as it is evaluated and `live` was still waiting on this module.
 */
// An address whose path is not validly escaped (`/t/%`) has no reading: the router's own decoder
// throws on it while matching, before any route or the not-found redirect is reached, and the
// page would open on an error. Such an address is the first screen, as any unknown one is, and
// is corrected before the router reads it. Only an address typed or pasted can be like this; the
// router never builds one. Outside a browser (a test) there is no address.
if (
  'location' in globalThis &&
  Option.isNone(Option.liftThrowable(decodeURIComponent)(location.pathname))
) {
  history.replaceState(null, '', '/')
}

/**
 * Reuses an intent-preloaded route for thirty seconds. Source: UX cache retention policy.
 * Expiry reruns its loader; the live query keeps receiving updates throughout this window.
 */
const PRELOAD_WARM_MS = 30_000

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // A loader here only opens a live query (`routes/thread.tsx`). The query stays open for the
  // registry's idle time whoever asked, so there is nothing to gain from asking again sooner.
  defaultPreloadStaleTime: PRELOAD_WARM_MS,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

/** Opens Settings on a section over wherever the Person is. */
export const openSettings = (settings: SettingsSection) =>
  router.navigate({ to: '.', search: { settings } })

/** Shuts Settings, leaving the Person where they were under it. */
export const closeSettings = () => router.navigate({ to: '.', search: {} })

/** The Thread on screen, when the address names one. */
export const threadOnScreen = (): Option.Option<ThreadId> =>
  Arr.head(
    router.state.matches.flatMap((match) => (match.routeId === '/t/$id' ? [match.params.id] : [])),
  )

/** Whether the address is the first screen itself. */
export const onFirst = () => router.state.location.pathname === '/'
