/**
 * Vivid's face: a silhouette (a disc, unless another is chosen) with two eyes. The two surfaces paint it differently — the web composes it
 * from styled elements reading CSS custom properties, the native app draws real SVG so Reanimated
 * can drive the tilt — but the proportions and the moods must stay identical, so both read them
 * from here rather than each holding its own copy of the multipliers.
 */

const FACE_MOODS = ['neutral', 'happy', 'thinking', 'asleep'] as const

export type FaceMood = (typeof FACE_MOODS)[number]

/** Head tilt per mood, in degrees: thinking leans back, happy leans in, the rest sit level. */
const FACE_TILT_DEGREES = {
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
 * The silhouettes a face can have. The eyes and the moods are the same in every one; only the
 * outline changes. The set and its order are Grok Bot's "Create your first Bot" row (the
 * screenshot `refs/grok-bot-screenshots/03-create-your-first-bot.png`): circle, tilted blob,
 * rounded square, pill, triangle, hexagon, cloud, drop. That app's own outlines could not be
 * read from the screenshot at path level, so these are drawn here to the same eight forms.
 */
const FACE_OUTLINES = [
  'circle',
  'blob',
  'square',
  'pill',
  'triangle',
  'hexagon',
  'cloud',
  'drop',
] as const

export type FaceOutline = (typeof FACE_OUTLINES)[number]

/**
 * Each silhouette as one SVG path in a 100 by 100 box, the face's own box. The web masks its
 * disc with it and the native app fills it, so both draw the same outline at any size.
 */
export const FACE_OUTLINE_PATHS = {
  circle: 'M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0Z',
  blob: 'M52 5C78 3 99 22 97 50C95 79 73 97 45 95C19 93 1 75 3 47C5 23 27 7 52 5Z',
  square:
    'M30 6H70A24 24 0 0 1 94 30V70A24 24 0 0 1 70 94H30A24 24 0 0 1 6 70V30A24 24 0 0 1 30 6Z',
  pill: 'M30 20H70A30 30 0 0 1 70 80H30A30 30 0 0 1 30 20Z',
  triangle: 'M50 6C54 6 58 8 60 13L95 78C99 86 94 93 85 93H15C6 93 1 86 5 78L40 13C42 8 46 6 50 6Z',
  hexagon:
    'M43 7Q50 3 57 7L85 23Q92 27 92 35V65Q92 73 85 77L57 93Q50 97 43 93L15 77Q8 73 8 65V35Q8 27 15 23Z',
  cloud:
    'M26 90C12 90 2 79 2 66C2 55 9 46 19 43C20 26 33 13 49 13C61 13 72 20 77 30C89 31 98 42 98 55C98 74 86 90 70 90Z',
  drop: 'M50 3C50 3 88 40 88 62A38 38 0 0 1 12 62C12 40 50 3 50 3Z',
} satisfies Record<FaceOutline, string>

/**
 * How far down the eyes move in a silhouette, as a fraction of its size. A triangle and a drop
 * are narrow where a disc's eyes sit, so their eyes go lower, into the body of the outline.
 */
const FACE_OUTLINE_EYE_DROP = {
  circle: 0,
  blob: 0,
  square: 0,
  pill: 0,
  triangle: 0.16,
  hexagon: 0,
  cloud: 0.04,
  drop: 0.16,
} satisfies Record<FaceOutline, number>

/**
 * Derives every measurement of a face of a given size. One computation, so a 14px face in a thread
 * row and a 96px face on an empty screen are the same drawing at two scales.
 */
export function faceGeometry(size: number, mood: FaceMood, outline: FaceOutline): FaceGeometry {
  const eyeWidth = Math.max(2, Math.round(size * 0.11))
  return {
    eyeWidth,
    eyeHeight: mood === 'asleep' ? Math.max(1.5, eyeWidth * 0.35) : Math.round(size * 0.24),
    eyeGap: Math.round(size * 0.22),
    eyeTopFraction: EYE_TOP_FRACTION + FACE_OUTLINE_EYE_DROP[outline],
    tiltDegrees: FACE_TILT_DEGREES[mood],
  }
}
