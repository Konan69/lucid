import type { InputOption, InputRequest } from '@vivid/contracts'
import { nativeMetrics as m } from '@vivid/tokens/native'
import type { Option } from 'effect'
import { useState } from 'react'
import { ScrollView, useWindowDimensions, View } from 'react-native'
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { scheduleOnRN } from 'react-native-worklets'
import { useTheme } from '../../theme'
import { COMPOSER_CLEAR, COMPOSER_SIDE } from '../../ui/Composer'
import { HANG } from '../../ui/Presence'
import { EDGE, Label, Press } from '../../ui/ui'
import { KEYBOARD_RESERVE, standingOf, standOf, tallestOf, type Standing } from './asked'

/**
 * The one clock the card and the foot of the conversation move on: the reference's
 * `USER_INPUT_TOGGLE_DURATION_MS` (220) on `Easing.out(Easing.cubic)`, "in the same class as the
 * iOS keyboard's". With reduced motion nothing travels; the card is where it should be.
 */
const RISE = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const

/** How much narrower than the composer's shape the card is, at each side. */
const INSET = 10
/** How far the card's foot is tucked behind the composer's top edge. */
const TUCK = 12
/** How far the window's foot is under the top of the composer's dock: its room, then the tuck. */
const OVERHANG = COMPOSER_CLEAR + TUCK
/**
 * How much of a tucked card shows above the composer's top edge: the grabber's row and a little
 * under it.
 */
const TUCKED = 40
/** A tucked card inside its window, whose foot is `TUCK` behind the composer's edge. */
const PEEK = TUCKED + TUCK
/**
 * Clear room over the card that moves with it, so the grabber can be pressed 44 points tall
 * without reaching into the first row: Android sends no touch to a control outside its parent,
 * so the room has to be inside what holds the grabber, not slop around it.
 */
const HEADROOM = 20
/** Room kept above the card inside its window, so the window does not cut the card's shadow. */
const SHADOW_ROOM = 32
/** The card's top corners. */
const CORNER = 22
/** The grabber's row, and the bar drawn in it. */
const GRAB = 24
/**
 * The room between the last row and the composer's top edge: a little more than the gap between
 * two rows, so the rows read as one group and the composer as the next thing. Everything of the
 * card below that edge is empty room and never a row.
 */
const UNDER = 10
/**
 * The question at the head of the card: the room over it (under the grabber's row) and under it
 * (over the first row), and the most lines it takes before it is cut short with an ellipsis. The
 * contract allows a question 400 characters long; all of it is in the Thread, as Vivid's message.
 */
const TITLE = { over: 4, under: 12, lines: 4 } as const
/** The system bar's own height under the status bar, in points. */
const NAV = 44

/** A row: at least a finger tall, and the measures the prototype was approved with. */
const ROW = { height: 48, corner: 14, gap: 8, vertical: 11, side: 14 } as const
/** The ring round the row whose answer is on its way, kept as a border so the row never resizes. */
const RING = 1.5
/** How far a row stands back while another answer is on its way. Still readable, plainly idle. */
const STANDING_BACK = 0.45

interface ChoicesProps {
  /** The request the card holds. */
  readonly request: InputRequest
  /** It is no longer the one that is up: the card slides away and then says so (`onGone`). */
  readonly leaving: boolean
  /** The answer that is on its way: a row's label, or the Person's own words. */
  readonly sending: Option.Option<string>
  /**
   * The measured height of the composer's dock (`ui/Composer.tsx`), which is the last thing in
   * the Thread's column: the card is anchored to it, so it stays on the composer when the
   * composer grows with its text and when the keyboard moves it.
   */
  readonly dock: number
  /**
   * Written with how far the card stands over the foot of the conversation, in points, on the UI
   * thread; the conversation keeps that much clear under its newest words.
   */
  readonly covered: SharedValue<number>
  readonly onAnswer: (label: string) => void
  /** The card has slid away. */
  readonly onGone: () => void
}

/**
 * The choices of a question from Vivid, as a card that rises from behind the composer while the
 * question waits on the Person looking at it. It holds a grabber, the question's words and the
 * rows, and nothing else. The question is also Vivid's message in the conversation (`Asked`,
 * `Question.tsx`), and words of the Person's own go in the composer, which answers the question
 * while the card is up.
 *
 * Ported from T3 Code mobile `src/features/threads/PendingUserInputCard.tsx`
 * (`PendingUserInputCard`), mechanism kept:
 * - The card is an overlay inside a clipping window, and it slides its own measured height on
 *   the UI thread with no change of opacity: "fading an opaque card over the live transcript
 *   reads as a crossfade", so the card stays opaque and the conversation is only revealed where
 *   the card has physically left. It stays mounted while tucked.
 * - How far it stands over the conversation is written to a shared value (`cardCoverage`;
 *   `covered` here), and the conversation's foot glides by it on the same clock.
 *
 * Adaptations, and why:
 * - One arrangement on both platforms. The reference is an overlay on iOS only and puts the card
 *   in the flow on Android (`EXPANDED_CARD_IS_OVERLAY`), because its overlay reaches outside a
 *   parent the size of its bar and Android "does not hit-test touches outside a parent's
 *   bounds". Here the window is an absolutely positioned child of the Thread's full-height
 *   column (`screen/Chat.tsx`), so every point of the card and of its tucked strip is inside its
 *   parent and can be touched on Android too. Vivid had the split until 11 October 2026; in the
 *   flow on a device the card came loose from the composer and its tucked strip stood in the
 *   middle of the conversation, where it could not be pressed.
 * - The window is anchored to the composer by measurement, not by constants: its foot is the
 *   measured height of the composer's dock above the column's foot, less `OVERHANG`. The column
 *   ends at the keyboard, so the card rides the keyboard with the composer.
 * - The reference's collapsed bar takes the composer's place. Vivid's composer always stays
 *   usable (it is how the Person answers in their own words, or says something else entirely),
 *   so there is no bar: the card rises from behind the composer's top edge, and tucked it shows
 *   its grabber there.
 * - The reference has two rest positions and drives them with a progress value set in the tap
 *   handler. Here there are three (up, tucked, gone) and the card leaves because the request's
 *   record changed, not because of a press, so what is animated is how much of the card shows,
 *   derived from where it stands (`standOf`).
 * - The reference first measures an expanded card without animating, because its list is doing
 *   its first end-pin. Vivid's conversation re-pins on every change of its content
 *   (`Transcript.settle`), so a card found waiting when a Thread opens simply rises.
 * - The reference keeps the card's foot on the bar it rises over. Here the foot is tucked behind
 *   the composer, and that strip is always empty room: the last row ends above the composer's
 *   top edge, and when the rows do not fit the card's most height they scroll inside it, as the
 *   reference's do, until the last one is wholly in view.
 * - No kicker, no field and no submit button: one press on a row answers. An answer
 *   that did not go through is said over the composer (`screen/Chat.tsx`), not in the card.
 */

/**
 * The most the card may be tall on this phone (`tallestOf`). The bar's room is the status bar,
 * the bar itself and Vivid's avatar hanging under it, which the card must not rise over.
 */
function useTallest(dock: number): number {
  const window = useWindowDimensions().height
  const insets = useSafeAreaInsets()
  return tallestOf({
    window,
    keyboard: KEYBOARD_RESERVE,
    bar: insets.top + NAV + HANG,
    composer: dock,
  })
}

/**
 * The window and the card in it. The window is as wide as the conversation and clips what is
 * inside it; its foot is `TUCK` behind the composer's top edge. The card sits at the window's
 * foot and is translated down by whatever part of it is not showing, so it leaves through the
 * window's foot and never draws over the composer.
 *
 * `showing` is how many points of what slides (the card and the clear `HEADROOM` over it) are in
 * the window: all of it, the tucked strip, or none. It is a derived value, so it is timed again
 * whenever where the card stands or its measured height changes, and when it reaches none for a
 * card that is leaving it says so once.
 */
export function Choices({
  request,
  leaving,
  sending,
  dock,
  covered,
  onAnswer,
  onGone,
}: ChoicesProps) {
  const [tucked, setTucked] = useState(false)
  const tallest = useTallest(dock)
  // What slides, measured straight from its layout: the distance it travels.
  const height = useSharedValue(0)
  const stand = standOf(leaving, tucked)
  const showing = useDerivedValue<number>(() => {
    const whole = height.get()
    const target = { up: whole, tucked: Math.min(HEADROOM + PEEK, whole), gone: 0 }[stand]
    return withTiming(target, RISE, (finished) => {
      if (finished === true && stand === 'gone') scheduleOnRN(onGone)
    })
  }, [stand, onGone])
  const slid = useAnimatedStyle(() => ({
    // Before it is measured nothing says how far down to hold it, so it is not drawn at all.
    opacity: height.get() > 0 ? 1 : 0,
    transform: [{ translateY: height.get() - showing.get() }],
  }))
  // Neither the clear room over the card nor the strip under the dock's top covers anything.
  useAnimatedReaction(
    () => Math.max(0, showing.get() - HEADROOM - OVERHANG),
    (over) => covered.set(over),
  )
  const held = tucked || leaving
  return (
    <View
      // A card that is leaving is no longer a way to answer: not to a finger, and not to a
      // screen reader, which would otherwise still find its rows while it slides away.
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
        // As wide as the conversation, with the card inset inside it: only the card and its
        // grabber take a touch, so the conversation still scrolls from the strips at its sides.
        pointerEvents="box-none"
        onLayout={(event) => height.set(event.nativeEvent.layout.height)}
        style={[{ flexShrink: 1, paddingTop: HEADROOM }, slid]}
      >
        <Surface
          request={request}
          // Tucked, the rows are still there under the window's foot, and must not be pressed;
          // nor may those of a request that has just been settled, here or anywhere else.
          rows={held ? 'held' : 'pressable'}
          tucked={tucked}
          tallest={tallest}
          sending={sending}
          onAnswer={onAnswer}
        />
        <Grabber tucked={tucked} disabled={leaving} onPress={() => setTucked((now) => !now)} />
      </Animated.View>
    </View>
  )
}

/**
 * The card itself: an opaque raised surface with the app's edge on its top and sides and a soft
 * shadow cast upward, round at its top corners and square at its foot, which is behind the
 * composer. It is opaque on purpose, as the reference's is: it lies over the conversation with
 * no blur behind it, and a translucent card would show the message under it through the rows.
 *
 * The shadow is written here and is not one of `ui/elevation.ts`'s tiers: those fall downward,
 * and this is the one shape in the app whose shadow falls up, onto the conversation it covers.
 */
function Surface({
  request,
  rows,
  tucked,
  tallest,
  sending,
  onAnswer,
}: {
  request: InputRequest
  /** Only the grabber's strip is showing, so the head's words are not drawn half cut. */
  tucked: boolean
  /** The rows can be pressed, or are there but out of reach. */
  rows: 'pressable' | 'held'
  /** The most of the card that may stand over the composer. Past it the rows scroll inside. */
  tallest: number
  sending: Option.Option<string>
  onAnswer: (label: string) => void
}) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        flexShrink: 1,
        // The height limit is on the shape that holds the scroller, which is what makes the
        // scroller, and not the card's room, give way when the rows do not fit. It was on a
        // wrapper, and the rows then ran on under the composer (seen on a device with five).
        maxHeight: tallest + TUCK,
        marginHorizontal: COMPOSER_SIDE + INSET,
        paddingHorizontal: ROW.side,
        // Under the last row: `UNDER` to the composer's top edge, then the strip behind it.
        paddingBottom: UNDER + TUCK,
        borderTopLeftRadius: CORNER,
        borderTopRightRadius: CORNER,
        borderCurve: 'continuous',
        borderTopWidth: EDGE,
        borderLeftWidth: EDGE,
        borderRightWidth: EDGE,
        borderColor: c.border,
        backgroundColor: c['subtle-strong'],
        boxShadow: '0 -10px 30px -18px rgba(0, 0, 0, 0.3)',
      }}
    >
      {/* The grabber's row. The grabber itself is laid over it from outside (`Grabber`). */}
      <View style={{ height: GRAB }} />
      <Title question={request.question} shown={!tucked} />
      <ScrollView
        // A card with more rows than fit scrolls inside itself, as the reference's does.
        bounces={false}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        pointerEvents={rows === 'held' ? 'none' : 'auto'}
        accessibilityElementsHidden={rows === 'held'}
        importantForAccessibility={rows === 'held' ? 'no-hide-descendants' : 'auto'}
        style={{ flexShrink: 1 }}
        contentContainerStyle={{ gap: ROW.gap }}
      >
        {request.options.map((option) => (
          <Row
            key={option.label}
            option={option}
            reach={rows === 'held' ? 'held' : 'pressable'}
            standing={standingOf(option.label, sending)}
            onPress={() => onAnswer(option.label)}
          />
        ))}
      </ScrollView>
    </View>
  )
}

/**
 * The question the choices answer, at the head of the card: under the grabber's row and over the
 * rows. The owner asked for it there (10 October 2026: "the title of the question should be on
 * the card"). It is also still Vivid's message in the Thread (`Asked`, `Question.tsx`), which is
 * what remains as history once the card has gone, so while the card is up the words are in both
 * places.
 *
 * It is part of the card's fixed head: when the rows do not fit they scroll under it. It starts
 * where the rows' labels start, not at the rows' edge. A long question takes at most
 * `TITLE.lines` lines. Its lines are balanced where the platform can (Android's
 * `textBreakStrategy`; iOS has no such setting for text).
 *
 * It is the card's heading for a screen reader, and the first thing in the card, so the card is
 * read question first, then the choices, then the grabber.
 *
 * It takes one question's words and knows nothing else about the request, so a request that
 * comes to carry several questions hands it the one being asked.
 *
 * Tucked, the strip over the composer is the grabber and a little under it, which would show the
 * top of the first line and nothing else; the words go clear while the card is tucked and come
 * back with it. They still slide with the card.
 */
function Title({ question, shown }: { question: string; shown: boolean }) {
  return (
    <Animated.View
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      style={{
        paddingHorizontal: ROW.side,
        paddingTop: TITLE.over,
        paddingBottom: TITLE.under,
        opacity: shown ? 1 : 0,
        transitionProperty: 'opacity',
        transitionDuration: m['dur-fast'],
      }}
    >
      <Label
        accessibilityRole="header"
        size="body"
        numberOfLines={TITLE.lines}
        ellipsizeMode="tail"
        textBreakStrategy="balanced"
        style={{ fontWeight: m['weight-strong'] }}
      >
        {question}
      </Label>
    </Animated.View>
  )
}

/**
 * The grabber: a short bar in the middle of the card's top row. Pressing it tucks the card down
 * to that row, and pressing it again brings the card back.
 *
 * It is laid over the card from the view that slides, not placed inside the card: its target is
 * the row (24 points) and the clear `HEADROOM` over it, 44 in all, every point of it inside its
 * parent, so it is as easy to press on Android as on iOS and never reaches into the first row.
 * The bar is drawn in the row, at the foot of the target.
 */
function Grabber({
  tucked,
  disabled,
  onPress,
}: {
  tucked: boolean
  /** The card is leaving. */
  disabled: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={tucked ? 'Show the choices' : 'Hide the choices'}
      accessibilityState={{ expanded: !tucked, disabled }}
      disabled={disabled}
      onPress={onPress}
      containerStyle={{
        position: 'absolute',
        top: 0,
        left: COMPOSER_SIDE + INSET,
        right: COMPOSER_SIDE + INSET,
      }}
      style={({ pressed }) => ({
        height: HEADROOM + GRAB,
        paddingTop: HEADROOM + EDGE,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: c.border }} />
    </Press>
  )
}

/** What each standing looks like: the fill, and the ring round the row that was chosen. */
const PAINT = {
  open: { fill: 'subtle', ring: false },
  back: { fill: 'subtle', ring: false },
  chosen: { fill: 'accent-soft', ring: true },
} as const satisfies Record<Standing, { fill: 'subtle' | 'accent-soft'; ring: boolean }>

/**
 * One choice: its label, and what picking it means in a smaller line under it when the request
 * gave one. One press answers with the label. While its answer is on its way the row is tinted
 * with the accent inside a ring of it, and the others stand back; it is the request's record
 * that takes the card away, not the call returning, so no row can be pressed a second time.
 *
 * It has no border and no keycap. The ring is a border that is always there, clear until the row
 * is chosen, so choosing a row never changes its size.
 */
function Row({
  option,
  reach,
  standing,
  onPress,
}: {
  option: InputOption
  /** Whether the card's rows can be pressed at all (`Surface`, `rows`). */
  reach: 'pressable' | 'held'
  standing: Standing
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const paint = PAINT[standing]
  // A row out of reach is disabled as well as untouchable: a switch control or a keyboard
  // reaches a control by other ways than a touch.
  const open = standing === 'open' && reach === 'pressable'
  return (
    <Animated.View
      style={{
        opacity: standing === 'back' ? STANDING_BACK : 1,
        transitionProperty: 'opacity',
        transitionDuration: m['dur-fast'],
      }}
    >
      <Press
        accessibilityRole="button"
        accessibilityLabel={[option.label, option.detail]
          .filter((part) => part.length > 0)
          .join(', ')}
        accessibilityState={{ disabled: !open, busy: standing === 'chosen' }}
        disabled={!open}
        depth={0.96}
        onPress={onPress}
        style={{
          minHeight: ROW.height,
          justifyContent: 'center',
          paddingVertical: ROW.vertical - RING,
          paddingHorizontal: ROW.side - RING,
          borderRadius: ROW.corner,
          borderCurve: 'continuous',
          borderWidth: RING,
          borderColor: paint.ring ? c.primary : 'transparent',
          backgroundColor: c[paint.fill],
        }}
      >
        <Label size="body" style={{ fontSize: 15, lineHeight: 20, fontWeight: m['weight-title'] }}>
          {option.label}
        </Label>
        {option.detail.length > 0 && (
          <Label size="label" tone="ink-3">
            {option.detail}
          </Label>
        )}
      </Press>
    </Animated.View>
  )
}
