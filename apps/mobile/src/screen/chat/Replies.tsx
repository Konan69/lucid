import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import type { Say } from '../../data/delivery'
import { useTheme } from '../../theme'
import { APPEAR } from '../../ui/motion/morph'
import { EDGE, Label, Press, TARGET } from '../../ui/ui'

/** How tall a reply is drawn: the control's height, on a line of its own under the bubbles. */
const HEIGHT = 32

/** How far a finger may land outside a reply and still press it, so it answers as a full target. */
const REACH = (TARGET - HEIGHT) / 2

/**
 * The replies Vivid offered under its newest reply (`offeredReplies` in `@vivid/state`), as taps:
 * pressing one says its words as the Person's next message, through the same `Say` the cards and
 * displays use, so it is sent exactly as if typed. The web draws the same (`Replies.tsx` in
 * `apps/web/src/screen/thread`).
 *
 * Nothing removes them. The Thread draws them only under the newest reply while Vivid is not
 * working, so once the Person's message lands under it, or Vivid starts again, they are not drawn.
 *
 * Each is a pill on the screen's own colour with the field's edge, so it reads as something to
 * press and not as another bubble; it fades in once as the reply settles (`APPEAR`, nothing with
 * reduced motion) and sinks under a finger (`Press`).
 */
export function Replies({ replies, onSay }: { replies: ReadonlyArray<string>; onSay: Say }) {
  const { colors: c } = useTheme()
  return (
    <Animated.View entering={APPEAR}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {replies.map((words) => (
          <Press
            key={words}
            accessibilityRole="button"
            accessibilityLabel={words}
            hitSlop={{ top: REACH, bottom: REACH }}
            onPress={() => void onSay(words)}
            style={({ pressed }) => ({
              height: HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 14,
              borderRadius: HEIGHT / 2,
              borderWidth: EDGE,
              borderColor: c['input-border'],
              backgroundColor: pressed ? c['wash-pressed'] : c.screen,
            })}
          >
            <Label size="footnote" tone="ink-3">
              ↪
            </Label>
            <Label size="footnote" numberOfLines={1}>
              {words}
            </Label>
          </Press>
        ))}
      </View>
    </Animated.View>
  )
}
