import type { asking } from '@vivid/state'
import type { ReactNode } from 'react'
import { useWindowDimensions, View } from 'react-native'
import Animated, {
  Easing,
  interpolate,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { scheduleOnRN } from 'react-native-worklets'
import { useKeyboardShowing } from '../../data/keyboard'
import { useTheme } from '../../theme'
import { COMPOSER_CLEAR, COMPOSER_CORNER, COMPOSER_SIDE } from '../../ui/Composer'
import { HANG } from '../../ui/Presence'
import { EDGE } from '../../ui/ui'
import { keyboardRoomOf, tallestOf } from './asked'

/**
 * The banner attached to the top of the composer, as everything that asks the Person something
 * is drawn: a question's choices (`Choices.tsx`) and an Approval (`Allow.tsx`). This is what the
 * two share: the surface, how it is attached and tucked behind the composer, the shadow the
 * composer casts on it, and how it rises and leaves.
 *
 * It is a port of T3 Code web's composer banner (`components/chat/ComposerBanner.tsx`: `Surface`,
 * `Attachment`, `Root`), standing and moving as T3 Code mobile's `PendingUserInputCard.tsx`
 * does. `Choices.tsx` says what was kept from each and where the phone differs.
 */

/**
 * The one clock the banner, the foot of the conversation and the floating row move on: the
 * reference's `USER_INPUT_TOGGLE_DURATION_MS` (220) on `Easing.out(Easing.cubic)`, "in the same
 * class as the iOS keyboard's". With reduced motion nothing travels; the banner is where it
 * should be.
 */
const RISE = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const

/**
 * What changes in place when something in a banner is closed or opened: a chevron turning over
 * and a body going clear, over the 200 ms the approved mockup gives its fold.
 */
export const FOLD = 200

/**
 * How much narrower than the composer's shape the banner is, at each side: the composer's own
 * corner, as in the reference, whose `--chat-composer-drawer-inset` (1.375rem) is the 22 px of
 * its composer's corner (`ComposerSurface.tsx`). The banner's edges then come down on the
 * straight part of the composer's top edge. Until 12 October 2026 this was 10 against a corner
 * of 24, and each edge ran into the curve and showed as a cut corner.
 */
const INSET = COMPOSER_CORNER
/**
 * How far the banner's foot is tucked behind the composer's top edge: the reference's 1rem and
 * 1px (`ComposerBanner.tsx`, `Attachment`).
 */
const TUCK = 17
/** How far the window's foot is under the top of the composer's dock: its room, then the tuck. */
const OVERHANG = COMPOSER_CLEAR + TUCK
/**
 * Clear room over the banner that moves with it: a question's head row is 36 points and is
 * pressed 44 tall, and Android sends no touch to a control outside its parent, so the room has
 * to be inside what holds the banner, not slop around it.
 */
export const HEADROOM = 8
/** Room kept above the banner inside its window, so the window does not cut its shadow. */
const SHADOW_ROOM = 32
/** The banner's top corners. */
export const CORNER = 16
/**
 * The room between the banner's edge and what it holds: the 4 px all round of the reference's
 * default `density` (`Root`). Every banner has it. Until 12 October 2026 an Approval's took the
 * reference's `spacious` 12 on a warning surface; the owner rejected that banner as bloated, and
 * an Approval is now drawn as a question is.
 */
export const ROOM = 4
/** The system bar's own height under the status bar, in points. */
const NAV = 44
/**
 * The column a banner's leading mark sits in, which is also where what is under it starts: the
 * reference's `--composer-banner-icon-column` (28 px on a narrow screen).
 */
export const MARK = 30
/** How far a control stands back while an answer is on its way. Still readable, plainly idle. */
export const STANDING_BACK = 0.45

/**
 * The shadow the composer casts on the banner behind it (`Seam`): how far above the composer's
 * top edge it reaches, how dark it is on that edge in each theme, and how it falls off, as
 * stops of that darkness from the far end (0) to the edge (1). The curve puts half of the dark
 * in the last 4 points, so it reads as one surface resting on another. The web banner's is the
 * same (`asked-surface`, `apps/web/src/styles/motion.css`).
 *
 * The reference shades this seam with a straight 10 px ramp, in its dark theme only
 * (`--background-image-composer-seam-above`). The owner asked for the shadow in both themes
 * and better drawn (12 October 2026): a straight ramp of my own had read as a grey band.
 */
const SEAM = {
  reach: 16,
  light: 0.16,
  dark: 0.45,
  falloff: [
    [0, 0],
    [0.42, 0.2],
    [0.75, 0.55],
    [1, 1],
  ],
} as const

/**
 * The most the banner may be tall on this phone (`tallestOf`). The bar's room is the status bar,
 * the bar itself and Vivid's avatar hanging under it, which the banner must not rise over. The
 * keyboard's room is kept only while the keyboard is up (`keyboardRoomOf`), read from the same
 * store the composer rests on.
 */
export function useTallest(dock: number): number {
  const window = useWindowDimensions().height
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardShowing()
  return tallestOf({
    window,
    keyboard: keyboardRoomOf(keyboard),
    bar: insets.top + NAV + HANG,
    composer: dock,
  })
}

/**
 * How much of what slides is in the window, and the styles that follow from it.
 *
 * `showing` is how many points of what slides (the banner and the clear `HEADROOM` over it) are
 * in the window: all of it, its head and the strip behind the composer, or none. It is a derived
 * value, so it is timed again whenever where the banner stands or a measured height changes, and
 * when it reaches none for a banner that is leaving it says so once.
 *
 * What slides is translated down by whatever part of it is not showing, and never up: when it
 * becomes shorter in one layout (its head going from two lines to one as it is closed, a
 * question with fewer rows) it is at rest at once, where a translation up would lift its foot
 * off the composer for the length of the slide.
 *
 * `head` is the height of the row that stays in sight of a banner closed to it (`tucked`), with
 * the banner's room (`ROOM`) over and under it.
 */
export function useSlide(stand: asking.Stand, covered: SharedValue<number>, onGone: () => void) {
  // What slides and its head row, measured straight from their layout.
  const height = useSharedValue(0)
  const head = useSharedValue(0)
  const showing = useDerivedValue<number>(() => {
    const whole = height.get()
    const closed = Math.min(HEADROOM + EDGE + ROOM + head.get() + ROOM + TUCK, whole)
    const target = { up: whole, tucked: closed, gone: 0 }[stand]
    return withTiming(target, RISE, (finished) => {
      if (finished === true && stand === 'gone') scheduleOnRN(onGone)
    })
  }, [stand, onGone])
  const slid = useAnimatedStyle(() => ({
    // Before it is measured nothing says how far down to hold it, so it is not drawn at all.
    opacity: height.get() > 0 ? 1 : 0,
    transform: [{ translateY: Math.max(0, height.get() - showing.get()) }],
  }))
  // Neither the clear room over the banner nor the strip under the dock's top covers anything.
  useAnimatedReaction(
    () => Math.max(0, showing.get() - HEADROOM - OVERHANG),
    (over) => covered.set(over),
  )
  return { height, head, showing, slid }
}

/**
 * The window and what slides in it. The window is as wide as the conversation and clips what is
 * inside it; its foot is `TUCK` behind the composer's top edge. The banner sits at the window's
 * foot, inset from the window's sides so that the window never cuts its edge, and leaves through
 * the window's foot, so it never draws over the composer.
 *
 * The window is an absolutely positioned child of the Thread's full-height column
 * (`screen/Chat.tsx`), anchored to the composer's measured dock, so every point of the banner is
 * inside its parent and can be touched on Android too, and it rides the keyboard with the
 * composer.
 */
export function Attached({
  dock,
  tallest,
  leaving,
  slide,
  children,
}: {
  /** The measured height of the composer's dock (`ui/Composer.tsx`), which the window stands on. */
  dock: number
  /** The most the banner may be tall (`useTallest`). */
  tallest: number
  /** What it held is no longer what is up: it is sliding away. */
  leaving: boolean
  slide: ReturnType<typeof useSlide>
  children: ReactNode
}) {
  return (
    <View
      // A banner that is leaving is no longer a way to answer: not to a finger, and not to a
      // screen reader, which would otherwise still find its controls while it slides away.
      pointerEvents={leaving ? 'none' : 'box-none'}
      accessibilityElementsHidden={leaving}
      importantForAccessibility={leaving ? 'no-hide-descendants' : 'auto'}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: dock - OVERHANG,
        height: tallest + TUCK + SHADOW_ROOM,
        justifyContent: 'flex-end',
        overflow: 'hidden',
      }}
    >
      <Animated.View
        // As wide as the conversation, with the banner inset inside it: only the banner takes a
        // touch, so the conversation still scrolls from the strips at its sides.
        pointerEvents="box-none"
        onLayout={(event) => slide.height.set(event.nativeEvent.layout.height)}
        style={[{ flexShrink: 1, paddingTop: HEADROOM }, slide.slid]}
      >
        {children}
      </Animated.View>
      <Seam showing={slide.showing} />
    </View>
  )
}

/**
 * The banner's surface: an opaque raised layer with a quiet edge on its top and both sides and a
 * soft drop under it, round at its top corners and square at its foot, which is behind the
 * composer. It is opaque on purpose: it lies over the conversation with no blur behind it, and a
 * translucent banner would show the message under it through what it holds.
 *
 * The edge is the layer's quieter line (`line-2`, about a tenth of the ink), as the web
 * banner's is. It is the same for a question and for an Approval: the reference tints its
 * approval's surface with its warning colour, and Vivid's does not (the owner, 12 October 2026:
 * an Approval "should just ask a normal question"). The shadow is the reference's composer elevation,
 * which its attached banner shares (`--shadow-composer` and `--shadow-composer-dark`,
 * `apps/web/src/index.css`): a soft drop pulled in under the shape. It is written here and is
 * not one of `ui/elevation.ts`'s tiers, which have no drop this tight.
 *
 * The height limit is on this shape, which holds whatever scrolls: that is what makes the
 * scroller, and not the banner's room, give way when what it holds does not fit.
 */
export function Surface({ tallest, children }: { tallest: number; children: ReactNode }) {
  const { colors: c, dark } = useTheme()
  return (
    <View
      style={{
        flexShrink: 1,
        maxHeight: tallest + TUCK,
        marginHorizontal: COMPOSER_SIDE + INSET,
        paddingTop: ROOM,
        paddingHorizontal: ROOM,
        // Under what it holds: its own room, then the strip that is behind the composer, which
        // is always empty.
        paddingBottom: ROOM + TUCK,
        borderTopLeftRadius: CORNER,
        borderTopRightRadius: CORNER,
        borderCurve: 'continuous',
        borderTopWidth: EDGE,
        borderLeftWidth: EDGE,
        borderRightWidth: EDGE,
        borderColor: c['line-2'],
        backgroundColor: c['subtle-strong'],
        boxShadow: dark
          ? '0 14px 32px -18px rgba(0, 0, 0, 0.75)'
          : '0 12px 28px -18px rgba(0, 0, 0, 0.4)',
      }}
    >
      {children}
    </View>
  )
}

/**
 * The shadow the composer casts on the banner behind it (`SEAM`): a strip just above the
 * composer's top edge, as wide as the banner, dark at the edge and clear `SEAM.reach` above it.
 * It is a picture on both systems, as the reference's is a gradient: an Android elevation falls
 * downward only, and one drawing keeps the two systems the same.
 *
 * It is in the window, not on the banner, so it stays at the composer's edge while the banner
 * slides behind it; it is as present as the banner is behind it, so it is never drawn over the
 * conversation alone. It takes no touches.
 */
function Seam({ showing }: { showing: DerivedValue<number> }) {
  const { dark } = useTheme()
  const deepest = dark ? SEAM.dark : SEAM.light
  const present = useAnimatedStyle(() => ({
    opacity: interpolate(showing.get() - HEADROOM, [TUCK, TUCK + SEAM.reach], [0, 1], 'clamp'),
  }))
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: COMPOSER_SIDE + INSET,
          right: COMPOSER_SIDE + INSET,
          bottom: TUCK,
          height: SEAM.reach,
        },
        present,
      ]}
    >
      <Svg width="100%" height={SEAM.reach}>
        <Defs>
          <LinearGradient id="asked-seam" x1="0" y1="0" x2="0" y2="1">
            {SEAM.falloff.map(([at, share]) => (
              <Stop key={at} offset={at} stopColor="#000000" stopOpacity={deepest * share} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={SEAM.reach} fill="url(#asked-seam)" />
      </Svg>
    </Animated.View>
  )
}
