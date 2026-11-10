import {
  ProjectListResponse,
  ProjectWork,
  ThreadAudience,
  type ProjectProgress,
  type PersonSummary,
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
const nameOrder: Order.Order<Project> = Order.mapInput(Order.String, (project: Project) =>
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
    nameOrder,
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
  threads: ThreadListResponse,
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

/**
 * A Project the server has just returned from a change to its work, in the list even if the live
 * query's next result has not arrived yet. A result that already holds this revision or a later
 * one is left as it is.
 */
export const revised =
  (project: Project) =>
  (current: ProjectListResponse): ProjectListResponse =>
    new ProjectListResponse({
      projects: current.projects.map((candidate) =>
        candidate.id === project.id && candidate.revision < project.revision ? project : candidate,
      ),
    })

/** A Project's progress log, newest first: the order a Person reads where it has been. */
export const progressOf = (project: Project): ReadonlyArray<ProjectProgress> =>
  ProjectWork.match(project.work, {
    Unspecified: () => [],
    Active: ({ progress }) => [...progress].reverse(),
    Completed: ({ progress }) => [...progress].reverse(),
  })

/**
 * The colours a Project's mark can wear: Vivid's face hues, in the order they are dealt. Violet
 * and gray are left out: the product's look has no violet, and gray is what "no Project" reads as.
 */
const HUES = ['blue', 'green', 'orange', 'magenta', 'cyan', 'yellow', 'red', 'brown'] as const
export type Hue = (typeof HUES)[number]

/**
 * The colour a Project's mark wears. The server keeps no colour for a Project, so the mark takes
 * one from the Project's id: the same Project is the same colour on every device and for every
 * Person, and it never changes when the Project is renamed. When a Project carries a colour of
 * its own, this is the one function to replace.
 */
export const hueOf = (id: ProjectId): Hue => {
  let sum = 0
  for (const letter of id) sum = (sum * 31 + letter.charCodeAt(0)) % 9973
  const at = sum % HUES.length
  return HUES.reduce<Hue>((chosen, hue, index) => (index === at ? hue : chosen), HUES[0])
}

/**
 * A Project and every Project inside it, at any depth. Scoping to a Project is scoping to the
 * work under it, so a Thread filed in a Project inside it still belongs. A circular chain cannot
 * loop: a Project already gathered is not gathered again.
 */
const within = (projects: ReadonlyArray<Project>, id: ProjectId): ReadonlySet<ProjectId> => {
  const gathered = new Set<ProjectId>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const project of projects) {
      const parent = project.parentProjectId
      if (parent !== null && gathered.has(parent) && !gathered.has(project.id)) {
        gathered.add(project.id)
        grew = true
      }
    }
  }
  return gathered
}

/**
 * The Threads a scope lets through: every Thread with no scope, or the ones filed in the scoped
 * Project and the Projects inside it. Done Threads stay in, so the list's own "Done" still works.
 */
export const scopedTo = (
  threads: ReadonlyArray<Thread>,
  projects: ReadonlyArray<Project>,
  scope: Option.Option<ProjectId>,
): ReadonlyArray<Thread> =>
  Option.match(scope, {
    onNone: () => threads,
    onSome: (id) => {
      const inside = within(projects, id)
      return threads.filter((thread) => thread.projectId !== null && inside.has(thread.projectId))
    },
  })

/** How many Threads filed directly in a Project are waiting on the Person. */
export const needingYou = (threads: ReadonlyArray<Thread>, projectId: ProjectId): number =>
  threads.filter(
    (thread) =>
      thread.projectId === projectId && !thread.archived && thread.attention === 'NeedsYou',
  ).length

/** The people in a Project's Threads, each once, in the order they are first met. */
export const peopleIn = (threads: ReadonlyArray<Thread>): ReadonlyArray<PersonSummary> => {
  const met = new Map<string, PersonSummary>()
  for (const thread of threads) {
    const named = ThreadAudience.guards.People(thread.audience) ? thread.audience.participants : []
    for (const person of [thread.createdBy, ...named]) {
      if (!met.has(person.id)) met.set(person.id, person)
    }
  }
  return [...met.values()]
}

/** Every Project by name, whatever its depth: the order of a list a name is looked up in. */
export const byName = (projects: ReadonlyArray<Project>): ReadonlyArray<Project> =>
  Arr.sort(projects, nameOrder)
