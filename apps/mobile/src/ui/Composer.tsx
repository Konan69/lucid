import { Option } from 'effect'
import { useState, type ReactNode, type Ref } from 'react'
import { Platform, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUp, ChevronLeft, Square } from 'lucide-react-native'
import { commit } from '../data/haptics'
import { useFontFamily } from '../data/font'
import { useKeyboardShowing } from '../data/keyboard'
import { MOBILE_TYPOGRAPHY } from '../data/typography'
import { ComposerEditor } from '../native/composer/Editor'
import type { ComposerEditorHandle } from '../native/composer/types'
import { useTheme } from '../theme'
import { BorderBeam } from '../../vendor/beam'
import { cast, lifted } from './elevation'
import { GLASS_SUPPORTED, GlassMaterial } from './Glass'
import { Label, Press, styles, TARGET } from './ui'

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

/** The pill that moves on from a question, and the round way back beside it (`Onward`). */
const PILL = { height: 34, side: 15, gap: 6 } as const
const BACK = 32
/** What the round button keeps between its drawn edge and the shape's: the pill keeps the same. */
const TRAILING = (TARGET - ROUND) / 2

/**
 * What the dock keeps clear above the composer's shape, for whatever is laid out against that
 * shape's top edge: a question's banner rises from behind it (`screen/chat/Choices.tsx`).
 */
export const COMPOSER_CLEAR = AROUND
/**
 * The shape's corner. A question's banner stands this far in from each side, so its edges come
 * down on the straight part of the composer's top edge and never across the curve.
 */
export const COMPOSER_CORNER = CORNER
/** What the dock keeps clear at each side of the shape. */
export const COMPOSER_SIDE = 12
/** The composer's height with one line in it and the keyboard up: the shape and the dock's room. */
export const COMPOSER_RESTING = TARGET + EDGE_ROOM * 2 + AROUND * 2

/**
 * A question from Vivid that is up over the composer (`screen/chat/Choices.tsx`), as far as the
 * composer has a part in it. The banner has no button of its own, as T3 Code's has none
 * (`ComposerPrimaryActions.tsx`, the `pendingAction` branch): the composer moves on from the
 * question. The web's composer is given the same (`apps/web/src/screen/thread/Composer.tsx`).
 */
export interface Onward {
  /** There is no question before this one to go back to. */
  readonly first: boolean
  /** Moving on from this question sends the answers. */
  readonly last: boolean
  /**
   * The question offers options, so words written under it are a message of their own. One
   * that offers none is answered by writing: the words are its answer, and the pill sends them.
   */
  readonly offers: boolean
  /** The question that is up has an answer, and none is on its way: the Person may move on. */
  readonly ready: boolean
  readonly onNext: () => void
  readonly onBack: () => void
}

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
 * While a question from Vivid is up (`asked`), the trailing end is T3 Code's compact footer in
 * place of the one button (`Moving`): from the second question a way back, and a pill that says
 * "Next", or "Submit" on the last question. Words written under a question that offers options
 * bring the ordinary button back, and it sends them as a message; under a question answered by
 * writing the pill stays, because the words are that question's answer (`screen/Chat.tsx`,
 * `reply`).
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
  asked,
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
  /** A question from Vivid is up: with nothing written, the trailing end moves on from it. */
  asked?: Onward
}) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardShowing()
  // What the editor says its text needs, inset included. One line is `ONE_LINE`.
  const [reported, setReported] = useState(ONE_LINE)
  // What the same words need when measured here (`Measure`), which is what an iPhone goes by.
  const [measured, setMeasured] = useState(ONE_LINE)
  // One of the two, never the larger of both. An iPhone's editor reports the height it was given
  // (see `Measure`), so once the composer had grown, that report stayed at the grown height and
  // the larger of the two never came down again: a line added with Return stayed after the line
  // was deleted and after the message was sent (seen on an iPhone, 13 October 2026). Android's
  // editor reports what its text needs and nothing is measured there.
  const needed = Platform.OS === 'ios' ? measured : reported
  const empty = value.trim().length === 0
  // With words written, the button sends them, while Vivid is working too: they join the answer
  // in progress at its next step (Flue's durability contract: a message that arrives while a
  // response is running joins it at a turn boundary, or waits its turn and is never lost). With
  // nothing written and Vivid working, it stops Vivid. Until 8 October 2026 it only stopped
  // while Vivid worked, so nothing could be said until the answer ended.
  // Words that cannot be sent yet (a send still on its way) leave the button dimmed, not a way to
  // stop: it must not change what it does under words the Person means to send.
  const sends = !empty && !disabled
  // While a question is up the trailing end moves on from it: with nothing written, and also
  // with words when the question is answered by writing, since the words are then its answer.
  // That comes before stopping, because a Run that asked is waiting on the Person, not working.
  // Until 12 October 2026 a question answered by writing kept the round arrow, so the last
  // question never said "Submit" (seen on the emulator).
  const moving = movingOf(Option.fromUndefinedOr(asked), empty)
  const stops = working && empty && Option.isNone(moving)
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
        paddingHorizontal: COMPOSER_SIDE,
        paddingTop: AROUND,
        paddingBottom: (keyboard ? 0 : insets.bottom) + AROUND,
      }}
    >
      <View style={styles.column}>
        <View
          style={[
            {
              borderRadius: CORNER,
              borderCurve: 'continuous',
              overflow: 'hidden',
            },
            // Over the page: the plugin's stack. The system's glass has an edge of its own;
            // without it the edge is the stack's ring, and there is no border.
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
          <View
            style={{ flexDirection: 'row', alignItems: 'flex-end', paddingVertical: EDGE_ROOM }}
          >
            <View
              style={{
                flex: 1,
                minWidth: 0,
                paddingLeft: 16,
                paddingVertical: (TARGET - ONE_LINE) / 2,
              }}
            >
              <Measure value={value} onHeight={setMeasured} />
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
                onContentHeightChange={setReported}
                style={{ height: Math.min(TALLEST, Math.max(ONE_LINE, needed)) }}
                textStyle={MOBILE_TYPOGRAPHY.typing}
              />
            </View>
            <Trailing moving={moving} empty={empty} sends={sends} onSend={act}>
              <Act working={working} stops={stops} idle={idle} onPress={act} />
            </Trailing>
          </View>
        </View>
      </View>
    </View>
  )
}

/**
 * The question the composer's trailing end moves on from, when it does: any question while
 * nothing is written, and one answered by writing while there are words too, since those words
 * are its answer. Words under a question that offers options are a message of their own, and
 * the ordinary button sends them.
 */
function movingOf(asked: Option.Option<Onward>, empty: boolean): Option.Option<Onward> {
  return Option.filter(asked, (question) => empty || !question.offers)
}

/**
 * How tall the words are, measured outside the editor: the same words in the same type and the
 * same width, drawn clear and out of the way, whose laid-out height is what the composer grows
 * to. On an iPhone only.
 *
 * The iPhone editor reports `UITextView.contentSize` (`modules/t3-composer-editor/ios`,
 * `emitContentSizeIfNeeded`), and while the text view may not scroll, which is the whole time
 * the composer is still growing, UIKit keeps that size equal to the view's own: the report never
 * says more than the height it was given, so the composer stayed one line tall and the lines
 * above the last went out of sight. T3 Code's composer never asks: focused, it is a fixed box
 * that scrolls (`ThreadComposer.tsx`, `scrollEnabled={isExpanded}`). Vivid's grows with its
 * words, so it measures them here. The editor's text has no padding of its own beside the inset
 * (`textContainerInset`, `lineFragmentPadding = 0`), so the two wrap alike. Android's editor
 * reports its layout's real height and needs none of this.
 *
 * A line just begun has no glyph yet and would not be counted, so a zero-width space ends the
 * words.
 */
function Measure({ value, onHeight }: { value: string; onHeight: (height: number) => void }) {
  const fontFamily = useFontFamily('regular')
  if (Platform.OS !== 'ios') return null
  return (
    <Text
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      onLayout={(event) => onHeight(event.nativeEvent.layout.height + INSET * 2)}
      style={[
        MOBILE_TYPOGRAPHY.typing,
        { position: 'absolute', top: 0, left: 16, right: 0, opacity: 0, fontFamily },
      ]}
    >
      {`${value}\u200b`}
    </Text>
  )
}

/**
 * The composer's trailing end. Ordinarily it is the one button (`children`). While a question
 * is being moved on from (`moving`) it is the pill: with nothing written it moves on with what
 * was picked, and with words under a question answered by writing it sends them as its answer.
 */
function Trailing({
  moving,
  empty,
  sends,
  onSend,
  children,
}: {
  moving: Option.Option<Onward>
  empty: boolean
  sends: boolean
  onSend: () => void
  children: ReactNode
}) {
  return Option.match(moving, {
    onNone: () => children,
    onSome: (asked) => (
      <Moving
        asked={asked}
        ready={empty ? asked.ready : sends}
        onPress={empty ? asked.onNext : onSend}
      />
    ),
  })
}

/**
 * The way back to the question before the one that is up, with what was picked there kept: a
 * 32-point round outline button with a chevron, T3 Code's compact Previous
 * (`ComposerPrimaryActions.tsx`: `variant="outline"`, an icon button with `ChevronLeftIcon`).
 * Nothing on the first question. It is pressed 44 points tall inside the row's own height, and
 * its slop stops halfway to the control after it so the two targets never overlap.
 */
function Back({ asked }: { asked: Onward }) {
  const { colors: c } = useTheme()
  if (asked.first) return null
  return (
    <View style={{ height: TARGET, justifyContent: 'center', marginLeft: PILL.gap }}>
      <Press
        accessibilityRole="button"
        accessibilityLabel="Previous question"
        depth={0.96}
        hitSlop={{
          top: (TARGET - BACK) / 2,
          bottom: (TARGET - BACK) / 2,
          left: PILL.gap,
          right: PILL.gap / 2,
        }}
        onPress={asked.onBack}
        style={({ pressed }) => ({
          width: BACK,
          height: BACK,
          borderRadius: BACK / 2,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: c['line-3'],
          backgroundColor: pressed ? c['wash-pressed'] : c['subtle-strong'],
        })}
      >
        <ChevronLeft pointerEvents="none" size={16} strokeWidth={2.2} color={c.ink} />
      </Press>
    </View>
  )
}

/**
 * What takes the one button's place while a question is being moved on from: the way back
 * (`Back`), and a pill that moves on (`onPress`) once it may (`ready`). The pill says what it does in a
 * word, T3 Code's compact labels (`formatPendingPrimaryActionLabel`): "Next", or "Submit" on
 * the last question, where moving on sends every answer. An arrow on a round button was the
 * mark that sends a message, and was not read as the way to the next question.
 *
 * Until the question has an answer the pill is a quiet shape with muted words, not a faded
 * accent: a neutral one reads as "pick something first". It is 34 points tall and pressed 44.
 */
function Moving({ asked, ready, onPress }: { asked: Onward; ready: boolean; onPress: () => void }) {
  const { colors: c } = useTheme()
  const label = asked.last ? 'Submit' : 'Next'
  return (
    <>
      <Back asked={asked} />
      <View
        style={{
          height: TARGET,
          justifyContent: 'center',
          marginLeft: PILL.gap,
          marginRight: TRAILING,
        }}
      >
        <Press
          accessibilityRole="button"
          accessibilityLabel={asked.last ? 'Submit answers' : 'Next question'}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          depth={0.96}
          hitSlop={{
            top: (TARGET - PILL.height) / 2,
            bottom: (TARGET - PILL.height) / 2,
            left: PILL.gap / 2,
            right: TRAILING,
          }}
          onPress={onPress}
          style={({ pressed }) => ({
            height: PILL.height,
            paddingHorizontal: PILL.side,
            borderRadius: PILL.height / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: ready ? c.primary : c['wash-pressed'],
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Label
            size="footnote"
            tone={ready ? 'ink-on-accent' : 'ink-4'}
            numberOfLines={1}
            style={{ fontWeight: '600' }}
          >
            {label}
          </Label>
        </Press>
      </View>
    </>
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
