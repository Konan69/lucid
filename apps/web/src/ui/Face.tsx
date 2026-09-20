import { cn } from './cn'

export type FaceColor =
  | 'accent'
  | 'brown'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'violet'
  | 'magenta'
  | 'gray'

export type FaceMood = 'neutral' | 'happy' | 'thinking' | 'asleep'

const COLOR_CLASS = {
  accent: 'bg-accent',
  brown: 'bg-face-brown',
  red: 'bg-face-red',
  orange: 'bg-face-orange',
  yellow: 'bg-face-yellow',
  green: 'bg-face-green',
  cyan: 'bg-face-cyan',
  blue: 'bg-face-blue',
  violet: 'bg-face-violet',
  magenta: 'bg-face-magenta',
  gray: 'bg-face-gray',
} satisfies Record<FaceColor, string>

/** Head tilt per mood: thinking leans back, happy leans in, the rest sit level. */
const TILT_CLASS = {
  neutral: '',
  happy: 'rotate-4',
  thinking: '-rotate-8',
  asleep: '',
} satisfies Record<FaceMood, string>

/** Vivid's face: a disc with two eyes. Same family as Grok Bot's blobs, its own shape. */
export function Face({
  color = 'accent',
  mood = 'neutral',
  size = 28,
  className,
  label,
}: {
  color?: FaceColor
  mood?: FaceMood
  size?: number
  className?: string
  label?: string
}) {
  const eye = Math.max(2, Math.round(size * 0.11))
  const eyeHeight = mood === 'asleep' ? Math.max(1.5, eye * 0.35) : Math.round(size * 0.24)
  // SAFETY: React forwards these validated CSS custom properties to the element.
  // The `face*` utilities in styles/index.css read them, so geometry stays one computation.
  const faceStyle = {
    '--face-size': `${size}px`,
    '--face-eye-w': `${eye}px`,
    '--face-eye-h': `${eyeHeight}px`,
    '--face-eye-gap': `${Math.round(size * 0.22)}px`,
  } as React.CSSProperties
  return (
    <span
      role="img"
      aria-label={label ?? 'Vivid'}
      className={cn(
        'relative inline-flex face shrink-0 items-center justify-center rounded-full',
        COLOR_CLASS[color],
        TILT_CLASS[mood],
        className,
      )}
      style={faceStyle}
    >
      <span className="absolute face-eyes flex items-center">
        <i className="block face-eye -rotate-6 rounded-full" />
        <i className="block face-eye rotate-6 rounded-full" />
      </span>
    </span>
  )
}
