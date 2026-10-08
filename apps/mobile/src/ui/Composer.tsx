import { useState, type Ref } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, Square } from 'lucide-react-native'
import { commit } from '../data/haptics'
import { useKeyboardShowing } from '../data/keyboard'
import { MOBILE_TYPOGRAPHY } from '../data/typography'
import { ComposerEditor } from '../native/composer/Editor'
import type { ComposerEditorHandle } from '../native/composer/types'
import { useTheme } from '../theme'
import { BorderBeam } from '../../vendor/beam'
import { cast, lifted } from './elevation'
import { GLASS_SUPPORTED, GlassMaterial } from './Glass'
import { Press, styles, TARGET } from './ui'

/**
 * The composer's measures. The one-line shape is T3 Code mobile's capsule
 * (`src/features/threads/ThreadComposer.tsx`, the resting shape handed to `ComposerSurface`, and
 * `src/components/ComposerToolbar.tsx`, `ComposerActionButton`): one line of text 36 points high
 * beside a 44-point target, with 2 points above and below.
 */
const LINE = MOBILE_TYPOGRAPHY.typing.lineHeight
/** One line of text with its room: the reference's 36. */
const ONE_LINE = 36
/** The room above and below the text inside the editor, which is what makes one line 36. */
const INSET = (ONE_LINE - LINE) / 2
/** The most the text is given before it scrolls inside the composer: the reference's 160. */
const TALLEST = 160
/** What the dock keeps clear around the shape, and the shape keeps clear around what it holds. */
const AROUND = 6
const EDGE_ROOM = 2
/**
 * Half the one-line height, so one line is a true capsule. It is also the button's own round
 * (22, half its target) plus the 2 points between them, so the two curves share a centre, and it
 * stays this when the text grows: the corner under the button never moves.
 */
const CORNER = TARGET / 2 + EDGE_ROOM
/** The drawn round of the one button, inside its 44-point target. */
const ROUND = 30

/**
 * Where a Person writes to Vivid: on the first screen to start a Thread, and in a Thread to
 * speak in it. The text is owned by the screen (a suggestion can fill it, a failed send keeps
 * it); this draws the field and the one button beside it.
 *
 * It has one shape, and it is the same size whether or not it is being written in: the text and
 * the button side by side on the system's glass. It grows only when the text does, a line at a
 * time up to `TALLEST`, after which the text scrolls inside it; the button stays at the foot,
 * where the thumb is. The reference this was ported from (T3 Code mobile's `ThreadComposer`)
 * opens a taller card as soon as the field has the keyboard. The owner asked on 6 October 2026
 * for the composer to "stay the same size unless when the input actually grows", so the card is
 * not here, and with it went the timed change of shape: a line that wraps is given its room at
 * once, as typing is never animated.
 *
 * The glass is a passive material laid under the content, not its parent, so the controls stay
 * out of the effect view's layout (the reference's `ComposerSurface`). The shadow is not the
 * reference's (`shadow-[0_6px_28px]`, one wide blur): it is the app's own tier for what floats
 * over the page (`ui/elevation.ts`), and the shape has no border beside it.
 *
 * The button is always there, as the reference's is: dimmed when there is nothing to send, the
 * way to send when there is, and while Vivid is working with nothing written the way to stop, in
 * the same place. Words written while Vivid works are sent to it (`act`). While it works there is
 * a beam travelling its edge (`Act`). The beam used to travel the whole composer's edge; the
 * owner asked for it on the send button alone (6 October 2026). The
 * reference's attachment button, dictation, model control and command popover are things
 * Vivid's composer does not have, and are not here.
 *
 * It rests on the home indicator's inset when the keyboard is down and directly on the keyboard
 * when it is up. The screen around it moves it there (`KeyboardAvoidingView`). The reference uses
 * `KeyboardStickyView` from a native keyboard module Vivid does not ship, so that is not ported.
 */
export function Composer({
  ref,
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
  value: string
  placeholder: string
  /**
   * Takes the keyboard as it appears. Only a Thread that has just taken the greeting's place
   * asks for it (`Front.Thread.writing`), so the keyboard a first message was typed on stays up.
   */
  autoFocus: boolean
  /** Vivid is in the middle of a Run here, so with nothing written the button stops it. */
  working: boolean
  /** A send is already on its way, so another cannot start. */
  disabled: boolean
  onChange: (text: string) => void
  onSend: () => void
  onStop: () => void
}) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardShowing()
  // What the editor says its text needs, inset included. One line is `ONE_LINE`.
  const [needed, setNeeded] = useState(ONE_LINE)
  const empty = value.trim().length === 0
  // With words written, the button sends them, while Vivid is working too: they join the answer
  // in progress at its next step (Flue's durability contract: a message that arrives while a
  // response is running joins it at a turn boundary, or waits its turn and is never lost). With
  // nothing written and Vivid working, it stops Vivid. Until 8 October 2026 it only stopped
  // while Vivid worked, so nothing could be said until the answer ended.
  const sends = !empty && !disabled
  const stops = working && !sends
  const idle = !sends && !stops

  function act() {
    if (idle) return
    commit()
    if (stops) onStop()
    else onSend()
  }

  return (
    <View
      style={{
        // The reference's dock: 12 at the sides and 6 above and below, over whatever the home
        // indicator needs when the keyboard is not covering it.
        paddingHorizontal: 12,
        paddingTop: AROUND,
        paddingBottom: (keyboard ? 0 : insets.bottom) + AROUND,
      }}
    >
      <View
        style={[
          styles.column,
          {
            borderRadius: CORNER,
            borderCurve: 'continuous',
            overflow: 'hidden',
          },
          // Over the page: the plugin's stack. The system's glass has an edge of its own; without
          // it the edge is the stack's ring, and there is no border.
          GLASS_SUPPORTED ? cast('md') : lifted('md', c.border),
        ]}
      >
        <GlassMaterial
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            borderRadius: CORNER,
            borderCurve: 'continuous',
          }}
        />
        {/* The button keeps to the foot as the text grows; one line is centred beside it. */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingVertical: EDGE_ROOM }}>
          <View
            style={{
              flex: 1,
              minWidth: 0,
              paddingLeft: 16,
              paddingVertical: (TARGET - ONE_LINE) / 2,
            }}
          >
            <ComposerEditor
              ref={ref}
              value={value}
              placeholder={placeholder}
              autoFocus={autoFocus}
              multiline
              onChangeText={onChange}
              onSubmit={act}
              // The text scrolls only once it has more lines than the composer will grow to.
              scrollEnabled={needed > TALLEST}
              // Android sets text from the top of its box, which leaves one line a few points
              // high beside the button (measured on a device); the editor centres it on
              // request. A point of tolerance, so a rounding difference is not a second line.
              singleLineCentered={needed <= ONE_LINE + 1}
              contentInsetVertical={INSET}
              onContentHeightChange={setNeeded}
              style={{ height: Math.min(TALLEST, Math.max(ONE_LINE, needed)) }}
              textStyle={MOBILE_TYPOGRAPHY.typing}
            />
          </View>
          <Act working={working} stops={stops} idle={idle} onPress={act} />
        </View>
      </View>
    </View>
  )
}

/**
 * The composer's one button: send, or stop while Vivid is working. A 44-point target around a
 * 30-point round with a 16-point glyph, the reference's `ComposerActionButton`
 * (`src/components/ComposerToolbar.tsx`). With nothing to do it is dimmed and does not answer.
 *
 * While Vivid is working a beam travels the round's edge: the border-beam effect's smallest
 * type, the one made for a button (`vendor/beam`, `size="sm"`; libraries.dev, from the owner's
 * bookmarks), in the colours and at the strength the web composer uses. It is drawn only then;
 * at rest nothing repaints. The round under it is quiet while it stops, a neutral disc with the
 * square in ink, so the beam is the one colour on it and is read as "at work", not as an alarm.
 */
function Act({
  working,
  stops,
  idle,
  onPress,
}: {
  /** Vivid is in the middle of a Run: the beam travels the edge. */
  working: boolean
  /** A press stops Vivid; otherwise it sends what is written. */
  stops: boolean
  idle: boolean
  onPress: () => void
}) {
  const { colors: c, dark } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={stops ? 'Stop Vivid' : 'Send'}
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
      <BorderBeam
        size="sm"
        active={working}
        colorVariant="ocean"
        strength={0.7}
        theme={dark ? 'dark' : 'light'}
        borderRadius={ROUND / 2}
      >
        <View
          style={{
            width: ROUND,
            height: ROUND,
            borderRadius: ROUND / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: stops ? c['subtle-strong'] : c.primary,
            opacity: idle ? 0.4 : 1,
          }}
        >
          {stops ? (
            <Square pointerEvents="none" size={11} color={c.foreground} fill={c.foreground} />
          ) : (
            <ArrowUp
              pointerEvents="none"
              size={16}
              strokeWidth={2.4}
              color={c['primary-foreground']}
            />
          )}
        </View>
      </BorderBeam>
    </Press>
  )
}
