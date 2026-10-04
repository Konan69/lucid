import { nativeMetrics as m } from '@vivid/tokens/native'
import { Data, Option } from 'effect'
import { ArrowUp, Check, PenLine } from 'lucide-react-native'
import { useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import Animated, { Easing, LinearTransition, ReduceMotion } from 'react-native-reanimated'
import { useTheme } from '../../theme'
import { APPEAR, LEAVE } from '../../ui/motion/morph'
import { Dot, EDGE, Field, HAIRLINE, Label, Notice, Press, radius, TARGET } from '../../ui/ui'

/** One answer on offer: what it is called, and what picking it means in a line. */
export interface Choice {
  readonly label: string
  /** Empty when the label says it all. */
  readonly detail: string
}

/** Where a question stands, and what each standing needs to be drawn. */
export type Asked = Data.TaggedEnum<{
  /**
   * Waiting on the Person looking at it. `sending` is the answer they gave that is on its way;
   * `onAnswer` takes a row's label or words of their own.
   */
  Open: {
    readonly sending: Option.Option<string>
    readonly onAnswer: (answer: string) => void
  }
  /** Settled. `note` says something about the answer, such as who gave it. */
  Answered: { readonly answer: string; readonly note: Option.Option<string> }
  /** Not this Person's to answer, or no longer needed: `note` says which. */
  Resting: { readonly note: string }
}>
export const Asked = Data.taggedEnum<Asked>()

/** The letter on each row's keycap, by its place. The contract allows six options. */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** A row is at least this tall: a finger's target with room to spare, as the reference draws it. */
const ROW = 56

/** How far a row stands back while another answer is on its way. Still readable, plainly idle. */
const STANDING_BACK = 0.45

/** The square before a row's label: its letter, or the pen on the row for words of one's own. */
const KEYCAP = 24

/**
 * How the card closes down to its answer: what stays glides to where it now belongs, as one
 * layout transition on the UI thread, in the web's `--dur-enter` on the product's settling curve
 * (`ui/motion/Rise.tsx`). With reduced motion the answered card is simply drawn.
 */
const FOLD = LinearTransition.duration(m['dur-enter'])
  .easing(Easing.bezier(0.2, 0, 0, 1))
  .reduceMotion(ReduceMotion.System)

/**
 * A question from Vivid, and the ways to answer it. Every question a Person answers by pressing
 * goes through this one piece, a real Input request in a Thread (`InputCard` in `Cards.tsx`). It
 * is presentational: it is told the title, the choices and where the question stands, and owns
 * only what the Person is in the middle of (the words of their own answer).
 *
 * Ported from the web's `apps/web/src/screen/thread/Question.tsx`, which follows the reference
 * assistant's question card: the title in title weight on a raised card; the rows in one bordered
 * container divided by hairlines; each row 56 tall with a square 24 letter keycap on a subtle
 * fill before its label, and a smaller second line when the option has one; and, once answered,
 * the card closed down to the title and the one chosen row, muted, with a check at its far end.
 *
 * The phone differs where a hand does:
 * - A row is its whole width to press, and answers the press with a fill, not a hover.
 * - Pressing sends at once, so the row says it is on its way (its fill stays and a spinner stands
 *   where the check will be) while the others stand back. The web has no such moment drawn.
 * - "Type your own answer" is one more row, not a field that is always there: a field opens the
 *   keyboard over the rows the Person was reading. Pressing the row opens the field in its place.
 * - There are no letter shortcuts or arrow keys; the letters are only the rows' names.
 *
 * An answered card holds only what it shows. The rows that were not chosen leave the tree as
 * they fade, and a card first drawn already answered (every answered question when a Thread is
 * opened again) never draws them at all.
 */
export function Question({
  status,
  title,
  choices,
  allowsOwn,
  asked,
  problem,
}: {
  /** The line over the title saying whose move it is. */
  status: string
  title: string
  choices: ReadonlyArray<Choice>
  /** Whether words of the Person's own are an answer. */
  allowsOwn: boolean
  asked: Asked
  /** Said under everything when an answer did not go through. */
  problem: Option.Option<string>
}) {
  const { colors: c } = useTheme()
  return (
    <Animated.View
      layout={FOLD}
      style={{
        padding: 14,
        gap: 8,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c.border,
        backgroundColor: c.subtle,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Dot tone="status-attention" size={6} />
        <Label size="caption" tone="status-attention" style={{ flex: 1 }}>
          {status}
        </Label>
      </View>
      <Label accessibilityRole="header" size="body" style={{ fontWeight: m['weight-strong'] }}>
        {title}
      </Label>
      <Body asked={asked} choices={choices} allowsOwn={allowsOwn} />
      {Option.isSome(problem) && <Notice message={problem.value} />}
    </Animated.View>
  )
}

/** What the rows of a question are drawn from, as it stands. */
interface Rows {
  readonly allowsOwn: boolean
  readonly answer: Option.Option<string>
  readonly sending: Option.Option<string>
  /** There only while the question can still be answered. */
  readonly onAnswer: Option.Option<(answer: string) => void>
}

/** What is under a question's title: its rows when it has any to draw, and a line when it has one. */
interface Under {
  readonly rows: Option.Option<Rows>
  readonly note: Option.Option<string>
}

/** Reads where a question stands into what is drawn under its title. */
const underOf = (asked: Asked, allowsOwn: boolean): Under =>
  Asked.$match(asked, {
    Resting: ({ note }) => ({ rows: Option.none(), note: Option.some(note) }),
    Open: ({ sending, onAnswer }) => ({
      rows: Option.some({
        allowsOwn,
        answer: Option.none(),
        sending,
        onAnswer: Option.some(onAnswer),
      }),
      note: Option.none(),
    }),
    Answered: ({ answer, note }) => ({
      rows: Option.some({
        allowsOwn: false,
        answer: Option.some(answer),
        sending: Option.none(),
        onAnswer: Option.none(),
      }),
      note,
    }),
  })

/**
 * What is under the title for where the question stands: the rows to answer with, the answer and
 * who gave it, or the line saying why there is nothing to press.
 *
 * An open question and an answered one are the same `Answers` in the same place, told different
 * things. Drawn as two branches they would be two components to React: answering would take every
 * row out and put the chosen one back, and nothing could fold.
 */
function Body({
  asked,
  choices,
  allowsOwn,
}: {
  asked: Asked
  choices: ReadonlyArray<Choice>
  allowsOwn: boolean
}) {
  const { rows, note } = underOf(asked, allowsOwn)
  return (
    <>
      {Option.isSome(rows) && <Answers choices={choices} {...rows.value} />}
      {Option.isSome(note) && <Note>{note.value}</Note>}
    </>
  )
}

/** A quiet line under the title or the answer: who it is waiting on, or who answered. */
function Note({ children }: { children: string }) {
  return (
    <Animated.View layout={FOLD}>
      <Label size="label" tone="ink-2">
        {children}
      </Label>
    </Animated.View>
  )
}

/** How one row stands: on offer, on its way, standing back while another is, or the answer. */
type Standing = 'open' | 'sending' | 'waiting' | 'chosen'

/** Where a choice stands, or none when the question was answered with something else. */
const standingOf = (
  choice: Choice,
  answer: Option.Option<string>,
  sending: Option.Option<string>,
): Option.Option<Standing> => {
  if (Option.isSome(answer)) {
    return answer.value === choice.label ? Option.some('chosen') : Option.none()
  }
  if (Option.isNone(sending)) return Option.some('open')
  return Option.some(sending.value === choice.label ? 'sending' : 'waiting')
}

/**
 * The rows of a question in their one bordered container: every choice while it is open, then the
 * row for words of the Person's own; and once it is answered only the one chosen, or the Person's
 * own words as a row when they wrote the answer themselves. Nothing is drawn for a question with
 * no choices, no own answer and nothing written.
 */
function Answers({
  choices,
  allowsOwn,
  answer,
  sending,
  onAnswer,
}: {
  choices: ReadonlyArray<Choice>
  allowsOwn: boolean
  answer: Option.Option<string>
  sending: Option.Option<string>
  /** There only while the question can still be answered. */
  onAnswer: Option.Option<(answer: string) => void>
}) {
  const { colors: c } = useTheme()
  // Whether this card was open on screen before it was answered. Only then does the check arrive;
  // a card first drawn answered is drawn whole, like everything else when a Thread is opened.
  const [arrives] = useState(Option.isNone(answer))
  const isChoice = (said: string) => choices.some((choice) => choice.label === said)
  // An answer that is none of the rows was written by hand, and is shown as a row of its own.
  const written = Option.filter(answer, (said) => !isChoice(said))
  if (choices.length === 0 && !allowsOwn && Option.isNone(written)) return null
  return (
    // The container clips its rows to its corners, so a pressed fill never squares them off.
    <Animated.View
      layout={FOLD}
      style={{
        marginTop: 2,
        borderRadius: radius.row,
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c.border,
        overflow: 'hidden',
      }}
    >
      {choices.map((choice, index) => {
        const standing = standingOf(choice, answer, sending)
        // A choice that was not the answer is not drawn once there is one.
        return Option.isNone(standing) ? null : (
          <Row
            key={choice.label}
            letter={LETTERS.charAt(index)}
            choice={choice}
            standing={standing.value}
            arrives={arrives}
            // None once answered: one row has nothing to divide.
            divided={index > 0 && Option.isNone(answer)}
            onPress={() => Option.map(onAnswer, (send) => send(choice.label))}
          />
        )
      })}
      {allowsOwn && Option.isSome(onAnswer) && (
        <Own
          bare={choices.length === 0}
          // Words that are none of the rows are the Person's own, on their way.
          sending={Option.exists(sending, (said) => !isChoice(said))}
          held={Option.isSome(sending)}
          onAnswer={onAnswer.value}
        />
      )}
      {Option.isSome(written) && (
        <Animated.View
          entering={arrives ? APPEAR : undefined}
          accessible
          accessibilityLabel={`${written.value}, answered`}
          style={{
            minHeight: ROW,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <Label size="body" tone="ink-2" style={{ flex: 1, fontSize: 15, lineHeight: 21 }}>
            {written.value}
          </Label>
          <Check size={16} strokeWidth={2} color={c['ink-2']} />
        </Animated.View>
      )}
    </Animated.View>
  )
}

/** The square a row begins with. It says nothing to a screen reader: the row's label does. */
function Keycap({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: KEYCAP,
        height: KEYCAP,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: m['radius-sm'],
        borderWidth: EDGE,
        borderColor: c.border,
        backgroundColor: c['subtle-strong'],
      }}
    >
      {children}
    </View>
  )
}

/**
 * One answer: its keycap, its label, and a smaller line under it when it has one. It is the same
 * row whether the question is open or answered, so the chosen one never redraws: it glides to
 * the top as the others fade where they stood, goes quiet, and its spinner gives way to a check.
 *
 * The press is answered by a fill across the whole row, not by the row sinking (`Press`): a row
 * that shrank inside its container would open gaps at the hairlines.
 */
function Row({
  letter,
  choice,
  standing,
  arrives,
  divided,
  onPress,
}: {
  letter: string
  choice: Choice
  standing: Standing
  /** Whether its check fades in: only on a card that was open on screen when it was answered. */
  arrives: boolean
  /** Whether a hairline is drawn over it. */
  divided: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const open = standing === 'open'
  const chosen = standing === 'chosen'
  return (
    <Animated.View
      layout={FOLD}
      exiting={LEAVE}
      style={{
        borderTopWidth: divided ? HAIRLINE : 0,
        borderTopColor: c.border,
        // The rows that were not pressed stand back while the one that was is on its way.
        opacity: standing === 'waiting' ? STANDING_BACK : 1,
        transitionProperty: 'opacity',
        transitionDuration: m['dur-fast'],
      }}
    >
      <Pressable
        accessibilityRole={chosen ? 'text' : 'button'}
        accessibilityLabel={[choice.label, choice.detail, chosen ? 'chosen' : '']
          .filter((part) => part.length > 0)
          .join(', ')}
        accessibilityState={{ disabled: !open, busy: standing === 'sending' }}
        disabled={!open}
        // A finger that drifts a little while pressing still means the press.
        pressRetentionOffset={12}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: ROW,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          backgroundColor: pressed || standing === 'sending' ? c['wash-pressed'] : 'transparent',
        })}
      >
        <Keycap>
          <Label size="caption" tone="ink-2" style={{ fontWeight: m['weight-strong'] }}>
            {letter}
          </Label>
        </Keycap>
        <View style={{ flex: 1, gap: 1 }}>
          <Label
            size="body"
            tone={chosen ? 'ink-2' : 'ink'}
            style={{ fontSize: 15, lineHeight: 21 }}
          >
            {choice.label}
          </Label>
          {choice.detail.length > 0 && (
            <Label size="label" tone={chosen ? 'ink-3' : 'ink-2'}>
              {choice.detail}
            </Label>
          )}
        </View>
        {standing === 'sending' && <ActivityIndicator size="small" color={c['ink-3']} />}
        {chosen && (
          <Animated.View entering={arrives ? APPEAR : undefined}>
            <Check size={16} strokeWidth={2} color={c['ink-2']} />
          </Animated.View>
        )}
      </Pressable>
    </Animated.View>
  )
}

/**
 * Words of the Person's own, as the last row. It rests as a row that says so (`OwnResting`);
 * pressing it puts the field in its place with the keyboard up (`OwnWriting`). It owns the words
 * being typed and whether the field is open, and nothing else.
 *
 * A question with no choices has only this to offer, so it is drawn open (`bare`), without
 * taking the keyboard: a card that raised the keyboard by being scrolled to would be a trap.
 * What was typed stays in the field until the question is answered, so an answer that did not
 * go through can be sent again.
 */
function Own({
  bare,
  sending,
  held,
  onAnswer,
}: {
  bare: boolean
  /** The Person's own words are on their way. */
  sending: boolean
  /** Any answer is on its way, so nothing here can be pressed. */
  held: boolean
  onAnswer: (answer: string) => void
}) {
  const [writing, setWriting] = useState(bare)
  const [own, setOwn] = useState('')
  // Keyed, so opening the field is one row leaving and another arriving, not one redrawn.
  return writing ? (
    <OwnWriting
      key="writing"
      own={own}
      divided={!bare}
      takesKeyboard={!bare}
      sending={sending}
      held={held}
      onChange={setOwn}
      onAnswer={onAnswer}
    />
  ) : (
    <OwnResting key="resting" held={held} onOpen={() => setWriting(true)} />
  )
}

/** The row that offers words of one's own: a pen where the others have a letter. */
function OwnResting({ held, onOpen }: { held: boolean; onOpen: () => void }) {
  const { colors: c } = useTheme()
  return (
    <Animated.View
      layout={FOLD}
      exiting={LEAVE}
      style={{
        // It is only ever under the choices, so it always has a row to be divided from.
        borderTopWidth: HAIRLINE,
        borderTopColor: c.border,
        opacity: held ? STANDING_BACK : 1,
        transitionProperty: 'opacity',
        transitionDuration: m['dur-fast'],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: held }}
        disabled={held}
        pressRetentionOffset={12}
        onPress={onOpen}
        style={({ pressed }) => ({
          minHeight: ROW,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
        })}
      >
        <Keycap>
          <PenLine size={13} strokeWidth={2} color={c['ink-2']} />
        </Keycap>
        <Label size="body" tone="ink-2" style={{ flex: 1, fontSize: 15, lineHeight: 21 }}>
          Type your own answer
        </Label>
      </Pressable>
    </Animated.View>
  )
}

/**
 * The field for words of the Person's own, in the row's place. The arrow sends what was typed,
 * and so does the keyboard's own Send. The row is the shape; the field inside it has none.
 */
function OwnWriting({
  own,
  divided,
  takesKeyboard,
  sending,
  held,
  onChange,
  onAnswer,
}: {
  own: string
  divided: boolean
  /** Whether it was opened by a press, which is when the keyboard should come up with it. */
  takesKeyboard: boolean
  sending: boolean
  held: boolean
  onChange: (text: string) => void
  onAnswer: (answer: string) => void
}) {
  const { colors: c } = useTheme()
  const said = own.trim()
  const ready = said.length > 0 && !held
  const send = () => {
    if (ready) onAnswer(said)
  }
  return (
    <Animated.View
      layout={FOLD}
      entering={APPEAR}
      exiting={LEAVE}
      style={{
        minHeight: ROW,
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingLeft: 12,
        paddingRight: 6,
        paddingVertical: 6,
        borderTopWidth: divided ? HAIRLINE : 0,
        borderTopColor: c.border,
        opacity: held && !sending ? STANDING_BACK : 1,
      }}
    >
      <Field
        accessibilityLabel="Your own answer"
        value={own}
        placeholder="Type your own answer"
        autoFocus={takesKeyboard}
        editable={!held}
        multiline
        returnKeyType="send"
        submitBehavior="blurAndSubmit"
        onChangeText={onChange}
        onSubmitEditing={send}
        style={{
          flex: 1,
          minHeight: TARGET,
          paddingHorizontal: 0,
          paddingVertical: 10,
          borderWidth: 0,
          backgroundColor: 'transparent',
        }}
      />
      <SendOwn ready={ready} sending={sending} onPress={send} />
    </Animated.View>
  )
}

/**
 * The way to send words of one's own: the composer's round arrow, smaller, inside a full 44
 * target. While the words are on their way a spinner stands in its place.
 */
function SendOwn({
  ready,
  sending,
  onPress,
}: {
  ready: boolean
  sending: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const target = {
    width: TARGET,
    height: TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  } as const
  if (sending) {
    return (
      <View style={target}>
        <ActivityIndicator size="small" color={c['ink-3']} />
      </View>
    )
  }
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Send answer"
      accessibilityState={{ disabled: !ready }}
      disabled={!ready}
      onPress={onPress}
      style={target}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 15,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: ready ? c.primary : c['subtle-strong'],
        }}
      >
        <ArrowUp size={17} strokeWidth={2.2} color={ready ? c['ink-on-accent'] : c['ink-3']} />
      </View>
    </Press>
  )
}
