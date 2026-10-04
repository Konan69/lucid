import { Data, Option } from 'effect'
import { Check } from 'lucide-react'
import { useState, type KeyboardEvent, type TransitionEvent } from 'react'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { cn } from '../../ui/cn'

/** One answer on offer: what it is called, and what picking it means in a line. */
export interface Choice {
  readonly label: string
  /** Empty when the label says it all. */
  readonly detail: string
}

/** Where a question stands, and what each standing needs to be drawn. */
export type Asked = Data.TaggedEnum<{
  /** Waiting on the Person looking at it. `onOwn` takes words of their own. */
  Open: {
    readonly onChoose: (choice: Choice) => void
    readonly onOwn: (answer: string) => void
  }
  /** Settled. `note` says something about the answer, such as who gave it. */
  Answered: { readonly answer: string; readonly note: Option.Option<string> }
  /** Not this Person's to answer, or no longer needed: `note` says which. */
  Resting: { readonly note: string }
}>
export const Asked = Data.taggedEnum<Asked>()

/* A question is read as a short column, like the reference's card: rows as wide as a whole
   Thread would leave each label alone at one end of a long empty line. */
const CARD = 'w-full max-w-xl p-4'

/** The letter on each row's keycap, by its place. The contract allows six options. */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * A question from Vivid, and the ways to answer it. Every question a Person answers by pressing
 * goes through this one piece, a real Input request in a Thread (`InputCard`). It is presentational:
 * it is told the title, the choices and where the question stands, and owns nothing but whether
 * it is still closing (the words being typed are `OwnAnswer`'s), so the phone app can mirror it
 * from the same description.
 *
 * The design follows the reference assistant's question card (Grok Bot's first conversation,
 * measured from screenshots): the title in title weight on a raised card; the rows in one
 * bordered container divided by hairlines; each row about 56px tall with a square 24px letter
 * keycap on a subtle fill before its label; "Type your own answer" under the rows; and, once
 * answered, the card closed down to the title and the one chosen row, muted, with a check at
 * its far end. Vivid's differs in two places. A row may carry a second, smaller line, because
 * the contract lets each option say what picking it means. And there is no dismiss mark at the
 * top right: the reference has one, but no request here can be dismissed by the Person yet.
 *
 * An answered card holds only what it shows. The rows that were not chosen, and the answer
 * field, are folded where they stand and then taken out of the document (`folding`). They used
 * to stay for good, invisible and `inert`, so the page still held every row with "(chosen)" on
 * one: anything that reads the document rather than the picture (a text snapshot, a copy, a
 * find-in-page) saw a card that had never closed. A card that is first drawn already answered,
 * which is every answered question after a reload, never draws them at all.
 *
 * From the keyboard, with focus inside the card: a letter picks its row, the arrows move between
 * rows, Enter picks the one in focus. Letters typed into the answer field are left alone.
 */
export function Question({
  status,
  title,
  choices,
  allowsOwn,
  asked,
}: {
  /** A line over the title saying whose move it is, where the Thread needs that said. */
  status: Option.Option<string>
  title: string
  choices: ReadonlyArray<Choice>
  /** Whether words of the Person's own are an answer. Said apart from `asked`, so the field can
   *  fold away with the rows when the question is answered instead of vanishing under them. */
  allowsOwn: boolean
  asked: Asked
}) {
  // Whether what an answer folds away is still in the document. It is only while the card that
  // was open on screen closes: a card born answered has nothing to fold.
  const [folding, setFolding] = useState(Asked.$is('Open')(asked))
  const head = (
    <>
      {Option.isSome(status) && (
        <div className="mb-2 flex items-center gap-2 text-meta text-attention">
          <i className="size-1.5 rounded-full bg-attention" />
          {status.value}
        </div>
      )}
      <h3 className="text-title font-title text-pretty text-ink">{title}</h3>
    </>
  )
  if (Asked.$is('Resting')(asked)) {
    return (
      <Card className={CARD}>
        {head}
        <p className="mt-2 text-label text-ink-3">{asked.note}</p>
      </Card>
    )
  }
  const open = Asked.$is('Open')(asked)
  // What is not part of the answer is drawn while the question is open and while it folds.
  const rest = open || folding
  const answer = Asked.$is('Answered')(asked) ? Option.some(asked.answer) : Option.none()

  return (
    <Card
      className={CARD}
      onKeyDown={Asked.$is('Open')(asked) ? (event) => steer(event, choices, asked) : undefined}
      onTransitionEnd={(event) => {
        if (foldEnded(event)) setFolding(false)
      }}
    >
      {head}
      <Answers
        choices={choices}
        answer={answer}
        rest={rest}
        onChoose={Asked.$is('Open')(asked) ? Option.some(asked.onChoose) : Option.none()}
      />
      {allowsOwn && rest && (
        <OwnAnswer onOwn={Asked.$is('Open')(asked) ? Option.some(asked.onOwn) : Option.none()} />
      )}
      {Asked.$is('Answered')(asked) && Option.isSome(asked.note) && (
        <p className="mt-2 text-meta font-meta text-ink-3">{asked.note.value}</p>
      )}
    </Card>
  )
}

/**
 * Whether a transition that just ended was a fold closing. The card hears every transition
 * inside it (a row's hover wash, the check fading in); only one that ended on a thing marked
 * `data-folded` means what was folded has finished going. Where nothing transitions (motion
 * turned off for a keyboard change) no end is heard, and the folded things stay as they were
 * before this was added: invisible, squeezed to nothing and `inert`.
 */
const foldEnded = (event: TransitionEvent<HTMLElement>) =>
  event.target instanceof HTMLElement && event.target.dataset['folded'] !== undefined

/**
 * The rows of a question in their one bordered container: every choice while it is open, and
 * once it is answered only the one chosen, or the Person's own words as a row when they wrote
 * the answer themselves. `rest` says whether the rows that were not chosen are still drawn (they
 * are while the question is open and while they fold); `onChoose` is there only while a row can
 * still be pressed. Nothing is drawn for a question with no choices and no written answer.
 */
function Answers({
  choices,
  answer,
  rest,
  onChoose,
}: {
  choices: ReadonlyArray<Choice>
  answer: Option.Option<string>
  rest: boolean
  onChoose: Option.Option<(choice: Choice) => void>
}) {
  // An answer that is none of the rows was written by hand, and is shown as a row of its own.
  const written = Option.filter(answer, (said) => choices.every((choice) => choice.label !== said))
  if (choices.length === 0 && Option.isNone(written)) return null
  return (
    // The list clips its rows to its corners, so a row's focus ring is drawn inside its edge.
    <ul className="mt-3 overflow-hidden rounded-control edge">
      {choices.map((choice, index) => {
        const standing = standingOf(answer, choice)
        return standing === 'folded' && !rest ? null : (
          <Row
            key={choice.label}
            letter={LETTERS.charAt(index)}
            choice={choice}
            standing={standing}
            divided={index > 0 && Option.isSome(onChoose)}
            onPress={() => Option.map(onChoose, (choose) => choose(choice))}
          />
        )
      })}
      {Option.isSome(written) && (
        <li className="flex min-h-14 items-center gap-3 px-3 py-2 motion-fade">
          <span className="min-w-0 flex-1 text-body text-pretty wrap-anywhere text-ink-3">
            {written.value}
          </span>
          <Check aria-hidden className="size-4 shrink-0 text-ink-3" />
        </li>
      )}
    </ul>
  )
}

/**
 * The field for words of the Person's own, under the rows. It owns the words being typed and
 * nothing else. `onOwn` is where they go while the question is open; once it is answered there is
 * nowhere for them to go, and the field folds away with the rows that were not chosen.
 */
function OwnAnswer({ onOwn }: { onOwn: Option.Option<(answer: string) => void> }) {
  const [own, setOwn] = useState('')
  const open = Option.isSome(onOwn)
  return (
    // The negative margin gives back the room the field's focus ring needs inside a thing that
    // clips: the fold hides overflow, and the ring is drawn 2px outside the field. It is given
    // up once folded, so the card ends exactly as tall as one drawn answered.
    <div
      className="-mx-0.5 -mb-0.5 motion-fold data-folded:mb-0"
      data-folded={open ? undefined : ''}
      inert={!open}
    >
      {/* The fold squeezes this box, which has no padding of its own. The form's padding was on
          the squeezed box before, and padding cannot be squeezed: the card kept 10px of it
          under the answer. */}
      <div>
        <form
          className="flex gap-2 px-0.5 pt-2.5 pb-0.5"
          onSubmit={(event) => {
            event.preventDefault()
            const said = own.trim()
            if (said.length > 0) Option.map(onOwn, (send) => send(said))
          }}
        >
          <input
            value={own}
            onChange={(event) => setOwn(event.currentTarget.value)}
            aria-label="Your own answer"
            placeholder="Type your own answer"
            className="h-9 min-w-0 flex-1 rounded-control bg-well px-3 text-label text-ink ring-line outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" variant="primary" disabled={own.trim().length === 0}>
            Answer
          </Button>
        </form>
      </div>
    </div>
  )
}

/** How one row stands: on offer, the one that was chosen, or folded away beside the chosen one. */
type Standing = 'open' | 'chosen' | 'folded'

const standingOf = (answer: Option.Option<string>, choice: Choice): Standing =>
  Option.match(answer, {
    onNone: () => 'open',
    onSome: (said) => (said === choice.label ? 'chosen' : 'folded'),
  })

/**
 * One answer: its keycap, its label, and a smaller line under it when it has one. It is the same
 * button whether the question is open or answered, so the rows that were not chosen fold away
 * from where they stood and the chosen one never moves or redraws; it only stops being pressable.
 * `Question` takes a folded row out of the document once its fold has ended.
 */
function Row({
  letter,
  choice,
  standing,
  divided,
  onPress,
}: {
  letter: string
  choice: Choice
  standing: Standing
  /** Whether a hairline is drawn over it. None once answered: one row has nothing to divide. */
  divided: boolean
  onPress: () => void
}) {
  const folded = standing === 'folded'
  return (
    <li className="motion-fold" data-folded={folded ? '' : undefined} inert={folded}>
      <button
        type="button"
        data-choice
        disabled={standing !== 'open'}
        onClick={onPress}
        className={cn(
          'block w-full text-left transition-colors duration-(--dur-fast) focus-visible:-outline-offset-2',
          divided && 'hairline-t',
          standing === 'open'
            ? 'cursor-pointer hover:bg-wash-hover active:bg-wash-pressed'
            : 'cursor-default',
        )}
      >
        {/* The height is the inner line's: the button itself is what the fold squeezes to nothing. */}
        <span className="flex min-h-14 items-center gap-3 px-3 py-2">
          <span
            aria-hidden
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-2 text-meta font-title text-ink-3 edge"
          >
            {letter}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block text-body text-pretty',
                standing === 'open' ? 'text-ink' : 'text-ink-3',
              )}
            >
              {choice.label}
              {standing === 'chosen' && <span className="sr-only"> (chosen)</span>}
            </span>
            {choice.detail.length > 0 && (
              <span className="block text-label text-pretty text-ink-3">{choice.detail}</span>
            )}
          </span>
          {standing === 'chosen' && (
            <Check aria-hidden className="size-4 shrink-0 text-ink-3 motion-fade" />
          )}
        </span>
      </button>
    </li>
  )
}

/**
 * Answers the keyboard for an open question. It is the card's own `onKeyDown`, so it only hears
 * keys while focus is inside the card, and it leaves every key alone that is being typed into a
 * field or pressed with a modifier (a shortcut is the app's, not an answer).
 */
function steer(
  event: KeyboardEvent<HTMLElement>,
  choices: ReadonlyArray<Choice>,
  asked: Extract<Asked, { readonly _tag: 'Open' }>,
) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  // A named key ("Enter", "Tab") is longer than one character; Enter on a row is the browser's.
  if (event.key.length !== 1) return
  const choice = choices[LETTERS.indexOf(event.key.toLocaleUpperCase())]
  if (choice === undefined) return
  event.preventDefault()
  asked.onChoose(choice)
}

/**
 * Moves focus one row down or up, round the ends. The rows are read from the card as it is on
 * screen. From somewhere that is not a row, down lands on the first and up on the last.
 */
function move(card: HTMLElement, step: 1 | -1) {
  const rows = Array.from(card.querySelectorAll<HTMLElement>('button[data-choice]'))
  const at = rows.findIndex((row) => row === document.activeElement)
  // Nothing in focus counts as the place before the first row, so one step up wraps to the last.
  const from = at === -1 && step === -1 ? 0 : at
  const next = rows[(from + step + rows.length) % rows.length]
  if (next !== undefined) next.focus()
}
