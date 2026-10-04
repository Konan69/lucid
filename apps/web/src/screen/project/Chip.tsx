import type { Project } from '@vivid/contracts'
import { Option } from 'effect'
import { Route, router } from '../../data/route'
import { scope } from '../../data/scope'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { Mark } from './Mark'

/**
 * The scope, beside the workspace's name: two segments, "All" and the Project the view is
 * narrowed to, with the Project's the chosen one. It is only drawn while there is a scope, so
 * its being there is the statement that the list under it is not everything; "All" is the one
 * tap out. The Project's own segment opens its page.
 *
 * It is a pair of segments and not a chip with a cross: a cross reads as "remove this Project",
 * and what the Person is choosing between is two views of the same Threads.
 *
 * The two are commands (leave the scope, open the Project's page), not a held choice, so they stay
 * buttons and are not a `Segmented`. "All" explains itself in a tooltip; the Project's `title` is
 * only its full name, for when the segment cuts it short.
 */
export function ScopeChip({ project }: { project: Project }) {
  return (
    <div
      role="group"
      aria-label="Scope"
      className="flex h-7 max-w-3/5 shrink-0 origin-right motion-pop items-center rounded-full bg-well p-0.5 edge"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={scope.leave}
              className="h-6 shrink-0 cursor-pointer rounded-full px-2 text-meta font-title text-ink-3 transition-colors duration-(--dur-fast) hover:text-ink"
            />
          }
        >
          All
        </TooltipTrigger>
        <TooltipContent>Show every thread</TooltipContent>
      </Tooltip>
      <button
        aria-current="true"
        title={project.name}
        onClick={() => router.go(Route.Projects({ open: Option.some(project.id) }))}
        className="flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-full bg-surface-3 pr-2.5 pl-2 text-meta font-title text-ink edge transition-colors duration-(--dur-fast) hover:bg-surface-2"
      >
        <Mark id={project.id} />
        <span className="truncate">{project.name}</span>
      </button>
    </div>
  )
}
