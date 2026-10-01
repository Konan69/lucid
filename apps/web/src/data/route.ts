import { InvitationId, ThreadId } from '@vivid/contracts'
import { Data, Option, Schema } from 'effect'

/**
 * Where the Person is in the app. The address bar is the source of truth, so a link can be sent,
 * a refresh lands in the same place, and the back button works; React reads it as an external
 * store instead of mirroring it into state.
 *
 * - `New`: the first screen, a Thread that does not exist yet.
 * - `Thread`: one Thread.
 * - `Today`, `Routines`, `Library`, `Projects`: the four places beside Threads.
 * - `Invite`: an invitation to a Company, shown before it is accepted.
 * - `Device`: approving a phone or desktop app that is asking to sign in as this Person.
 */
export type Route = Data.TaggedEnum<{
  New: {}
  Thread: { readonly id: ThreadId }
  Today: {}
  Routines: {}
  Library: {}
  Projects: {}
  Invite: { readonly id: InvitationId }
  Device: { readonly code: Option.Option<string> }
}>
export const Route = Data.taggedEnum<Route>()

/** The Settings overlay's sections. Which one is open rides in the query so it can be linked to. */
export const SettingsSection = Schema.Literals([
  'general',
  'people',
  'connections',
  'rules',
  'memory',
  'devices',
  'record',
] as const)
export type SettingsSection = typeof SettingsSection.Type

const decodeSection = Schema.decodeUnknownOption(SettingsSection)

const PLACES = new Map<string, Route>([
  ['today', Route.Today()],
  ['routines', Route.Routines()],
  ['library', Route.Library()],
  ['projects', Route.Projects()],
])

/** Reads a path. Anything unrecognised is the first screen rather than an error page. */
export function parseRoute(pathname: string, search: string): Route {
  const [first, second] = pathname.split('/').filter((part) => part.length > 0)
  if (first === undefined) return Route.New()
  if (first === 't' && second !== undefined) {
    return Route.Thread({ id: ThreadId.make(decodeURIComponent(second)) })
  }
  if (first === 'invite' && second !== undefined) {
    return Route.Invite({ id: InvitationId.make(decodeURIComponent(second)) })
  }
  if (first === 'device') {
    return Route.Device({
      code: Option.fromNullOr(new URLSearchParams(search).get('user_code')),
    })
  }
  const place = PLACES.get(first)
  return place === undefined ? Route.New() : place
}

export const pathOf = (route: Route): string =>
  Route.$match(route, {
    New: () => '/',
    Thread: ({ id }) => `/t/${encodeURIComponent(id)}`,
    Today: () => '/today',
    Routines: () => '/routines',
    Library: () => '/library',
    Projects: () => '/projects',
    Invite: ({ id }) => `/invite/${encodeURIComponent(id)}`,
    Device: () => '/device',
  })

const listeners = new Set<() => void>()
let current = parseRoute(location.pathname, location.search)
let settings = decodeSection(new URLSearchParams(location.search).get('settings'))

const read = () => {
  current = parseRoute(location.pathname, location.search)
  settings = decodeSection(new URLSearchParams(location.search).get('settings'))
  for (const listener of listeners) listener()
}

// The back and forward buttons change the address without telling anyone but this listener.
addEventListener('popstate', read)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const router = {
  subscribe,
  route: () => current,
  settings: () => settings,
  /** Goes somewhere, leaving the place the Person was in the history. */
  go: (route: Route) => {
    history.pushState(null, '', pathOf(route))
    read()
  },
  /** Corrects the address without adding a history entry, for a route that just became invalid. */
  replace: (route: Route) => {
    history.replaceState(null, '', pathOf(route))
    read()
  },
  /** Opens Settings on a section over wherever the Person is, or closes it. */
  openSettings: (section: Option.Option<SettingsSection>) => {
    const address = new URL(location.href)
    Option.match(section, {
      onNone: () => address.searchParams.delete('settings'),
      onSome: (name) => address.searchParams.set('settings', name),
    })
    history.pushState(null, '', `${address.pathname}${address.search}`)
    read()
  },
}
