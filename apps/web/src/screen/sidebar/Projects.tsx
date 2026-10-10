import type { Project, ProjectId, Thread } from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { Option } from 'effect'
import { ChevronRight } from 'lucide-react'
import { create } from 'zustand'
import { kept } from '../../data/kept'
import { router } from '../../router'
import { scope } from '../../data/scope'
import { cn } from '../../ui/cn'
import { Count } from '../../ui/Count'
import { Mark } from '../project/Mark'
import { CAPTION, FULL, HOVER, ROW } from './rows'

/** Going to a Project is scoping to it: its page opens and the Thread list narrows to it. */
export function openProject(id: ProjectId) {
  scope.enter(id)
  void router.navigate({ to: '/projects/{-$id}', params: { id: id } })
}

// Whether the group is folded away is the Person's choice on this browser, like the sidebar's
// width. It is a Zustand store, as T3 Code web keeps its interface state
// (`apps/web/src/rightPanelStore.ts`), so the caption needs no effect to remember it: the choice
// is read once, when the store is made, and written when it is changed (`folded` or `open`).
const key = 'vivid.projects'
const useFold = create(() => ({ folded: Option.contains(kept.read(key), 'folded') }))
const fold = {
  toggle: () => {
    const folded = !useFold.getState().folded
    useFold.setState({ folded })
    kept.write(key, folded ? 'folded' : 'open')
  },
}

/** More Projects than this and the rail would be all Projects; the rest are one row away. */
const SHOWN = 6

/**
 * Projects, above the Threads: each one a row with its own colour and, when any of its Threads is
 * waiting on the Person, how many. The group ends with the quiet way to make another. With no
 * Projects it is that one row and nothing else, with no heading over a list of nothing.
 *
 * The layout is ChatGPT's sidebar ("Projects ›" as a caption that folds, above the recent
 * conversations; see `artifacts/night/reviews/ui-mining/catalogue/chatgpt.md` and the owner's
 * screenshot). Vivid adds the colour mark and the count, and a Project's row is also what scopes
 * the view to it (`openProject`).
 */
export function ProjectGroup({
  projects,
  threads,
  scoped,
  open,
}: {
  projects: ReadonlyArray<Project>
  /** Every Thread the Person can see, unscoped: a Project's count does not depend on the scope. */
  threads: ReadonlyArray<Thread>
  /** The Project the view is narrowed to: its row is said in full ink. */
  scoped: Option.Option<ProjectId>
  /** The Project whose page is on screen: its row carries the fill, as any open row does. */
  open: Option.Option<ProjectId>
}) {
  const isFolded = useFold((state) => state.folded)
  const top = projectsData.projectsIn(projects, null)
  const shown = top.slice(0, SHOWN)
  const more = top.length - shown.length

  return (
    <section>
      {top.length > 0 && (
        <h3 className="mt-1">
          <button
            onClick={fold.toggle}
            aria-expanded={!isFolded}
            className={cn(
              'group/caption flex cursor-pointer items-center gap-1 rounded-row px-2.5 text-meta font-title text-ink-3 transition-colors duration-(--dur-fast) hover:text-ink focus-visible:-outline-offset-2',
              CAPTION,
            )}
          >
            Projects
            <ChevronRight
              className={cn(
                'size-3 text-ink-4 transition-transform duration-(--dur-fast) group-hover/caption:text-ink-2',
                !isFolded && 'rotate-90',
              )}
            />
          </button>
        </h3>
      )}
      {top.length > 0 && !isFolded && (
        <ul className="flex flex-col gap-px">
          {shown.map((project) => (
            <li key={project.id}>
              <ProjectRow
                project={project}
                needing={projectsData.needingYou(threads, project.id)}
                scoped={Option.contains(scoped, project.id)}
                open={Option.contains(open, project.id)}
              />
            </li>
          ))}
          {more > 0 && (
            <li>
              <button
                onClick={() =>
                  void router.navigate({ to: '/projects/{-$id}', params: { id: undefined } })
                }
                className={cn(ROW, FULL, HOVER, 'text-ink-3 hover:text-ink')}
              >
                <span className="size-5.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-label">{more} more</span>
                <ChevronRight className="size-3.5 text-ink-4 group-hover/row:text-ink-2" />
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

/**
 * One Project: its colour, its name, and how many of its Threads are waiting on the Person.
 *
 * Being scoped to a Project and having its page open are two facts. The fill means what it means
 * on every row of the rail, "this is what is on screen"; the scope is said in the name's weight,
 * so a scoped Project and the open Thread under it are never two filled rows at once.
 */
function ProjectRow({
  project,
  needing,
  scoped,
  open,
}: {
  project: Project
  needing: number
  scoped: boolean
  open: boolean
}) {
  return (
    <button
      onClick={() => openProject(project.id)}
      aria-current={open ? 'page' : undefined}
      className={cn(ROW, FULL, open ? 'bg-wash-selected' : HOVER)}
    >
      <span className="inline-flex size-5.5 shrink-0 items-center justify-center">
        <Mark id={project.id} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-label',
          scoped && 'font-strong',
          scoped || open ? 'text-ink' : 'text-ink-2 group-hover/row:text-ink',
        )}
      >
        {project.name}
      </span>
      {needing > 0 && (
        <span
          className="text-meta font-title text-attention"
          aria-label={`${needing} ${needing === 1 ? 'thread needs' : 'threads need'} you`}
        >
          <Count value={needing} />
        </span>
      )}
    </button>
  )
}
