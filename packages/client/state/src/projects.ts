import {
  ProjectListResponse,
  type Project,
  type ProjectId,
  type Thread,
  type ThreadListResponse,
} from '@vivid/contracts'
import { Array as Arr, Option, Order } from 'effect'

/**
 * Projects, as pure functions over what the server sends.
 *
 * A Project is a place work is filed: it has a name, it may sit inside another Project, and
 * Threads are filed in it. The screen reads `live.projects` and `live.threads`; this module only
 * arranges them. Nothing here is invented: a Project shows its name, how many Threads are filed in
 * it and when one of them last moved, because that is all the server says about it.
 */

export type { Project }

/** Projects by name, whatever its case, so the shelf does not reshuffle each time a Thread moves. */
const byName: Order.Order<Project> = Order.mapInput(Order.String, (project: Project) =>
  project.name.toLocaleLowerCase(),
)

/** Most recently moved first. */
const byLastMove: Order.Order<Thread> = Order.mapInput(
  Order.flip(Order.Number),
  (thread: Thread) => thread.updatedAt,
)

/** The Projects directly inside `parentId`, or the top-level ones when it is `null`. */
export const projectsIn = (
  projects: ReadonlyArray<Project>,
  parentId: ProjectId | null,
): ReadonlyArray<Project> =>
  Arr.sort(
    projects.filter((project) => project.parentProjectId === parentId),
    byName,
  )

/** One Project by id, when the Person can still see it. */
export const findProject = (
  projects: ReadonlyArray<Project>,
  id: ProjectId,
): Option.Option<Project> => Option.fromUndefinedOr(projects.find((project) => project.id === id))

/**
 * The Projects above one, outermost first. It stops at a parent the Person cannot see and at a
 * Project it has already passed, so a broken or circular chain ends the trail instead of the page.
 */
export const trailTo = (
  projects: ReadonlyArray<Project>,
  project: Project,
): ReadonlyArray<Project> => {
  const trail: Array<Project> = []
  const passed = new Set<ProjectId>([project.id])
  let parentId = project.parentProjectId
  while (parentId !== null && !passed.has(parentId)) {
    const above = parentId
    const parent = projects.find((candidate) => candidate.id === above)
    if (parent === undefined) break
    passed.add(parent.id)
    trail.unshift(parent)
    parentId = parent.parentProjectId
  }
  return trail
}

/** The Threads the Person can open that are filed in one Project, most recently moved first. */
export const threadsIn = (
  threads: typeof ThreadListResponse.Type,
  projectId: ProjectId,
): ReadonlyArray<Thread> =>
  Arr.sort(
    threads.threads.filter((thread) => thread.projectId === projectId && !thread.archived),
    byLastMove,
  )

/**
 * How many Threads are filed in a Project that the Person is not in. A Project counts every
 * Thread filed in it; the list shows only the ones this Person can open. It never goes below zero:
 * the two numbers come from two live queries that can be a moment apart.
 */
export const hiddenThreads = (project: Project, visible: ReadonlyArray<Thread>): number =>
  Math.max(0, project.threadCount - visible.length)

/** "1 Thread", "4 Threads". */
export const countThreads = (count: number): string =>
  `${count} ${count === 1 ? 'Thread' : 'Threads'}`

/** When something in a Project last moved, as a date and a time. */
export const formatMoved = (updatedAt: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(updatedAt)

/**
 * A Project the server has just returned from a call, in the list even if the live query's next
 * result has not arrived yet. It adds nothing when that result got there first.
 */
export const confirmed =
  (project: Project) =>
  (current: ProjectListResponse): ProjectListResponse =>
    current.projects.some((candidate) => candidate.id === project.id)
      ? current
      : new ProjectListResponse({ projects: [project, ...current.projects] })
