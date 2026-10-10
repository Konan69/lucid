import type { Connection, ConnectionId } from '@vivid/contracts'
import type { connecting } from '@vivid/state'
import { Effect, Redacted, Result } from 'effect'
import { useId, useState } from 'react'
import { act } from '../../data/app'
import { changing } from '../../data/live'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { useSurface } from '../../ui/Layer'

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
 * Collects the key a service asks for. It is opened from Settings and from the card in a Thread;
 * either way the key goes straight to the integration and nowhere else. The values are wrapped the moment they leave the form and
 * sent once; they are not kept in state after the dialog closes and never appear anywhere else.
 *
 * The dialog is open for as long as the attempt is waiting for a key, so it does not close
 * itself: `onClose` says the Person sent it away, and `onAnswered` hands over the account as the
 * server answered with it, and either one moves the attempt on. Both name the attempt the dialog
 * was opened for, so a dialog left from an attempt that was replaced ends nothing.
 *
 * Every answer that holds an account is handed over, whether or not the service took the key:
 * the machine decides. After one completion the account no longer waits for a key and the server
 * takes no second one (`makeComplete`, `apps/server/src/connections/executor.ts`), so a key the
 * service refused ends the attempt (`Unusable`) and closes this; "check it and try again" was
 * offering a retry the server cannot take. Only the call itself failing keeps the dialog open.
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
  // Sent away (Escape, a click outside, the close button) it plays out before `onClose` is told.
  const close = () => onClose(keying.attempt.id)
  const surface = useSurface(close)

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
    <Dialog {...surface}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Connect ${keying.serviceName}`}</DialogTitle>
          <DialogDescription>
            This goes straight to the integration and is never shown to Vivid or kept in a thread.
          </DialogDescription>
        </DialogHeader>
        {/* `contents`: the fields and the actions take the dialog's own gap, and the submit button
            stays inside the form whose inputs `submit` reads. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void act(submit(event.currentTarget))
          }}
        >
          <FieldGroup>
            {keying.fields.map((field) => (
              <Field key={field.name}>
                <FieldLabel htmlFor={`${ids}-${field.name}`}>{field.label}</FieldLabel>
                <Input
                  mono
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
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
