import { InputAnswer, type InputOption, type InputQuestion } from '@vivid/contracts'
import { asking } from '@vivid/state'
import { Data, Option, type Array as Arr } from 'effect'
import { Check, ChevronLeft } from 'lucide-react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, IconButton } from '../../ui/button'
import { Card } from '../../ui/card'
import { cn } from '../../ui/cn'
import { Input } from '../../ui/input'

/** Where a request stands, and what each standing needs to be drawn. */
export type Asked = Data.TaggedEnum<{
  /**
   * Waiting on the Person looking at it. `onSend` takes every question's answer, in the
   * questions' order. If they do not go through it says so (`onFailed`), with the question the
   * server's refusal names when it names one, so the card can be answered again.
   */
  Open: {
    readonly questions: Arr.NonEmptyReadonlyArray<InputQuestion>
    readonly onSend: (
      answers: Arr.NonEmptyReadonlyArray<InputAnswer>,
      onFailed: (place: Option.Option<number>) => void,
    ) => void
  }
  /** Settled. `note` says something about the answers, such as who gave them. */
  Answered: {
    readonly questions: Arr.NonEmptyReadonlyArray<InputQuestion>
    readonly answers: Arr.NonEmptyReadonlyArray<InputAnswer>
    readonly note: Option.Option<string>
  }
  /** Not this Person's to answer, or no longer needed: `note` says which. */
  Resting: {
    readonly questions: Arr.NonEmptyReadonlyArray<InputQuestion>
    readonly note: string
  }
}>
export const Asked = Data.taggedEnum<Asked>()

/* A question is read as a short column, like the reference's card: rows as wide as a whole
   Thread would leave each label alone at one end of a long empty line. */
const CARD = 'block w-full max-w-xl p-4'

/** The letter on each row's keycap, by its place. The contract allows six options. */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The line over a card's first title saying whose move it is, where the Thread needs that said. */
function Status({ status }: { status: Option.Option<string> }) {
  return Option.isNone(status) ? null : (
    <div className="mb-2 flex items-center gap-2 text-meta text-attention">
      <i className="size-1.5 rounded-full bg-attention" />
      {status.value}
    </div>
  )
}

/** One question's words, as a card's title. */
function Title({ children }: { children: ReactNode }) {
  return <h3 className="text-title font-title text-pretty text-ink">{children}</h3>
}

/**
 * A request from Vivid, and the ways to answer it. Every request a Person answers by pressing
 * goes through this one piece, a real Input request in a Thread (`InputCard`). It is told where
 * the request stands and owns only what the Person is in the middle of.
 *
 * The design follows the reference assistant's question card (Grok Bot's first conversation,
 * measured from screenshots): the title in title weight on a raised card; the rows in one
 * bordered container divided by hairlines; each row about 56px tall with a square 24px letter
 * keycap on a subtle fill before its label; "Type your own answer" under the rows; and, once
 * answered, the card closed down to the title and what was chosen, muted, with a check at its
 * far end. Vivid's differs in two places. A row may carry a second, smaller line, because the
 * contract lets each option say what picking it means. And there is no dismiss mark at the top
 * right: the reference has one, but no request here can be dismissed by the Person yet.
 *
 * A request carries one to four questions, answered together. While it is open the card asks
 * them one at a time (`Open`), as T3 Code's `ComposerPendingUserInputPanel.tsx` does, on the
 * model the phone shares (`asking`, `@vivid/state`). Once it is answered the card lists every
 * question with what was said to it (`Settled`).
 *
 * Until 11 October 2026 a request was one question, and answering it folded the rows that were
 * not chosen away where they stood. An answered card now lists questions that were never on
 * screen together, so there is nothing to fold from: it is drawn as it is, and only its checks
 * fade in.
 *
 * From the keyboard, with focus inside the card: a letter picks its row, the arrows move between
 * rows, Enter picks the one in focus. Letters typed into the answer field are left alone.
 */
export function Question({ status, asked }: { status: Option.Option<string>; asked: Asked }) {
  return Asked.$match(asked, {
    Open: (open) => <Open status={status} asked={open} />,
    Resting: ({ questions, note }) => (
      <Card className={CARD}>
        <Status status={status} />
        <div className="grid gap-2">
          {questions.map((question) => (
            <Title key={question.question}>{question.question}</Title>
          ))}
        </div>
        <p className="mt-2 text-label text-ink-3">{note}</p>
      </Card>
    ),
    Answered: ({ questions, answers, note }) => (
      <Card className={CARD}>
        <Status status={status} />
        <div className="grid gap-4">
          {questions.map((question, place) => (
            <Settled
              key={question.question}
              question={question}
              answer={Option.fromUndefinedOr(answers[place])}
            />
          ))}
        </div>
        {Option.isSome(note) && <p className="mt-2 text-meta font-meta text-ink-3">{note.value}</p>}
      </Card>
    ),
  })
}

/**
 * An open request: the question that is up, with its place among the others and a way back when
 * there are several, its rows, the field for words of the Person's own when the question takes
 * them, and for a question several options may be chosen for the button that moves on.
 *
 * A question that takes one option moves on by itself a moment after the press
 * (`asking.ADVANCE_AFTER`, T3 Code's auto-advance), so the Person sees what they pressed; on the
 * last question that sends every answer. What moving on comes to is worked out at the press and
 * carried out after the moment, and nothing can be pressed meanwhile (`moving`). Words typed in
 * the field are that question's answer and move on at once.
 *
 * Once the answers are sent nothing more can be pressed (`sent`): it is the request's record
 * that closes the card, a moment after the call returns, and rows awake in between could send a
 * second time. If the answers do not go through the card wakes again, on the question the
 * server's refusal names when it names one, with everything picked kept.
 */
function Open({
  status,
  asked,
}: {
  status: Option.Option<string>
  asked: Extract<Asked, { readonly _tag: 'Open' }>
}) {
  const { questions, onSend } = asked
  const [drafting, setDrafting] = useState(() => asking.begin(questions))
  const [moving, setMoving] = useState(false)
  const [sent, setSent] = useState(false)
  const progress = asking.progressOf(questions, drafting)
  const { question } = progress
  const held = moving || sent

  function take(step: asking.Step, from: asking.Asking) {
    asking.Step.$match(step, {
      Stay: () => undefined,
      Next: ({ asking: next }) => setDrafting(next),
      Send: ({ answers }) => {
        setSent(true)
        onSend(answers, (place) => {
          setSent(false)
          Option.map(place, (named) => setDrafting(asking.returnTo(from, named)))
        })
      },
    })
  }

  function pick(label: string) {
    if (held) return
    const picked = asking.press(questions, drafting, label)
    setDrafting(picked)
    if (question.selection === 'Several') return
    const step = asking.advance(questions, picked)
    setMoving(true)
    setTimeout(() => {
      setMoving(false)
      take(step, picked)
    }, asking.ADVANCE_AFTER)
  }

  function write(words: string) {
    const written = asking.type(questions, drafting, words)
    setDrafting(written)
    take(asking.advance(questions, written), written)
  }

  return (
    <Card className={CARD} onKeyDown={(event) => steer(event, question.options, pick)}>
      <Status status={status} />
      {progress.of > 1 && (
        <Place progress={progress} held={held} onBack={() => setDrafting(asking.back(drafting))} />
      )}
      <Title>{question.question}</Title>
      <Rows
        options={question.options}
        picked={asking.pickedIn(progress.draft)}
        standing="open"
        onPress={held ? Option.none() : Option.some(pick)}
      />
      {question.allowsOwnAnswer && (
        // Keyed by the question's place, so each question's field starts with its own words.
        <OwnAnswer
          key={progress.at}
          written={asking.writtenIn(progress.draft)}
          held={held}
          onOwn={write}
        />
      )}
      {question.selection === 'Several' && question.options.length > 0 && (
        <div className="mt-3 flex justify-end">
          <Button
            disabled={!progress.canAdvance || held}
            onClick={() => take(asking.advance(questions, drafting), drafting)}
          >
            {progress.last ? 'Send' : 'Next'}
          </Button>
        </div>
      )}
    </Card>
  )
}

/**
 * Where the Person is in a request of several questions, over the title: from the second
 * question on a way back to the one before, with what was picked there kept, and which question
 * this is.
 */
function Place({
  progress,
  held,
  onBack,
}: {
  progress: asking.Progress
  /** The answers are on their way, or a pressed option is being shown: nothing moves. */
  held: boolean
  onBack: () => void
}) {
  return (
    <div className="mb-1 flex h-6 items-center gap-1 text-meta font-meta text-ink-3 tabular-nums">
      {!progress.first && (
        <IconButton label="Previous question" size="icon-xs" disabled={held} onClick={onBack}>
          <ChevronLeft />
        </IconButton>
      )}
      <span aria-label={`Question ${progress.at + 1} of ${progress.of}`}>
        {`${progress.at + 1} of ${progress.of}`}
      </span>
    </div>
  )
}

/**
 * One question of an answered request: its words, and what was said to it in the rows' own
 * container. Options that were picked are their rows, muted, each with a check; words that were
 * written are a row of their own.
 */
function Settled({
  question,
  answer,
}: {
  question: InputQuestion
  answer: Option.Option<InputAnswer>
}) {
  const picked: ReadonlyArray<string> = Option.match(answer, {
    onNone: () => [],
    onSome: (said) =>
      InputAnswer.match(said, {
        Chosen: ({ labels }): ReadonlyArray<string> => labels,
        Written: () => [],
      }),
  })
  const written = Option.flatMap(answer, (said) =>
    InputAnswer.match(said, {
      Chosen: () => Option.none<string>(),
      Written: ({ words }) => Option.some(words),
    }),
  )
  return (
    <div>
      <Title>{question.question}</Title>
      <Rows
        options={question.options.filter((option) => picked.includes(option.label))}
        letters={question.options}
        picked={picked}
        standing="settled"
        onPress={Option.none()}
      />
      {Option.isSome(written) && (
        <ul className="mt-3 overflow-hidden rounded-control edge">
          <li className="flex min-h-14 items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 text-body text-pretty wrap-anywhere text-ink-3">
              {written.value}
            </span>
            <Check aria-hidden className="size-4 shrink-0 text-ink-3 motion-fade" />
          </li>
        </ul>
      )}
    </div>
  )
}

/**
 * The rows of a question in their one bordered container. Open, they are every option, each
 * pressable, with the ones in the draft marked; settled, they are the options that were picked.
 * `letters` is the full list the keycaps are counted from, so a settled row keeps the letter it
 * was offered under. Nothing is drawn where there are no rows.
 */
function Rows({
  options,
  letters = options,
  picked,
  standing,
  onPress,
}: {
  options: ReadonlyArray<InputOption>
  letters?: ReadonlyArray<InputOption>
  picked: ReadonlyArray<string>
  standing: 'open' | 'settled'
  onPress: Option.Option<(label: string) => void>
}) {
  if (options.length === 0) return null
  return (
    // The list clips its rows to its corners, so a row's focus ring is drawn inside its edge.
    <ul className="mt-3 overflow-hidden rounded-control edge">
      {options.map((option, index) => (
        <Row
          key={option.label}
          letter={LETTERS.charAt(letters.indexOf(option))}
          option={option}
          standing={rowStanding(standing, picked.includes(option.label))}
          divided={index > 0}
          pressable={Option.isSome(onPress)}
          onPress={() => Option.map(onPress, (press) => press(option.label))}
        />
      ))}
    </ul>
  )
}

/**
 * The field for words of the Person's own, under the rows of a question that takes them. It owns
 * the words being typed; submitting them answers the question and moves on. `written` is what
 * the question already holds, when the Person comes back to it.
 */
function OwnAnswer({
  written,
  held,
  onOwn,
}: {
  written: string
  /** The answers are on their way: the words cannot be sent again. */
  held: boolean
  onOwn: (answer: string) => void
}) {
  const [own, setOwn] = useState(written)
  return (
    <form
      className="flex gap-2 pt-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (own.trim().length > 0 && !held) onOwn(own)
      }}
    >
      {/* It has no visible label (the placeholder and the question above say what it is), so it
          is a bare `Input` with its name for a screen reader, not a `Field`. */}
      <Input
        compact
        value={own}
        onChange={(event) => setOwn(event.currentTarget.value)}
        aria-label="Your own answer"
        placeholder="Type your own answer"
        className="flex-1"
      />
      <Button type="submit" variant="outline" disabled={own.trim().length === 0 || held}>
        Answer
      </Button>
    </form>
  )
}

/**
 * How one row stands: on offer, picked (it is in the draft of the open question, and can be
 * pressed again), or the settled answer of a question that is closed.
 */
type Standing = 'open' | 'picked' | 'settled'

const rowStanding = (rows: 'open' | 'settled', picked: boolean): Standing => {
  if (rows === 'settled') return 'settled'
  return picked ? 'picked' : 'open'
}

/**
 * How a row answers the pointer. A settled row is text, not a control. A row that can be pressed
 * says so with the pointer and a wash under it; one that cannot just now (the answers are on
 * their way) says that too.
 */
const pointerOf = (standing: Standing, pressable: boolean): string => {
  if (standing === 'settled') return 'cursor-default'
  return pressable
    ? 'cursor-pointer hover:bg-wash-hover active:bg-wash-pressed'
    : 'cursor-not-allowed'
}

/**
 * One option: its keycap, its label, and a smaller line under it when it has one. On offer it
 * is pressable; picked it keeps a fill and a check and can be pressed again (which takes it back
 * where several may be chosen); settled it is muted and is no longer a control.
 */
function Row({
  letter,
  option,
  standing,
  divided,
  pressable,
  onPress,
}: {
  letter: string
  option: InputOption
  standing: Standing
  /** Whether a hairline is drawn over it. */
  divided: boolean
  /** Whether a press does anything now: not while the answers are on their way. */
  pressable: boolean
  onPress: () => void
}) {
  const settled = standing === 'settled'
  return (
    <li>
      <button
        type="button"
        data-choice
        aria-pressed={settled ? undefined : standing === 'picked'}
        disabled={settled || !pressable}
        onClick={onPress}
        className={cn(
          'block w-full text-left transition-colors duration-(--dur-fast) focus-visible:-outline-offset-2',
          divided && 'hairline-t',
          pointerOf(standing, pressable),
          standing === 'picked' && 'bg-wash-selected',
        )}
      >
        <span className="flex min-h-14 items-center gap-3 px-3 py-2">
          <span
            aria-hidden
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-2 text-meta font-title text-ink-3 edge"
          >
            {letter}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn('block text-body text-pretty', settled ? 'text-ink-3' : 'text-ink')}
            >
              {option.label}
              {settled && <span className="sr-only"> (chosen)</span>}
            </span>
            {option.detail.length > 0 && (
              <span className="block text-label text-pretty text-ink-3">{option.detail}</span>
            )}
          </span>
          {standing !== 'open' && (
            <Check
              aria-hidden
              className={cn('size-4 shrink-0 motion-fade', settled ? 'text-ink-3' : 'text-ink')}
            />
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
  options: ReadonlyArray<InputOption>,
  onPick: (label: string) => void,
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
  const option = options[LETTERS.indexOf(event.key.toLocaleUpperCase())]
  if (option === undefined) return
  event.preventDefault()
  onPick(option.label)
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
