import type { PressableProps, StyleProp, ViewStyle } from 'react-native'
import { Pressable } from 'react-native'
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { nativeMetrics } from '@vivid/tokens/native'

/**
 * How far something sinks under a finger. Small enough that it reads as the surface giving, not
 * as the control shrinking; the label and icon go with it, which is what makes it feel physical.
 */
const PRESSED_SCALE = 0.97

/** A strong ease-out: it moves at once and settles, so the press is felt in its first frame. */
const PRESS_TIMING = {
  duration: nativeMetrics['dur-fast'],
  easing: Easing.bezier(0.23, 1, 0.32, 1),
  // With reduced motion the scale is skipped; the pressed fill each control draws still shows.
  reduceMotion: ReduceMotion.System,
} as const

/**
 * Everything a finger can activate is one of these. A touch screen has no hover, so the press is
 * the only moment the interface can say "I heard that": the surface sinks on press-in, on the UI
 * thread, without a React render, and the action fires on release.
 *
 * `containerStyle` is the outer box (where it sits in its parent); `style` is the pressable's
 * own look, and may be a function of `pressed` like any `Pressable`.
 */
export function Press({
  containerStyle,
  onPressIn,
  onPressOut,
  ...props
}: PressableProps & { containerStyle?: StyleProp<ViewStyle> }) {
  const scale = useSharedValue(1)
  // Reanimated's get/set API is the compiler-safe equivalent of reading and assigning `.value`.
  const sunk = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }))
  return (
    <Animated.View style={[containerStyle, sunk]}>
      <Pressable
        // A finger that drifts a little while pressing still means the press.
        pressRetentionOffset={12}
        {...props}
        onPressIn={(event) => {
          scale.set(withTiming(PRESSED_SCALE, PRESS_TIMING))
          if (onPressIn != null) onPressIn(event)
        }}
        onPressOut={(event) => {
          scale.set(withTiming(1, PRESS_TIMING))
          if (onPressOut != null) onPressOut(event)
        }}
      />
    </Animated.View>
  )
}
