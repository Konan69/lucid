import { Button } from '../../ui/button'

/**
 * Google's "G" as the artwork Google publishes for its sign-in button: four parts on an 18-unit
 * square, each in one of Google's own colours. Its sign-in branding rules ask for this mark,
 * unaltered, beside the words "Continue with Google".
 *
 * The colours are Google's, the same in light and dark, so they are data of the mark and not
 * theme tokens, the way every other service's mark carries its own (`@vivid/marks`).
 */
const G = [
  {
    fill: '#4285F4',
    d: 'M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z',
  },
  {
    fill: '#34A853',
    d: 'M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z',
  },
  {
    fill: '#FBBC05',
    d: 'M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z',
  },
  {
    fill: '#EA4335',
    d: 'M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z',
  },
] as const

/**
 * The mark. It is decoration to a screen reader: the words beside it already say "Google". The
 * desktop app's waiting card (`Waiting.tsx`) draws it too, beside the same words.
 */
export function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden focusable="false" className="size-4">
      {G.map((part) => (
        <path key={part.fill} fill={part.fill} d={part.d} />
      ))}
    </svg>
  )
}

/**
 * The other way in: one button, for a new Person and a returning one alike, set apart from the
 * form above it by a word and not by a second card. It is a control like the form's own button
 * and as wide, but drawn as an outline, so the form stays the first thing the eye lands on.
 *
 * - `resting`: a request is on its way (this one or the form's), so it cannot be pressed.
 * - `leaving`: this is the one on its way, and the button says where the page is going.
 */
export function GoogleWay({
  resting,
  leaving,
  onStart,
}: {
  resting: boolean
  leaving: boolean
  onStart: () => void
}) {
  return (
    <>
      <div className="flex items-center gap-3 text-meta text-ink-3">
        <span aria-hidden className="h-px flex-1 bg-line-2" />
        or
        <span aria-hidden className="h-px flex-1 bg-line-2" />
      </div>
      <Button variant="outline" disabled={resting} onClick={onStart} className="w-full">
        <GoogleMark />
        {leaving ? 'Opening Google…' : 'Continue with Google'}
      </Button>
    </>
  )
}
