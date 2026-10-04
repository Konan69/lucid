import type { Project, ProjectId } from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { Result } from 'effect'
import { useId, useState } from 'react'
import { change, live } from '../../data/live'
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
 * Makes a Project: a name, and nothing else. `inside` is the Project it will sit in, or nothing
 * for one of its own. A Project gets its id from the server, so this waits for the answer; the
 * Project that comes back is put in the live list as a change already accepted, so whoever asked
 * (`onMade`) can open it or file a Thread in it before the live query's next result arrives.
 *
 * A refusal is said under the field in plain words with what was typed still there.
 */
export function CreateProject({
  inside,
  onMade,
  onClose,
}: {
  inside: ProjectId | null
  onMade: (project: Project) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [refused, setRefused] = useState(false)
  // One Project per press: a second Enter while the first is on its way must not make a second.
  const [creating, setCreating] = useState(false)
  const field = useId()
  // Sent away (Escape, a click outside, the close button) it plays out before `onClose` is told.
  const surface = useSurface(onClose)

  async function create() {
    if (creating) return
    setCreating(true)
    setRefused(false)
    const result = await change((client) =>
      client.CreateProject({ name: name.trim(), parentProjectId: inside }),
    )
    if (Result.isFailure(result)) {
      setCreating(false)
      setRefused(true)
      return
    }
    live.projects.expect(projectsData.confirmed(result.success))(true)
    onClose()
    onMade(result.success)
  }

  return (
    <Dialog {...surface}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project keeps the threads about one piece of work together.
          </DialogDescription>
        </DialogHeader>
        {/* `contents`: the field and the actions take the dialog's own gap, and the submit button
            stays inside the form so Enter in the field makes the Project. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Field>
            <FieldLabel htmlFor={field}>Name</FieldLabel>
            <Input
              id={field}
              required
              // A dialog exists to take this one answer; the cursor belongs in it.
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Office move"
            />
            {/* Under the field it is about, with what was typed still there. */}
            {refused && (
              <FieldError>
                Unable to create the project. Check your connection and try again.
              </FieldError>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || name.trim().length === 0}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
