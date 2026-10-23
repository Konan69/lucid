import type { ProjectId, Thread } from '@vivid/contracts'
import { Effect, Option, Result } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import { Check, Plus } from 'lucide-react-native'
import { confirm } from '../../data/haptics'
import { projects } from '@vivid/state'
import { useLive, useLiveData } from '../../data/live'
import { patchThread } from '../../data/threads'
import { useTheme } from '../../theme'
import { Row, Section } from '../../ui/List'
import { Live } from '../../ui/Live'
import { Sheet } from '../../ui/Sheet'
import { Notice, Skeleton } from '../../ui/ui'
import { CreateProject } from '../project/Create'
import { Mark } from '../project/Mark'
import { start } from '../../data/app'

/**
 * "Move to a project", from the Thread's own menu: pick one of the Person's Projects, make a new
 * one and file the Thread in it, or take the Thread out of the Project it is in. Every Project
 * the Person can see is listed by name with its colour, and the one the Thread is in is marked.
 * Choosing is a single change to the Thread, shown at once in the list behind.
 */
export function Filing({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const list = useLive(data.live.projects)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const [creating, setCreating] = useState(false)

  function file(projectId: ProjectId | null) {
    return start(
      Effect.gen(function* () {
        const result = yield* patchThread(data, thread.id, { projectId })
        if (Result.isFailure(result)) {
          setRefused(Option.some('That thread could not be moved just now. Try again.'))
          return
        }
        confirm()
        onClose()
      }),
    )
  }

  if (creating) {
    // The new Project takes the Thread at once; the name sheet closes itself after `onMade`.
    return (
      <CreateProject
        inside={null}
        onMade={(project) => void start(patchThread(data, thread.id, { projectId: project.id }))}
        onClose={onClose}
      />
    )
  }

  return (
    <Sheet title="Move to a project" detail={thread.title} onClose={onClose}>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Live state={list} loading={<Skeleton rows={3} />}>
        {(value) => (
          <Section title="Projects">
            {projects.byName(value.projects).map((project) => (
              <Row
                key={project.id}
                leading={<Mark id={project.id} />}
                title={project.name}
                trailing={
                  // An empty box keeps every name ending at the same edge, marked or not.
                  <View style={{ width: 20, alignItems: 'center' }}>
                    {project.id === thread.projectId && (
                      <Check
                        accessibilityLabel="Current"
                        size={18}
                        strokeWidth={2}
                        color={c.primary}
                      />
                    )}
                  </View>
                }
                onPress={() => void file(project.id)}
              />
            ))}
            <Row
              leading={<Plus size={18} strokeWidth={1.7} color={c['foreground-secondary']} />}
              title="New project"
              trailing={null}
              onPress={() => setCreating(true)}
            />
          </Section>
        )}
      </Live>
      {thread.projectId !== null && (
        <Section title="Or">
          <Row title="Remove from its project" trailing={null} onPress={() => void file(null)} />
        </Section>
      )}
    </Sheet>
  )
}
