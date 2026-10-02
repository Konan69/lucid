import type {
  LibraryFolderId,
  LibraryShelf,
  MeResponse,
  ProjectId,
  Role,
  ThreadId,
} from '@vivid/contracts'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { createContext, useContext } from 'react'

/**
 * Where a signed-in Person can be in the app. Every place is a screen on one native stack, so
 * going somewhere pushes it and the system's back swipe returns.
 *
 * - `Home`: every Thread the Person can see, and somewhere to write to start a new one. It is
 *   the root, so it is also the first screen: with no Threads yet it is just Vivid and a composer.
 * - `Chat`: one Thread. Only its id travels; its title and everything else are read live.
 * - `Computer`: Vivid's computer, reached from a Thread's bar: where it stands and its controls.
 * - `Routines`, `Projects`, `Library`, `Skills`: the places beside Threads.
 * - `Folder`, `Project`: one level down inside the Library or a Project. Each level is its own
 *   screen, so going deeper pushes and the back swipe climbs out one level at a time. A folder
 *   carries its name because only the listing it was opened from knows it.
 * - `Settings`: the Person's own settings; `People` is who is in the Company they are working in,
 *   and `Memory` is what Vivid has kept about the Person, for them to correct or remove.
 */
export type Routes = {
  Home: undefined
  Chat: { id: ThreadId }
  Computer: undefined
  Routines: undefined
  Library: undefined
  Folder: { shelf: LibraryShelf; id: LibraryFolderId; name: string }
  Projects: undefined
  Project: { id: ProjectId }
  Skills: undefined
  Settings: undefined
  People: undefined
  Memory: undefined
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

/** A Membership's role as it is written on screen. A new role fails to compile here. */
export const ROLE_NAME = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
} as const satisfies Record<Role, string>
