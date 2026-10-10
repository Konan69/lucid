import type { PressableProps, StyleProp, ViewStyle } from 'react-native'
import { Pressable } from 'react-native'
import Animated, {
  type LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'
import { nativeMetrics } from '@vivid/tokens/native'

/**
 * How far something sinks under a finger. Small enough that it reads as the surface giving, not
 * as the control shrinking; the label and icon go with it, which is what makes it feel physical.
 */
const PRESSED_SCALE = 0.97

/**
 * The surface is on a spring, not a timed curve. A finger can lift, or come back down, before the
 * last movement has finished, and a spring carries on from where the surface is, at the speed it
 * was moving; a timed curve starts again from rest, which is felt as a hitch on a quick double
 * tap. It is critically damped (ratio 1): nothing threw this surface, so it must not bounce.
 *
 * It sinks quickly, so the press is felt as the finger lands, and comes back a little slower, the
 * way something released does. With reduced motion nothing travels: the surface is at its
 * pressed size at once, and the pressed fill each control draws still shows.
 */
const SINK = {
  duration: nativeMetrics['dur-fast'],
  dampingRatio: 1,
  reduceMotion: ReduceMotion.System,
} as const
const RISE = {
  duration: nativeMetrics['dur-base'],
  dampingRatio: 1,
  reduceMotion: ReduceMotion.System,
} as const

/**
 * Everything a finger can activate is one of these. A touch screen has no hover, so the press is
 * the only moment the interface can say "I heard that": the surface sinks on press-in, on the UI
 * thread, without a React render, and the action fires on release.
 *
 * `containerStyle` is the outer box (where it sits in its parent); `style` is the pressable's
 * own look, and may be a function of `pressed` like any `Pressable`.
 *
 * `layout` is given only by a control that changes shape (`ui/motion/morph.ts`). It is not on by
 * default: a layout transition on every pressable would also ease each one into place whenever
 * the keyboard or a list moved it, which reads as lag.
 *
 * `depth` is how small the surface gets under the finger, for the few shapes a design gives a
 * depth of their own (the round button beside the thinking bubble and a question's choices sink
 * to 0.96, as their approved prototypes do). Everything else sinks to `PRESSED_SCALE`.
 */
export function Press({
  containerStyle,
  layout,
  depth = PRESSED_SCALE,
  onPressIn,
  onPressOut,
  ...props
}: PressableProps & {
  containerStyle?: StyleProp<ViewStyle>
  layout?: LinearTransition
  depth?: number
}) {
  const scale = useSharedValue(1)
  // Reanimated's get/set API is the compiler-safe equivalent of reading and assigning `.value`.
  const sunk = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }))
  return (
    <Animated.View layout={layout} style={[containerStyle, sunk]}>
      <Pressable
        // A finger that drifts a little while pressing still means the press.
        pressRetentionOffset={12}
        {...props}
        onPressIn={(event) => {
          scale.set(withSpring(depth, SINK))
          if (onPressIn != null) onPressIn(event)
        }}
        onPressOut={(event) => {
          scale.set(withSpring(1, RISE))
          if (onPressOut != null) onPressOut(event)
        }}
      />
    </Animated.View>
  )
}
