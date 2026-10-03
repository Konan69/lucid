import type { FaceOutline } from '@vivid/contracts'
import { FACE_OUTLINE_PATHS, faceGeometry, type FaceMood } from '@vivid/marks'
import { faceColorOf, useAppearance } from '../data/vivid'
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

/** The fill of each face colour, for the face and for anything that shows a colour as a swatch. */
export const FACE_COLOR_CLASS = {
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

/** The silhouette as a CSS mask: the 100-box path of `@vivid/marks`, stretched to the face. */
const maskOf = (outline: FaceOutline) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path d='${FACE_OUTLINE_PATHS[outline]}'/></svg>`,
  )}")`

/**
 * Vivid's face: a silhouette with two eyes. The proportions, the moods, the tilt and the outlines
 * come from `@vivid/marks`, so this face and the one the native app draws in SVG stay the same.
 *
 * With no `color` and no `outline` it is Vivid as it looks where the Person is working: both come
 * from the one live appearance (`data/vivid.ts`), so every face in the app changes at the moment
 * a new look is saved, and it is announced by Vivid's chosen name. A caller that names a colour
 * or an outline draws that instead: a swatch, or the Customise sheet's preview of a draft.
 *
 * A disc is drawn as it always was, rounded and with its own shadow. Any other outline is the
 * same painted box behind a mask, which also clips the box's drop shadow; the highlight stays.
 */
export function Face({
  color,
  outline,
  mood = 'neutral',
  size = 28,
  className,
  label,
}: {
  color?: FaceColor
  outline?: FaceOutline
  mood?: FaceMood
  size?: number
  className?: string
  label?: string
}) {
  const vivid = useAppearance()
  const drawnColor = color === undefined ? faceColorOf(vivid.look) : color
  const drawnOutline = outline === undefined ? vivid.outline : outline
  const geometry = faceGeometry(size, mood, drawnOutline)
  // SAFETY: React forwards these validated CSS custom properties to the element.
  // The `face*` utilities in styles/index.css read them, so geometry stays one computation.
  const faceStyle = {
    '--face-size': `${size}px`,
    '--face-eye-w': `${geometry.eyeWidth}px`,
    '--face-eye-h': `${geometry.eyeHeight}px`,
    '--face-eye-gap': `${geometry.eyeGap}px`,
    '--face-eye-top': `${geometry.eyeTopFraction * 100}%`,
    '--face-tilt': `${geometry.tiltDegrees}deg`,
    // A disc needs no mask: `rounded-full` is its outline and keeps its shadow. The property is
    // read by the `.face` rule in `styles/vivid.css`.
    '--face-mask': drawnOutline === 'circle' ? 'none' : maskOf(drawnOutline),
  } as React.CSSProperties
  return (
    <span
      role="img"
      aria-label={label === undefined ? vivid.name : label}
      className={cn(
        'relative inline-flex face shrink-0 items-center justify-center',
        drawnOutline === 'circle' && 'rounded-full',
        FACE_COLOR_CLASS[drawnColor],
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
