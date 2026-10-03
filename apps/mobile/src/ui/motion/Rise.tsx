import { useMemo, type ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import Animated, { Easing, FadeInDown } from 'react-native-reanimated'
import { nativeMetrics as m } from '@vivid/tokens/native'

/** The product's one settling curve (`--ease-out` in the web tokens): quick away, soft landing. */
const SETTLE = Easing.bezier(0.2, 0, 0, 1)

/** How far something rises as it arrives, in points. The web's `rise-in` travels the same six. */
const TRAVEL = 6

/** The beat between one arrival and the next: long enough to read as a sequence, not a wait. */
const BEAT = 60

/**
 * Something arriving on a screen the Person has just opened: it fades in while rising a few
 * points, once, when it mounts. `place` is its turn in a short list, so the items of one arrive
 * one after another (the web's `animate-rise-in stagger-n`), in the order they are read.
 *
 * It is for the rare screen that is waited for (the first screen, with its suggestions), never
 * for a row in a list that scrolls: a recycled row would arrive again every time it came back.
 *
 * The motion is a Reanimated layout animation, so it runs on the UI thread and nothing renders
 * per frame. Reanimated skips it when the phone is set to reduce motion (its default for layout
 * animations), and the content is simply there.
 */
export function Rise({
  place,
  style,
  children,
}: {
  place: number
  style?: StyleProp<ViewStyle>
  children: ReactNode
}) {
  // Built once for a place: an inline builder would be made again on every render.
  const entering = useMemo(
    () =>
      FadeInDown.duration(m['dur-slow'])
        .delay(place * BEAT)
        .easing(SETTLE)
        .withInitialValues({ transform: [{ translateY: TRAVEL }] }),
    [place],
  )
  return (
    <Animated.View entering={entering} style={style}>
      {children}
    </Animated.View>
  )
}
