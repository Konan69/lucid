import { useState, type ReactNode, type Ref } from 'react'
import { Platform, View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, Square } from 'lucide-react-native'
import Animated, {
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated'
import { Option } from 'effect'
import { commit } from '../data/haptics'
import { useKeyboardShowing } from '../data/keyboard'
import { MOBILE_TYPOGRAPHY } from '../data/typography'
import { ComposerEditor } from '../native/composer/Editor'
import type { ComposerEditorHandle } from '../native/composer/types'
import { useTheme } from '../theme'
import { BorderBeam } from '../../vendor/beam'
import { heldAfter, isOpen, type Held, type Measured } from './composer/expansion'
import { AnimatedGlassMaterial } from './Glass'
import type { Origin } from './Presence'
import { Press, styles, TARGET } from './ui'

/**
 * The composer's measures. All of them are T3 Code mobile's
 * (`src/features/threads/ThreadComposer.tsx`, the two shapes handed to `ComposerSurface`, and
 * `src/components/ComposerToolbar.tsx`, `ComposerActionButton`).
 *
 * At rest it is a capsule: one line of text 36 points high beside a 44-point target, with 2
 * points above and below. While it is being written in it is a card: the text has from 72 to 160
 * points and scrolls inside that, and the button sits in a row of its own under it.
 */
const LINE = MOBILE_TYPOGRAPHY.reading.lineHeight
/** The room above and below the text inside the editor: 6, which makes one line the capsule's 36. */
const INSET = 6
const RESTING = LINE + INSET * 2
const OPEN_SHORTEST = 72
const OPEN_TALLEST = 160
/** The card is never shorter than this, so opening it always reads as a change of shape. */
const CARD_SHORTEST = 140
/**
 * The capsule's corner is a number just past the card's, not half its height: the reference
 * keeps the two close so the corner hardly travels while the shape opens.
 */
const CAPSULE = 27
const CARD = 26
/** The drawn round of the one button, inside its 44-point target. */
const ROUND = 30

/** The capsule: the text and the button side by side, 2 points clear of the edge above and below. */
const CAPSULE_FRAME = {
  borderRadius: CAPSULE,
  overflow: 'hidden',
  flexDirection: 'row',
  alignItems: 'center',
  paddingVertical: 2,
} as const satisfies ViewStyle

/** The card: the text over a row that holds the button. */
const CARD_FRAME = {
  borderRadius: CARD,
  minHeight: CARD_SHORTEST,
  overflow: 'hidden',
  paddingTop: 14,
  paddingBottom: 6,
} as const satisfies ViewStyle

/**
 * Everything that differs between the two states, in one place: the frame, the room the dock
 * keeps around it (6 around the capsule, 8 around the card), where the text sits and where the
 * button sits. The reference has an attachment button before the text at rest; with none here,
 * the text starts 16 in from the capsule's edge.
 */
const AT_REST = {
  frame: CAPSULE_FRAME,
  around: 6,
  text: { flex: 1, minWidth: 0, paddingLeft: 16 },
  act: {},
} as const
const OPENED = {
  frame: CARD_FRAME,
  around: 8,
  text: { paddingHorizontal: 14 },
  act: { alignSelf: 'flex-end' },
} as const

/**
 * How the composer changes shape: one 220 ms layout transition, shared by the outline, the glass
 * behind it and the content, so the card grows upward without showing its final-size content
 * early. Android gets none. The reference's reason holds here too: the composer rides the
 * keyboard there, and a timed morph beside that movement reads as jitter.
 *
 * The reference's `COMPOSER_LAYOUT_TRANSITION` and `COMPOSER_TRANSITION_DURATION_MS`.
 */
const MORPH_MS = 220
const MORPHS = Platform.OS !== 'android'
const MORPH = MORPHS
  ? LinearTransition.duration(MORPH_MS).reduceMotion(ReduceMotion.System)
  : undefined

/**
 * The composer's shape: an outline that casts the shadow and clips, the system's glass behind,
 * and the content in front as the glass's sibling.
 *
 * Ported from T3 Code mobile `ComposerSurface` (`src/features/threads/ThreadComposer.tsx`). The
 * glass is a passive material (`GlassMaterial`) laid under the content, not its parent, so the
 * controls stay out of the effect view's layout. The shadow is the reference's
 * `shadow-[0_6px_28px]` in black at 15% in light and 35% in dark, and its elevation on Android
 * before 9, which has no outset box shadow.
 *
 * One change: the reference eases the corner by setting a shared value in a layout effect. Here
 * the animated style names its own target, which Reanimated eases to when the target changes, so
 * no effect is needed.
 */
function Surface({
  frame,
  children,
}: {
  frame: ViewStyle & { borderRadius: number }
  children: ReactNode
}) {
  const { dark } = useTheme()
  const corner = frame.borderRadius
  const rounded = useAnimatedStyle(() => ({
    borderRadius: MORPHS
      ? withTiming(corner, { duration: MORPH_MS, reduceMotion: ReduceMotion.System })
      : corner,
  }))
  return (
    <Animated.View
      layout={MORPH}
      style={[
        rounded,
        {
          overflow: 'hidden',
          boxShadow: dark ? '0 6px 28px rgba(0, 0, 0, 0.35)' : '0 6px 28px rgba(0, 0, 0, 0.15)',
          elevation: Platform.OS === 'android' && Platform.Version < 28 ? 10 : undefined,
        },
      ]}
    >
      <AnimatedGlassMaterial
        layout={MORPH}
        style={[{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }, rounded]}
      />
      <Animated.View collapsable={false} layout={MORPH} style={[frame, rounded]}>
        {children}
      </Animated.View>
    </Animated.View>
  )
}

/**
 * Where a Person writes to Vivid: on the first screen to start a Thread, and in a Thread to
 * speak in it. The text is owned by the screen (a suggestion can fill it, a failed send keeps
 * it); this draws the field and the one button beside it.
 *
 * It is the system's glass (`Surface`), and it has two shapes, as T3 Code mobile's composer does
 * (`ThreadComposer`): a capsule at rest, and a card while it is being written in. The reference
 * opens the card on focus. Here it is also open for a draft seen to need more than a line
 * (`composer/expansion.ts`), so words a suggestion filled in, or a draft kept from before, are
 * never cut to one line.
 *
 * The button is always there, as the reference's is: dimmed when there is nothing to send, the
 * way to send when there is, and while Vivid is working the way to stop, in the same place,
 * which is exactly where the thumb is. The reference's attachment button, dictation, model
 * control and command popover are things Vivid's composer does not have, and are not here.
 *
 * It rests on the home indicator's inset when the keyboard is down and directly on the keyboard
 * when it is up. The screen around it moves it there (`KeyboardAvoidingView`). The reference uses
 * `KeyboardStickyView` from a native keyboard module Vivid does not ship, so that is not ported.
 */
export function Composer({
  ref,
  origin,
  value,
  placeholder,
  autoFocus,
  working,
  disabled,
  onChange,
  onSend,
  onStop,
}: {
  ref?: Ref<ComposerEditorHandle>
  /**
   * Where a send leaves from on its way to the top of the screen (`ui/Presence.tsx`): put on the
   * button's round, and told each time the Person sends.
   */
  origin: Origin
  value: string
  placeholder: string
  /**
   * Takes the keyboard as it appears. Only a Thread that has just taken the greeting's place
   * asks for it (`Front.Thread.writing`), so the keyboard a first message was typed on stays up.
   */
  autoFocus: boolean
  /** Vivid is in the middle of a Run here, so the button stops instead of sending. */
  working: boolean
  /** A send is already on its way, so another cannot start. */
  disabled: boolean
  onChange: (text: string) => void
  onSend: () => void
  onStop: () => void
}) {
  const { dark } = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardShowing()
  const [focused, setFocused] = useState(false)
  // What the editor says its text needs, inset included. One line is `RESTING`.
  const [needed, setNeeded] = useState(RESTING)
  // The draft last seen to wrap. The card's width differs from the capsule's, so the shape is
  // decided from this and not from the latest height (`composer/expansion.ts`).
  const [held, setHeld] = useState<Held>(Option.none())
  const empty = value.trim().length === 0
  const idle = !working && (disabled || empty)
  const open = isOpen(focused, held, value)

  /** The editor measured the draft in the shape now drawn. */
  function measured(height: number) {
    setNeeded(height)
    // A point of tolerance, so a rounding difference in one line's height is not a wrap.
    const report: Measured = {
      text: value,
      frame: open ? 'card' : 'capsule',
      wrapped: height > RESTING + 1,
    }
    setHeld((now) => {
      const next = heldAfter(now, report)
      // The same text again is the same answer: keep the value React already has, so a repeated
      // report (Android sends one for every layout) does not render again.
      return Option.getOrNull(next) === Option.getOrNull(now) ? now : next
    })
  }
  const state = open ? OPENED : AT_REST

  function send() {
    if (idle) return
    commit()
    if (working) {
      onStop()
      return
    }
    // Counted in a value the UI thread reads, so the disc leaves without waiting for a render.
    origin.sends.set((count) => count + 1)
    onSend()
  }

  return (
    <View
      style={{
        // The reference's dock: 12 at the sides and the state's own room above and below, over
        // whatever the home indicator needs when the keyboard is not covering it.
        paddingHorizontal: 12,
        paddingTop: state.around,
        paddingBottom: (keyboard ? 0 : insets.bottom) + state.around,
      }}
    >
      {/* While Vivid is working, a beam travels the composer's edge: the same one, with the same
          colours and strength, as the web composer (`apps/web/src/screen/thread/Composer.tsx`).
          It is drawn only then; at rest nothing repaints. */}
      <BorderBeam
        active={working}
        colorVariant="ocean"
        strength={0.7}
        theme={dark ? 'dark' : 'light'}
        borderRadius={state.frame.borderRadius}
        style={styles.column}
      >
        <Surface frame={state.frame}>
          {/* The editor keeps its place in the tree in both shapes, so opening the card never
              remounts it and the keyboard stays up. */}
          <Animated.View layout={MORPH} style={state.text}>
            <ComposerEditor
              ref={ref}
              value={value}
              placeholder={placeholder}
              autoFocus={autoFocus}
              multiline
              onChangeText={onChange}
              onSubmit={send}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              // At rest the one line does not scroll; in the card the text scrolls inside it.
              scrollEnabled={open}
              contentInsetVertical={INSET}
              onContentHeightChange={measured}
              style={{
                height: open ? Math.min(OPEN_TALLEST, Math.max(OPEN_SHORTEST, needed)) : RESTING,
              }}
              textStyle={MOBILE_TYPOGRAPHY.reading}
            />
          </Animated.View>
          {/* A little air between the text and the row under it. Its slot is kept when the
              shape is a capsule, so the views around it keep their places in the tree. */}
          {open && <View style={{ height: 4 }} />}
          <Animated.View layout={MORPH} style={state.act}>
            <Act round={origin.button} working={working} idle={idle} onPress={send} />
          </Animated.View>
        </Surface>
      </BorderBeam>
    </View>
  )
}

/**
 * The composer's one button: send, or stop while Vivid is working. A 44-point target around a
 * 30-point round with a 16-point glyph, the reference's `ComposerActionButton`
 * (`src/components/ComposerToolbar.tsx`). With nothing to do it is dimmed and does not answer.
 */
function Act({
  round,
  working,
  idle,
  onPress,
}: {
  /** Where the screen finds the button's round, to fly a send from it. */
  round: Origin['button']
  working: boolean
  idle: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={working ? 'Stop Vivid' : 'Send'}
      accessibilityState={{ disabled: idle }}
      disabled={idle}
      onPress={onPress}
      style={({ pressed }) => ({
        width: TARGET,
        height: TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Animated.View
        ref={round}
        // Kept as a view of its own, so there is always something to measure.
        collapsable={false}
        style={{
          width: ROUND,
          height: ROUND,
          borderRadius: ROUND / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: working ? c['status-danger'] : c.primary,
          opacity: idle ? 0.4 : 1,
        }}
      >
        {working ? (
          <Square
            pointerEvents="none"
            size={11}
            color={c['ink-on-color']}
            fill={c['ink-on-color']}
          />
        ) : (
          <ArrowUp
            pointerEvents="none"
            size={16}
            strokeWidth={2.4}
            color={c['primary-foreground']}
          />
        )}
      </Animated.View>
    </Press>
  )
}
