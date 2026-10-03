/**
 * The motion Integrations, Routines, Library, Notifications and Settings share, in one place so
 * the numbers cannot drift between them. Everything here is built from the motion tokens
 * (`--dur-fast` 120ms, `--dur-enter` 240ms, `--ease-out-expo`); nothing loops, and the global
 * `prefers-reduced-motion` rule in `styles/index.css` shortens every one of them to nothing.
 */

/**
 * The wait before each place in a list starts to arrive: 40ms apart, inside the 30–80ms a stagger
 * reads as one gesture. They are whole class names because Tailwind only emits a class it can
 * read in the source, and because a delay is a fixed design value, not a style computed per row.
 * The list ends at the ninth place: past it everything arrives together, so a long list is never
 * still arriving when the Person is already reading its top (8 × 40ms + 240ms ends at 560ms).
 */
const WAIT = [
  '[animation-delay:0ms]',
  '[animation-delay:40ms]',
  '[animation-delay:80ms]',
  '[animation-delay:120ms]',
  '[animation-delay:160ms]',
  '[animation-delay:200ms]',
  '[animation-delay:240ms]',
  '[animation-delay:280ms]',
  '[animation-delay:320ms]',
] as const

/**
 * A tile or row arriving: it fades in and rises 6px (`rise-in`, 240ms on ease-out-expo). It is a
 * CSS animation, so it runs once when the element is first drawn and never again on a re-render.
 */
export const ENTER = 'animate-rise-in'

/** The class that makes the `place`-th item of a list wait its turn before it arrives. */
export const stagger = (place: number) => WAIT[Math.min(place, WAIT.length - 1)]

/**
 * What every pressable tile and row does under a finger or a click: it gives by 3%, in 120ms, and
 * comes back. A transition, not a keyframe, so a fast second press picks up from where it is.
 */
export const PRESS = 'transition-press duration-(--dur-fast) active:scale-97'

/**
 * A line that draws itself once, for the check that says a thing has just been done. The path
 * must carry `pathLength={1}`; it starts fully dashed out and the dash runs to nothing in 240ms.
 */
export const DRAW =
  'transition-[stroke-dashoffset] duration-(--dur-enter) ease-out-expo [stroke-dasharray:1] [stroke-dashoffset:0] starting:[stroke-dashoffset:1]'
