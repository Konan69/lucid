import { useId } from 'react'
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg'
import Animated, { cubicBezier, useReducedMotion } from 'react-native-reanimated'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { FACE_OUTLINE_PATHS, faceGeometry, type FaceMood } from '@vivid/marks'
import type { FaceOutline, Look } from '@vivid/contracts'
import { facePaintOf, useAppearance } from '../data/vivid'
import { useTheme } from '../theme'

/** The web face's own curve, so the tilt settles the same way on both surfaces. */
const TILT_CURVE = cubicBezier(0.2, 0, 0, 1)

/**
 * Vivid's face, drawn as real SVG. The proportions and the tilt angles come from `@vivid/marks`,
 * the same source the web face reads, so the two surfaces show one face rather than two similar
 * ones.
 *
 * It is drawn as Vivid looks where the Person is working (`data/vivid.ts`): in the theme's primary
 * until someone chooses a colour, with eyes in the ink that theme sets on its primary; or in the
 * chosen `face-*` hue. Every face reads that one live value, so a change shows on all of them at
 * once. `look` and `outline` draw a face that is not the saved one: a swatch, or the Customise sheet's preview.
 * The name it is announced by is Vivid's chosen name; `label` replaces it where the face stands
 * for a choice rather than for Vivid.
 *
 * The tilt between moods is a transition on the style, not an animation started from an effect:
 * a mood is a state, the face is drawn in it, and Reanimated carries the change on the UI thread.
 * It runs once per change of mood and never loops. A Person who has asked their phone for less
 * motion gets the new tilt at once: the mood still shows, nothing turns.
 */
export function Face({
  size = 28,
  mood = 'neutral',
  look,
  outline,
  label,
}: {
  size?: number
  mood?: FaceMood
  look?: Look
  outline?: FaceOutline
  label?: string
}) {
  const { colors: c } = useTheme()
  const vivid = useAppearance()
  const paint = facePaintOf(look === undefined ? vivid.look : look, c)
  const still = useReducedMotion()
  // `useId` embeds colons, which are not legal in an SVG fragment identifier.
  const id = useId().replace(/:/g, '')
  // The silhouette is one path in a 100 box (`@vivid/marks`), the same one the web masks with.
  const drawn = FACE_OUTLINE_PATHS[outline === undefined ? vivid.outline : outline]
  const scale = `scale(${size / 100})`
  const geometry = faceGeometry(size, mood, outline === undefined ? vivid.outline : outline)
  const { eyeWidth, eyeHeight, eyeGap } = geometry
  const left = (size - eyeWidth * 2 - eyeGap) / 2
  const top = size * geometry.eyeTopFraction
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        transform: [{ rotate: `${geometry.tiltDegrees}deg` }],
        transitionProperty: 'transform',
        transitionDuration: still ? 0 : m['dur-base'],
        transitionTimingFunction: TILT_CURVE,
      }}
    >
      <Svg
        width={size}
        height={size}
        accessibilityRole="image"
        accessibilityLabel={label === undefined ? vivid.name : label}
      >
        <Defs>
          <RadialGradient id={id} cx="32%" cy="28%" r="55%">
            <Stop offset="0" stopColor={c['ink-on-color']} stopOpacity={0.28} />
            <Stop offset="1" stopColor={c['ink-on-color']} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Path d={drawn} transform={scale} fill={paint.fill} />
        <Path d={drawn} transform={scale} fill={`url(#${id})`} />

        <Rect
          x={left}
          y={top}
          width={eyeWidth}
          height={eyeHeight}
          rx={eyeWidth / 2}
          fill={paint.eyes}
          transform={`rotate(-6 ${left + eyeWidth / 2} ${top + eyeHeight / 2})`}
        />
        <Rect
          x={left + eyeWidth + eyeGap}
          y={top}
          width={eyeWidth}
          height={eyeHeight}
          rx={eyeWidth / 2}
          fill={paint.eyes}
          transform={`rotate(6 ${left + eyeWidth * 1.5 + eyeGap} ${top + eyeHeight / 2})`}
        />
      </Svg>
    </Animated.View>
  )
}
