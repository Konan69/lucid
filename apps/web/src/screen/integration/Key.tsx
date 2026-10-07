import type { ConnectionId } from '@vivid/contracts'
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

/** An integration that is waiting for its key: which one, what to call it, and what it asks for. */
export interface Keying {
  readonly id: ConnectionId
  readonly name: string
  readonly fields: ReadonlyArray<{ readonly name: string; readonly label: string }>
}

/**
 * Collects the key a service asks for. It is opened from Settings and from the card in a Thread;
 * either way the key goes straight to the integration and nowhere else. The values are wrapped the moment they leave the form and
 * sent once; they are not kept in state after the dialog closes and never appear anywhere else.
 */
export function EnterKey({ keying, onClose }: { keying: Keying; onClose: () => void }) {
  const [refusal, setRefusal] = useState<string | null>(null)
  // One id for the form; each field's own name is added to it, so a label finds its input.
  const ids = useId()
  // Sent away (Escape, a click outside, the close button) it plays out before `onClose` is told.
  const surface = useSurface(onClose)

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
      if (Result.isFailure(result)) {
        setRefusal('That was not accepted. Check it and try again.')
        return
      }
      onClose()
    })
  }

  return (
    <Dialog {...surface}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Connect ${keying.name}`}</DialogTitle>
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
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
