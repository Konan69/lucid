import { Result } from 'effect'
import { useState } from 'react'
import { change } from '../../data/live'
import { Route, router } from '../../data/route'
import { Button } from '../../ui/Button'
import { Dialog, DialogActions, DialogField } from '../../ui/Dialog'

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

  async function create() {
    if (creating) return
    setCreating(true)
    const result = await change((client) => client.CreateCompany({ name: name.trim() }))
    if (Result.isFailure(result)) {
      setCreating(false)
      setRefusal('The company could not be created. Try again.')
      return
    }
    onClose()
    router.go(Route.New())
  }

  return (
    <Dialog
      title="Create a company"
      description="Shared threads, a shared Library and shared rules for the people you work with. Your own threads, notes and integrations stay yours."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <DialogField
          label="Company name"
          value={name}
          onChange={setName}
          placeholder="Acme"
          maxLength={80}
        />
        {refusal !== null && (
          <p role="alert" className="mt-2 text-label text-danger">
            {refusal}
          </p>
        )}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={creating || name.trim().length === 0}>
            {creating ? 'Creating…' : 'Create company'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
