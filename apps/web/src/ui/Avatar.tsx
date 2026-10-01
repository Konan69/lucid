import type { PersonSummary } from '@vivid/contracts'
import { cn } from './cn'

/**
 * A Person as a small round mark: their picture when they have one, otherwise their initial.
 * Decorative by default because the name is always written beside it.
 */
export function Avatar({
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
    <span
      aria-hidden
      className={cn(
        'inline-flex size-(--avatar-size) shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 text-(length:--avatar-font-size) font-title text-ink-2 ring-line',
        className,
      )}
      style={avatarStyle}
    >
      {image === null ? initial : <img src={image} alt="" className="size-full object-cover" />}
    </span>
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
  return (
    <span
      className="inline-flex shrink-0 items-center"
      title={people.map((p) => p.name).join(', ')}
    >
      {shown.map((person) => (
        <Avatar
          key={person.id}
          name={person.name}
          image={person.image}
          size={size}
          className="-ml-1 ring-2 ring-surface-1 first:ml-0"
        />
      ))}
      {more > 0 && <span className="ml-1 text-meta font-meta text-ink-4">+{more}</span>}
    </span>
  )
}
