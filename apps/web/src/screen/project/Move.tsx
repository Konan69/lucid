import type { ProjectId, Thread } from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { Option } from 'effect'
import { Check, Plus } from 'lucide-react'
import { useState } from 'react'
import { act } from '../../data/app'
import { changing, live, useLiveValue } from '../../data/live'
import { orSay } from '../../data/said'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { useSurface } from '../../ui/Layer'
import { CreateProject } from './Create'
import { Mark } from './Mark'

/**
 * Files a Thread in a Project, or takes it out of one, and shows it before the server has
 * confirmed. A refusal puts the Thread back where it was and says so.
 */
function fileThread(thread: Thread, projectId: ProjectId | null) {
  void act(
    orSay(
      changing(
        (client) => client.PatchThread({ id: thread.id, patch: { projectId } }),
        () =>
          live.threads.expect((current) => ({
            threads: current.threads.map((each) =>
              each.id === thread.id ? { ...each, projectId } : each,
            ),
          })),
      ),
      `“${thread.title}” couldn’t be moved. Try again.`,
    ),
  )
}

const CHOICE =
  'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-row px-2.5 text-left text-label text-ink-2 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink'

/**
 * "Move to a project", from a Thread's menu: pick one of the Person's Projects, make a new one
 * and file the Thread in it, or take the Thread out of the Project it is in. One choice ends it;
 * there is nothing to confirm, since moving a Thread again undoes it.
 *
 * Every Project the Person can see is listed by name, flat, whatever it sits inside: a name is
 * what is looked for here, and where a Project sits is on its own page.
 */
export function MoveThread({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const [creating, setCreating] = useState(false)
  // Sent away (Escape, a click outside, the close button) it plays out before `onClose` is told.
  // A choice calls `onClose` itself: the Thread in its new place is what the Person wants next.
  const surface = useSurface(onClose)
  const list = useLiveValue(live.projects)
  const all = Option.match(list, {
    onNone: (): ReadonlyArray<projectsData.Project> => [],
    onSome: (value) => projectsData.byName(value.projects),
  })
  const move = (projectId: ProjectId | null) => {
    fileThread(thread, projectId)
    onClose()
  }

  if (creating) {
    return <CreateProject inside={null} onMade={(project) => move(project.id)} onClose={onClose} />
  }

  return (
    <Dialog {...surface}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to a project</DialogTitle>
          <DialogDescription>{thread.title}</DialogDescription>
        </DialogHeader>
        {/* One body: the way out of a Project sits close under the list, not a dialog gap away. */}
        <div>
          <ul className="-mx-2.5 flex max-h-72 flex-col gap-px overflow-y-auto">
            {all.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  aria-current={project.id === thread.projectId ? 'true' : undefined}
                  onClick={() => move(project.id)}
                  className={CHOICE}
                >
                  <span className="inline-flex size-5.5 shrink-0 items-center justify-center">
                    <Mark id={project.id} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {project.id === thread.projectId && <Check className="size-3.5 text-ink-2" />}
                </button>
              </li>
            ))}
            <li>
              <button type="button" onClick={() => setCreating(true)} className={CHOICE}>
                <span className="inline-flex size-5.5 shrink-0 items-center justify-center">
                  <Plus className="size-4" strokeWidth={1.6} />
                </span>
                <span className="min-w-0 flex-1 truncate">New project</span>
              </button>
            </li>
          </ul>
          {thread.projectId !== null && (
            <div className="-mx-2.5 mt-2 border-t border-line-1 pt-2">
              <button type="button" onClick={() => move(null)} className={CHOICE}>
                <span className="min-w-0 flex-1 truncate pl-8">Remove from project</span>
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
