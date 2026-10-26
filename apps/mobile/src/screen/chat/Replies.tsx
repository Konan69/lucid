import Animated, { Easing, Keyframe, ReduceMotion } from 'react-native-reanimated'
import { commit } from '../../data/haptics'
import type { Say } from '../../data/delivery'
import { useTheme } from '../../theme'
import { GlassMaterial } from '../../ui/Glass'
import { Label, Press, TARGET } from '../../ui/ui'

/** A reply's height: the app's compact control, its target made up to 44 by slop. */
const HEIGHT = 32
const REACH = (TARGET - HEIGHT) / 2

/** The owner's approved mockup (v8, 26 October 2026): 4 pt between replies. */
const GAP = 4

/** The strong ease-out every arrival in the app uses; no overshoot (the owner: "too much bounce"). */
const OUT = Easing.bezier(0.22, 1, 0.36, 1)

/**
 * One reply arriving: it slides in 16 pt from the left as it fades in, over 420 ms, each one 120 ms
 * after the one before, so they come one after another rather than as one pop (the owner, v5–v7:
 * "it still pops up at the same time", then "too fast").
 */
const arriving = (at: number) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateX: -16 }] },
    100: { opacity: 1, transform: [{ translateX: 0 }], easing: OUT },
  })
    .duration(420)
    .delay(at * 120)
    .reduceMotion(ReduceMotion.System)

/**
 * Leaving once the Person has said something: the row fades over 300 ms, easing back 6 pt to the
 * left ("disappears too fast"). It is the row that leaves, because the Thread unmounts the row.
 */
const LEAVING = new Keyframe({
  0: { opacity: 1, transform: [{ translateX: 0 }] },
  100: { opacity: 0, transform: [{ translateX: -6 }], easing: OUT },
})
  .duration(300)
  .reduceMotion(ReduceMotion.System)

/**
 * The replies Vivid offered under its newest reply (`offeredReplies` in `@vivid/state`), as taps:
 * pressing one says its words as the Person's next message, through the same `Say` the cards and
 * displays use, so it is sent exactly as if typed. The web draws the same (`Replies.tsx` in
 * `apps/web/src/screen/thread`).
 *
 * Nothing removes them. The Thread draws them only under the last bubble of the newest reply while
 * Vivid is not working, so once the Person's message lands under it, or Vivid starts again, they
 * leave on their own (`LEAVING`).
 *
 * Each is a short glass pill (the system's liquid glass where there is one, the frosted fill
 * elsewhere) with a hairline edge and no shadow, holding the "↪" character and one to three words,
 * as Claude Duet draws its suggestions. It sinks under a finger (`Press`) and the press is felt.
 */
export function Replies({ replies, onSay }: { replies: ReadonlyArray<string>; onSay: Say }) {
  const { colors: c } = useTheme()
  return (
    <Animated.View
      exiting={LEAVING}
      // In the column the bubbles are read in, clear of the face (24 wide, 8 apart).
      style={{ marginLeft: 32, flexDirection: 'row', flexWrap: 'wrap', gap: GAP }}
    >
      {replies.map((words, at) => (
        <Animated.View key={words} entering={arriving(at)}>
          <Press
            accessibilityRole="button"
            accessibilityLabel={words}
            hitSlop={{ top: REACH, bottom: REACH }}
            onPress={() => {
              commit()
              void onSay(words)
            }}
            style={{
              height: HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              paddingLeft: 10,
              paddingRight: 12,
              borderRadius: HEIGHT / 2,
              borderCurve: 'continuous',
              overflow: 'hidden',
              borderWidth: 0.5,
              borderColor: c['border-subtle'],
            }}
          >
            <GlassMaterial
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                borderRadius: HEIGHT / 2,
              }}
            />
            <Label size="label" tone="ink-3">
              ↪
            </Label>
            <Label size="body" numberOfLines={1}>
              {words}
            </Label>
          </Press>
        </Animated.View>
      ))}
    </Animated.View>
  )
}
