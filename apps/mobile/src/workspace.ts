import { createContext, useContext } from 'react'
import { useWindowDimensions } from 'react-native'
import { useNavigation, type NavigationProp } from '@react-navigation/native'
import type { Api, Connection } from './lib/api'
import type { ThemePreference } from './theme'
import { deriveLayout } from './lib/layout'
import { resolveThreadSelectionNavigationAction } from './lib/adaptive-navigation'
export type Routes = {
  Home: undefined
  Chat: { id: string; title: string; draft?: string; sendOnOpen?: boolean }
  Today: undefined
  Routines: undefined
  Library: undefined
  Projects: undefined
  Connectors: undefined
  Settings: undefined
}
export type Preferences = Connection & {
  theme: ThemePreference
  pinnedThreads?: string[]
  settledThreads?: string[]
}
type WorkspaceValue = {
  api: Api
  preferences: Preferences
  savePreferences: (next: Preferences) => Promise<void>
  createThread: (draft?: string) => Promise<{ id: string; title: string; draft?: string }>
}
export const WorkspaceContext = createContext<WorkspaceValue | null>(null)
export function useWorkspace() {
  const workspace = useContext(WorkspaceContext)
  if (workspace === null) throw new Error('Workspace context is unavailable.')
  return workspace
}
export const SidebarContext = createContext({
  open: () => {},
  close: () => {},
  activeThread: '',
  activeRoute: 'Home',
})
export const useSidebar = () => useContext(SidebarContext)
export type ThreadActivity = 'ready' | 'working' | 'attention' | 'approve' | 'failed' | 'done'
export const ActivityContext = createContext<{
  activity: Record<string, ThreadActivity>
  report: (id: string, status?: ThreadActivity) => void
}>({ activity: {}, report: () => {} })
export const useThreadActivity = () => useContext(ActivityContext)
/**
 * The web-style pathname of the current native route, recorded so a Thread opened from the
 * sidebar can return to where the Person was. Home is the root and a Chat is its Thread's path.
 */
function pathnameOf(route: keyof Routes, id: string): string {
  if (route === 'Home') return '/'
  return route === 'Chat' ? `/threads/vivid/${id}` : `/${route}`
}

export function useOpenThread() {
  const sidebar = useSidebar()
  const navigation = useNavigation<NavigationProp<Routes>>()
  const dimensions = useWindowDimensions()
  return (id: string, title: string, draft?: string) => {
    sidebar.close()
    const current = navigation.getState().routes.at(-1)
    let pathname = '/'
    if (current !== undefined) {
      pathname = pathnameOf(current.name, id)
    }
    const action = resolveThreadSelectionNavigationAction({
      usesSplitView: deriveLayout(dimensions).usesSplitView,
      pathname,
    })
    if (action === 'set-params') navigation.navigate('Chat', { id, title, draft })
    else if (action === 'replace')
      navigation.reset({
        index: 1,
        routes: [{ name: 'Home' }, { name: 'Chat', params: { id, title, draft } }],
      })
    else navigation.navigate('Chat', { id, title, draft })
  }
}
