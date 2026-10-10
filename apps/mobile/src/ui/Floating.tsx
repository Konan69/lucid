import { GlassContainer } from 'expo-glass-effect'
import { ChevronDown } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import Animated, {
  Easing,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
  type DerivedValue,
} from 'react-native-reanimated'
import { useTheme } from '../theme'
import { GLASS_SUPPORTED } from './Glass'
import { APPEAR, LEAVE, POP } from './motion/morph'
import { Pill } from './Pill'
import { BUBBLE, Thinking, THINKING_CLEAR } from './Thinking'
import { Press, TARGET } from './ui'

/** The room between the bubble and the button once they are apart. */
const GAP = 12

/**
 * How far each shape is pushed toward the other while the button is folded away: half of the gap
 * and the button's width, so the button's far edge lands exactly on the bubble's and the pair
 * reads as the bubble alone, in the middle.
 */
const SEPARATION = (GAP + BUBBLE) / 2

/** How near two glass shapes must be for the system to run them together. */
const MERGE = 12

/** The one clock the bubble, the button and the button's glyph move on. */
const TIMING = {
  duration: 240,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const

/** The button taking its new place when the bubble beside it comes or goes, on the same clock. */
const REPLACED = LinearTransition.duration(TIMING.duration)
  .easing(TIMING.easing)
  .reduceMotion(ReduceMotion.System)

/** The dot that says something new arrived. */
const DOT = 9

/**
 * What floats over the foot of a conversation, in the middle: the thinking bubble, and the round
 * button that returns to the newest words, which comes out of the bubble's end when the Person
 * has scrolled away from them.
 *
 * - Thinking, at the newest words: the bubble alone.
 * - Thinking, scrolled away: the bubble and the button side by side.
 * - Scrolled away, not thinking: the button alone, in the middle.
 * - Neither: nothing.
 *
 * Ported from T3 Code mobile `src/features/threads/floating-working-control.tsx`
 * (`FloatingWorkingControl`), mechanism kept: the two shapes are always laid out side by side
 * with a gap, and one progress value (`separationProgress`; `separation` here) runs from 0 to 1
 * when the Person scrolls away, over 240 ms on `Easing.out(Easing.cubic)`, honouring reduced
 * motion. At 0 the bubble is translated right by half of the gap and the button's width, and the
 * button left by the same, so the button sits inside the bubble's end; the button's glyph is as
 * opaque as the progress. At 1 neither is translated. Where the system has glass both shapes are
 * glass views in one `GlassContainer` (`spacing` 12, the reference's `GLASS_MERGE_SPACING`), so
 * their glass runs together while they are near; elsewhere they are two drawn pills on the same
 * transforms and the whole button, not only its glyph, is as opaque as the progress (the
 * reference's fallback branch).
 *
 * Adaptations, and why:
 * - The reference's control is 38.5 points high on a 16-point gap (separation 27.25). Vivid's
 *   bubble is 30, so the button is 30 and the gap 12 (separation 21): the owner approved those in
 *   the prototype.
 * - The reference sets the progress in an effect. Here it is a derived value, which Reanimated
 *   re-runs when `away` changes: the same `withTiming`, with no effect to run after the render.
 * - The reference's container hugs its two shapes. This one is as wide as the conversation, with
 *   the shapes in its middle: when thinking ends while the Person is scrolled away the bubble
 *   fades out (`LEAVE`) and the button moves to the middle on the same 240 ms clock (`REPLACED`),
 *   and a layout transition is measured in the parent, which therefore must not itself move.
 *   The reference draws that state as a separate branch and does not animate between the two.
 * - The reference's button answers on press-in. This one answers on release, as every control in
 *   the app does, so the press is seen: the shape sinks to 0.96.
 * - It has no number and no words. One or more messages that arrived while the Person was
 *   scrolled away are a dot on the button; how many is said to a screen reader (`label`).
 *
 * The row is always there, so what is inside it can fade out. It is as tall as a finger's target
 * and takes no touches itself: only the button does, and it is drawn at 30 points inside a
 * 44-point target that stays within the row, because Android does not send a touch to a child
 * outside its parent's bounds.
 *
 * Whoever draws this keeps `THINKING_ROOM` clear at the foot of the conversation
 * (`ui/Thinking.tsx`), so nothing in the conversation moves when any of it comes or goes.
 *
 * Not seen on an iPhone from here; whether the two glass shapes run together is unproved.
 */
export function Floating({
  thinking,
  away,
  arrived,
  label,
  onNewest,
}: {
  /** Vivid is at work or about to be. */
  thinking: boolean
  /** The Person has scrolled away from the newest words. */
  away: boolean
  /** Whether anything arrived while they were away, which is what the dot says. */
  arrived: boolean
  /** What the button says to a screen reader, with how many arrived. */
  label: string
  onNewest: () => void
}) {
  // It starts where it should rest (a derived value's first run takes an animation's end), as
  // the reference's `useSharedValue(showScrollToEnd ? 1 : 0)` does, and is timed from then on.
  const separation = useDerivedValue<number>(() => withTiming(away ? 1 : 0, TIMING), [away])
  const aside = useAnimatedStyle(() => ({
    transform: [{ translateX: SEPARATION * (1 - separation.get()) }],
  }))
  return (
    <Row>
      {thinking && <Thinking style={aside} />}
      {(thinking || away) && (
        <Newest
          separation={separation}
          beside={thinking}
          out={away}
          arrived={arrived}
          label={label}
          onPress={onNewest}
        />
      )}
    </Row>
  )
}

/**
 * The row the two shapes are laid out in: over the foot of the conversation, as tall as a
 * finger's target with the shapes in its middle, which puts their foot `THINKING_CLEAR` above
 * the composer. Where the system has glass it is the container that runs their glass together.
 */
function Row({ children }: { children: ReactNode }) {
  const row = {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: THINKING_CLEAR - (TARGET - BUBBLE) / 2,
    height: TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: GAP,
  } as const
  if (GLASS_SUPPORTED) {
    return (
      <GlassContainer spacing={MERGE} pointerEvents="box-none" style={row}>
        {children}
      </GlassContainer>
    )
  }
  return (
    <View pointerEvents="box-none" style={row}>
      {children}
    </View>
  )
}

/**
 * The round button that returns to the newest words. It is mounted whenever the bubble is, folded
 * into the bubble's end and untouchable until the Person scrolls away (`out`); with no bubble it
 * is there only while they are away, alone in the middle.
 *
 * `beside` is whether the bubble is beside it. Only then is it pushed toward the bubble by the
 * progress: alone, it stands in the middle whatever the progress is, so it arrives and leaves in
 * place. It is read as a plain value, not animated: the bubble coming or going changes the
 * layout, and the layout transition (`REPLACED`) is what carries the button across.
 *
 * The shape sinks under the finger as a whole (`Press` is outside the glass), and where the
 * system has glass the glass answers too (`interactive`), as the reference's does.
 */
function Newest({
  separation,
  beside,
  out,
  arrived,
  label,
  onPress,
}: {
  separation: DerivedValue<number>
  beside: boolean
  out: boolean
  arrived: boolean
  label: string
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const toward = useAnimatedStyle(
    () => ({
      transform: [{ translateX: beside ? -SEPARATION * (1 - separation.get()) : 0 }],
    }),
    [beside],
  )
  const shown = useAnimatedStyle(() => ({ opacity: separation.get() }))
  return (
    <Animated.View
      entering={APPEAR}
      exiting={LEAVE}
      layout={REPLACED}
      // Folded into the bubble it is not a control: not to a finger and not to a screen reader.
      pointerEvents={out ? 'box-none' : 'none'}
      accessibilityElementsHidden={!out}
      importantForAccessibility={out ? 'auto' : 'no-hide-descendants'}
      style={[{ width: BUBBLE, height: BUBBLE }, toward]}
    >
      <Press
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={!out}
        depth={0.96}
        // Drawn at 30 points and pressed at 44.
        hitSlop={(TARGET - BUBBLE) / 2}
        onPress={onPress}
      >
        {/* Without glass the whole pill fades with the progress; with it only the glyph does,
            and the glass itself stays, run into the bubble's. */}
        <Pill interactive style={[{ width: BUBBLE }, GLASS_SUPPORTED ? undefined : shown]}>
          <Animated.View
            style={[
              { width: BUBBLE, height: BUBBLE, alignItems: 'center', justifyContent: 'center' },
              GLASS_SUPPORTED ? shown : undefined,
            ]}
          >
            <ChevronDown pointerEvents="none" size={16} strokeWidth={2.4} color={c.ink} />
          </Animated.View>
        </Pill>
      </Press>
      {arrived && out && (
        // Outside the pill, which clips to its round: the dot stands on its edge.
        <Animated.View
          entering={POP}
          exiting={LEAVE}
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: -1,
            right: -1,
            width: DOT,
            height: DOT,
            borderRadius: DOT / 2,
            backgroundColor: c.primary,
            // A ring in the page's colour, so the dot is not read as part of the button's edge.
            boxShadow: `0 0 0 2px ${c.screen}`,
          }}
        />
      )}
    </Animated.View>
  )
}
