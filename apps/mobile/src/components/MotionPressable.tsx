import type { PressableProps, StyleProp, ViewStyle } from "react-native";
import { Pressable } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { nativeMetrics } from "@vivid/design-tokens/native";

// Vivid web Button/EmptyState's 0.98 press treatment, executed on the UI thread.
export function MotionPressable({
  containerStyle,
  onPressIn,
  onPressOut,
  ...props
}: PressableProps & { containerStyle?: StyleProp<ViewStyle> }) {
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const timing = {
    duration: nativeMetrics["dur-fast"],
    easing: Easing.bezier(0.2, 0, 0, 1),
    reduceMotion: ReduceMotion.System,
  };
  return (
    <Animated.View style={[containerStyle, animated]}>
      <Pressable
        {...props}
        onPressIn={(event) => {
          scale.value = withTiming(0.98, timing);
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          scale.value = withTiming(1, timing);
          onPressOut?.(event);
        }}
      />
    </Animated.View>
  );
}
