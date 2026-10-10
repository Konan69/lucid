import type { InputOption, InputRequest } from '@vivid/contracts'
import { nativeMetrics as m } from '@vivid/tokens/native'
import type { Option } from 'effect'
import { useState } from 'react'
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native'
import Animated, {
  Easing,
  FadeInUp,
  FadeOutDown,
  LinearTransition,
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
import { COMPOSER_CLEAR, COMPOSER_RESTING, COMPOSER_SIDE } from '../../ui/Composer'
import { HANG } from '../../ui/Presence'
import { EDGE, Label, Press } from '../../ui/ui'
import { KEYBOARD_RESERVE, standingOf, standOf, tallestOf, type Standing } from './asked'

/**
 * Whether the card is laid over the foot of the conversation and slides behind the composer, or
 * is a row of the screen's own column between the two.
 *
 * Ported from T3 Code mobile `src/features/threads/PendingUserInputCard.tsx`
 * (`EXPANDED_CARD_IS_OVERLAY`): an overlay on iOS, in the flow on Android, which "does not
 * hit-test touches outside a parent's bounds". The split is kept as the reference has it. Here
 * the overlay happens to lie inside its parent (the conversation's box), with only its tucked
 * strip outside, so the reason may not bind on Android; that is not proved on a device, and
 * until it is the reference's arrangement stands.
 */
export const OVERLAID = Platform.OS === 'ios'

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

/** The card arriving and leaving where it is in the flow: the reference's, on the same clock. */
const ARRIVE = FadeInUp.duration(RISE.duration)
  .easing(RISE.easing)
  .reduceMotion(ReduceMotion.System)
const DEPART = FadeOutDown.duration(RISE.duration)
  .easing(RISE.easing)
  .reduceMotion(ReduceMotion.System)
/** The card in the flow changing height when it is tucked: the reference's `CARD_LAYOUT_TRANSITION`. */
const RESIZE = LinearTransition.duration(200).reduceMotion(ReduceMotion.System)

/** How much narrower than the composer's shape the card is, at each side. */
const INSET = 10
/** How far the card's foot is tucked behind the composer's top edge. */
const TUCK = 12
/** How far below the conversation's box the card reaches: the dock's room, then the tuck. */
const OVERHANG = COMPOSER_CLEAR + TUCK
/**
 * How much of a tucked card shows above the composer's top edge: the grabber's row and a little
 * under it. One number for both arrangements. On a device (Android, in the flow, 11 October
 * 2026) the strip measured about 50 points where 40 was meant, because the tucked card kept the
 * whole room under its rows.
 */
const TUCKED = 40
/** A tucked card inside the overlay's window, whose foot is `TUCK` behind the composer's edge. */
const PEEK = TUCKED + TUCK
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
 * question waits on the Person looking at it. It holds a grabber and the rows, and nothing else:
 * the question itself is Vivid's message in the conversation (`Asked`, `Question.tsx`), and words
 * of the Person's own go in the composer, which answers the question while the card is up.
 *
 * Ported from T3 Code mobile `src/features/threads/PendingUserInputCard.tsx`
 * (`PendingUserInputCard`), mechanism kept:
 * - On iOS the card is an overlay inside a clipping window, and it slides its own measured
 *   height on the UI thread with no change of opacity: "fading an opaque card over the live
 *   transcript reads as a crossfade", so the card stays opaque and the conversation is only
 *   revealed where the card has physically left. It stays mounted while tucked.
 * - How far it stands over the conversation is written to a shared value (`cardCoverage`;
 *   `covered` here), and the conversation's foot glides by it on the same clock.
 * - On Android it is in the flow and arrives with `FadeInUp`, leaves with `FadeOutDown`.
 *
 * Adaptations, and why:
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
 * - No title, no question, no field and no submit button: one press on a row answers. An answer
 *   that did not go through is said over the composer (`screen/Chat.tsx`), not in the card.
 */
export function Choices(props: ChoicesProps) {
  return OVERLAID ? <Over {...props} /> : <Inflow {...props} />
}

/**
 * The most the card may be tall on this phone (`tallestOf`). The bar's room is the status bar,
 * the bar itself and Vivid's avatar hanging under it, which the card must not rise over.
 */
function useTallest(): number {
  const window = useWindowDimensions().height
  const insets = useSafeAreaInsets()
  return tallestOf({
    window,
    keyboard: KEYBOARD_RESERVE,
    bar: insets.top + NAV + HANG,
    composer: COMPOSER_RESTING,
  })
}

/**
 * The overlay. A window as wide as the conversation is fixed with its foot `OVERHANG` under the
 * conversation's box, which is `TUCK` behind the composer's top edge, and clips what is inside
 * it; the card sits at the window's foot and is translated down by whatever part of it is not
 * showing, so it leaves through the window's foot and never draws over the composer.
 *
 * `showing` is how many points of the card are in the window: all of it, `PEEK`, or none. It is
 * a derived value, so it is timed again whenever where the card stands or its measured height
 * changes, and when it reaches none for a card that is leaving it says so once.
 */
function Over({ request, leaving, sending, covered, onAnswer, onGone }: ChoicesProps) {
  const [tucked, setTucked] = useState(false)
  const tallest = useTallest()
  // The card's own height, written straight from its layout: the distance it slides.
  const height = useSharedValue(0)
  const stand = standOf(leaving, tucked)
  const showing = useDerivedValue<number>(() => {
    const whole = height.get()
    const target = { up: whole, tucked: Math.min(PEEK, whole), gone: 0 }[stand]
    return withTiming(target, RISE, (finished) => {
      if (finished === true && stand === 'gone') scheduleOnRN(onGone)
    })
  }, [stand, onGone])
  const slid = useAnimatedStyle(() => ({
    // Before it is measured nothing says how far down to hold it, so it is not drawn at all.
    opacity: height.get() > 0 ? 1 : 0,
    transform: [{ translateY: height.get() - showing.get() }],
  }))
  // The strip behind the composer covers none of the conversation.
  useAnimatedReaction(
    () => Math.max(0, showing.get() - OVERHANG),
    (over) => covered.set(over),
  )
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
        bottom: -OVERHANG,
        height: tallest + SHADOW_ROOM,
        // Never taller than the conversation's box: with the keyboard up and a long message
        // being typed there is less room than was reserved, and the card gives way, not the bar.
        maxHeight: '100%',
        justifyContent: 'flex-end',
        overflow: 'hidden',
      }}
    >
      <Animated.View
        // As wide as the conversation, with the card inset inside it: only the card takes a
        // touch, so the conversation still scrolls from the strips at its sides.
        pointerEvents="box-none"
        onLayout={(event) => height.set(event.nativeEvent.layout.height)}
        style={[{ flexShrink: 1 }, slid]}
      >
        <Surface
          request={request}
          // Tucked, the rows are still there under the window's foot, and must not be pressed;
          // nor may those of a request that has just been settled, here or anywhere else.
          rows={tucked || leaving ? 'held' : 'pressable'}
          tallest={tallest}
          // The window ends `OVERHANG` under the conversation's box, so that much of the card is
          // room of its own, measured with it: it slides its whole height.
          foot="padded"
          tucked={tucked}
          sending={sending}
          onToggle={() => setTucked((now) => !now)}
          onAnswer={onAnswer}
        />
      </Animated.View>
    </View>
  )
}

/**
 * The card in the flow, under the conversation and over the composer. The conversation's box is
 * shorter by the card, so nothing is written to `covered`. Tucked, the rows are not drawn and
 * the card is its grabber.
 *
 * Its foot is not part of its layout: the card ends where the conversation's box does, and the
 * strip behind the composer is drawn hanging under it (`Surface`, `foot`). It was a negative
 * margin until 11 October 2026; on a device the card then stood about 12 points higher than
 * meant and its last row ended behind the composer.
 */
function Inflow({ request, sending, onAnswer }: ChoicesProps) {
  const [tucked, setTucked] = useState(false)
  const tallest = useTallest()
  return (
    <Animated.View entering={ARRIVE} exiting={DEPART} layout={RESIZE} pointerEvents="box-none">
      <Surface
        request={request}
        rows={tucked ? 'absent' : 'pressable'}
        tallest={tallest}
        foot="hung"
        tucked={tucked}
        sending={sending}
        onToggle={() => setTucked((now) => !now)}
        onAnswer={onAnswer}
      />
    </Animated.View>
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
  tallest,
  foot,
  tucked,
  sending,
  onToggle,
  onAnswer,
}: {
  request: InputRequest
  /** The rows can be pressed, are there but out of reach, or are not drawn. */
  rows: 'pressable' | 'held' | 'absent'
  /** The most the card may be tall, its foot aside. Past it the rows scroll inside the card. */
  tallest: number
  /**
   * How the strip behind the composer is made: `padded` is room inside the card, measured with
   * it (the overlay slides the whole of it); `hung` is drawn under the card and takes no room
   * in the layout (the card in the flow ends where the conversation's box does).
   */
  foot: 'padded' | 'hung'
  tucked: boolean
  sending: Option.Option<string>
  onToggle: () => void
  onAnswer: (label: string) => void
}) {
  const { colors: c } = useTheme()
  // What is under the last row inside the conversation's box. The dock keeps `COMPOSER_CLEAR`
  // more between the box and the composer's edge, so the two together are `UNDER`; a tucked
  // card in the flow keeps only what makes its strip `TUCKED` tall over the composer.
  const under = rows === 'absent' ? TUCKED - COMPOSER_CLEAR - GRAB - EDGE : UNDER - COMPOSER_CLEAR
  return (
    <View
      style={{
        flexShrink: 1,
        // The height limit is on the shape that holds the scroller, which is what makes the
        // scroller, and not the card's room, give way when the rows do not fit. It was on a
        // wrapper, and the rows then ran on under the composer (seen on a device with five).
        maxHeight: tallest + (foot === 'padded' ? OVERHANG : 0),
        marginHorizontal: COMPOSER_SIDE + INSET,
        paddingHorizontal: ROW.side,
        paddingBottom: under + (foot === 'padded' ? OVERHANG : 0),
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
      <Grabber tucked={tucked} onPress={onToggle} />
      {rows !== 'absent' && (
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
      )}
      {foot === 'hung' && (
        // The same surface carried on behind the composer: empty, and drawn outside the card's
        // own box, so it changes nothing about where the card or its rows are.
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: '100%',
            left: -EDGE,
            right: -EDGE,
            height: OVERHANG,
            borderLeftWidth: EDGE,
            borderRightWidth: EDGE,
            borderColor: c.border,
            backgroundColor: c['subtle-strong'],
          }}
        />
      )}
    </View>
  )
}

/**
 * The grabber: a short bar in the middle of a row of its own at the top of the card. Pressing it
 * tucks the card down to that row, and pressing it again brings the card back. It is drawn 24
 * points tall and pressed at 44.
 */
function Grabber({ tucked, onPress }: { tucked: boolean; onPress: () => void }) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={tucked ? 'Show the choices' : 'Hide the choices'}
      accessibilityState={{ expanded: !tucked }}
      hitSlop={{ top: 10, bottom: 10 }}
      onPress={onPress}
      style={({ pressed }) => ({
        height: GRAB,
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
