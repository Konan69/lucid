import type { Project, ProjectId } from '@vivid/contracts'
import { projects } from '@vivid/state'
import { Option } from 'effect'
import { useSyncExternalStore } from 'react'
import { LiveState, useLive, useLiveData } from '../../data/live'

/**
 * The Project the Person has narrowed their view to, if any.
 *
 * Scoping narrows what is listed, not what Vivid knows: the drawer shows the Project's Threads
 * and a new Thread is filed in it, while Vivid still reads everything the Person may see. It is
 * held outside React so the drawer, the first screen and a Project's page agree without passing
 * it down, and it lasts as long as the app is open: a phone app opened fresh shows everything.
 *
 * What is held is only an id. It counts as a scope only while the live list of Projects holds
 * that Project (`useScope`): after a change of workspace it names nothing here, so nothing is
 * narrowed and nothing is filed, and nothing has to remember to clear it.
 */

let chosen: Option.Option<ProjectId> = Option.none()
const listeners = new Set<() => void>()

const choose = (next: Option.Option<ProjectId>) => {
  chosen = next
  for (const listener of listeners) listener()
}

export const scope = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  chosen: () => chosen,
  /** Narrows the view to one Project. */
  enter: (id: ProjectId) => choose(Option.some(id)),
  /** Back to everything. */
  leave: () => choose(Option.none()),
}

/** The scoped Project, when the Person has chosen one and it is in the workspace they are in. */
export function useScope(): Option.Option<Project> {
  const data = useLiveData()
  const id = useSyncExternalStore(scope.subscribe, scope.chosen)
  const list = useLive(data.live.projects)
  if (!LiveState.$is('Ready')(list)) return Option.none()
  const all = list.value.projects
  return Option.flatMap(id, (wanted) => projects.findProject(all, wanted))
}
