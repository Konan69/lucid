import { Option } from 'effect'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { ThinkingOrb } from '../../vendor/orb'
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { APPEAR, LEAVE } from './motion/morph'
import { Pill, PILL } from './Pill'
import { Label } from './ui'

/** What the bubble says while Vivid is on no step. The web says the same (`apps/web/src/screen/thread/Doing.tsx`). */
export const THINKING = 'Thinking'

/** The orb is one of the library's two tuned sizes; its slot is as tall as a line of the word. */
const ORB = 20
const SLOT = 24

/** The bubble's height: every pill's, and the round button's that comes out of its end. */
export const BUBBLE = PILL

/** What is kept clear under the bubble, before the composer, and over it, before the words. */
export const THINKING_CLEAR = 6

/**
 * How much room the bubble needs at the foot of a conversation. A Thread keeps this much clear
 * under its newest words while the bubble is there (`screen/Chat.tsx`, `Transcript`).
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
 * `THINKING_ROOM` clear there for as long as it is shown. `style` is how that
 * row moves it aside when the button comes out; the bubble itself decides nothing about where it
 * is.
 *
 * The orb is the one moving thing, and it is drawn only while this is. The bubble fades in and
 * out with the work; with reduced motion it is simply there.
 */
export function Thinking({
  style,
  words,
  lead,
}: {
  style: ComponentProps<typeof Pill>['style']
  /** What Vivid is doing now ("Using Grain"); "Thinking" while it is on no step. */
  words: string
  /** The Integration's logo when the step works through one; Vivid's orb otherwise. */
  lead: Option.Option<ReactNode>
}) {
  const { dark } = useTheme()
  const vivid = useAppearance()
  return (
    <Pill
      interactive={false}
      raised={false}
      // It says something and does nothing: a touch on it goes to the conversation under it.
      pointerEvents="none"
      entering={APPEAR}
      exiting={LEAVE}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${vivid.name}: ${words}`}
      accessibilityState={{ busy: true }}
      // Said when it appears and when the step changes: it is how a Thread says what Vivid is on.
      accessibilityLiveRegion="polite"
      style={style}
    >
      <View
        style={{
          height: BUBBLE,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          // The orb is round and sits nearer its end than the word does to its own.
          paddingLeft: 6,
          paddingRight: 14,
        }}
      >
        <View style={{ width: SLOT, height: SLOT, alignItems: 'center', justifyContent: 'center' }}>
          {Option.getOrElse(lead, () => (
            // The words beside it name it, so a screen reader is not told twice.
            <ThinkingOrb
              state="breathing"
              size={ORB}
              theme={dark ? 'dark' : 'light'}
              accessibilityLabel=""
            />
          ))}
        </View>
        <Shimmer words={words} />
      </View>
    </Pill>
  )
}

/** One pass of the sheen across the words, then a rest before the next. */
const SWEEP = 1300
const REST = 500

/**
 * The words with a band of light passing across them, left to right, for as long as Vivid works:
 * the "it is alive" the owner asked of the status (26 October 2026: "should have some shimmer",
 * then "the shimmer isn't enough"). The band is the bubble's own surface at full strength over
 * the words, so the ink seems to catch the light where it passes; it is a translated view, so it
 * runs on the UI thread and costs no layout. It is the bubble's one moving thing besides the orb,
 * and only while the bubble is up. With reduced motion the words simply stand.
 */
function Shimmer({ words }: { words: string }) {
  const { colors: c } = useTheme()
  const reduced = useReducedMotion()
  const [width, setWidth] = useState(0)
  const at = useSharedValue(0)
  const band = Math.max(28, width * 0.45)
  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: -band + at.get() * (width + band) }],
  }))
  return (
    <View
      // The band starts once the words have a width, and starts again when the words change size,
      // so it always crosses exactly what is written.
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width)
        if (next === width) return
        setWidth(next)
        at.set(0)
        at.set(
          withRepeat(
            withSequence(
              withTiming(1, { duration: SWEEP, easing: Easing.linear }),
              withDelay(REST, withTiming(0, { duration: 0 })),
            ),
            -1,
          ),
        )
      }}
      style={{ overflow: 'hidden' }}
    >
      <Label size="footnote" tone="ink" maxFontSizeMultiplier={1.3} numberOfLines={1}>
        {words}
      </Label>
      {!reduced && width > 0 && (
        <Animated.View
          pointerEvents="none"
          style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, width: band }, sweep]}
        >
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={c.screen} stopOpacity={0} />
                <Stop offset="0.5" stopColor={c.screen} stopOpacity={0.82} />
                <Stop offset="1" stopColor={c.screen} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#sheen)" />
          </Svg>
        </Animated.View>
      )}
    </View>
  )
}
