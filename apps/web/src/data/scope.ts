import { ProjectId, type Project } from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { Option } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { create } from 'zustand'
import { kept } from './kept'
import { live, useLiveValue } from './live'
import { engine } from './runtime'

/**
 * The Project the Person has narrowed their view to, if any.
 *
 * Scoping narrows what is listed, not what Vivid knows: the Thread list shows the Project's
 * Threads and a new Thread is filed in it, while Vivid still reads everything the Person may see.
 * The choice is this browser's, kept between visits like the sidebar's width, and held in a store
 * so starting a Thread (which is not a component) can read it.
 *
 * What is kept is only an id. It counts as a scope only while the live list of Projects holds
 * that Project: after a change of workspace the kept id names nothing here, so nothing is
 * narrowed and nothing is filed, and it means something again on the way back. Nothing has to
 * remember to clear it.
 *
 * A Zustand store, as T3 Code web keeps its interface state (`apps/web/src/rightPanelStore.ts`).
 * It holds the id that was chosen, whether or not it names a Project here; screens read
 * `useScope`, which answers with the Project. The id is read from the browser once, when the
 * store is made, and written by `choose`, so what is kept stays the bare id it always was.
 */

const key = 'vivid.scope'

const useChosen = create<{ readonly chosen: Option.Option<ProjectId> }>()(() => ({
  chosen: Option.map(kept.read(key), (id) => ProjectId.make(id)),
}))

const choose = (chosen: Option.Option<ProjectId>) => {
  useChosen.setState({ chosen })
  Option.match(chosen, {
    onNone: () => kept.remove(key),
    onSome: (id) => kept.write(key, id),
  })
}

export const scope = {
  /** Narrows the view to one Project. */
  enter: (id: ProjectId) => choose(Option.some(id)),
  /** Back to everything. */
  leave: () => choose(Option.none()),
  /**
   * The Project a Thread started now is filed in: the scoped one when the live list holds it,
   * none otherwise. An id the server would refuse is never sent, so a stale scope cannot stop a
   * Thread from being started.
   */
  filing: (): ProjectId | null => {
    const list = engine.registry.get(live.projects.atom)
    const { chosen } = useChosen.getState()
    if (Option.isNone(chosen) || !AsyncResult.isSuccess(list)) return null
    const id = chosen.value
    return list.value.projects.some((project) => project.id === id) ? id : null
  },
}

/** The scoped Project, when the Person has chosen one and it is in the workspace they are in. */
export function useScope(): Option.Option<Project> {
  const id = useChosen((state) => state.chosen)
  const list = useLiveValue(live.projects)
  return Option.flatMap(list, (value) =>
    Option.flatMap(id, (wanted) => projectsData.findProject(value.projects, wanted)),
  )
}
