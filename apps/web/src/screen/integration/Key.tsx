import type { Connection, ConnectionId } from '@vivid/contracts'
import type { connecting } from '@vivid/state'
import { Effect, Redacted, Result } from 'effect'
import { useId, useState } from 'react'
import { act } from '../../data/app'
import { changing } from '../../data/live'
import { Button } from '../../ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'

/**
 * An integration that is waiting for its key: which one, what its service is called, and what it
 * asks for. It is the part of the machine's `Keying` state the form needs (`connecting` in
 * `@vivid/state`), so that state is handed over as it is.
 */
export interface Keying {
  /** The attempt the dialog belongs to: its answer and its closing say this back. */
  readonly attempt: { readonly id: connecting.AttemptId }
  readonly id: ConnectionId
  readonly serviceName: string
  readonly fields: ReadonlyArray<{ readonly name: string; readonly label: string }>
}

/**
 * Collects the key a service asks for, inside the Integration's own card: the card in a Thread
 * and the one Settings shows while a key is wanted. The key goes straight to the integration and
 * nowhere else. The values are wrapped the moment they leave the form and sent once; they are not
 * kept in state after the form closes and never appear anywhere else.
 *
 * It was a dialog over the page until the approved mockup 4 of 26 October 2026 (issue #126): the
 * key is typed where the Integration is, so the Person never loses sight of what it is for.
 *
 * The form is shown for as long as the attempt is waiting for a key, so it does not close itself:
 * `onClose` says the Person sent it away (Cancel, or Escape in a field), and `onAnswered` hands
 * over the account as the server answered with it, and either one moves the attempt on. Both
 * name the attempt the form was opened for, so a form left from an attempt that was replaced ends
 * nothing.
 *
 * Every answer that holds an account is handed over, whether or not the service took the key:
 * the machine decides. After one completion the account no longer waits for a key and the server
 * takes no second one (`makeComplete`, `apps/server/src/connections/executor.ts`), so a key the
 * service refused ends the attempt (`Unusable`) and closes this; "check it and try again" was
 * offering a retry the server cannot take. Only the call itself failing keeps the form open.
 */
export function EnterKey({
  keying,
  onClose,
  onAnswered,
}: {
  keying: Keying
  onClose: (attempt: connecting.AttemptId) => void
  onAnswered: (attempt: connecting.AttemptId, connection: Connection) => void
}) {
  const [refusal, setRefusal] = useState<string | null>(null)
  // One id for the form; each field's own name is added to it, so a label finds its input.
  const ids = useId()
  const close = () => onClose(keying.attempt.id)

  function submit(form: HTMLFormElement) {
    return Effect.gen(function* () {
      // Each field is read from its own input, by the name the service gave it: an input's value is
      // always text, where a form's entries could also be files.
      const typed = (name: string) => {
        const input = form.elements.namedItem(name)
        return input instanceof HTMLInputElement ? input.value : ''
      }
      const fields = Object.fromEntries(
        keying.fields.map((field) => [field.name, Redacted.make(typed(field.name))]),
      )
      const result = yield* changing((client) =>
        client.CompleteConnection({ id: keying.id, fields }),
      )
      // The call itself did not get through: nothing was completed, so it can be sent again.
      if (Result.isFailure(result)) {
        setRefusal('That was not accepted. Check it and try again.')
        return
      }
      onAnswered(keying.attempt.id, result.success.connection)
    })
  }

  return (
    <form
      aria-label={`Key for ${keying.serviceName}`}
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        close()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void act(submit(event.currentTarget))
      }}
    >
      <FieldGroup>
        {keying.fields.map((field, place) => (
          <Field key={field.name}>
            <FieldLabel htmlFor={`${ids}-${field.name}`}>{field.label}</FieldLabel>
            <Input
              mono
              // The form appears because the Person pressed for it, so the first field is theirs.
              autoFocus={place === 0}
              id={`${ids}-${field.name}`}
              required
              name={field.name}
              type="password"
              autoComplete="off"
            />
          </Field>
        ))}
        {refusal !== null && <FieldError>{refusal}</FieldError>}
      </FieldGroup>
      <p className="text-meta font-meta text-pretty text-ink-3">
        It goes straight to {keying.serviceName}. Vivid never sees it and it is never kept in a
        thread.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Connect
        </Button>
      </div>
    </form>
  )
}
