import type { PersonSummary } from '@vivid/contracts'
import { Avatar, AvatarFallback, AvatarImage } from './avatar'
import { cn } from './cn'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

/**
 * A Person as a small round mark: their picture when they have one, otherwise their initial.
 * Decorative by default because the name is always written beside it.
 *
 * It is shadcn's `Avatar` (Base UI's: the initial stays until the picture has loaded, and stays
 * for good when it cannot be), sized in pixels because Vivid draws a Person at many sizes, from a
 * 16 px face in a row of them to the 40 px one in Settings.
 */
export function PersonAvatar({
  name,
  image = null,
  size = 24,
  className,
}: {
  name: string
  image?: string | null
  size?: number
  className?: string
}) {
  const initial = name.trim().charAt(0).toUpperCase()
  // SAFETY: React forwards these validated CSS custom properties to the element.
  const avatarStyle = {
    '--avatar-size': `${size}px`,
    '--avatar-font-size': `${Math.round(size * 0.46)}px`,
  } as React.CSSProperties
  return (
    <Avatar aria-hidden className={cn('size-(--avatar-size)', className)} style={avatarStyle}>
      {image !== null && <AvatarImage src={image} alt="" />}
      <AvatarFallback className="bg-surface-3 text-(length:--avatar-font-size)">
        {initial}
      </AvatarFallback>
    </Avatar>
  )
}

/**
 * The People in something, overlapped. Shows the first few faces and counts the rest, so a Thread
 * shared with twelve people takes the same room as one shared with three.
 */
export function Faces({
  people,
  size = 18,
  limit = 3,
}: {
  people: ReadonlyArray<PersonSummary>
  size?: number
  limit?: number
}) {
  const shown = people.slice(0, limit)
  const more = people.length - shown.length
  const names = people.map((person) => person.name).join(', ')
  return (
    <Tooltip>
      {/* Who they are is one hover away: the faces alone cannot say, and the count hides some. */}
      <TooltipTrigger
        render={
          <span role="img" aria-label={names} className="inline-flex shrink-0 items-center" />
        }
      >
        {shown.map((person) => (
          <PersonAvatar
            key={person.id}
            name={person.name}
            image={person.image}
            size={size}
            className="-ml-1 ring-2 ring-surface-1 first:ml-0"
          />
        ))}
        {more > 0 && <span className="ml-1 text-meta font-meta text-ink-3">+{more}</span>}
      </TooltipTrigger>
      <TooltipContent>{names}</TooltipContent>
    </Tooltip>
  )
}
