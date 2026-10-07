import { Effect, Result } from 'effect'
import { useId, useState } from 'react'
import { act } from '../../data/app'
import { changing } from '../../data/live'
import { Route, router } from '../../data/route'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { Field, FieldError, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { useSurface } from '../../ui/Layer'

/**
 * Creates a Company: a name, and that is all. It is opened from the workspace switcher and from
 * Settings → People, the two places a Person working alone would look for "work with others".
 * The server moves the session into the new Company, so the Person lands on its first screen.
 */
export function CreateCompany({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  // One Company per press: a second Enter while the first is on its way must not make a second.
  const [creating, setCreating] = useState(false)
  const field = useId()
  // Sent away (Escape, a click outside, the close button) it plays out before `onClose` is told.
  const surface = useSurface(onClose)

  function create() {
    return Effect.gen(function* () {
      if (creating) return
      setCreating(true)
      const result = yield* changing((client) => client.CreateCompany({ name: name.trim() }))
      if (Result.isFailure(result)) {
        setCreating(false)
        setRefusal('The company could not be created. Try again.')
        return
      }
      onClose()
      router.go(Route.New())
    })
  }

  return (
    <Dialog {...surface}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a company</DialogTitle>
          <DialogDescription>
            Shared threads, a shared Library and shared rules for the people you work with. Your own
            threads, notes and integrations stay yours.
          </DialogDescription>
        </DialogHeader>
        {/* `contents`: the field and the actions take the dialog's own gap, and the submit button
            stays inside the form so Enter in the field creates the Company. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void act(create())
          }}
        >
          <Field>
            <FieldLabel htmlFor={field}>Company name</FieldLabel>
            <Input
              id={field}
              required
              // A dialog exists to take this one answer; the cursor belongs in it.
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Acme"
            />
            {/* Under the field it is about, with what was typed still there. */}
            {refusal !== null && <FieldError>{refusal}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || name.trim().length === 0}>
              {creating ? 'Creating…' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
