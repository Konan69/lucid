import type { Project, ProjectId } from '@vivid/contracts'
import { projects } from '@vivid/state'
import { Option, Result } from 'effect'
import { commit } from '../../data/haptics'
import { useLiveData } from '../../data/live'
import { NameSheet } from '../../ui/Sheet'

/**
 * Makes a Project: a name, and nothing else. `inside` is the Project it will sit in, or nothing
 * for one of its own. The Project the server returns is put in the live list at once, as a
 * change already accepted, so whoever asked (`onMade`) can open it or file a Thread in it
 * without waiting on the live query's next result.
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
  const data = useLiveData()
  return (
    <NameSheet
      title="New project"
      detail="A project keeps the threads about one piece of work together."
      label="Name"
      initial=""
      placeholder="Office move"
      action="Create project"
      maxLength={80}
      onClose={onClose}
      onSave={async (name) => {
        const result = await data.change((client) =>
          client.CreateProject({ name, parentProjectId: inside }),
        )
        if (Result.isFailure(result)) {
          return Option.some('Unable to create the project. Check your connection and try again.')
        }
        commit()
        data.live.projects.expect(projects.confirmed(result.success))(true)
        onMade(result.success)
        return Option.none()
      }}
    />
  )
}
