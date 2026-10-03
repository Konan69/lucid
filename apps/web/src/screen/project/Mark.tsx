import type { ProjectId } from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { cn } from '../../ui/cn'

/* Each hue's fill, written out so the stylesheet is generated with all of them. A new hue fails
   to compile here until it has one. */
const FILL = {
  blue: 'bg-face-blue',
  green: 'bg-face-green',
  orange: 'bg-face-orange',
  magenta: 'bg-face-magenta',
  cyan: 'bg-face-cyan',
  yellow: 'bg-face-yellow',
  red: 'bg-face-red',
  brown: 'bg-face-brown',
} satisfies Record<projectsData.Hue, string>

const SIZE = {
  /** In a row or a chip, beside a label. */
  row: 'size-2.5 rounded-[3px]',
  /** Beside a Project's name at the head of its own page. */
  page: 'size-4 rounded-[5px]',
} as const

/**
 * A Project's mark: a small filled shape in the Project's own colour. It is what tells one
 * Project from another at a glance, in the sidebar, in the scope chip and on its page. It is a
 * colour and not a folder: a Project is a piece of work, not a place files are put.
 */
export function Mark({
  id,
  size = 'row',
  className,
}: {
  id: ProjectId
  size?: keyof typeof SIZE
  className?: string
}) {
  return (
    <i
      aria-hidden
      className={cn('block shrink-0', SIZE[size], FILL[projectsData.hueOf(id)], className)}
    />
  )
}
