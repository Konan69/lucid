import type { InputRequest } from '@vivid/contracts'
import { asking, filling, form } from '@vivid/state'
import { Option } from 'effect'
import { useId, useState } from 'react'
import { answerIntegration, useFilling } from '../../data/filling'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Attached, Head, Panel, Row, SURFACE, steer, type Reach } from './Choices'

/**
 * An Integration's question, asked mid-call, as one more of Vivid's questions: the same banner
 * attached to the composer (`Choices.tsx`), the same head, the same rows, and under them the
 * Feed card's two buttons (`feed/Decide.tsx`). Nothing else is added: the owner accepted it drawn
 * from the app's own parts ("those are questions, it's fine", 9 November 2026, mockup
 * `u4-phone.html`).
 *
 * The head is the Integration's message. Under it is one block per property of its form, in the
 * form's order (`form.entriesOf`, `@vivid/state`): a closed set is the question's rows, one or
 * several; yes or no is two rows; words and numbers are the app's own field. Each block has its
 * title over it (none for a form of one choice, which the head already asks), "optional" beside
 * an optional one, and its help line under the title. What is wrong with a value is said under
 * its field once the Person has changed it, and keeps Send off whether said or not.
 *
 * Skip answers `decline`; Send answers `accept` with every field that has a value. Both go
 * through `AnswerIntegrationInput` (`filling`, `@vivid/state`). The values are plain state here:
 * nothing waits on them until a button is pressed.
 */
export function Filled({
  request,
  leaving,
  onGone,
}: {
  request: InputRequest
  /** It is no longer the one that is up: the banner folds away and then says so (`onGone`). */
  leaving: boolean
  onGone: () => void
}) {
  const reading = useFilling()
  return (
    <Attached leaving={leaving} refusal={filling.refusalFor(reading, request.id)} onGone={onGone}>
      {Option.match(form.formOf(request), {
        onNone: () => null,
        onSome: (asked) => (
          <Fields
            request={request}
            asked={asked}
            held={leaving || filling.isHeld(reading, request.id)}
            going={filling.goingOn(reading, request.id)}
          />
        ),
      })}
    </Attached>
  )
}

/** The banner's surface: the head, and under it the fields and the two buttons. */
function Fields({
  request,
  asked,
  held,
  going,
}: {
  request: InputRequest
  asked: form.IntegrationForm
  /** Nothing can be changed or sent just now (`Filled`). */
  held: boolean
  /** Which button's answer is on its way. */
  going: Option.Option<'Send' | 'Skip'>
}) {
  const panel = useId()
  const [open, setOpen] = useState(true)
  // What the Person has given so far, and which fields they have changed: plain state, since
  // nothing waits on it until Send or Skip.
  const [entries, setEntries] = useState(() => form.entriesOf(asked))
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set())
  const content = form.contentOf(entries)
  const reach: Reach = held || !open ? 'held' : 'pressable'
  const change = (key: string, next: ReadonlyArray<form.Entry>) => {
    setEntries(next)
    setChanged((before) => new Set(before).add(key))
  }
  const send = () => {
    if (held || Option.isNone(content)) return
    answerIntegration({
      id: request.id,
      response: { action: 'accept', content: content.value },
    })
  }
  return (
    <section aria-label="Vivid's question" className={SURFACE} onKeyDown={steer}>
      <Head
        words={asked.message}
        count={Option.none()}
        open={open}
        panel={panel}
        onToggle={() => setOpen((shown) => !shown)}
      />
      <Panel id={panel} open={open}>
        <form
          className="asked-scroll"
          autoComplete="off"
          // Every field is checked by the form's own model (`form.problemOf`), in Vivid's words.
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <div className="mt-2 flex min-w-0 flex-col gap-3 ps-8 pe-1 pb-1 sm:ps-7">
            {entries.map((entry) => (
              <Block
                key={entry.key}
                entry={entry}
                titled={form.titled(entries)}
                reach={reach}
                said={changed.has(entry.key)}
                onPick={(value) => change(entry.key, form.pick(entries, entry.key, value))}
                onTurn={(on) => change(entry.key, form.turn(entries, entry.key, on))}
                onType={(words) => change(entry.key, form.type(entries, entry.key, words))}
              />
            ))}
            <footer className="flex justify-end gap-2 pb-1">
              <Button
                type="button"
                variant="secondary"
                disabled={held}
                onClick={() =>
                  answerIntegration({ id: request.id, response: { action: 'decline' } })
                }
              >
                {Option.contains(going, 'Skip') ? 'Skipping…' : 'Skip'}
              </Button>
              <Button type="submit" disabled={held || Option.isNone(content)}>
                {Option.contains(going, 'Send') ? 'Sending…' : 'Send'}
              </Button>
            </footer>
          </div>
        </form>
      </Panel>
    </section>
  )
}

/**
 * One property of the form: its title and help, then its rows or its field, then what is wrong
 * with it once the Person has changed it (`said`).
 */
function Block({
  entry,
  titled,
  reach,
  said,
  onPick,
  onTurn,
  onType,
}: {
  entry: form.Entry
  titled: boolean
  reach: Reach
  said: boolean
  onPick: (value: string) => void
  onTurn: (on: boolean) => void
  onType: (words: string) => void
}) {
  const id = useId()
  const problem = said ? form.problemOf(entry) : Option.none()
  const typed = form.Entry.$is('Text')(entry) || form.Entry.$is('Number')(entry)
  return (
    <div role={typed ? undefined : 'group'} aria-labelledby={typed ? undefined : `${id}-title`}>
      {titled && (
        <Title id={`${id}-title`} field={typed ? Option.some(id) : Option.none()} entry={entry} />
      )}
      {Option.match(entry.help, {
        onNone: () => null,
        onSome: (help) => (
          <p id={`${id}-help`} dir="auto" className="ms-1 mb-1.5 text-meta text-ink-3">
            {help}
          </p>
        ),
      })}
      {form.Entry.$match(entry, {
        One: ({ choices, picked }) => (
          <Choices
            rows={choices.map((choice) => ({
              label: choice.label,
              chosen: Option.contains(picked, choice.value),
              press: () => onPick(choice.value),
            }))}
            several={false}
            reach={reach}
          />
        ),
        Several: ({ choices, picked }) => (
          <Choices
            rows={choices.map((choice) => ({
              label: choice.label,
              chosen: picked.includes(choice.value),
              press: () => onPick(choice.value),
            }))}
            several
            reach={reach}
          />
        ),
        Toggle: ({ on }) => (
          <Choices
            rows={form.YES_NO.map((row) => ({
              label: row.label,
              chosen: Option.contains(on, row.on),
              press: () => onTurn(row.on),
            }))}
            several={false}
            reach={reach}
          />
        ),
        Text: (text) => (
          <Field
            id={id}
            entry={text}
            words={text.words}
            problem={problem}
            reach={reach}
            onType={onType}
          />
        ),
        Number: (number) => (
          <Field
            id={id}
            entry={number}
            words={number.words}
            problem={problem}
            reach={reach}
            onType={onType}
          />
        ),
      })}
      {!typed && <Problem id={`${id}-problem`} problem={problem} />}
    </div>
  )
}

/** A block's title, with "optional" beside an optional one. A field's title is its label. */
function Title({
  id,
  field,
  entry,
}: {
  id: string
  /** The field it names, when the block is a field. */
  field: Option.Option<string>
  entry: form.Entry
}) {
  const words = (
    <>
      {entry.title}
      {!entry.required && <span className="text-ink-3"> · optional</span>}
    </>
  )
  const look = 'ms-1 mb-1.5 block text-meta text-ink-2'
  return Option.match(field, {
    onNone: () => (
      <p id={id} dir="auto" className={look}>
        {words}
      </p>
    ),
    onSome: (input) => (
      <label id={id} htmlFor={input} dir="auto" className={look}>
        {words}
      </label>
    ),
  })
}

/** What is wrong with a block, in one sentence under it, when anything is and it is said. */
function Problem({ id, problem }: { id: string; problem: Option.Option<string> }) {
  return Option.match(problem, {
    onNone: () => null,
    onSome: (words) => (
      <p id={id} className="ms-1 mt-1 text-meta text-danger">
        {words}
      </p>
    ),
  })
}

/** One row as the block draws it: its words, whether it is chosen, and what a press does. */
interface Shown {
  readonly label: string
  readonly chosen: boolean
  readonly press: () => void
}

/** A closed set, drawn as the question's own rows (`Row`, `Choices.tsx`), without number keys. */
function Choices({
  rows,
  several,
  reach,
}: {
  rows: ReadonlyArray<Shown>
  several: boolean
  reach: Reach
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map((row) => (
        <Row
          key={row.label}
          option={{ label: row.label, detail: '' }}
          digit={Option.none()}
          several={several}
          reach={reach}
          standing={asking.standingOf(row.chosen, false)}
          onPress={row.press}
        />
      ))}
    </ul>
  )
}

/**
 * Words or a number, in the app's own field. A number keeps the Person's words as typed; the
 * keyboard offered follows the kind, and an email or address gets its own.
 */
function Field({
  id,
  entry,
  words,
  problem,
  reach,
  onType,
}: {
  id: string
  entry: form.Entry
  words: string
  problem: Option.Option<string>
  reach: Reach
  onType: (words: string) => void
}) {
  const described = [
    Option.isSome(entry.help) ? `${id}-help` : '',
    Option.isSome(problem) ? `${id}-problem` : '',
  ]
    .filter((one) => one !== '')
    .join(' ')
  return (
    <>
      <Input
        id={id}
        dir="auto"
        aria-invalid={Option.isSome(problem)}
        aria-describedby={described === '' ? undefined : described}
        disabled={reach === 'held'}
        value={words}
        {...keyboardOf(entry)}
        onChange={(event) => onType(event.target.value)}
      />
      <Problem id={`${id}-problem`} problem={problem} />
    </>
  )
}

/** The field's type and keyboard, from what it holds. */
const keyboardOf = (entry: form.Entry) => {
  if (form.Entry.$is('Number')(entry))
    return { inputMode: entry.integer ? 'numeric' : 'decimal' } as const
  if (!form.Entry.$is('Text')(entry)) return {}
  return Option.match(entry.format, {
    onNone: () => ({}),
    onSome: (format) => {
      switch (format) {
        case 'email':
          return { type: 'email', inputMode: 'email' } as const
        case 'uri':
          return { type: 'url', inputMode: 'url' } as const
        case 'date':
          return { placeholder: 'YYYY-MM-DD' }
        case 'date-time':
          return { placeholder: 'YYYY-MM-DDTHH:MM' }
      }
    },
  })
}
