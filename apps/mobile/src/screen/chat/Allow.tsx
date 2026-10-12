import { ApprovalDecision, type InputOption } from '@vivid/contracts'
import { asking, type ApprovalUp } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import type { SharedValue } from 'react-native-reanimated'
import { Attached, Surface, useSlide, useTallest } from './Banner'
import { Body, Head, Rows, Under } from './Choices'

interface AllowProps {
  /** The Approval the banner holds, and how many are waiting on this Person with it. */
  readonly up: ApprovalUp
  /** It is no longer the one that is up: the banner slides away and then says so (`onGone`). */
  readonly leaving: boolean
  /** A decision is on its way: nothing more can be decided until that try ends. */
  readonly busy: boolean
  /** The measured height of the composer's dock, which the banner is anchored to. */
  readonly dock: number
  /** Written with how far the banner stands over the foot of the conversation (`useSlide`). */
  readonly covered: SharedValue<number>
  readonly onDecide: (decision: ApprovalDecision) => void
  /** The banner has slid away. */
  readonly onGone: () => void
}

/** One answer to an Approval: the row that says it, and the decision a press on it sends. */
interface Answer {
  readonly option: InputOption
  readonly decision: ApprovalDecision
}

/**
 * The three answers, in the order they are drawn. An option's `detail` is its second line, and
 * a row with none draws one line (`Row`, `Choices.tsx`). Only "Always allow" needs one: it is
 * the answer whose reach is not said by its label. The labels are distinct, which is what tells
 * the rows apart (`Rows`).
 */
const ANSWERS: ReadonlyArray<Answer> = [
  { option: { label: 'Allow', detail: '' }, decision: ApprovalDecision.cases.AllowOnce.make({}) },
  {
    option: { label: 'Always allow', detail: 'Vivid won’t ask again for this' },
    decision: ApprovalDecision.cases.AlwaysAllow.make({}),
  },
  { option: { label: 'Don’t allow', detail: '' }, decision: ApprovalDecision.cases.Deny.make({}) },
]

/**
 * Something Vivid will not do without a yes, as a banner attached to the top of the composer
 * while it waits on the Person looking at it. It is a question's banner and nothing more
 * (`Choices.tsx`): the same surface, window and slide (`Banner.tsx`), the same head row and the
 * same rows, drawn by the same components. It takes the question's place while both wait: an
 * Approval comes first (`screen/Chat.tsx`). What Vivid asked stays in the conversation as its
 * own words (`Cards.tsx`), with exactly what would be done and how it ended.
 *
 * - The head's words are the action's summary; at its trailing end is "1/n" only when more than
 *   one Approval waits (the banner always holds the oldest), and the chevron that closes the
 *   banner to its head and opens it again.
 * - Under it are the three answers as rows (`ANSWERS`). A press sends that decision and shows
 *   the row as chosen, with the question row's check, while the others stand back.
 *
 * Until 12 October 2026 this was a port of T3 Code web's approval banner (`ChatComposer.tsx`,
 * the `activePendingApproval` branch): a tinted warning surface with a shield, a line saying
 * what kind of action it was and on which account, a "Details" box, and a row of buttons with
 * the lesser answer behind an ellipsis. The owner rejected it as bloated: "highest it should
 * just ask a normal question". Nothing of that is here; the detail it showed is in the Thread.
 *
 * A decision that did not go through is said over the composer (`screen/Chat.tsx`), as a
 * question's is, and not in the banner.
 */
export function Allow({ up, leaving, busy, dock, covered, onDecide, onGone }: AllowProps) {
  // Whether the Person has the banner open. It is this Approval's: the banner is keyed by it
  // (`screen/Chat.tsx`), so the next one comes up open.
  const [open, setOpen] = useState(true)
  // The row last pressed, by its label. It is set in the press itself and only says which row a
  // decision on its way came from: see `standingOf`.
  const [pressed, setPressed] = useState<Option.Option<string>>(Option.none())
  const tallest = useTallest(dock)
  const slide = useSlide(asking.standOf(leaving, !open), covered, onGone)
  // Closed, the rows are behind the composer and must not be pressed; nor may those of an
  // Approval that was settled, here or anywhere else, or whose decision is on its way.
  const held = !open || leaving || busy
  const { waiting } = up
  return (
    <Attached dock={dock} tallest={tallest} leaving={leaving} slide={slide}>
      <Surface tallest={tallest}>
        <Head
          words={up.approval.action.summary}
          count={waiting > 1 ? Option.some(`1/${waiting}`) : Option.none()}
          says={{
            hide: 'Hide the answers',
            show: 'Show the answers',
            place: waiting > 1 ? `1 of ${waiting} waiting on you. ` : '',
          }}
          open={open}
          disabled={leaving}
          onHeight={(height) => slide.head.set(height)}
          onToggle={() => setOpen(!open)}
        />
        <Body open={open}>
          <Under>
            <Rows
              rows={ANSWERS.map(({ option, decision }) => ({
                option,
                decision,
                standing: standingOf(option, pressed, busy),
              }))}
              several={false}
              reach={held ? 'held' : 'pressable'}
              onPick={(answer) => {
                setPressed(Option.some(answer.option.label))
                onDecide(answer.decision)
              }}
            />
          </Under>
        </Body>
      </Surface>
    </Attached>
  )
}

/**
 * How one answer's row stands. A row is chosen only while a decision is on its way and it is
 * the row that was pressed for it; the others then stand back. The screen marks the decision as
 * on its way in the same press (`useAllowing`, `screen/Chat.tsx`), so the check is there from
 * the first frame, and it keeps it so until the Approval's record takes the banner away. When
 * the decision is refused, `busy` goes false and every row is open again with none chosen,
 * whatever was pressed before.
 */
const standingOf = (
  option: InputOption,
  pressed: Option.Option<string>,
  busy: boolean,
): asking.Standing => asking.standingOf(busy && Option.contains(pressed, option.label), busy)
