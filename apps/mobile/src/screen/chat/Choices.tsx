import type { InputAnswer, InputOption, InputRequest } from '@vivid/contracts'
import { asking } from '@vivid/state'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { Option, type Array as Arr } from 'effect'
import { Check, ChevronDown, CircleHelp } from 'lucide-react-native'
import { useCallback, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated, {
  cubicBezier,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { useTheme } from '../../theme'
import { Label, Press } from '../../ui/ui'
import {
  Attached,
  CORNER,
  FOLD,
  HEADROOM,
  MARK,
  ROOM,
  STANDING_BACK,
  Surface,
  useSlide,
  useTallest,
} from './Banner'

/**
 * One question giving way to the next, or to the one before: what is under the head fades out as
 * what replaces it fades in, over 160 ms, in place. Nothing slides, so the banner reads as one
 * banner being asked the next thing. With reduced motion it simply changes. The banner's own
 * height follows on the banner's clock (`RISE`, `Banner.tsx`).
 */
const SWAP_IN = FadeIn.duration(160).reduceMotion(ReduceMotion.System)
const SWAP_OUT = FadeOut.duration(160).reduceMotion(ReduceMotion.System)

/** The check arriving on a chosen row: the app's swap curve, over 150 ms. */
const SWAP = cubicBezier(0.2, 0, 0, 1)
const CHECK = 150

/** The room between the banner's edge and what it holds: the reference's default density. */
const PAD = ROOM.default

/**
 * The head row: its least height, the column its mark sits in (which is also where the body's
 * start is, so the rows stand under the head's words), and the most lines of the question it
 * shows. The contract allows a question 400 characters long; all of it is in the Thread, as
 * Vivid's message.
 */
const HEAD = { height: 36, mark: MARK, lines: 2 } as const

/**
 * A row, as the mockup was approved: 40 points at least and pressed 44 tall, no fill at rest, a
 * label of up to three lines and a second line of up to three. The owner rejected cutting a
 * choice to one line with an ellipsis (11 October 2026: "truncated isn't helping design well"),
 * so a row grows with its words and the list scrolls instead.
 */
const ROW = { height: 40, corner: 8, gap: 2, vertical: 6, side: 10, lines: 3 } as const
/** The fade at the foot of the rows while more are below, and how much "more" is. */
const MORE = { fade: 26, least: 4 } as const

interface ChoicesProps {
  /** The request the banner holds. */
  readonly request: InputRequest
  /** It is no longer the one that is up: the banner slides away and then says so (`onGone`). */
  readonly leaving: boolean
  /** The answers are on their way: nothing more can be chosen until that try ends. */
  readonly busy: boolean
  /**
   * Where the Person is in the request's questions. It is kept by the screen, not the banner,
   * because the composer moves on from a question and answers one that offers no options
   * (`asking.replyOf`, `@vivid/state`).
   */
  readonly drafting: asking.Asking
  readonly onDraft: (next: asking.Asking) => void
  /**
   * The measured height of the composer's dock (`ui/Composer.tsx`), which is the last thing in
   * the Thread's column: the banner is anchored to it, so it stays on the composer when the
   * composer grows with its text and when the keyboard moves it.
   */
  readonly dock: number
  /**
   * Written with how far the banner stands over the foot of the conversation, in points, on the
   * UI thread; the conversation keeps that much clear under its newest words and the floating
   * row rides up by it.
   */
  readonly covered: SharedValue<number>
  /** Every question has its answer: send them, in the questions' order. */
  readonly onSend: (answers: Arr.NonEmptyReadonlyArray<InputAnswer>) => void
  /** The banner has slid away. */
  readonly onGone: () => void
}

/**
 * What Vivid is asking, as a banner attached to the top of the composer while the request waits
 * on the Person looking at it. A request carries one to four questions, and the banner asks them
 * one at a time. The questions are also Vivid's message in the conversation (`Asked`,
 * `Question.tsx`), which is what stays once the banner has gone.
 *
 * It is the banner the web has (`apps/web/src/screen/thread/Choices.tsx`), which is a port of
 * T3 Code web's (`components/chat/ComposerBanner.tsx`, `ComposerPendingUserInputPanel.tsx`), in
 * the measures of the phone mockup the owner approved on 11 October 2026. Kept from them:
 * - It is narrower than the composer, round at its top corners only and tucked behind the
 *   composer's top edge, so the two read as one shape.
 * - Its head is one row and the whole row is a control: a small mark, the question's words,
 *   which question this is ("2/3", only with more than one) and a chevron. Pressing it hides
 *   everything under the head, and pressing it again brings it back. What is hidden is one
 *   question: the banner is open again when another question comes up.
 * - Under the head, standing under the head's words: for a question several options may be
 *   chosen for, the line "Select one or more options."; then the options, each a plain row with
 *   no fill until it is pressed or chosen, and a check at its trailing end once chosen. They
 *   scroll inside the banner when they do not fit.
 * - There is no button in the banner. The composer under it moves on from a question and sends
 *   the answers (`ui/Composer.tsx`, `Onward`), after T3 Code's compact footer
 *   (`ComposerPrimaryActions.tsx`, the `pendingAction` branch).
 * - A question that takes one option moves on by itself a moment after the press
 *   (`ADVANCE_AFTER`); on the last question that sends.
 *
 * How it stands and moves is T3 Code mobile's `PendingUserInputCard.tsx`, kept from the card
 * this replaced:
 * - The banner is an overlay inside a clipping window, and it slides its own measured height on
 *   the UI thread with no change of opacity: "fading an opaque card over the live transcript
 *   reads as a crossfade". It stays mounted while closed.
 * - How far it stands over the conversation is written to a shared value (`covered`), and the
 *   conversation's foot and the floating row glide by it on the same clock.
 * - The window is an absolutely positioned child of the Thread's full-height column
 *   (`screen/Chat.tsx`), anchored to the composer's measured dock, so every point of the banner
 *   is inside its parent and can be touched on Android too, and it rides the keyboard with the
 *   composer.
 *
 * The surface, the window and the slide are in `Banner.tsx`, which an Approval's banner shares
 * (`Allow.tsx`).
 *
 * Where the phone differs from the web's banner, and why:
 * - A row has no number at its trailing end and no number key picks it: a phone has no keys.
 * - Closing it slides the banner down behind the composer until only its head shows; the web
 *   folds a grid row. The banner already moves by translation on the UI thread, and a fold would
 *   lay the conversation out again on every frame.
 * - The check arrives by opacity and scale with no blur: a blur is drawn again on every frame.
 * - The fade at the rows' foot is the surface's own colour drawn over the rows, since there is
 *   no mask to fade the rows themselves with.
 * - An answer that did not go through is said over the composer (`screen/Chat.tsx`), not in the
 *   banner, and the banner goes back to the question the refusal names.
 */

/**
 * Picking an option, as the banner does it on the model both clients share (`asking`,
 * `@vivid/state`).
 *
 * A question that takes one option moves on by itself `ADVANCE_AFTER` after the press, so the
 * Person sees what they pressed; on the last question that sends. What moving on comes to is
 * worked out at the press, from what was just picked, and only carried out later; no row can be
 * pressed meanwhile (`moving`). A question several options may be chosen for only toggles: the
 * composer moves on.
 *
 * That later move is called off when the banner stops being a way to answer: `alive` is a ref
 * callback for a mark the banner draws only while its request is the one that is up, and React
 * runs its cleanup the moment the mark is taken out, which is when the request is withdrawn or
 * answered and when the banner is unmounted. Until 11 October 2026 the move was left to run, so
 * a press on a request withdrawn within that moment still sent its answers. The signal is an
 * `AbortController` kept for the life of the banner: once the banner is called off it stays so.
 */
function usePicking(
  request: InputRequest,
  drafting: asking.Asking,
  act: Pick<ChoicesProps, 'onDraft' | 'onSend'>,
) {
  const { questions } = request
  const [moving, setMoving] = useState(false)
  const [off] = useState(() => new AbortController())
  const alive = useCallback(() => () => off.abort(), [off])

  function pick(label: string) {
    const picked = asking.press(questions, drafting, label)
    act.onDraft(picked)
    if (asking.progressOf(questions, picked).question.selection === 'Several') return
    const step = asking.advance(questions, picked)
    setMoving(true)
    setTimeout(() => {
      if (off.signal.aborted) return
      setMoving(false)
      asking.Step.$match(step, {
        Stay: () => undefined,
        Next: ({ asking: next }) => act.onDraft(next),
        Send: ({ answers }) => act.onSend(answers),
      })
    }, asking.ADVANCE_AFTER)
  }

  // The ref callback is handed back apart from the rest: a value with a ref in it is treated
  // as a ref, and reading the rest while rendering would then be read as reading one.
  return [{ progress: asking.progressOf(questions, drafting), moving, pick }, alive] as const
}

/**
 * The banner in its window (`Attached`, `Banner.tsx`): the head, and under it the question that
 * is up, on the surface every banner over the composer has.
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
  const [picking, alive] = usePicking(request, drafting, { onDraft, onSend })
  const { progress } = picking
  // The question the Person closed the banner on. It is one question's, not the banner's: when
  // another question comes up the banner is open again.
  const [closedAt, setClosedAt] = useState<Option.Option<number>>(Option.none())
  const open = !Option.contains(closedAt, progress.at)
  const tallest = useTallest(dock)
  const slide = useSlide(asking.standOf(leaving, !open), covered, onGone)
  // Closed, the rows are behind the composer and must not be pressed; nor may those of a request
  // that has just been settled, here or anywhere else, or whose answers are on their way, or in
  // the moment a pressed option is shown before the banner moves on.
  const held = !open || leaving || busy || picking.moving
  return (
    <Attached dock={dock} tallest={tallest} leaving={leaving} slide={slide}>
      <Surface tallest={tallest} variant="default" density="default">
        <Head
          progress={progress}
          open={open}
          disabled={leaving}
          onHeight={(height) => slide.head.set(height)}
          onToggle={() => setClosedAt(open ? Option.some(progress.at) : Option.none())}
        />
        <Body open={open}>
          <LayoutAnimationConfig skipEntering>
            <Animated.View
              key={progress.at}
              entering={SWAP_IN}
              exiting={SWAP_OUT}
              style={{ flexShrink: 1 }}
            >
              <Options
                progress={progress}
                reach={held ? 'held' : 'pressable'}
                busy={busy}
                onPick={picking.pick}
              />
            </Animated.View>
          </LayoutAnimationConfig>
        </Body>
      </Surface>
      {/* There only while this request is the one that is up: see `usePicking`. */}
      {!leaving && <View ref={alive} />}
    </Attached>
  )
}

/**
 * The head row, which is the control that closes and opens the banner: a column for the mark,
 * the question's own words, and at the trailing end which question this is and a chevron.
 *
 * The words are the question itself, since a question in Vivid's contract has no short header
 * (`packages/contracts/src/inputs.ts`): two lines at most while the banner is open, then an
 * ellipsis, and one quieter line while it is closed. All of the question is Vivid's message in
 * the Thread. The chevron points down while the banner is open and turns over when it is
 * closed, as the reference's `ToggleIcon` does.
 *
 * To a screen reader it is one control: what a press does, whether the banner is open, and as
 * its value the question and its place, so the question is heard here as well as in the Thread.
 * It is 36 points tall and pressed 44 (`HEADROOM`). It answers a press with the wash and does
 * not sink: a row as wide as the banner that shrank would read as the banner moving.
 */
function Head({
  progress,
  open,
  disabled,
  onHeight,
  onToggle,
}: {
  progress: asking.Progress
  /** Everything under the head is showing. */
  open: boolean
  /** The banner is leaving. */
  disabled: boolean
  /** The row was laid out this tall: what shows of a closed banner. */
  onHeight: (height: number) => void
  onToggle: () => void
}) {
  const { colors: c } = useTheme()
  const still = useReducedMotion()
  const place = progress.of > 1 ? `Question ${progress.at + 1} of ${progress.of}. ` : ''
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={
        open ? 'Hide the question and its options' : 'Show the question and its options'
      }
      accessibilityValue={{ text: `${place}${progress.question.question}` }}
      accessibilityState={{ expanded: open, disabled }}
      disabled={disabled}
      depth={1}
      hitSlop={{ top: HEADROOM }}
      onPress={onToggle}
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      style={({ pressed }) => ({
        minHeight: HEAD.height,
        flexDirection: 'row',
        alignItems: 'flex-start',
        // Concentric with the banner's corner: its 16 less the 4 between them.
        borderRadius: CORNER - PAD,
        borderCurve: 'continuous',
        backgroundColor: pressed ? c['wash-hover'] : 'transparent',
      })}
    >
      <View
        style={{
          width: HEAD.mark,
          height: HEAD.height,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <CircleHelp pointerEvents="none" size={13} strokeWidth={2} color={c['ink-3']} />
      </View>
      <Label
        size="footnote"
        tone={open ? 'ink' : 'ink-2'}
        numberOfLines={open ? HEAD.lines : 1}
        ellipsizeMode="tail"
        style={{
          flex: 1,
          minWidth: 0,
          marginVertical: 9,
          lineHeight: 18,
          fontWeight: open ? m['weight-strong'] : m['weight-title'],
        }}
      >
        {progress.question.question}
      </Label>
      <View
        style={{
          height: HEAD.height,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 6,
          paddingRight: 8,
        }}
      >
        {progress.of > 1 && (
          <Label
            size="micro"
            tone="ink-3"
            style={{ fontWeight: m['weight-title'], fontVariant: ['tabular-nums'] }}
          >
            {`${progress.at + 1}/${progress.of}`}
          </Label>
        )}
        <Animated.View
          style={{
            transform: [{ rotate: open ? '0deg' : '180deg' }],
            transitionProperty: 'transform',
            transitionDuration: still ? 0 : FOLD,
            transitionTimingFunction: 'ease-out',
          }}
        >
          <ChevronDown pointerEvents="none" size={15} strokeWidth={2.2} color={c['ink-3']} />
        </Animated.View>
      </View>
    </Press>
  )
}

/**
 * What is under the head. Closed, it is behind the composer (the banner has slid down to its
 * head), and it goes clear on the way there, so the head's words are never read against a row
 * sliding past; it is then no part of the screen to a finger or a screen reader.
 */
function Body({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <Animated.View
      pointerEvents={open ? 'auto' : 'none'}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      style={{
        flexShrink: 1,
        opacity: open ? 1 : 0,
        transitionProperty: 'opacity',
        transitionDuration: FOLD,
        transitionTimingFunction: 'ease-out',
      }}
    >
      {children}
    </Animated.View>
  )
}

/** Whether the banner's rows can be pressed, or are there but out of reach. */
type Reach = 'pressable' | 'held'

/**
 * One question's options, standing under the head's words: for a question several options may
 * be chosen for, the line that says so, and the rows, which scroll under that line when they do
 * not fit (`Rows`). A question that offers no options has nothing here: the composer answers
 * it, and says "Reply".
 */
function Options({
  progress,
  reach,
  busy,
  onPick,
}: {
  progress: asking.Progress
  reach: Reach
  busy: boolean
  onPick: (label: string) => void
}) {
  const { question } = progress
  if (question.options.length === 0) return null
  return (
    <View style={{ flexShrink: 1, paddingLeft: HEAD.mark, paddingRight: PAD, paddingBottom: PAD }}>
      {question.selection === 'Several' && (
        <Label size="caption" tone="ink-3" style={{ marginBottom: 4 }}>
          Select one or more options.
        </Label>
      )}
      <Rows progress={progress} reach={reach} busy={busy} onPick={onPick} />
    </View>
  )
}

/**
 * The rows, in a scroller that gives way when the banner has reached its most height. It draws
 * no scroll indicator; while more rows are below what is in sight, its foot fades into the
 * surface over `MORE.fade` points, which is the sign that there is more.
 *
 * Whether there is more is worked out on the UI thread from the scroller's own three measures
 * (its content, its room and how far it is scrolled), so nothing is drawn again by React while
 * the Person scrolls. The fade is the surface's colour laid over the rows and takes no touches.
 */
function Rows({
  progress,
  reach,
  busy,
  onPick,
}: {
  progress: asking.Progress
  reach: Reach
  busy: boolean
  onPick: (label: string) => void
}) {
  const { colors: c } = useTheme()
  const { question } = progress
  const picked = asking.pickedIn(progress.draft)
  const several = question.selection === 'Several'
  const content = useSharedValue(0)
  const room = useSharedValue(0)
  const scrolled = useSharedValue(0)
  const follow = useAnimatedScrollHandler((event) => scrolled.set(event.contentOffset.y))
  const more = useDerivedValue(() => content.get() - room.get() - scrolled.get() > MORE.least)
  const fading = useAnimatedStyle(() => ({
    opacity: withTiming(more.get() ? 1 : 0, { duration: CHECK, reduceMotion: ReduceMotion.System }),
  }))
  return (
    <View style={{ flexShrink: 1 }}>
      <Animated.ScrollView
        bounces={false}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={follow}
        onLayout={(event) => room.set(event.nativeEvent.layout.height)}
        onContentSizeChange={(_width, height) => content.set(height)}
        pointerEvents={reach === 'held' ? 'none' : 'auto'}
        style={{ flexShrink: 1 }}
        contentContainerStyle={{ gap: ROW.gap }}
      >
        {question.options.map((option) => (
          <Row
            key={option.label}
            option={option}
            several={several}
            reach={reach}
            standing={asking.standingOf(picked.includes(option.label), busy)}
            onPress={() => onPick(option.label)}
          />
        ))}
      </Animated.ScrollView>
      <Animated.View
        pointerEvents="none"
        style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, height: MORE.fade }, fading]}
      >
        <Svg width="100%" height={MORE.fade}>
          <Defs>
            <LinearGradient id="asked-more" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={c['subtle-strong']} stopOpacity={0} />
              <Stop offset="1" stopColor={c['subtle-strong']} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height={MORE.fade} fill="url(#asked-more)" />
        </Svg>
      </Animated.View>
    </View>
  )
}

/**
 * One option: its label, and what picking it means in a smaller line under it when the question
 * gave one. It has no fill and no edge at rest; under a finger it takes the wash and sinks a
 * little, and once chosen it keeps a stronger wash and shows a check at its trailing end, so
 * what is chosen is not said by its fill alone. Where several may be chosen a press takes the
 * choice back; where one may be chosen the press moves on. While the answers are on their way
 * the rows that were not chosen stand back.
 *
 * Both lines wrap, to three lines each at most, and are never cut to one. The check's place is
 * always kept, so choosing a row never changes where its words break. The check arrives by
 * opacity and scale (0.25 to 1) over 150 ms on the app's swap curve; with reduced motion it is
 * simply there.
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
  /** Whether the banner's rows can be pressed at all (`Choices`, `held`). */
  reach: Reach
  standing: asking.Standing
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const still = useReducedMotion()
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
        accessibilityState={
          several ? { checked: chosen, disabled: !open } : { selected: chosen, disabled: !open }
        }
        disabled={!open}
        depth={0.98}
        // Drawn at 40 points and pressed at 44: the two between one row and the next are both's.
        hitSlop={{ top: ROW.gap, bottom: ROW.gap }}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: ROW.height,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingVertical: ROW.vertical,
          paddingHorizontal: ROW.side,
          borderRadius: ROW.corner,
          borderCurve: 'continuous',
          backgroundColor: fillOf(chosen, pressed, c),
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Label size="footnote" numberOfLines={ROW.lines}>
            {option.label}
          </Label>
          {option.detail.length > 0 && option.detail !== option.label && (
            <Label size="caption" tone="ink-3" numberOfLines={ROW.lines}>
              {option.detail}
            </Label>
          )}
        </View>
        <Animated.View
          style={{
            width: 18,
            height: 18,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: chosen ? 1 : 0,
            transform: [{ scale: chosen ? 1 : 0.25 }],
            transitionProperty: ['opacity', 'transform'],
            transitionDuration: still ? 0 : CHECK,
            transitionTimingFunction: SWAP,
          }}
        >
          <Check pointerEvents="none" size={15} strokeWidth={2.4} color={c.primary} />
        </Animated.View>
      </Press>
    </Animated.View>
  )
}

/**
 * A row's fill: the stronger wash once chosen, the light wash under a finger, and none at rest.
 * A chosen row keeps its own fill under a finger; it still sinks, which is what says it heard.
 */
const fillOf = (
  chosen: boolean,
  pressed: boolean,
  colors: ReturnType<typeof useTheme>['colors'],
): string => {
  if (chosen) return colors['wash-selected']
  return pressed ? colors['wash-hover'] : 'transparent'
}
