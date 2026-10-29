import {
  HandoffFormState,
  HandoffRequest,
  HandoffScreenState,
  type HandoffField,
  type HandoffFieldPurpose,
  type HandoffFieldReceipt,
  type HandoffValue,
  type PersonId,
} from '@vivid/contracts'
import { handing } from '@vivid/state'
import { Array as Arr, Option, Redacted } from 'effect'
import { useId, useState } from 'react'
import { pressHandoff, useHanding } from '../../data/handing'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Markdown } from '../../ui/Markdown'
import { Attached, Head, Panel, SURFACE } from './Choices'

/**
 * A step Vivid handed the Person on its Computer (a sign-in, a code, a payment, a CAPTCHA,
 * taking control), drawn the way a question is (`Question.tsx`, `Choices.tsx`):
 *
 * - In the conversation it is Vivid's words, where the tool call was (`Handed`), with who it
 *   waits on when that is somebody else, and who did it once it is done.
 * - While it waits on the Person looking at it, it is the banner over the composer (`Handing`):
 *   the fields Vivid found on the page as secure fields, or for a step on the screen the way to
 *   take it; then the Computer panel to finish on (the Thread's own panel, `Computer.tsx`, which
 *   gives the Person control while a step is open); then Continue, which sends Vivid on.
 *
 * What is typed is kept in this banner's fields until it is sent, and then nowhere on this side:
 * a fill carries it to the server once, and the fields are emptied as it goes. Nothing typed is
 * a draft, a route or an optimistic message.
 */

/** What is typed in one field so far; a field not yet typed into holds no text. */
const typedIn = (values: ReadonlyMap<string, string>, field: HandoffField) =>
  Option.getOrElse(Option.fromUndefinedOr(values.get(field.id)), () => '')

/** The keyboard and suggestions for a field. Never another site's saved password. */
const keyboardOf = (purpose: HandoffFieldPurpose) => {
  switch (purpose) {
    case 'Code':
      return { autoComplete: 'one-time-code', inputMode: 'numeric' } as const
    case 'CardNumber':
    case 'CardCode':
      return { autoComplete: 'off', inputMode: 'numeric' } as const
    case 'Text':
    case 'Password':
    case 'CardExpiry':
      return { autoComplete: 'new-password', inputMode: 'text' } as const
  }
}

/** The step in the conversation: Vivid's sentence, and what became of it in one quiet line. */
export function Handed({ handoff, me }: { handoff: HandoffRequest; me: PersonId }) {
  const theirs = handing.isOpen(handoff) && handoff.askedOf.id !== me
  const done = HandoffRequest.match(handoff, {
    Form: ({ state }) =>
      HandoffFormState.guards.Completed(state) ? Option.some(state.completedBy) : Option.none(),
    Screen: ({ state }) =>
      HandoffScreenState.guards.Completed(state) ? Option.some(state.completedBy) : Option.none(),
  })
  return (
    <div className="mt-3">
      <Markdown content={handoff.summary} />
      {theirs && <p className="mt-1 text-label text-ink-3">Waiting on {handoff.askedOf.name}.</p>}
      {Option.isSome(done) && (
        <p className="mt-1 text-label text-ink-3">Done by {done.value.name}.</p>
      )}
    </div>
  )
}

/** One field's latest result, in a row under the field's label. */
function Result({ field, receipt }: { field: HandoffField; receipt: HandoffFieldReceipt }) {
  return (
    <li className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="truncate text-ink-2">{field.label}</span>
      <span className="text-meta text-ink-3">{handing.resultWords(receipt.result)}</span>
    </li>
  )
}

/**
 * The fields to type into. Each is a password field whatever it holds, so nothing typed is shown
 * on the screen, and none is offered this site's or another's saved values.
 */
function Fields({
  fields,
  values,
  held,
  onType,
}: {
  fields: ReadonlyArray<HandoffField>
  values: ReadonlyMap<string, string>
  held: boolean
  onType: (field: HandoffField, value: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {fields.map((field) => {
        const keyboard = keyboardOf(field.purpose)
        return (
          <label key={field.id} className="flex flex-col gap-1">
            <span className="text-meta font-title text-ink-2">{field.label}</span>
            <Input
              compact
              type="password"
              name={`handoff-${field.id}`}
              autoComplete={keyboard.autoComplete}
              inputMode={keyboard.inputMode}
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              disabled={held}
              value={typedIn(values, field)}
              onChange={(event) => onType(field, event.currentTarget.value)}
            />
          </label>
        )
      })}
    </div>
  )
}

/** The actions after the fields are in: finish on the screen, then send Vivid on. */
function Finish({
  handoff,
  held,
  panelOpen,
  onOpenScreen,
}: {
  handoff: HandoffRequest
  held: boolean
  panelOpen: boolean
  onOpenScreen: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!panelOpen && (
        <Button variant="outline" disabled={held} onClick={onOpenScreen}>
          Open the screen
        </Button>
      )}
      <Button disabled={held} onClick={() => pressHandoff(handing.Command.cases.Complete.make({ id: handoff.id }))}>
        Continue
      </Button>
      <NotNow handoff={handoff} held={held} />
    </div>
  )
}

/** Withdraws the step: Vivid is not woken and the Computer is handed back. */
function NotNow({ handoff, held }: { handoff: HandoffRequest; held: boolean }) {
  return (
    <Button
      variant="ghost"
      disabled={held}
      onClick={() => pressHandoff(handing.Command.cases.Withdraw.make({ id: handoff.id }))}
    >
      Not now
    </Button>
  )
}

/** A form step: fill the fields, then finish on the screen. */
function Form({
  handoff,
  held,
  panelOpen,
  onOpenScreen,
}: {
  handoff: typeof HandoffRequest.cases.Form.Type
  held: boolean
  panelOpen: boolean
  onOpenScreen: () => void
}) {
  // Text in a field is plain state: nothing waits on it until Fill is pressed.
  const [values, setValues] = useState<ReadonlyMap<string, string>>(new Map())
  const toFill = handing.fieldsToFill(handoff.fields, handoff.state)
  const receipts = HandoffFormState.guards.Ready(handoff.state) ? handoff.state.fields : []
  const typed = toFill.flatMap((field): ReadonlyArray<HandoffValue> => {
    const value = typedIn(values, field)
    return value === '' ? [] : [{ fieldId: field.id, value: Redacted.make(value) }]
  })
  const filling = HandoffFormState.guards.Applying(handoff.state)
  // The first fill covers every field; a later one any of those not filled.
  const complete = HandoffFormState.guards.Waiting(handoff.state)
    ? typed.length === toFill.length
    : typed.length > 0
  const fill = () => {
    if (!Arr.isReadonlyArrayNonEmpty(typed) || !complete) return
    pressHandoff(
      handing.Command.cases.Fill.make({ request: { id: handoff.id, values: typed } }),
    )
    // Sent: what was typed is not kept here a moment longer.
    setValues(new Map())
  }
  return (
    <form
      className="flex flex-col gap-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault()
        fill()
      }}
    >
      {receipts.length > 0 && (
        <ul className="flex flex-col gap-1 text-label">
          {handoff.fields.map((field) =>
            Option.match(
              Arr.findFirst(receipts, (receipt) => receipt.fieldId === field.id),
              {
                onNone: () => null,
                onSome: (receipt) => <Result key={field.id} field={field} receipt={receipt} />,
              },
            ),
          )}
        </ul>
      )}
      {toFill.length > 0 && (
        <>
          <p className="text-meta text-ink-3">
            Typed into the page on Vivid’s computer. Vivid never sees what you type.
          </p>
          <Fields
            fields={toFill}
            values={values}
            held={held || filling}
            onType={(field, value) => setValues((before) => new Map(before).set(field.id, value))}
          />
        </>
      )}
      {HandoffFormState.guards.Ready(handoff.state) && (
        <p className="text-label text-ink-2">
          Now finish on the screen: check the page and press its button there. Then continue.
        </p>
      )}
      {HandoffFormState.guards.Ready(handoff.state) ? (
        <div className="flex flex-col gap-2">
          {toFill.length > 0 && (
            <div>
              <Button type="submit" variant="outline" disabled={held || !complete}>
                Fill again
              </Button>
            </div>
          )}
          <Finish handoff={handoff} held={held} panelOpen={panelOpen} onOpenScreen={onOpenScreen} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={held || filling || !complete}>
            {filling ? 'Filling…' : 'Fill'}
          </Button>
          <NotNow handoff={handoff} held={held} />
        </div>
      )}
    </form>
  )
}

/** A step on the screen: take it, do it there, then send Vivid on. */
function Screen({
  handoff,
  held,
  panelOpen,
  onOpenScreen,
}: {
  handoff: typeof HandoffRequest.cases.Screen.Type
  held: boolean
  panelOpen: boolean
  onOpenScreen: () => void
}) {
  return HandoffScreenState.match(handoff.state, {
    Waiting: () => (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={held}
          onClick={() => {
            pressHandoff(handing.Command.cases.Begin.make({ id: handoff.id }))
            if (!panelOpen) onOpenScreen()
          }}
        >
          Take the screen
        </Button>
        <NotNow handoff={handoff} held={held} />
      </div>
    ),
    Ready: () => (
      <div className="flex flex-col gap-3">
        <p className="text-label text-ink-2">Do the step on the screen. Then continue.</p>
        <Finish handoff={handoff} held={held} panelOpen={panelOpen} onOpenScreen={onOpenScreen} />
      </div>
    ),
    Completed: () => null,
    Withdrawn: () => null,
  })
}

/**
 * The banner over the composer for the step waiting on this Person (`handing.handoffUp`). It has
 * a head like a question's and, under it, the form or the screen step. A call that did not go
 * through is said over the banner (`Attached`), as an answer's is.
 */
export function Handing({
  handoff,
  panelOpen,
  onOpenScreen,
}: {
  handoff: HandoffRequest
  /** The Computer panel is showing beside the Thread. */
  panelOpen: boolean
  onOpenScreen: () => void
}) {
  const panel = useId()
  const [open, setOpen] = useState(true)
  const reading = useHanding()
  const held = handing.isWaiting(reading)
  return (
    <Attached
      leaving={false}
      refusal={handing.refusalFor(reading, handoff.id)}
      onGone={() => undefined}
    >
      <section aria-label="Vivid needs you for one step" className={SURFACE}>
        <Head
          words={handoff.summary}
          count={Option.none()}
          open={open}
          panel={panel}
          onToggle={() => setOpen((shown) => !shown)}
        />
        <Panel id={panel} open={open}>
          <div className="mt-2 flex min-w-0 flex-col gap-3 ps-8 pe-1 pb-2 sm:ps-7">
            {HandoffRequest.match(handoff, {
              Form: (form) => (
                <Form
                  key={form.id}
                  handoff={form}
                  held={held}
                  panelOpen={panelOpen}
                  onOpenScreen={onOpenScreen}
                />
              ),
              Screen: (screen) => (
                <Screen
                  handoff={screen}
                  held={held}
                  panelOpen={panelOpen}
                  onOpenScreen={onOpenScreen}
                />
              ),
            })}
          </div>
        </Panel>
      </section>
    </Attached>
  )
}
