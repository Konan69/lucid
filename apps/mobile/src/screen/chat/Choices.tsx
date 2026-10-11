import type { InputAnswer, InputOption, InputRequest } from '@vivid/contracts'
import { asking } from '@vivid/state'
import { nativeMetrics as m } from '@vivid/tokens/native'
import type { Array as Arr } from 'effect'
import { Check, ChevronLeft } from 'lucide-react-native'
import { useCallback, useState } from 'react'
import { ScrollView, useWindowDimensions, View } from 'react-native'
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
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
import { EDGE, Label, Press, TARGET } from '../../ui/ui'
import { KEYBOARD_RESERVE, tallestOf } from './asked'

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

/**
 * One question giving way to the next, or to the one before: what the card holds fades out as
 * what replaces it fades in, over 160 ms, in place. Nothing slides, so the card reads as one
 * card being asked the next thing, not as a stack of cards. With reduced motion it simply
 * changes. The card's own height follows on the card's clock (`RISE`).
 */
const SWAP_IN = FadeIn.duration(160).reduceMotion(ReduceMotion.System)
const SWAP_OUT = FadeOut.duration(160).reduceMotion(ReduceMotion.System)

/** The button that moves on from a question several options may be chosen for. */
const BUTTON = { height: 46, corner: 14, over: 10 } as const

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
  /** The answers are on their way: nothing more can be chosen until that try ends. */
  readonly busy: boolean
  /**
   * Where the Person is in the request's questions. It is kept by the screen, not the card,
   * because the composer answers a question that offers no options (`asking.replyOf`, `@vivid/state`).
   */
  readonly drafting: asking.Asking
  readonly onDraft: (next: asking.Asking) => void
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
  /** Every question has its answer: send them, in the questions' order. */
  readonly onSend: (answers: Arr.NonEmptyReadonlyArray<InputAnswer>) => void
  /** The card has slid away. */
  readonly onGone: () => void
}

/**
 * What Vivid is asking, as a card that rises from behind the composer while the request waits on
 * the Person looking at it. A request carries one to four questions, and the card asks them one
 * at a time: the question's words, its options as rows, and, with more than one question, which
 * of them this is ("1 of 3") and a way back to the one before. The questions are also Vivid's
 * message in the conversation (`Asked`, `Question.tsx`).
 *
 * Answering one at a time, and sending every answer together at the end, is the model both
 * clients share (`asking`, `@vivid/state`), after T3 Code's
 * `ComposerPendingUserInputPanel.tsx`: a question that takes one option moves on by itself a
 * moment after the press (`ADVANCE_AFTER`), and one that takes several has a button to move on.
 *
 * The composer is hardly ever part of answering. What the Person sends from it is an ordinary
 * message: the server withdraws the waiting request when it takes that message, the card slides
 * away, and Vivid reads the message right after its own questions. So a reply both skips the
 * questions and answers them in the Person's own words, and the card has no field. The one
 * exception is a question that offers no options and takes words: with nothing to press, what
 * is sent from the composer is that question's answer, the card moves on, and what was picked
 * before is kept (`asking.replyOf`, `@vivid/state`). Its card is the question's words and its place.
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
 * - The reference lists every question in one scrolling card with a field under each and one
 *   "Submit answers" button. A phone's card over a composer has room for one question, so it
 *   takes the reference's web arrangement instead (one at a time, with its place and a way
 *   back), and it has no field: the composer under it is the field.
 * - An answer that did not go through is said over the composer (`screen/Chat.tsx`), not in the
 *   card, and the card goes back to the question the refusal names.
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
 * Answering a request's questions one at a time (`asking`, `@vivid/state`), as the card does
 * it: picking, moving on, going back, and the moment a single press is shown before the card
 * moves on. Where the Person is belongs to the screen (`drafting`, `onDraft`).
 *
 * A question that takes one option moves on by itself `ADVANCE_AFTER` after the press, so the
 * Person sees what they pressed; on the last question that sends. What moving on comes to is
 * worked out at the press, from what was just picked, and only carried out later; nothing can
 * be pressed meanwhile (`moving`).
 *
 * That later move is called off when the card stops being a way to answer: `alive` is a ref
 * callback for a mark the card draws only while its request is the one that is up, and React
 * runs its cleanup the moment the mark is taken out, which is when the request is withdrawn or
 * answered and when the card is unmounted. Until 11 October 2026 the move was left to run, so a
 * press on a request withdrawn within that moment still sent its answers. The signal is an
 * `AbortController` kept for the life of the card: once the card is called off it stays so.
 */
function useAnswering(
  request: InputRequest,
  drafting: asking.Asking,
  act: {
    readonly onDraft: (next: asking.Asking) => void
    readonly onSend: (answers: Arr.NonEmptyReadonlyArray<InputAnswer>) => void
  },
) {
  const { questions } = request
  const [moving, setMoving] = useState(false)
  const [off] = useState(() => new AbortController())
  const alive = useCallback(() => () => off.abort(), [off])

  function take(step: asking.Step) {
    asking.Step.$match(step, {
      Stay: () => undefined,
      Next: ({ asking: next }) => act.onDraft(next),
      Send: ({ answers }) => act.onSend(answers),
    })
  }

  function pick(label: string) {
    const picked = asking.press(questions, drafting, label)
    act.onDraft(picked)
    if (asking.progressOf(questions, picked).question.selection === 'Several') return
    const step = asking.advance(questions, picked)
    setMoving(true)
    setTimeout(() => {
      if (off.signal.aborted) return
      setMoving(false)
      take(step)
    }, asking.ADVANCE_AFTER)
  }

  // The ref callback is handed back apart from the rest: a value with a ref in it is treated
  // as a ref, and reading the rest while rendering would then be read as reading one.
  return [
    {
      progress: asking.progressOf(questions, drafting),
      moving,
      pick,
      next: () => take(asking.advance(questions, drafting)),
      back: () => act.onDraft(asking.back(drafting)),
    },
    alive,
  ] as const
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
  busy,
  drafting,
  dock,
  covered,
  onDraft,
  onSend,
  onGone,
}: ChoicesProps) {
  const [tucked, setTucked] = useState(false)
  const [answering, alive] = useAnswering(request, drafting, { onDraft, onSend })
  const tallest = useTallest(dock)
  // What slides, measured straight from its layout: the distance it travels.
  const height = useSharedValue(0)
  const stand = asking.standOf(leaving, tucked)
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
  // Tucked, the rows are still there under the window's foot, and must not be pressed; nor may
  // those of a request that has just been settled, here or anywhere else, or whose answers are
  // on their way, or in the moment a pressed option is shown before the card moves on.
  const held = tucked || leaving || busy || answering.moving
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
          progress={answering.progress}
          rows={held ? 'held' : 'pressable'}
          tucked={tucked}
          busy={busy}
          tallest={tallest}
          onPick={answering.pick}
          onNext={answering.next}
        />
        <Grabber tucked={tucked} disabled={leaving} onPress={() => setTucked((now) => !now)} />
        <Place progress={answering.progress} held={held} onBack={answering.back} />
        {/* There only while this request is the one that is up: see `useAnswering`. */}
        {!leaving && <View ref={alive} />}
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
 * Under the grabber's row it holds the question that is up (`Current`), keyed by the question's
 * place: moving to another question takes the one out and puts the other in, and the two
 * cross-fade (`SWAP_IN`, `SWAP_OUT`). The first question is simply there when the card rises.
 *
 * The shadow is written here and is not one of `ui/elevation.ts`'s tiers: those fall downward,
 * and this is the one shape in the app whose shadow falls up, onto the conversation it covers.
 */
function Surface({
  progress,
  rows,
  tucked,
  busy,
  tallest,
  onPick,
  onNext,
}: {
  progress: asking.Progress
  /** The rows can be pressed, or are there but out of reach. */
  rows: Reach
  /** Only the grabber's strip is showing, so the head's words are not drawn half cut. */
  tucked: boolean
  busy: boolean
  /** The most of the card that may stand over the composer. Past it the rows scroll inside. */
  tallest: number
  onPick: (label: string) => void
  onNext: () => void
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
      {/* The grabber's row. The grabber, the way back and the count are laid over it from
          outside (`Grabber`, `Place`). */}
      <View style={{ height: GRAB }} />
      <LayoutAnimationConfig skipEntering>
        <Animated.View
          key={progress.at}
          entering={SWAP_IN}
          exiting={SWAP_OUT}
          style={{ flexShrink: 1 }}
        >
          <Current
            progress={progress}
            rows={rows}
            tucked={tucked}
            busy={busy}
            onPick={onPick}
            onNext={onNext}
          />
        </Animated.View>
      </LayoutAnimationConfig>
    </View>
  )
}

/** Whether a card's controls can be pressed, or are there but out of reach. */
type Reach = 'pressable' | 'held'

/**
 * One question as the card asks it: its words at the head, its options as rows that scroll
 * under the head when they do not fit, and, for a question several options may be chosen for,
 * the button that moves on at the foot. A question that offers no options is its words and
 * nothing under them: the composer answers it, and says "Reply".
 */
function Current({
  progress,
  rows,
  tucked,
  busy,
  onPick,
  onNext,
}: {
  progress: asking.Progress
  rows: Reach
  tucked: boolean
  busy: boolean
  onPick: (label: string) => void
  onNext: () => void
}) {
  const { question } = progress
  const picked = asking.pickedIn(progress.draft)
  const several = question.selection === 'Several'
  return (
    <>
      <Title question={question.question} shown={!tucked} />
      {question.options.length > 0 && (
        <ScrollView
          // A card with more rows than fit scrolls inside itself, as the reference's does.
          bounces={false}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          pointerEvents={rows === 'held' ? 'none' : 'auto'}
          accessibilityElementsHidden={tucked}
          importantForAccessibility={tucked ? 'no-hide-descendants' : 'auto'}
          style={{ flexShrink: 1 }}
          contentContainerStyle={{ gap: ROW.gap }}
        >
          {question.options.map((option) => (
            <Row
              key={option.label}
              option={option}
              several={several}
              reach={rows}
              standing={asking.standingOf(picked.includes(option.label), busy)}
              onPress={() => onPick(option.label)}
            />
          ))}
        </ScrollView>
      )}
      {several && question.options.length > 0 && (
        <Onward
          last={progress.last}
          ready={progress.canAdvance}
          reach={tucked ? 'held' : rows}
          onPress={onNext}
        />
      )}
    </>
  )
}

/**
 * The button that moves on from a question several options may be chosen for: "Next", or "Send"
 * on the last question, where moving on sends every answer. It is at the card's foot, under the
 * rows and over the room behind the composer, and does nothing until at least one option is
 * chosen. A question that takes one option has no button; its press moves on.
 */
function Onward({
  last,
  ready,
  reach,
  onPress,
}: {
  /** Moving on from this question sends the answers. */
  last: boolean
  /** At least one option is chosen. */
  ready: boolean
  reach: Reach
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const open = ready && reach === 'pressable'
  return (
    <Press
      accessibilityRole="button"
      accessibilityState={{ disabled: !open }}
      disabled={!open}
      depth={0.96}
      onPress={onPress}
      containerStyle={{ marginTop: BUTTON.over }}
      style={{
        height: BUTTON.height,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: BUTTON.corner,
        borderCurve: 'continuous',
        backgroundColor: c.primary,
        opacity: open ? 1 : 0.4,
      }}
    >
      <Label size="body" tone="ink-on-accent" style={{ fontWeight: m['weight-title'] }}>
        {last ? 'Send' : 'Next'}
      </Label>
    </Press>
  )
}

/**
 * Where the Person is in a request of several questions, laid over the leading end of the
 * grabber's row: from the second question on a way back to the one before, with what was picked
 * there kept, and then which question this is ("2 of 3"), quietly. A request of one question
 * has neither.
 *
 * Like the grabber it is laid over the card from the view that slides, so the way back is a
 * full 44-point target (the row and the clear `HEADROOM` over it) with every point inside its
 * parent. It is drawn after the grabber and so takes its own corner of the grabber's target.
 */
function Place({
  progress,
  held,
  onBack,
}: {
  progress: asking.Progress
  /** The card's controls are out of reach. */
  held: boolean
  onBack: () => void
}) {
  const { colors: c } = useTheme()
  if (progress.of < 2) return null
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: 0,
        left: COMPOSER_SIDE + INSET,
        height: HEADROOM + GRAB,
        flexDirection: 'row',
        alignItems: 'flex-end',
      }}
    >
      {!progress.first && (
        <Press
          accessibilityRole="button"
          accessibilityLabel="Previous question"
          accessibilityState={{ disabled: held }}
          disabled={held}
          onPress={onBack}
          style={({ pressed }) => ({
            width: TARGET,
            height: HEADROOM + GRAB,
            paddingTop: HEADROOM + EDGE,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <ChevronLeft pointerEvents="none" size={18} strokeWidth={2} color={c['ink-2']} />
        </Press>
      )}
      <View
        pointerEvents="none"
        style={{
          height: GRAB + EDGE,
          justifyContent: 'center',
          // With no way back before it, it starts where the rows' labels start.
          paddingLeft: progress.first ? ROW.side * 2 : 0,
        }}
      >
        <Label
          size="micro"
          tone="ink-3"
          accessibilityLabel={`Question ${progress.at + 1} of ${progress.of}`}
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {`${progress.at + 1} of ${progress.of}`}
        </Label>
      </View>
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

/** What each standing looks like: the fill, and the ring round a row that is chosen. */
const PAINT = {
  open: { fill: 'subtle', ring: false },
  back: { fill: 'subtle', ring: false },
  chosen: { fill: 'accent-soft', ring: true },
} as const satisfies Record<asking.Standing, { fill: 'subtle' | 'accent-soft'; ring: boolean }>

/**
 * One option: its label, and what picking it means in a smaller line under it when the question
 * gave one. A chosen row is tinted with the accent inside a ring of it. Where several may be
 * chosen a chosen row also has a check at its trailing end, so what is chosen is not said by
 * colour alone, and a press takes the choice back; where one may be chosen the press moves on.
 * While the answers are on their way the rows that were not chosen stand back.
 *
 * It has no border and no keycap. The ring is a border that is always there, clear until the row
 * is chosen, so choosing a row never changes its size.
 */
function Row({
  option,
  several,
  reach,
  standing,
  onPress,
}: {
  option: InputOption
  /** Several of the question's options may be chosen, so this one is a checkbox. */
  several: boolean
  /** Whether the card's rows can be pressed at all (`Current`, `rows`). */
  reach: Reach
  standing: asking.Standing
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const paint = PAINT[standing]
  const chosen = standing === 'chosen'
  // A row out of reach is disabled as well as untouchable: a switch control or a keyboard
  // reaches a control by other ways than a touch. A chosen row can be pressed again only where
  // that takes the choice back.
  const open = reach === 'pressable' && (standing === 'open' || (chosen && several))
  return (
    <Animated.View
      style={{
        opacity: standing === 'back' ? STANDING_BACK : 1,
        transitionProperty: 'opacity',
        transitionDuration: m['dur-fast'],
      }}
    >
      <Press
        accessibilityRole={several ? 'checkbox' : 'button'}
        accessibilityLabel={[option.label, option.detail]
          .filter((part) => part.length > 0)
          .join(', ')}
        accessibilityState={several ? { checked: chosen, disabled: !open } : { disabled: !open }}
        disabled={!open}
        depth={0.96}
        onPress={onPress}
        style={{
          minHeight: ROW.height,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingVertical: ROW.vertical - RING,
          paddingHorizontal: ROW.side - RING,
          borderRadius: ROW.corner,
          borderCurve: 'continuous',
          borderWidth: RING,
          borderColor: paint.ring ? c.primary : 'transparent',
          backgroundColor: c[paint.fill],
        }}
      >
        <View style={{ flex: 1 }}>
          <Label
            size="body"
            style={{ fontSize: 15, lineHeight: 20, fontWeight: m['weight-title'] }}
          >
            {option.label}
          </Label>
          {option.detail.length > 0 && (
            <Label size="label" tone="ink-3">
              {option.detail}
            </Label>
          )}
        </View>
        {several && chosen && (
          <Check pointerEvents="none" size={18} strokeWidth={2} color={c.primary} />
        )}
      </Press>
    </Animated.View>
  )
}
