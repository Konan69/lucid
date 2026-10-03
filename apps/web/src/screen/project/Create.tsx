import type { Project, ProjectId } from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { Result } from 'effect'
import { useState } from 'react'
import { change, live } from '../../data/live'
import { Button } from '../../ui/Button'
import { Dialog, DialogActions, DialogField } from '../../ui/Dialog'

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
    <Dialog
      title="New project"
      description="A project keeps the threads about one piece of work together."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <DialogField
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Office move"
          maxLength={80}
        />
        {refused && (
          <p role="alert" className="mt-2 text-label text-danger">
            Unable to create the project. Check your connection and try again.
          </p>
        )}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={creating || name.trim().length === 0}>
            Create project
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
