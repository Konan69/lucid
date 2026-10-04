import { InvitationId, ProjectId, ThreadId } from '@vivid/contracts'
import { Data, Option, Schema } from 'effect'

/**
 * Where the Person is in the app. The address bar is the source of truth, so a link can be sent,
 * a refresh lands in the same place, and the back button works; React reads it as an external
 * store instead of mirroring it into state.
 *
 * - `New`: the first screen, a Thread that does not exist yet.
 * - `Thread`: one Thread.
 * - `Routines`, `Library`: the places beside Threads.
 * - `Projects`: the shelf of Projects, or one Project open on it. The open one rides in the path
 *   so the sidebar's group can link straight to a Project.
 * - `Invite`: an invitation to a Company, shown before it is accepted.
 * - `Device`: approving a phone or desktop app that is asking to sign in as this Person.
 */
export type Route = Data.TaggedEnum<{
  New: {}
  Thread: { readonly id: ThreadId }
  Routines: {}
  Library: {}
  Projects: { readonly open: Option.Option<ProjectId> }
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
  'texting',
  'devices',
  'record',
] as const)
export type SettingsSection = typeof SettingsSection.Type

const decodeSection = Schema.decodeUnknownOption(SettingsSection)

const PLACES = new Map<string, Route>([
  ['routines', Route.Routines()],
  ['library', Route.Library()],
  ['projects', Route.Projects({ open: Option.none() })],
])

/**
 * One part of a path, as it was before it was escaped. A part that was never validly escaped
 * (`/t/%`) has no reading, where the browser's own decoder would throw and take the page with it.
 */
const unescaped = Option.liftThrowable(decodeURIComponent)

/** Reads a path. Anything unrecognised is the first screen rather than an error page. */
export function parseRoute(pathname: string, search: string): Route {
  const [first, second] = pathname.split('/').filter((part) => part.length > 0)
  if (first === undefined) return Route.New()
  const named = second === undefined ? Option.none<string>() : unescaped(second)
  if (first === 't' && Option.isSome(named)) {
    return Route.Thread({ id: ThreadId.make(named.value) })
  }
  if (first === 'invite' && Option.isSome(named)) {
    return Route.Invite({ id: InvitationId.make(named.value) })
  }
  if (first === 'projects' && Option.isSome(named)) {
    return Route.Projects({ open: Option.some(ProjectId.make(named.value)) })
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
    Routines: () => '/routines',
    Library: () => '/library',
    Projects: ({ open }) =>
      Option.match(open, {
        onNone: () => '/projects',
        onSome: (id) => `/projects/${encodeURIComponent(id)}`,
      }),
    Invite: ({ id }) => `/invite/${encodeURIComponent(id)}`,
    Device: () => '/device',
  })

const listeners = new Set<() => void>()
let current = parseRoute(location.pathname, location.search)
let settings = decodeSection(new URLSearchParams(location.search).get('settings'))
if (Route.$is('Device')(current)) settings = Option.some('devices')

/**
 * The Settings section the address asks for. A device's approval link (`/device?user_code=…`) is
 * a request to open Devices with its code filled in, wherever the Person happens to land.
 */
const sectionAt = (route: Route, search: string) =>
  Route.$is('Device')(route)
    ? Option.some<SettingsSection>('devices')
    : decodeSection(new URLSearchParams(search).get('settings'))

const read = () => {
  current = parseRoute(location.pathname, location.search)
  settings = sectionAt(current, location.search)
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
