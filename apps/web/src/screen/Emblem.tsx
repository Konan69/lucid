import type { CSSProperties, ReactNode } from 'react'
import { cn } from '../ui/cn'

/**
 * The hues an emblem may take. They are the `face-*` colours and nothing else, so colour on these
 * screens always comes from the one saturated palette the faces already use, never from a tint
 * made up for one place.
 */
const HUE = {
  red: 'bg-face-red',
  orange: 'bg-face-orange',
  yellow: 'bg-face-yellow',
  green: 'bg-face-green',
  cyan: 'bg-face-cyan',
  blue: 'bg-face-blue',
  violet: 'bg-face-violet',
  magenta: 'bg-face-magenta',
  brown: 'bg-face-brown',
  gray: 'bg-face-gray',
} as const
export type Hue = keyof typeof HUE

/**
 * A place or a kind of thing, as a white glyph on a square of solid colour: the way a phone's
 * Settings marks each section, and how Grok Bot puts its colour in a few saturated shapes on a
 * neutral page (`refs/grok-bot-screenshots/01-give-each-bot-a-job.png`) and none in the chrome.
 * Each place has one hue (Routines orange, Library violet, Integrations green…), so the same
 * colour means the same place in the palette, in Settings and on the screen itself.
 *
 * The glyph is drawn at three fifths of the square, in the white the tokens keep for text on
 * colour and at lucide's own stroke, the weight every other icon on these screens has. The
 * corner is a quarter of the side, which keeps the square the same shape at every size.
 */
export function Emblem({
  hue,
  size = 28,
  children,
  className,
}: {
  hue: Hue
  size?: number
  /** One lucide icon. It is sized here, so it is passed without a size of its own. */
  children: ReactNode
  className?: string
}) {
  // SAFETY: React forwards these validated CSS custom properties to the element.
  const style = {
    '--emblem': `${size}px`,
    '--emblem-corner': `${Math.round(size / 4)}px`,
  } as CSSProperties
  return (
    <span
      aria-hidden
      style={style}
      className={cn(
        'inline-flex size-(--emblem) shrink-0 items-center justify-center rounded-(--emblem-corner) text-ink-on-color [&>svg]:size-3/5',
        HUE[hue],
        className,
      )}
    >
      {children}
    </span>
  )
}
