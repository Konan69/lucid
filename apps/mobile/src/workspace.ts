import type {
  ConnectionId,
  LibraryFolderId,
  LibraryShelf,
  MeResponse,
  ProjectId,
  Role,
  Service,
  ThreadId,
} from '@vivid/contracts'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Option } from 'effect'
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { First } from './data/first'
import type { Front, FrontStore } from './data/front'
import type { KeyRoute } from './data/connecting'

/**
 * Where a signed-in Person can be in the app. Every place is a screen on one native stack, so
 * going somewhere puts it over the first screen and the system's way back returns.
 *
 * - `Home`: the first screen and the root. It is somewhere to write to start a new Thread, or
 *   one Thread, in the same place (`data/front.ts`); a Thread is not a screen of its own, so
 *   starting or choosing one never changes screens.
 * - `Computer`: Vivid's computer, reached from a Thread's bar: where it stands and its controls.
 * - `Library`: the place beside Threads, in the drawer. `Projects` is reached from
 *   the quiet group under the Threads.
 * - `Folder`, `Project`: one level down inside the Library or a Project. Each level is its own
 *   screen, so going deeper pushes and the back swipe climbs out one level at a time. A folder
 *   carries its name because only the listing it was opened from knows it.
 * - `Settings`: the Person's own settings; `People` is who is in the Company they are working in,
 *   and `Memory` is what Vivid has kept about the Person, for them to correct or remove.
 *   `Texting` is where they connect their phone number so they can text Vivid.
 * - `Integrations`: the services Vivid can use, and the catalog to connect more from. A screen
 *   and not a sheet over Settings, because the two sheets below are presented from it, and the
 *   platform cannot present one over a React Native `Modal`.
 * - `Account`: one connected account's own bottom sheet (name it, add another, disconnect it),
 *   by its id, so it is drawn from the live list and shows the account as it stands now.
 * - `NameAccount`: the bottom sheet that asks what to call an account before it is begun, on a
 *   service that does not say who signs in. It is opened over the Integrations page and over a
 *   Thread, from the card that asks for one more account. `shared` is whether the account is
 *   for the Person's Company (an admin's choice) and not for the Person alone. `card` is the card
 *   in a Thread that asked, when one did (the tool call it stands for), so the account it begins
 *   is that card's to carry on from. Route params are plain data, so absence is `null` here and
 *   an `Option` the moment it is read.
 * - `Key`: the bottom sheet that takes the key a service asks for. It carries the attempt that
 *   asked for it (said back to the session's machine as the sheet ends), which Integration the
 *   key is for, the service's name, and the fields it asks for (their names and labels, never
 *   what is typed).
 * - `Notifications`: what finished or needs the Person while they were elsewhere, in the drawer.
 */
export type Routes = {
  Home: undefined
  Computer: undefined
  Library: undefined
  Folder: { shelf: LibraryShelf; id: LibraryFolderId; name: string }
  Projects: undefined
  Project: { id: ProjectId }
  Settings: undefined
  People: undefined
  Memory: undefined
  Texting: undefined
  Integrations: undefined
  Account: { id: ConnectionId }
  NameAccount: {
    service: Service['id']
    serviceName: string
    shared: boolean
    card: string | null
  }
  Key: KeyRoute
  Notifications: undefined
}

/**
 * The signed-in Person and where they are working, for every screen inside the shell. The shell
 * is drawn only once `live.me` has answered, so a screen never has to handle not knowing who is
 * signed in. `null` is the value outside the shell, where no such screen is drawn.
 */
const MeContext = createContext<MeResponse | null>(null)

export const MeProvider = MeContext.Provider

export function useMe(): MeResponse {
  const me = useContext(MeContext)
  if (me === null) throw new Error('This screen is drawn outside the signed-in shell.')
  return me
}

/**
 * The stack every screen is on, typed by where it can go. `navigate` goes to a place; `push` is
 * for going a level deeper into the same kind of place (a Project inside a Project), which
 * `navigate` would treat as already being there.
 */
export const useGo = () => useNavigation<NativeStackNavigationProp<Routes>>()

/**
 * What the first screen is showing, for every screen inside the shell (`data/front.ts`). `null`
 * is the value outside the shell, as it is for `MeContext`.
 */
const FrontContext = createContext<FrontStore | null>(null)

export const FrontProvider = FrontContext.Provider

/** The store of what the first screen shows: to put a Thread there, or to start afresh. */
export function useFront(): FrontStore {
  const front = useContext(FrontContext)
  if (front === null) throw new Error('This screen is drawn outside the signed-in shell.')
  return front
}

/** What the first screen is showing right now. */
export function useShowing(): Front {
  const front = useFront()
  return useSyncExternalStore(front.subscribe, front.showing, front.showing)
}

/**
 * A Thread's first words, when it was started from this phone's greeting and how far they have
 * got (`data/first.ts`). Nothing for every other Thread.
 */
export function useFirst(id: ThreadId): Option.Option<First> {
  const { firsts } = useFront()
  const all = useSyncExternalStore(firsts.subscribe, firsts.all, firsts.all)
  return Option.fromUndefinedOr(all.get(id))
}

/**
 * Opens a Thread from a screen that is over the first one (a Project, a notification):
 * the Thread is put in front, and the stack returns to the first screen, where it is.
 */
export function useOpenThread(): (id: ThreadId) => void {
  const front = useFront()
  const go = useGo()
  return (id) => {
    front.open(id, false)
    go.popTo('Home')
  }
}

/** A Membership's role as it is written on screen. A new role fails to compile here. */
export const ROLE_NAME = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
} as const satisfies Record<Role, string>
