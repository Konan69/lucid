import { faceGeometry, type FaceMood } from '@vivid/marks'
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

export type { FaceMood }

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

/**
 * Vivid's face: a disc with two eyes. The proportions, the moods and the tilt come from
 * `@vivid/marks`, so this disc and the one the native app draws in SVG stay the same face. Only
 * the colour palette is web-only; native shows Vivid in the accent colour alone.
 */
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
  const geometry = faceGeometry(size, mood)
  // SAFETY: React forwards these validated CSS custom properties to the element.
  // The `face*` utilities in styles/index.css read them, so geometry stays one computation.
  const faceStyle = {
    '--face-size': `${size}px`,
    '--face-eye-w': `${geometry.eyeWidth}px`,
    '--face-eye-h': `${geometry.eyeHeight}px`,
    '--face-eye-gap': `${geometry.eyeGap}px`,
    '--face-eye-top': `${geometry.eyeTopFraction * 100}%`,
    '--face-tilt': `${geometry.tiltDegrees}deg`,
  } as React.CSSProperties
  return (
    <span
      role="img"
      aria-label={label ?? 'Vivid'}
      className={cn(
        'relative inline-flex face shrink-0 items-center justify-center rounded-full',
        COLOR_CLASS[color],
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
