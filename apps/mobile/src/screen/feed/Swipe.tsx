import { Option } from 'effect'
import { Check, X } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  interpolate,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import { scheduleOnRN } from 'react-native-worklets'
import { commit, tick } from '../../data/haptics'
import { useTheme } from '../../theme'
import { Label } from '../../ui/ui'

/** One way a card can be swiped away: the words it says, in the card's own terms, and what it does. */
export interface Side {
  readonly words: string
  readonly run: () => void
  /**
   * Where the card goes once released past the line: `away` off the screen, as the list then folds
   * it (an answer, Done); `back` home, for a side that leaves the card where it is (opening its
   * Thread).
   */
  readonly ends: 'away' | 'back'
}

/** What each direction does: right is the card's answer, left its way out. Either may be absent. */
export interface Sides {
  readonly answer: Option.Option<Side>
  readonly away: Option.Option<Side>
}

/** The share of the card's width a drag must cross before a release acts (the haptic line). */
const ARM = 0.34
/** Under this sideways travel the drag still belongs to the list's scroll (`failOffsetY`). */
const SIDEWAYS = 10
const UPRIGHT = 10
/** Apple's scroll deceleration, used to project where a flick would come to rest. */
const DECELERATION = 0.99
/** The ring around the side's mark: radius 20 in a 44-point box. */
const RING = 2 * Math.PI * 20

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

/**
 * A Feed card the Person can swipe like a card in the hand (9 November 2026: "should feel like it's
 * floating off the screen and skewing"). The card follows the finger one to one, lifts toward the
 * Person, turns away in depth as a sheet pulled by one edge, leans from where it was held and skews
 * with the speed of the throw. Under it, the side it is heading to shows in that side's colour and
 * the card's own words; a ring fills as the drag nears the line. Crossing the line ticks; a release
 * past half the width, or a flick that would carry it there, throws the card off at the finger's
 * speed, and the side's work is done the moment the card has left its place, so the list closes
 * the gap while the card is still flying. Waiting for the throw's spring to settle left the empty
 * place standing for about a second after the card was gone (11 November 2026: "i still see its
 * place empty where it was, then a second later the space closes").
 *
 * Gesture, springs and haptics follow Apple's fluid interface rules (`apple-design`): velocity is
 * handed to the spring, the landing point is projected from the flick, a side the card cannot go
 * to resists instead of stopping hard. A vertical move stays the list's scroll.
 */
export function Swipe({
  sides,
  held,
  children,
}: {
  sides: Sides
  /** A press is on its way: the card takes no swipe until it is answered. */
  held: boolean
  children: ReactNode
}) {
  const motion = useSwipe(sides, held)
  return (
    <View
      onLayout={(event) => {
        motion.width.set(event.nativeEvent.layout.width)
        motion.height.set(event.nativeEvent.layout.height)
      }}
    >
      {Option.isSome(sides.answer) && (
        <Under side={1} words={sides.answer.value.words} motion={motion} />
      )}
      {Option.isSome(sides.away) && (
        <Under side={-1} words={sides.away.value.words} motion={motion} />
      )}
      <Animated.View pointerEvents="none" style={[styles.lift, motion.lifted]} />
      <GestureDetector gesture={motion.pan}>
        <Animated.View style={motion.carried}>{children}</Animated.View>
      </GestureDetector>
    </View>
  )
}

/** The values one swipe moves, shared between the card, its shadow and what waits under it. */
interface Motion {
  readonly x: SharedValue<number>
  readonly width: SharedValue<number>
  readonly height: SharedValue<number>
  /** The side last armed (1 or -1), kept while `fill` eases back so the side does not blink out. */
  readonly side: SharedValue<number>
  /** 0 to 1: how armed that side is, eased so the line reads as a step, not a flicker. */
  readonly fill: SharedValue<number>
  readonly pan: ReturnType<typeof Gesture.Pan>
  readonly carried: ReturnType<typeof useAnimatedStyle>
  readonly lifted: ReturnType<typeof useAnimatedStyle>
}

/**
 * The swipe's physics. Every frame runs on the UI thread; the JavaScript side hears only the three
 * moments that matter: the line crossed (a tick), the release that acts (a commit) and the throw
 * landing (the side's work).
 */
function useSwipe(sides: Sides, held: boolean): Motion {
  const still = useReducedMotion()
  const x = useSharedValue(0)
  const y = useSharedValue(0)
  const speed = useSharedValue(0)
  const pivot = useSharedValue(1)
  const height = useSharedValue(1)
  const width = useSharedValue(1)
  const lastSide = useSharedValue(1)
  const fill = useSharedValue(0)
  // The side a released card was thrown to, until its work is done; 0 when nothing is in flight.
  const thrown = useSharedValue(0)
  const right = Option.isSome(sides.answer)
  const left = Option.isSome(sides.away)
  // Plain booleans for the worklets, which cannot read the Sides' functions.
  const rightBack = Option.exists(sides.answer, ({ ends }) => ends === 'back')
  const leftBack = Option.exists(sides.away, ({ ends }) => ends === 'back')
  const act = (side: number) => Option.map(side > 0 ? sides.answer : sides.away, ({ run }) => run())

  // The tick is felt on the frame the line is crossed, both ways, and never per frame.
  useAnimatedReaction(
    () => armedSide(x.get() / width.get(), right, left),
    (now, before) => {
      if (before === null || now === before) return
      if (now !== 0) lastSide.set(now)
      fill.set(withTiming(now === 0 ? 0 : 1, { duration: 160 }))
      scheduleOnRN(tick)
    },
  )

  // A thrown card's work is done on the frame it clears its own place (a full width across), not
  // when the throw's spring settles: past that point the Person sees only the gap it left.
  const land = () => {
    'worklet'
    const side = thrown.get()
    if (side === 0) return
    thrown.set(0)
    scheduleOnRN(act, side)
  }
  useAnimatedReaction(
    () => thrown.get() !== 0 && Math.abs(x.get()) >= width.get(),
    (gone, before) => {
      if (gone && before !== true) land()
    },
  )

  const pan = Gesture.Pan()
    .enabled(!held && (right || left))
    .activeOffsetX([-SIDEWAYS, SIDEWAYS])
    .failOffsetY([-UPRIGHT, UPRIGHT])
    .onBegin((event) => {
      'worklet'
      // Held above the middle the card leans with the drag; held below, against it, as paper does.
      pivot.set(event.y < height.get() / 2 ? 1 : -1)
    })
    .onChange((event) => {
      'worklet'
      const allowed = event.translationX > 0 ? right : left
      // A side with nothing to do resists: the card moves a little and comes home.
      x.set(allowed ? event.translationX : event.translationX * 0.12)
      y.set(event.translationY * 0.4)
      speed.set(event.velocityX)
    })
    .onEnd((event) => {
      'worklet'
      const w = width.get()
      const projected = x.get() + ((event.velocityX / 1000) * DECELERATION) / (1 - DECELERATION)
      const side = landing(projected / w, event.velocityX, right, left)
      if (side === 0) {
        x.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: event.velocityX }))
        y.set(withSpring(0, { duration: 400, dampingRatio: 0.8 }))
        speed.set(withTiming(0, { duration: 200 }))
        return
      }
      scheduleOnRN(commit)
      if (side > 0 ? rightBack : leftBack) {
        x.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: event.velocityX }))
        y.set(withSpring(0, { duration: 400, dampingRatio: 0.8 }))
        speed.set(withTiming(0, { duration: 200 }))
        scheduleOnRN(act, side)
        return
      }
      const throwSpeed = side * Math.max(Math.abs(event.velocityX), 1500)
      thrown.set(side)
      y.set(withSpring(y.get() - 80, { duration: 500, dampingRatio: 1 }))
      // The spring's end lands the card too, should a measure leave the width unknown.
      x.set(
        withSpring(
          side * w * 1.8,
          { duration: 500, dampingRatio: 1, velocity: throwSpeed },
          (done) => {
            if (done) land()
          },
        ),
      )
    })

  const carried = useAnimatedStyle(() => {
    const p = x.get() / width.get()
    const near = Math.min(Math.abs(p), 1)
    const gone = Math.abs(p) > 1 ? Math.max(0, 1 - (Math.abs(p) - 1) * 2.4) : 1
    if (still) return { transform: [{ translateX: x.get() }], opacity: gone }
    const skew = Math.max(-6, Math.min(6, -speed.get() / 260))
    return {
      transform: [
        { perspective: 1000 },
        { translateX: x.get() },
        { translateY: y.get() - near * 16 },
        { rotateY: `${-p * 24}deg` },
        { rotateZ: `${p * 12 * pivot.get()}deg` },
        { skewY: `${skew}deg` },
      ],
      // The card thins a little as it lifts, so the side under it reads through its edge.
      opacity: gone * (1 - near * 0.1),
    }
  })

  // The lifted shadow is a fixed layer whose opacity moves: a shadow is never animated itself.
  const lifted = useAnimatedStyle(() => {
    const p = x.get() / width.get()
    const near = Math.min(Math.abs(p), 1)
    return {
      opacity: near * (Math.abs(p) > 1 ? 0 : 1),
      transform: [{ translateX: x.get() * 0.92 }, { translateY: 14 - near * 6 }, { scale: 0.96 }],
    }
  })

  return { x, width, height, side: lastSide, fill, pan, carried, lifted }
}

/** Which side a drag at this share of the width would act on now: 1 right, -1 left, 0 neither. */
function armedSide(p: number, right: boolean, left: boolean): number {
  'worklet'
  if (p >= ARM && right) return 1
  if (p <= -ARM && left) return -1
  return 0
}

/**
 * Where a release goes: past half the width, or flicked so it would come to rest there, and moving
 * that way (a flick back toward the middle never throws).
 */
function landing(projected: number, velocity: number, right: boolean, left: boolean): number {
  'worklet'
  const side = projected > 0.5 && right ? 1 : projected < -0.5 && left ? -1 : 0
  if (side === 0) return 0
  return Math.abs(velocity) < 50 || Math.sign(velocity) === side ? side : 0
}

/**
 * What waits under the card on one side. A faint wash of the side's colour while the Person
 * decides, a ring filling toward the line, then at the line a deeper wash, the mark filled and the
 * side's words. The answer is the accent at low strength (9 November 2026: "deep blue is too
 * much"); the way out is ink.
 */
function Under({ side, words, motion }: { side: 1 | -1; words: string; motion: Motion }) {
  const { colors: c } = useTheme()
  const tone = side > 0 ? c.accent : c.ink
  // Worklets copy what they close over: they get the shared values alone, never the gesture.
  const { x, width, side: lit, fill } = motion
  const shown = useAnimatedStyle(() => {
    const p = (x.get() / width.get()) * side
    const fade = p > 1 ? Math.max(0, 1 - (p - 1) * 2) : 1
    return { opacity: p > 0 ? Math.min(1, p / 0.06) * fade : 0 }
  })
  // How armed this side is: the shared fill, only while this is the side last armed.
  const on = () => {
    'worklet'
    return lit.get() === side ? fill.get() : 0
  }
  const wash = useAnimatedStyle(() => ({ opacity: 0.06 + 0.1 * on() }))
  const said = useAnimatedStyle(() => ({
    opacity: on(),
    transform: [{ translateY: (1 - on()) * 4 }],
  }))
  const mark = useAnimatedStyle(() => {
    const p = Math.max(0, (x.get() / width.get()) * side)
    const grow = interpolate(Math.min(1, p / ARM), [0, 1], [0.7, 1])
    return { transform: [{ scale: grow + 0.06 * on() }] }
  })
  const filled = useAnimatedStyle(() => ({ opacity: 0.18 * on() }))
  const ring = useAnimatedProps(() => {
    const p = Math.max(0, (x.get() / width.get()) * side)
    return { strokeDashoffset: RING * (1 - Math.min(1, p / ARM)) }
  })
  const Glyph = side > 0 ? Check : X
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.under, { justifyContent: side > 0 ? 'flex-start' : 'flex-end' }, shown]}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, styles.round, { backgroundColor: tone }, wash]}
      />
      {/* The mark over its word, in the strip the card has just left: beside the mark the card
          still covered the word at the line (Android emulator, 10 November 2026). */}
      <View style={styles.side}>
        <Animated.View style={[styles.mark, mark]}>
          <Svg width={44} height={44} style={styles.ring}>
            <Circle
              cx={22}
              cy={22}
              r={20}
              stroke={tone}
              strokeOpacity={0.14}
              strokeWidth={2.5}
              fill="none"
            />
            <AnimatedCircle
              cx={22}
              cy={22}
              r={20}
              stroke={tone}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={RING}
              fill="none"
              animatedProps={ring}
            />
          </Svg>
          <Animated.View style={[styles.core, { backgroundColor: tone }, filled]} />
          <Glyph size={18} strokeWidth={2.6} color={tone} />
        </Animated.View>
        <Animated.View style={said}>
          <Label size="label" style={{ fontWeight: '600', color: tone }} numberOfLines={1}>
            {words}
          </Label>
        </Animated.View>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  under: {
    position: 'absolute',
    inset: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  side: { width: 96, alignItems: 'center', gap: 6 },
  round: { borderRadius: 24, borderCurve: 'continuous' },
  lift: {
    position: 'absolute',
    inset: 0,
    borderRadius: 24,
    boxShadow: '0 22px 44px -18px rgba(16, 24, 56, 0.38)',
  },
  mark: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', transform: [{ rotate: '-90deg' }] },
  core: { position: 'absolute', width: 32, height: 32, borderRadius: 16 },
})
