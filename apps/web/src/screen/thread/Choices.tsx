import type { InputAnswer, InputOption, InputRequest } from '@vivid/contracts'
import { asking as model } from '@vivid/state'
import { Option, type Array as Arr } from 'effect'
import { Check, ChevronDown, CircleHelp } from 'lucide-react'
import { useCallback, useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Alert } from '../../ui/alert'
import { cn } from '../../ui/cn'
import type { Asking } from './asking'

/**
 * What Vivid is asking, as a banner attached to the top of the composer while the request waits
 * on the Person looking at it. A request carries one to four questions, and the banner asks them
 * one at a time. The questions are also Vivid's message in the conversation (`Asked`,
 * `Question.tsx`), which is what stays once the banner has gone.
 *
 * It is a port of T3 Code web's pending-question banner, read from its `origin/main`:
 * `components/chat/ComposerBanner.tsx` (`Attachment`, `Surface`, `Root`, `Row`, `Icon`,
 * `Content`, `Actions`, `Scroll`, `Body`, `ToggleIcon`) and
 * `components/chat/ComposerPendingUserInputPanel.tsx` (`ComposerPendingUserInputCard`).
 * Kept from it:
 * - The banner is in the composer's column, narrower than the composer, round at its top
 *   corners only and tucked behind the composer's top edge, so the two read as one shape with
 *   no edge and no gap between them (`asked-attachment`, `asked-surface` in `styles/motion.css`,
 *   which hold the reference's measures).
 * - Its head is one row and the whole row is a button: a small mark, the row's words, which
 *   question this is ("1/3", only with more than one) and a chevron. Pressing it hides
 *   everything under the head, so a tall question stops covering the Thread, and pressing it
 *   again brings it back. What is hidden is one question: the banner opens again by itself when
 *   another question comes up, which can happen without a press.
 * - Under the head, indented under the head's words: for a question several options may be
 *   chosen for, the line "Select one or more options."; then the options, each a plain row with
 *   no fill until the pointer is over it or it is chosen, its number key at its trailing end and
 *   a check there once chosen. They scroll inside the banner when they do not fit.
 * - The number keys 1 to 9 pick a row while focus is not in a field and the banner is open. A
 *   question that takes one option moves on by itself 200 ms after the press, so the Person
 *   sees what they pressed; that move is called off if the banner stops being a way to answer.
 * - There is no button in the banner. The composer's footer moves on from a question and sends
 *   the answers (`ComposerPrimaryActions.tsx`; here `Onward` in `Composer.tsx`).
 *
 * Adapted, and why:
 * - A question in Vivid's contract has no short `header` (`packages/contracts/src/inputs.ts`
 *   says why), so the head row's words are the question itself: one line, cut short, while the
 *   banner is closed, and two lines at most while it is open. A question may be 400 characters
 *   long, and all of it shown pushed the options off a small screen; all of it is Vivid's
 *   message in the Thread. The body does not say the question a second time, as the
 *   reference's does under its header.
 * - A row's label and its second line wrap, to three lines each at most, and are never cut to
 *   one line: the owner rejected an ellipsis on a choice (11 October 2026: "truncated isn't
 *   helping design well"). Past that the list scrolls. A string with no place to break (an
 *   address, a link) breaks anywhere, so nothing reaches past the banner's edge; and each takes
 *   its direction from its own first strong letter (`dir="auto"`), so an Arabic label starts at
 *   the right in a banner that reads left to right.
 * - There is no dismiss control. What the Person sends from the composer is an ordinary message,
 *   and the server withdraws the waiting request when it takes it: that is the way to dismiss.
 * - The reference's panel opens and closes by animating a measured height, and its banner is
 *   simply there. Here both use the app's own way to fold (`motion-fold`: a grid row, 200 ms,
 *   the app's ease-out, with opacity), which measures nothing; under reduced motion both are
 *   instant.
 * - The reference scrolls in an overlay scroll area that fades whichever edge has more beyond
 *   it. Vivid has no such primitive, so the scroller draws no scrollbar and fades its foot while
 *   there are rows below (`asked-scroll`).
 * - The colours and sizes are Vivid's tokens: the raised surface and the composer's shadow, the
 *   layer's quiet edge, the washes for a row under the pointer and a chosen row, and the label,
 *   body and meta sizes for the reference's xs, sm and 2xs/3xs.
 * - While a pressed option is being shown, before the banner moves on, the rows cannot be
 *   pressed again. The reference lets a second press restart its timer; here what moving on
 *   comes to is worked out at the press by the model both of Vivid's clients share
 *   (`asking`, `@vivid/state`), as the phone does.
 * - An answer that did not go through is said over the banner, and the banner goes back to the
 *   question the refusal names.
 * - The arrow keys move between the rows while focus is in the banner.
 */

/** Whether the banner's rows can be pressed, or are there but out of reach. */
type Reach = 'pressable' | 'held'

/**
 * The banner over the composer, for what it holds (`useAsking`): the questions of the request
 * that is up, or of the one folding away. It is keyed by the request, so each banner starts on
 * its first question, open, and arrives.
 */
export function Raised({ asking }: { asking: Asking }) {
  const drawn = model.Hold.$match(asking.hold, {
    Free: () => Option.none(),
    Up: ({ request }) => Option.some({ request, leaving: false }),
    Leaving: ({ request }) => Option.some({ request, leaving: true }),
  })
  if (Option.isNone(drawn)) return null
  const { request, leaving } = drawn.value
  return (
    <Choices
      key={request.id}
      request={request}
      leaving={leaving}
      busy={asking.sendingTo(request.id)}
      drafting={asking.draftingIn(request)}
      refusal={Option.map(asking.refusal, (refused) => refused.words)}
      onDraft={(next) => asking.draft(request.id, next)}
      onSend={(answers) => asking.answer(request.id, answers)}
      onGone={asking.release}
    />
  )
}

interface ChoicesProps {
  /** The request the banner holds. */
  readonly request: InputRequest
  /** It is no longer the one that is up: the banner folds away and then says so (`onGone`). */
  readonly leaving: boolean
  /** The answers are on their way: nothing more can be chosen until that try ends. */
  readonly busy: boolean
  /**
   * Where the Person is in the request's questions. It is kept by the Thread, not the banner,
   * because the composer moves on from a question and answers one that offers no options.
   */
  readonly drafting: model.Asking
  /** What to say when the last answers did not go through, in one sentence. */
  readonly refusal: Option.Option<string>
  readonly onDraft: (next: model.Asking) => void
  /** Every question has its answer: send them, in the questions' order. */
  readonly onSend: (answers: Arr.NonEmptyReadonlyArray<InputAnswer>) => void
  /** The banner has folded away. */
  readonly onGone: () => void
}

/**
 * Picking an option, as the banner does it on the model both clients share (`asking`,
 * `@vivid/state`).
 *
 * A question that takes one option moves on by itself `ADVANCE_AFTER` after the press; on the
 * last question that sends. What moving on comes to is worked out at the press, from what was
 * just picked, and only carried out later; nothing can be pressed meanwhile (`moving`). A
 * question several options may be chosen for only toggles: the composer's footer moves on.
 *
 * That later move is called off when the banner stops being a way to answer: `alive` is a ref
 * callback for a mark the banner draws only while its request is the one that is up, and React
 * runs its cleanup the moment the mark is taken out, which is when the request is withdrawn or
 * answered and when the banner is unmounted. Without it a press on a request withdrawn within
 * that moment would still send its answers. The signal is an `AbortController` kept for the life
 * of the banner: once the banner is called off it stays so.
 */
function usePicking(
  request: InputRequest,
  drafting: model.Asking,
  act: Pick<ChoicesProps, 'onDraft' | 'onSend'>,
) {
  const { questions } = request
  const [moving, setMoving] = useState(false)
  const [off] = useState(() => new AbortController())
  const alive = useCallback(() => () => off.abort(), [off])

  function pick(label: string) {
    const picked = model.press(questions, drafting, label)
    act.onDraft(picked)
    if (model.progressOf(questions, picked).question.selection === 'Several') return
    const step = model.advance(questions, picked)
    setMoving(true)
    setTimeout(() => {
      if (off.signal.aborted) return
      setMoving(false)
      model.Step.$match(step, {
        Stay: () => undefined,
        Next: ({ asking: next }) => act.onDraft(next),
        Send: ({ answers }) => act.onSend(answers),
      })
    }, model.ADVANCE_AFTER)
  }

  // The ref callback is handed back apart from the rest: a value with a ref in it is treated
  // as a ref, and reading the rest while rendering would then be read as reading one.
  return [{ progress: model.progressOf(questions, drafting), moving, pick }, alive] as const
}

/** Whether a key is being typed into something: a field, the composer, editable text. */
const typedInto = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable)

/**
 * The number keys pick a row: 1 the first, 2 the second, as each row says at its trailing end.
 * It answers a ref callback for a mark the banner draws only while its rows can be pressed, so
 * the keys are heard for exactly that long: not while the banner is closed (the numbers are out
 * of sight), leaving, or sending. The reference listens from an effect on the same conditions.
 *
 * A key is left alone when it is typed into a field or the composer, pressed with a modifier (a
 * shortcut is the app's), held down, or pressed somewhere that is not this Thread: a dialog over
 * the Thread has the keyboard while it is open.
 */
const digits =
  (options: ReadonlyArray<InputOption>, onPick: (label: string) => void) => (mark: HTMLElement) => {
    const thread = mark.closest('[data-alive]')
    const hear = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      if (typedInto(event.target) || !/^[1-9]$/u.test(event.key)) return
      const here =
        event.target === document.body ||
        (thread !== null && event.target instanceof Node && thread.contains(event.target))
      const option = options[Number(event.key) - 1]
      if (!here || option === undefined) return
      event.preventDefault()
      onPick(option.label)
    }
    document.addEventListener('keydown', hear)
    return () => document.removeEventListener('keydown', hear)
  }

/**
 * The arrow keys move between the rows while focus is in the banner. It is the banner's own
 * `onKeyDown`, so it hears nothing typed into the composer. From somewhere in the banner that is
 * not a row, down lands on the first row and up on the last; the ends wrap round.
 */
function steer(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-choice]'))
  const at = rows.findIndex((row) => row === document.activeElement)
  const step = event.key === 'ArrowDown' ? 1 : -1
  // Nothing in focus counts as the place before the first row, so one step up wraps to the last.
  const from = at === -1 && step === -1 ? 0 : at
  const next = rows[(from + step + rows.length) % rows.length]
  if (next === undefined) return
  event.preventDefault()
  next.focus()
}

/**
 * The banner in its place: the composer's gutters and column, and in it the attachment
 * (`asked-attachment`), which is narrower than the composer, tucked behind its top edge, and
 * folds in as it is mounted. It is drawn between the conversation and the composer, in the
 * column's flow, so the conversation ends above it and keeps its newest words in sight by
 * itself: the Thread's scroller is a reversed column, which the browser keeps on its end as the
 * room above the composer changes.
 *
 * A banner that is leaving is no longer a way to answer: it is `inert`, so neither a pointer nor
 * the keyboard nor a screen reader finds its rows while it folds away. When that fold has ended
 * it says so (`onGone`), and only then can the next request's banner arrive.
 */
function Choices({
  request,
  leaving,
  busy,
  drafting,
  refusal,
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
  // Closed, the rows are out of sight and must not be pressed; nor may those of a request that
  // has just been settled, here or anywhere else, or whose answers are on their way, or in the
  // moment a pressed option is shown before the banner moves on.
  const held = !open || leaving || busy || picking.moving
  return (
    <div className="shrink-0 px-4 sm:px-6" inert={leaving}>
      <div className="mx-auto w-full max-w-(--thread-max-w)">
        {Option.isSome(refusal) && (
          <div className="flex justify-center pb-2 sm:justify-end">
            <Alert variant="destructive">{refusal.value}</Alert>
          </div>
        )}
        <div
          data-folded={leaving ? '' : undefined}
          className="asked-attachment"
          onTransitionEnd={(event) => {
            // Only the banner's own fold, not a row's fill or the panel opening inside it.
            if (leaving && event.target === event.currentTarget) onGone()
          }}
        >
          <div>
            <Banner
              progress={progress}
              open={open}
              reach={held ? 'held' : 'pressable'}
              busy={busy}
              onToggle={() => setClosedAt(open ? Option.some(progress.at) : Option.none())}
              onPick={picking.pick}
            />
          </div>
        </div>
        {/* There only while this request is the one that is up: see `usePicking`. */}
        {!leaving && <span hidden ref={alive} />}
        {/* There only while the rows can be pressed: see `digits`. */}
        {!held && <span hidden ref={digits(progress.question.options, picking.pick)} />}
      </div>
    </div>
  )
}

/**
 * The banner's surface (`asked-surface`: the reference's attached `Surface` and `Root`), its
 * head row and, under it, the panel that the head opens and closes.
 *
 * The head is the reference's `Row` drawn as a button: a column for the mark as wide as the row
 * is tall (28 px, 24 from the `sm` width up), the words, and at the trailing end the count and
 * the chevron. It says whether the panel is open (`aria-expanded`) and names what it controls.
 * The chevron points down while the panel is open and turns over when it is closed, as the
 * reference's `ToggleIcon` does; it is decoration, since the row is the control.
 */
function Banner({
  progress,
  open,
  reach,
  busy,
  onToggle,
  onPick,
}: {
  progress: model.Progress
  /** The panel under the head is showing. */
  open: boolean
  reach: Reach
  busy: boolean
  onToggle: () => void
  onPick: (label: string) => void
}) {
  const panel = useId()
  const { question } = progress
  return (
    <section
      aria-label="Vivid's question"
      className="asked-surface bg-surface-3 text-label lift"
      onKeyDown={steer}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        title={open ? 'Hide the question and its options' : 'Show the question and its options'}
        onClick={onToggle}
        className="flex min-h-7 w-full cursor-pointer items-start gap-1 rounded-row text-start transition-colors duration-150 hover:bg-wash-hover focus-visible:-outline-offset-2"
      >
        <span
          aria-hidden
          className="flex size-7 flex-none items-center justify-center text-ink-3 sm:w-6"
        >
          <CircleHelp className="size-3" />
        </span>
        <span
          data-asked="question"
          dir="auto"
          className={cn(
            'min-w-0 flex-1 py-1.5 font-title text-ink',
            // Two lines of the question at most, then an ellipsis; one while it is closed.
            open ? 'line-clamp-2 wrap-anywhere' : 'truncate',
          )}
        >
          {question.question}
        </span>
        <span className="flex h-7 flex-none items-center gap-1">
          {progress.of > 1 && (
            <span
              aria-label={`Question ${progress.at + 1} of ${progress.of}`}
              className="text-meta font-title text-ink-3 tabular-nums"
            >
              {progress.at + 1}/{progress.of}
            </span>
          )}
          <span aria-hidden className="flex size-6 items-center justify-center text-ink-3">
            <ChevronDown className={cn('size-3.5', !open && 'rotate-180')} />
          </span>
        </span>
      </button>
      {/* The panel folds between nothing and its own height (`motion-fold`); folded it stays in
          the document, so it is `inert` there. */}
      <div id={panel} data-folded={open ? undefined : ''} inert={!open} className="motion-fold">
        <div>
          <Options progress={progress} reach={reach} busy={busy} onPick={onPick} />
        </div>
      </div>
    </section>
  )
}

/**
 * What is under the head, indented under the head's words (the reference's `Scroll` and `Body`):
 * for a question several options may be chosen for, the line that says so, and the options.
 * They scroll inside the banner when they do not fit (`asked-scroll`). The options are keyed by
 * the question's place as well as their label, so each question's rows are its own.
 *
 * A question that offers no options has nothing here: the composer answers it, and says
 * "Reply".
 */
function Options({
  progress,
  reach,
  busy,
  onPick,
}: {
  progress: model.Progress
  reach: Reach
  busy: boolean
  onPick: (label: string) => void
}) {
  const { question } = progress
  if (question.options.length === 0) return null
  const picked = model.pickedIn(progress.draft)
  const several = question.selection === 'Several'
  return (
    <div className="asked-scroll">
      <div className="min-w-0 ps-8 pe-1 pb-1 sm:ps-7">
        {several && <p className="mt-1 text-ink-3">Select one or more options.</p>}
        <ul className="mt-2 flex flex-col gap-0.5">
          {question.options.map((option, place) => (
            <Row
              key={`${progress.at}:${option.label}`}
              option={option}
              digit={place + 1}
              several={several}
              reach={reach}
              standing={model.standingOf(picked.includes(option.label), busy)}
              onPress={() => onPick(option.label)}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * What a row is to a screen reader. Where several options may be chosen it is a checkbox, on or
 * off; where one may be chosen it is a button that is pressed once it is the one picked.
 */
const roleOf = (several: boolean, chosen: boolean) =>
  several ? ({ role: 'checkbox', 'aria-checked': chosen } as const) : { 'aria-pressed': chosen }

/**
 * A row's fill and how it answers a pointer, after the reference's: no fill at rest, a wash
 * under the pointer, a stronger one once chosen. A row that cannot be pressed just now and is
 * not the chosen one is dimmed, and says so with the pointer.
 */
const lookOf = (chosen: boolean, open: boolean) =>
  cn(
    chosen ? 'bg-wash-pressed text-ink' : 'text-ink-2',
    open && 'cursor-pointer',
    open && !chosen && 'hover:bg-wash-hover',
    !open && 'cursor-not-allowed',
    !open && !chosen && 'opacity-50',
  )

/**
 * One option (the reference's option button): its label, and what picking it means in a smaller
 * line under it when the question gave one. At its trailing end is the number key that picks
 * it, as a bare numeral with no fill and no edge; a chosen row shows a check there instead, so
 * what is chosen is not said by its fill alone. Where several may be chosen a press takes the
 * choice back; where one may be chosen the press moves on.
 *
 * A row out of reach is `aria-disabled`, not disabled: it keeps the keyboard's focus through the
 * moment a pressed option is shown, where a disabled button would drop it to the page.
 */
function Row({
  option,
  digit,
  several,
  reach,
  standing,
  onPress,
}: {
  option: InputOption
  /** The number key that picks it, counted from one. */
  digit: number
  /** Several of the question's options may be chosen, so this one is a checkbox. */
  several: boolean
  /** Whether the banner's rows can be pressed at all (`Choices`, `held`). */
  reach: Reach
  standing: model.Standing
  onPress: () => void
}) {
  const chosen = standing === 'chosen'
  // A chosen row can be pressed again only where that takes the choice back.
  const open = reach === 'pressable' && (standing === 'open' || (chosen && several))
  return (
    <li>
      <button
        type="button"
        data-choice
        {...roleOf(several, chosen)}
        aria-disabled={!open}
        aria-keyshortcuts={String(digit)}
        onClick={() => {
          if (open) onPress()
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-row px-2.5 py-2 text-start transition-colors duration-150 focus-visible:-outline-offset-2',
          lookOf(chosen, open),
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            data-asked="label"
            dir="auto"
            className="line-clamp-3 text-body font-title wrap-anywhere"
          >
            {option.label}
          </span>
          {option.detail.length > 0 && option.detail !== option.label && (
            <span
              data-asked="detail"
              dir="auto"
              className="line-clamp-3 text-meta wrap-anywhere text-ink-3"
            >
              {option.detail}
            </span>
          )}
        </span>
        {chosen ? (
          <Check aria-hidden className="size-3.5 shrink-0 text-primary" />
        ) : (
          <kbd
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center font-sans text-meta font-title text-ink-3 tabular-nums"
          >
            {digit}
          </kbd>
        )}
      </button>
    </li>
  )
}
