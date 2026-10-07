import { StyleSheet, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { ThinkingOrb } from '../../vendor/orb'
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { cast, lifted } from './elevation'
import { GLASS_SUPPORTED, GlassMaterial } from './Glass'
import { APPEAR, LEAVE } from './motion/morph'
import { Label } from './ui'

/** The word beside the orb. The web says the same beside its own (`apps/web/src/screen/Thread.tsx`). */
const THINKING = 'Thinking…'

/** The orb is one of the library's two tuned sizes; its slot is as tall as a line of the word. */
const ORB = 20
const SLOT = 24

/** The bubble's height: the pill under Vivid's avatar is the same (`ui/Presence.tsx`, `PILL`). */
const BUBBLE = 30

/** What is kept clear under the bubble, before the composer, and over it, before the words. */
export const THINKING_CLEAR = 6

/**
 * How much room the bubble needs at the foot of a conversation. A Thread keeps this much clear
 * under its newest words, always, so the bubble arriving and leaving moves nothing.
 */
export const THINKING_ROOM = BUBBLE + THINKING_CLEAR * 2

/**
 * Vivid at work, said where the Person is already looking: at the foot of the conversation, just
 * above the composer they have just sent from, in the middle and in a bubble of its own.
 *
 * It was in Vivid's capsule at the top of the screen, and the owner asked for it "just above"
 * the composer (6 October 2026). There it was a bare line on the conversation's left inset, and
 * he asked for it "in the middle and still have a bubble, not on the left" (7 October 2026). The
 * arrangement is T3 Code mobile's working control (`FloatingWorkingControl`,
 * `src/features/threads/floating-working-control.tsx`): a glass pill centred over the foot of the
 * feed, above the composer, that fades in and out with the work. The glass is built as the pill
 * under Vivid's avatar is: an outline that clips, the passive material behind, the content in
 * front as the material's sibling.
 *
 * It floats: whoever draws it lays it over the foot of the conversation and keeps
 * `THINKING_ROOM` clear there, so nothing is pushed when it comes and goes.
 *
 * The orb is the one moving thing, and it is drawn only while this is. The bubble fades in and
 * out with the work; nothing else moves, and with reduced motion it is simply there.
 */
export function Thinking() {
  const { colors: c, dark } = useTheme()
  const vivid = useAppearance()
  return (
    <Animated.View
      entering={APPEAR}
      exiting={LEAVE}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${vivid.name} is thinking`}
      accessibilityState={{ busy: true }}
      // Said when it appears: it is how a Thread says that Vivid has started on what was sent.
      accessibilityLiveRegion="polite"
      style={[
        {
          height: BUBBLE,
          borderRadius: BUBBLE / 2,
          borderCurve: 'continuous',
          overflow: 'hidden',
        },
        // The system's glass has an edge of its own; without it the ring is the edge.
        GLASS_SUPPORTED ? cast('sm') : lifted('sm', c.border),
      ]}
    >
      <GlassMaterial
        style={[StyleSheet.absoluteFill, { borderRadius: BUBBLE / 2, borderCurve: 'continuous' }]}
      />
      <View
        style={{
          height: BUBBLE,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          // The orb is round and sits nearer its end than the word does to its own.
          paddingLeft: 6,
          paddingRight: 12,
        }}
      >
        <View style={{ width: SLOT, height: SLOT, alignItems: 'center', justifyContent: 'center' }}>
          {/* The words beside it name it, so a screen reader is not told twice. */}
          <ThinkingOrb
            state="breathing"
            size={ORB}
            theme={dark ? 'dark' : 'light'}
            accessibilityLabel=""
          />
        </View>
        <Label size="footnote" tone="ink-2" maxFontSizeMultiplier={1.3}>
          {THINKING}
        </Label>
      </View>
    </Animated.View>
  )
}
