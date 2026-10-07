import { View } from 'react-native'
import Animated, { useReducedMotion } from 'react-native-reanimated'
import { useTheme } from '../theme'

/** One dot, and the room between two. */
const DOT = 6
const GAP = 4
/** How far a dot lifts at the top of its bounce, in points. */
const LIFT = 4
/** One whole turn of the three, and how long each dot waits after the one before it. */
const TURN = 1200
const BEAT = 160

/**
 * One dot's turn: it lifts and brightens in the first third, lands by the middle, and rests for
 * the rest while the other two take theirs. Lifting slows as it rises and landing slows as it
 * settles, so it reads as a bounce and not as a slide.
 */
const BOUNCE = {
  '0%': { transform: [{ translateY: 0 }], opacity: 0.4 },
  '30%': { transform: [{ translateY: -LIFT }], opacity: 1 },
  '60%': { transform: [{ translateY: 0 }], opacity: 0.4 },
  '100%': { transform: [{ translateY: 0 }], opacity: 0.4 },
} as const

/**
 * Three dots bouncing in turn: Vivid is about to speak here. They stand in the conversation where
 * its words will be, for as long as it has none (`Waiting` in `screen/Chat.tsx`, and a reply that
 * has started with nothing in it yet in `screen/chat/Message.tsx`). The owner asked for them
 * there, where a Thread used to show nothing (7 October 2026).
 *
 * They move only while they are drawn, and they are drawn only while Vivid is awaited. The motion
 * is a keyframe animation on the UI thread, of transform and opacity alone; nothing renders per
 * frame. With reduced motion the three dots are simply there.
 *
 * It says nothing to a screen reader: whoever draws it says that Vivid is thinking.
 */
export function Dots() {
  const { colors: c } = useTheme()
  const still = useReducedMotion()
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // As tall as a line of the words that will take its place, so they arrive without a jump.
      style={{ height: 24, flexDirection: 'row', alignItems: 'center', gap: GAP }}
    >
      {[0, 1, 2].map((place) => (
        <Animated.View
          key={place}
          style={[
            {
              width: DOT,
              height: DOT,
              borderRadius: DOT / 2,
              backgroundColor: c['ink-2'],
              opacity: still ? 0.6 : 0.4,
            },
            still
              ? undefined
              : {
                  animationName: BOUNCE,
                  animationDuration: TURN,
                  animationDelay: place * BEAT,
                  animationIterationCount: 'infinite',
                  animationTimingFunction: 'ease-in-out',
                },
          ]}
        />
      ))}
    </View>
  )
}
