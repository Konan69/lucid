import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { ThinkingOrb } from '../../vendor/orb'
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { APPEAR, LEAVE } from './motion/morph'
import { Label } from './ui'

/** The word beside the orb. The web says the same beside its own (`apps/web/src/screen/Thread.tsx`). */
const THINKING = 'Thinking…'

/** The orb is one of the library's two tuned sizes; its slot is as tall as a line of the word. */
const ORB = 20
const SLOT = 24

/**
 * Vivid at work, said where the Person is already looking: at the foot of the conversation, just
 * above the composer they have just sent from.
 *
 * It was in Vivid's capsule at the top of the screen, with a disc that rose to it from the send
 * button. The owner saw that on his phone and asked for it "just above" (6 October 2026): the
 * top of the screen is the far end from the thumb and from the words being answered. So the
 * capsule keeps Vivid's name, and this line stands under the newest message for as long as the
 * Run takes.
 *
 * The orb is the one moving thing, and it is drawn only while this is. The line fades in and out
 * with the work; nothing else moves, and with reduced motion it is simply there.
 */
export function Thinking() {
  const { dark } = useTheme()
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
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
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
      <Label tone="ink-2" style={{ lineHeight: SLOT }}>
        {THINKING}
      </Label>
    </Animated.View>
  )
}
