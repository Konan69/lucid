import { ThreadId, type Thread } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { FolderKanban, FolderSearch, Plus, SquarePen } from 'lucide-react-native'
import { projects } from '@vivid/state'
import { useNow } from '../data/foreground'
import { commit } from '../data/haptics'
import { relativeTime } from '../data/lanes'
import { LiveState, useLive, useLiveData, useLiveValue } from '../data/live'
import { UNTITLED } from '../data/threads'
import { Avatar } from '../ui/Avatar'
import { Bar } from '../ui/Bar'
import { Screen } from '../ui/Screen'
import { Row, Section } from '../ui/List'
import { Live } from '../ui/Live'
import { Button, Empty, Label, Notice, Skeleton, styles } from '../ui/ui'
import { useGo, useOpenThread, type Routes } from '../workspace'
import { CreateProject } from './project/Create'
import { Mark } from './project/Mark'
import { scope } from './project/scope'

/** A Project as the server describes it; the screen below is also called `Project`. */
type ProjectRecord = projects.Project

/** A Project's row: its colour, its name, what is in it, and how many Threads wait on the Person. */
function ProjectRow({ project, needing }: { project: ProjectRecord; needing: number }) {
  const go = useGo()
  return (
    <Row
      leading={<Mark id={project.id} />}
      title={project.name}
      detail={projects.countThreads(project.threadCount).toLowerCase()}
      trailing={
        needing > 0 ? (
          <Label
            size="label"
            tone="status-attention"
            accessibilityLabel={`${needing} waiting for you`}
            style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}
          >
            {needing}
          </Label>
        ) : undefined
      }
      onPress={() => {
        // Going to a Project is scoping to it, wherever it is opened from.
        scope.enter(project.id)
        go.push('Project', { id: project.id })
      }}
    />
  )
}

/**
 * Every top-level Project, by name. It is reached from the drawer when there are more Projects
 * than its group shows; with none it is one sentence and the way to make the first.
 */
export function Projects() {
  const data = useLiveData()
  const go = useGo()
  const list = useLive(data.live.projects)
  const threads = useLiveValue(data.live.threads)
  const mine = Option.match(threads, {
    onNone: (): ReadonlyArray<Thread> => [],
    onSome: (value) => value.threads,
  })
  const [creating, setCreating] = useState(false)
  return (
    <Screen>
      <Bar
        title="Projects"
        actions={[
          {
            symbol: 'plus',
            icon: Plus,
            label: 'New project',
            disabled: false,
            onPress: () => setCreating(true),
          },
        ]}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column]}
      >
        <Live state={list} loading={<Skeleton rows={4} />}>
          {(value) => {
            const top = projects.projectsIn(value.projects, null)
            return top.length === 0 ? (
              <Empty
                icon={FolderKanban}
                title="No projects yet"
                line="A project keeps the threads about one piece of work together."
                room="page"
              >
                <Button
                  kind="primary"
                  icon={Plus}
                  label="New project"
                  onPress={() => setCreating(true)}
                />
              </Empty>
            ) : (
              <Section title="All projects">
                {top.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    needing={projects.needingYou(mine, project.id)}
                  />
                ))}
              </Section>
            )
          }}
        </Live>
      </ScrollView>
      {creating && (
        <CreateProject
          inside={null}
          onMade={(project) => {
            scope.enter(project.id)
            go.push('Project', { id: project.id })
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </Screen>
  )
}

/**
 * One Project's page: which one it is (its colour and name), what is known about it, then its
 * Threads with their live state, the Projects inside it and, in a Company, the people in its
 * Threads. All of it is read live, so a Thread someone else files here appears without a
 * refresh. It says nothing the server does not: a Project has no purpose line, no "where it
 * stands", no next step and no files of its own yet, so none is drawn. A Project the Person can
 * no longer see says so instead of drawing an empty page under a stale name.
 */
export function Project({ route }: NativeStackScreenProps<Routes, 'Project'>) {
  const data = useLiveData()
  const list = useLive(data.live.projects)
  const { id } = route.params
  const project = LiveState.$is('Ready')(list)
    ? projects.findProject(list.value.projects, id)
    : Option.none<ProjectRecord>()
  const gone = LiveState.$is('Ready')(list) && Option.isNone(project)
  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column]}
      >
        {gone && (
          <Empty
            icon={FolderSearch}
            title="This project is not here"
            line="It may be in a space you are not working in right now."
            room="page"
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

/** What a Thread's row says at its end: that it is waiting or being worked on, or when it moved. */
function Standing({ thread, now }: { thread: Thread; now: number }) {
  if (thread.attention === 'NeedsYou') {
    return (
      <Label size="caption" tone="status-attention" style={{ fontWeight: '600' }}>
        Needs you
      </Label>
    )
  }
  if (thread.attention === 'Working') {
    return (
      <Label size="caption" tone="status-working" style={{ fontWeight: '600' }}>
        Working
      </Label>
    )
  }
  return (
    <Label size="caption" tone="ink-2" style={{ fontVariant: ['tabular-nums'] }}>
      {relativeTime(thread.updatedAt, now)}
    </Label>
  )
}

/** The Threads filed in a Project that this Person can open, and a count of the ones they cannot. */
function Filed({
  threads,
  hidden,
  now,
}: {
  threads: ReadonlyArray<Thread>
  hidden: number
  now: number
}) {
  const openThread = useOpenThread()
  if (threads.length === 0 && hidden === 0) {
    return (
      <Label size="label" tone="ink-2">
        No threads here yet. Start one and it is filed in this project.
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
              title={thread.title}
              detail={thread.preview.length > 0 ? thread.preview : undefined}
              trailing={<Standing thread={thread} now={now} />}
              onPress={() => openThread(thread.id)}
            />
          ))}
        </Section>
      )}
      {hidden > 0 && (
        <Label size="caption" tone="ink-2" style={{ paddingHorizontal: 4 }}>
          {hidden === 1
            ? '1 more thread here is not shared with you.'
            : `${hidden} more threads here are not shared with you.`}
        </Label>
      )}
    </View>
  )
}

/** Everything on a Project's page under the bar. */
function Inside({ project, all }: { project: ProjectRecord; all: ReadonlyArray<ProjectRecord> }) {
  const data = useLiveData()
  const go = useGo()
  const openThread = useOpenThread()
  const now = useNow()
  const threads = useLiveValue(data.live.threads)
  const [creating, setCreating] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const inside = projects.projectsIn(all, project.id)
  const mine = Option.match(threads, {
    onNone: (): ReadonlyArray<Thread> => [],
    onSome: (value) => value.threads,
  })
  const filed = projects.threadsIn({ threads: mine }, project.id)
  const hidden = projects.hiddenThreads(project, filed)
  const needing = projects.needingYou(mine, project.id)
  const people = project.companyId === null ? [] : projects.peopleIn(filed)

  /** Opens an empty Thread filed here; its first message gives it its name. */
  async function begin() {
    commit()
    scope.enter(project.id)
    const id = ThreadId.make(randomUUID())
    const result = await data.change((client) =>
      client.CreateThread({ id, title: UNTITLED, projectId: project.id }),
    )
    if (Result.isFailure(result)) {
      setRefused(Option.some('Unable to start a thread here. Check your connection and try again.'))
      return
    }
    openThread(id)
  }

  return (
    <>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Mark id={project.id} size={16} />
          <Label accessibilityRole="header" size="title" style={{ flex: 1 }}>
            {project.name}
          </Label>
        </View>
        <Label size="label" tone="ink-2">
          {projects.countThreads(project.threadCount).toLowerCase()}
          {needing > 0 && (
            <Label size="label" tone="status-attention" style={{ fontWeight: '600' }}>
              {` · ${needing} ${needing === 1 ? 'needs' : 'need'} you`}
            </Label>
          )}
          {` · moved ${relativeTime(project.updatedAt, now)}`}
        </Label>
      </View>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <View style={styles.wrap}>
        <Button kind="primary" icon={SquarePen} label="New thread" onPress={() => void begin()} />
        <Button icon={Plus} label="Project inside" onPress={() => setCreating(true)} />
      </View>
      <Filed threads={filed} hidden={hidden} now={now} />
      {inside.length > 0 && (
        <Section title="Inside this project">
          {inside.map((child) => (
            <ProjectRow
              key={child.id}
              project={child}
              needing={projects.needingYou(mine, child.id)}
            />
          ))}
        </Section>
      )}
      {people.length > 0 && (
        // A Project has no members of its own on the server, so this is the people the Person
        // can see in its Threads, and it is titled as that.
        <Section title="People in these threads">
          {people.map((person) => (
            <Row
              key={person.id}
              leading={<Avatar name={person.name} image={person.image} size={28} />}
              title={person.name}
            />
          ))}
        </Section>
      )}
      {creating && (
        <CreateProject
          inside={project.id}
          onMade={(made) => {
            scope.enter(made.id)
            go.push('Project', { id: made.id })
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  )
}
