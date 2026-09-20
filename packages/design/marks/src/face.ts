/**
 * Vivid's face: a disc with two eyes. The two surfaces paint it differently — the web composes it
 * from styled elements reading CSS custom properties, the native app draws real SVG so Reanimated
 * can drive the tilt — but the proportions and the moods must stay identical, so both read them
 * from here rather than each holding its own copy of the multipliers.
 */

export const FACE_MOODS = ['neutral', 'happy', 'thinking', 'asleep'] as const

export type FaceMood = (typeof FACE_MOODS)[number]

/** Head tilt per mood, in degrees: thinking leans back, happy leans in, the rest sit level. */
export const FACE_TILT_DEGREES = {
  neutral: 0,
  happy: 4,
  thinking: -8,
  asleep: 0,
} satisfies Record<FaceMood, number>

export type FaceGeometry = {
  /** Eye width in pixels, floored at 2 so the eyes survive a favicon-sized face. */
  readonly eyeWidth: number
  /** Eye height in pixels. Asleep closes the eye to a slit rather than hiding it. */
  readonly eyeHeight: number
  /** Gap between the two eyes in pixels. */
  readonly eyeGap: number
  /** Distance from the top of the disc to the top of the eyes, as a fraction of its size. */
  readonly eyeTopFraction: number
  readonly tiltDegrees: number
}

/** Eyes sit slightly above centre; the face reads as looking at you rather than past you. */
const EYE_TOP_FRACTION = 0.38

/**
 * Derives every measurement of a face of a given size. One computation, so a 14px face in a thread
 * row and a 96px face on an empty screen are the same drawing at two scales.
 */
export function faceGeometry(size: number, mood: FaceMood): FaceGeometry {
  const eyeWidth = Math.max(2, Math.round(size * 0.11))
  return {
    eyeWidth,
    eyeHeight: mood === 'asleep' ? Math.max(1.5, eyeWidth * 0.35) : Math.round(size * 0.24),
    eyeGap: Math.round(size * 0.22),
    eyeTopFraction: EYE_TOP_FRACTION,
    tiltDegrees: FACE_TILT_DEGREES[mood],
  }
}
