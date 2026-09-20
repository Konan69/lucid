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
import { useTheme } from '../theme'

// Geometry and colors ported from apps/web/src/ui/Face.tsx, not a new logo.
/** Head tilt per mood, in degrees: thinking leans back, happy leans in, the rest sit level. */
const TILT_DEGREES = { neutral: 0, happy: 4, thinking: -8, asleep: 0 } satisfies Record<
  'neutral' | 'happy' | 'thinking' | 'asleep',
  number
>

export function Face({
  size = 28,
  mood = 'neutral',
}: {
  size?: number
  mood?: 'neutral' | 'happy' | 'thinking' | 'asleep'
}) {
  const { colors: c } = useTheme()
  const id = useId().replace(/:/g, '')
  const eye = Math.max(2, Math.round(size * 0.11))
  const eyeH = mood === 'asleep' ? Math.max(1.5, eye * 0.35) : Math.round(size * 0.24)
  const gap = Math.round(size * 0.22)
  const left = (size - eye * 2 - gap) / 2
  const y = size * 0.38
  const tilt = TILT_DEGREES[mood]
  const rotation = useSharedValue(tilt)
  useEffect(() => {
    // Reanimated exposes `set` specifically so compiler-enabled React can update shared values.
    rotation.set(
      withTiming(tilt, {
        duration: m['dur-base'],
        easing: Easing.bezier(0.2, 0, 0, 1),
        reduceMotion: ReduceMotion.System,
      }),
    )
  }, [tilt, rotation])
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
          y={y}
          width={eye}
          height={eyeH}
          rx={eye / 2}
          fill={c['face-eye']}
          transform={`rotate(-6 ${left + eye / 2} ${y + eyeH / 2})`}
        />
        <Rect
          x={left + eye + gap}
          y={y}
          width={eye}
          height={eyeH}
          rx={eye / 2}
          fill={c['face-eye']}
          transform={`rotate(6 ${left + eye * 1.5 + gap} ${y + eyeH / 2})`}
        />
      </Svg>
    </Animated.View>
  )
}
