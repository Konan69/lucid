import type { ConnectionId } from '@vivid/contracts'
import { Redacted, Result } from 'effect'
import { useState } from 'react'
import { change } from '../../data/live'
import { Button } from '../../ui/Button'
import { Dialog, DialogActions } from '../../ui/Dialog'

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

  async function submit(form: HTMLFormElement) {
    // Each field is read from its own input, by the name the service gave it: an input's value is
    // always text, where a form's entries could also be files.
    const typed = (name: string) => {
      const input = form.elements.namedItem(name)
      return input instanceof HTMLInputElement ? input.value : ''
    }
    const fields = Object.fromEntries(
      keying.fields.map((field) => [field.name, Redacted.make(typed(field.name))]),
    )
    const result = await change((client) => client.CompleteConnection({ id: keying.id, fields }))
    if (Result.isFailure(result)) {
      setRefusal('That was not accepted. Check it and try again.')
      return
    }
    onClose()
  }

  return (
    <Dialog
      title={`Connect ${keying.name}`}
      description="This goes straight to the integration and is never shown to Vivid or kept in a thread."
      width="md"
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit(event.currentTarget)
        }}
        className="flex flex-col gap-3"
      >
        {keying.fields.map((field) => (
          <label key={field.name} className="flex flex-col gap-1.5">
            <span className="text-label text-ink-2">{field.label}</span>
            <input
              required
              name={field.name}
              type="password"
              autoComplete="off"
              className="h-9 rounded-control bg-well px-3 font-mono text-label text-ink ring-line outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        ))}
        {refusal !== null && (
          <p role="alert" className="text-label text-danger">
            {refusal}
          </p>
        )}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Connect
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
