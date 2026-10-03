import type { ProjectId } from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { Option } from 'effect'
import { ChevronRight, FolderKanban } from 'lucide-react'
import { useState } from 'react'
import { live, useLiveValue } from '../../data/live'
import { Route, router } from '../../data/route'
import { cn } from '../../ui/cn'
import { FULL, HOVER, ROW, TOOL } from './rows'

/**
 * Projects, under the Threads. A Project is where Threads are filed, not a place a Person starts
 * from, so it is not a row beside New thread. It is one quiet line below the list, closed until
 * asked, and it is not drawn at all for a Person who works alone and has never made a Project:
 * `always` is true inside a Company, where filing is shared and the way in has to exist before
 * the first Project does.
 *
 * Open, it lists the top-level Projects (each opens that Project) and ends with the way to the
 * whole shelf, which is also where a Project is made.
 */
export function ProjectGroup({
  always,
  open,
}: {
  always: boolean
  /** The Project on screen, when the Person is in one: its row is the chosen one. */
  open: Option.Option<ProjectId>
}) {
  const [expanded, setExpanded] = useState(false)
  const state = useLiveValue(live.projects)
  // Nothing is drawn while the answer is on its way: a line that appeared and then left for a
  // Person with no Projects would be a flicker about something they never see.
  if (Option.isNone(state)) return null
  const top = projectsData.projectsIn(state.value.projects, null)
  if (top.length === 0 && !always) return null

  return (
    <section className="mt-2">
      <button
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className={cn(ROW, FULL, HOVER, 'text-ink-3 hover:text-ink')}
      >
        <span className="inline-flex size-5.5 items-center justify-center">
          <FolderKanban className="size-4" strokeWidth={1.6} />
        </span>
        <span className="min-w-0 flex-1 text-label">Projects</span>
        {top.length > 0 && (
          <span className="text-meta font-meta text-ink-3 tabular-nums">{top.length}</span>
        )}
      </button>
      {expanded && (
        <ul className="flex flex-col gap-px pb-2">
          {top.map((project) => {
            const chosen = Option.contains(open, project.id)
            return (
              <li key={project.id}>
                <button
                  onClick={() => router.go(Route.Projects({ open: Option.some(project.id) }))}
                  aria-current={chosen ? 'page' : undefined}
                  className={cn(
                    ROW,
                    TOOL,
                    'pl-10',
                    chosen ? 'bg-wash-selected text-ink' : cn(HOVER, 'text-ink-2 hover:text-ink'),
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-label">{project.name}</span>
                  <span className="text-meta font-meta text-ink-3 tabular-nums">
                    {project.threadCount}
                  </span>
                </button>
              </li>
            )
          })}
          <li>
            <button
              onClick={() => router.go(Route.Projects({ open: Option.none() }))}
              className={cn(ROW, TOOL, HOVER, 'pl-10 text-ink-3 hover:text-ink')}
            >
              <span className="min-w-0 flex-1 truncate text-label">All projects</span>
              <ChevronRight className="size-3.5 text-ink-4 group-hover/row:text-ink-2" />
            </button>
          </li>
        </ul>
      )}
    </section>
  )
}
