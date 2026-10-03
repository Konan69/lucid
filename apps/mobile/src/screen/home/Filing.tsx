import type { ProjectId, Thread } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import { Check } from 'lucide-react-native'
import { confirm } from '../../data/haptics'
import { useLive, useLiveData } from '../../data/live'
import { patchThread } from '../../data/threads'
import { useTheme } from '../../theme'
import { Row, Section } from '../../ui/List'
import { Live } from '../../ui/Live'
import { Sheet } from '../../ui/Sheet'
import { Empty, Notice, Skeleton } from '../../ui/ui'

/**
 * Files a Thread in a Project, from the Thread's own menu. It lists every Project the Person can
 * see by name, marks the one the Thread is in, and offers the way back out of it. Choosing one is
 * a single change to the Thread, shown at once in the list behind.
 *
 * A Project is made on the Projects screen, not here: this sheet is about one Thread.
 */
export function Filing({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const list = useLive(data.live.projects)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  async function file(projectId: ProjectId | null) {
    const result = await patchThread(data, thread.id, { projectId })
    if (Result.isFailure(result)) {
      setRefused(Option.some('That thread could not be moved just now. Try again.'))
      return
    }
    confirm()
    onClose()
  }

  return (
    <Sheet title="Add to a project" detail={thread.title} onClose={onClose}>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Live state={list} loading={<Skeleton rows={3} />}>
        {(value) =>
          value.projects.length === 0 ? (
            <Empty line="You have no projects yet." />
          ) : (
            <Section title="Projects">
              {value.projects.map((project) => (
                <Row
                  key={project.id}
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
            </Section>
          )
        }
      </Live>
      {thread.projectId !== null && (
        <Section title="Or">
          <Row title="Take it out of its project" trailing={null} onPress={() => void file(null)} />
        </Section>
      )}
    </Sheet>
  )
}
