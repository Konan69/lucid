import { useEffect, useId } from 'react'
import Svg, { Circle, Defs, RadialGradient, Rect, Stop } from 'react-native-svg'
import Animated, {
  Easing,
  ReduceMotion,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { faceGeometry, type FaceMood } from '@vivid/marks'
import { useTheme } from '../theme'

/**
 * Vivid's face, drawn as real SVG so Reanimated can carry the tilt between moods on the UI thread.
 * The proportions and the tilt angles come from `@vivid/marks`, the same source the web face
 * reads, so the two surfaces show one face rather than two similar ones.
 */
export function Face({ size = 28, mood = 'neutral' }: { size?: number; mood?: FaceMood }) {
  const { colors: c } = useTheme()
  // `useId` embeds colons, which are not legal in an SVG fragment identifier.
  const id = useId().replace(/:/g, '')
  const geometry = faceGeometry(size, mood)
  const { eyeWidth, eyeHeight, eyeGap } = geometry
  const left = (size - eyeWidth * 2 - eyeGap) / 2
  const top = size * geometry.eyeTopFraction
  const rotation = useSharedValue(geometry.tiltDegrees)
  useEffect(() => {
    // Reanimated exposes `set` specifically so compiler-enabled React can update shared values.
    rotation.set(
      withTiming(geometry.tiltDegrees, {
        duration: m['dur-base'],
        easing: Easing.bezier(0.2, 0, 0, 1),
        reduceMotion: ReduceMotion.System,
      }),
    )
  }, [geometry.tiltDegrees, rotation])
  const motion = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.get()}deg` }] }))
  return (
    <Animated.View style={[{ width: size, height: size }, motion]}>
      <Svg width={size} height={size} accessibilityRole="image" accessibilityLabel="Vivid">
        <Defs>
          <RadialGradient id={id} cx="32%" cy="28%" r="55%">
            <Stop offset="0" stopColor={c['ink-on-color']} stopOpacity={0.28} />
            <Stop offset="1" stopColor={c['ink-on-color']} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={c.accent} />
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />

        <Rect
          x={left}
          y={top}
          width={eyeWidth}
          height={eyeHeight}
          rx={eyeWidth / 2}
          fill={c['face-eye']}
          transform={`rotate(-6 ${left + eyeWidth / 2} ${top + eyeHeight / 2})`}
        />
        <Rect
          x={left + eyeWidth + eyeGap}
          y={top}
          width={eyeWidth}
          height={eyeHeight}
          rx={eyeWidth / 2}
          fill={c['face-eye']}
          transform={`rotate(6 ${left + eyeWidth * 1.5 + eyeGap} ${top + eyeHeight / 2})`}
        />
      </Svg>
    </Animated.View>
  )
}
