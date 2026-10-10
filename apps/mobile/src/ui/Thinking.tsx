import type { ComponentProps } from 'react'
import { View } from 'react-native'
import { ThinkingOrb } from '../../vendor/orb'
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { APPEAR, LEAVE } from './motion/morph'
import { Pill, PILL } from './Pill'
import { Label } from './ui'

/** The word beside the orb. The web says the same beside its own (`apps/web/src/screen/Thread.tsx`). */
const THINKING = 'Thinking…'

/** The orb is one of the library's two tuned sizes; its slot is as tall as a line of the word. */
const ORB = 20
const SLOT = 24

/** The bubble's height: every pill's, and the round button's that comes out of its end. */
export const BUBBLE = PILL

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
 * feed, above the composer, that fades in and out with the work. The shape is `Pill`
 * (`ui/Pill.tsx`), which says how the glass is built.
 *
 * It floats: `Floating` (`ui/Floating.tsx`) lays it over the foot of the conversation, with the
 * button that returns to the newest words folded into its end, and the conversation keeps
 * `THINKING_ROOM` clear there, so nothing is pushed when it comes and goes. `style` is how that
 * row moves it aside when the button comes out; the bubble itself decides nothing about where it
 * is.
 *
 * The orb is the one moving thing, and it is drawn only while this is. The bubble fades in and
 * out with the work; with reduced motion it is simply there.
 */
export function Thinking({ style }: { style: ComponentProps<typeof Pill>['style'] }) {
  const { dark } = useTheme()
  const vivid = useAppearance()
  return (
    <Pill
      interactive={false}
      // It says something and does nothing: a touch on it goes to the conversation under it.
      pointerEvents="none"
      entering={APPEAR}
      exiting={LEAVE}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${vivid.name} is thinking`}
      accessibilityState={{ busy: true }}
      // Said when it appears: it is how a Thread says that Vivid has started on what was sent.
      accessibilityLiveRegion="polite"
      style={style}
    >
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
    </Pill>
  )
}
