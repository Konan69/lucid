import { ThreadId, type ProjectId, type Thread } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { FolderKanban, Plus, SquarePen } from 'lucide-react-native'
import { projects } from '@vivid/state'
import { useNow } from '../data/foreground'
import { commit } from '../data/haptics'
import { relativeTime } from '../data/lanes'
import { LiveState, useLive, useLiveData, useLiveValue } from '../data/live'
import { UNTITLED } from '../data/threads'
import { useTheme } from '../theme'
import { Header, Screen } from '../ui/Header'
import { Row, Section } from '../ui/List'
import { Live } from '../ui/Live'
import { NameSheet } from '../ui/Sheet'
import { Button, Dot, Empty, IconButton, Label, Notice, Skeleton, styles } from '../ui/ui'
import { useGo, type Routes } from '../workspace'

/** A Project as the server describes it; the screen below is also called `Project`. */
type ProjectRecord = projects.Project

/** A Project's row: its name, how many Threads are filed in it, and that it goes somewhere. */
function ProjectRow({ project }: { project: ProjectRecord }) {
  const go = useGo()
  const { colors: c } = useTheme()
  return (
    <Row
      leading={<FolderKanban size={20} strokeWidth={1.6} color={c['ink-2']} />}
      title={project.name}
      detail={projects.countThreads(project.threadCount)}
      onPress={() => go.push('Project', { id: project.id })}
    />
  )
}

/**
 * Asks for a new Project's name. `parent` is the Project it will sit inside, or nothing for the
 * top level. The Project the server returns is shown at once, as a change already accepted, so
 * the list does not wait on the live query's next result.
 */
function Create({ parent, onClose }: { parent: ProjectId | null; onClose: () => void }) {
  const data = useLiveData()
  return (
    <NameSheet
      title="New project"
      detail="A place to file threads that belong together."
      label="Name"
      initial=""
      placeholder="Office move"
      action="Create project"
      maxLength={80}
      onClose={onClose}
      onSave={async (name) => {
        const result = await data.change((client) =>
          client.CreateProject({ name, parentProjectId: parent }),
        )
        if (Result.isFailure(result)) return Option.some(result.failure.message)
        commit()
        data.live.projects.expect(projects.confirmed(result.success))(true)
        return Option.none()
      }}
    />
  )
}

/** Projects: where work is filed. The top level; each Project opens as its own screen. */
export function Projects() {
  const data = useLiveData()
  const go = useGo()
  const list = useLive(data.live.projects)
  const [creating, setCreating] = useState(false)
  return (
    <Screen>
      <Header
        title="Projects"
        subtitle="Threads that belong together."
        onBack={go.goBack}
        trailing={<IconButton icon={Plus} label="New project" onPress={() => setCreating(true)} />}
      />
      <ScrollView contentContainerStyle={[styles.page, styles.column]}>
        <Live state={list} loading={<Skeleton rows={4} />}>
          {(value) => {
            const top = projects.projectsIn(value.projects, null)
            return top.length === 0 ? (
              <Empty
                title="No projects yet"
                detail="Make one for anything with more than one thread: a launch, a client, a move."
              >
                <Button icon={Plus} label="New project" onPress={() => setCreating(true)} />
              </Empty>
            ) : (
              <Section title="All projects">
                {top.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </Section>
            )
          }}
        </Live>
      </ScrollView>
      {creating && <Create parent={null} onClose={() => setCreating(false)} />}
    </Screen>
  )
}

/**
 * One Project: the Projects inside it and the Threads filed in it. Both are read live, so a
 * Thread someone else files here appears without a refresh. A Project the Person can no longer
 * see says so instead of drawing an empty page under a stale name.
 */
export function Project({ route }: NativeStackScreenProps<Routes, 'Project'>) {
  const data = useLiveData()
  const go = useGo()
  const list = useLive(data.live.projects)
  const { id } = route.params
  const project = LiveState.$is('Ready')(list)
    ? projects.findProject(list.value.projects, id)
    : Option.none<ProjectRecord>()
  const gone = LiveState.$is('Ready')(list) && Option.isNone(project)
  return (
    <Screen>
      <Header
        title={Option.match(project, { onNone: () => 'Project', onSome: (value) => value.name })}
        onBack={go.goBack}
      />
      <ScrollView contentContainerStyle={[styles.page, styles.column]}>
        {gone && (
          <Empty
            title="This project is not here"
            detail="It may be in a space you are not working in right now."
          />
        )}
        <Live state={list} loading={<Skeleton rows={4} />}>
          {(value) =>
            Option.isSome(project) ? <Inside project={project.value} all={value.projects} /> : null
          }
        </Live>
      </ScrollView>
    </Screen>
  )
}

/** What is in a Project: a way to start a Thread here, the Projects inside, and its Threads. */
function Inside({ project, all }: { project: ProjectRecord; all: ReadonlyArray<ProjectRecord> }) {
  const data = useLiveData()
  const go = useGo()
  const threads = useLiveValue(data.live.threads)
  const [creating, setCreating] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const inside = projects.projectsIn(all, project.id)
  const filed = Option.match(threads, {
    onNone: (): ReadonlyArray<Thread> => [],
    onSome: (value) => projects.threadsIn(value, project.id),
  })
  const hidden = projects.hiddenThreads(project, filed)

  /** Opens an empty Thread filed here; its first message gives it its name. */
  async function begin() {
    commit()
    const id = ThreadId.make(randomUUID())
    const result = await data.change((client) =>
      client.CreateThread({ id, title: UNTITLED, projectId: project.id }),
    )
    if (Result.isFailure(result)) {
      setRefused(Option.some(result.failure.message))
      return
    }
    go.navigate('Chat', { id })
  }

  return (
    <>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <View style={styles.wrap}>
        <Button
          kind="primary"
          icon={SquarePen}
          label="New thread here"
          onPress={() => void begin()}
        />
        <Button icon={Plus} label="Project inside" onPress={() => setCreating(true)} />
      </View>
      {inside.length > 0 && (
        <Section title="Projects inside">
          {inside.map((child) => (
            <ProjectRow key={child.id} project={child} />
          ))}
        </Section>
      )}
      <Filed threads={filed} hidden={hidden} />
      {creating && <Create parent={project.id} onClose={() => setCreating(false)} />}
    </>
  )
}

/** The Threads filed in a Project that this Person can open, and a count of the ones they cannot. */
function Filed({ threads, hidden }: { threads: ReadonlyArray<Thread>; hidden: number }) {
  const go = useGo()
  const now = useNow()
  if (threads.length === 0 && hidden === 0) {
    return (
      <Label size="label" tone="ink-3">
        No threads are filed here yet.
      </Label>
    )
  }
  return (
    <View style={{ gap: 8 }}>
      {threads.length > 0 && (
        <Section title="Threads">
          {threads.map((thread) => (
            <Row
              key={thread.id}
              leading={<Dot tone={thread.attention === 'Unread' ? 'accent' : 'line-4'} />}
              title={thread.title}
              detail={thread.preview.length > 0 ? thread.preview : undefined}
              trailing={
                <Label size="caption" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
                  {relativeTime(thread.updatedAt, now)}
                </Label>
              }
              onPress={() => go.navigate('Chat', { id: thread.id })}
            />
          ))}
        </Section>
      )}
      {hidden > 0 && (
        <Label size="caption" tone="ink-3" style={{ paddingHorizontal: 4 }}>
          {`${projects.countThreads(hidden)} here ${hidden === 1 ? 'is' : 'are'} private to other people.`}
        </Label>
      )}
    </View>
  )
}
