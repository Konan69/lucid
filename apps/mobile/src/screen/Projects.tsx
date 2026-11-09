import { ProjectEvidence, ProjectWork, ThreadId, type Thread } from '@vivid/contracts'
import { Effect, Option, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import {
  Check,
  FolderKanban,
  FolderSearch,
  Plus,
  RotateCcw,
  SquarePen,
  Target,
} from 'lucide-react-native'
import { goal, projects } from '@vivid/state'
import { useNow } from '../data/foreground'
import { useTheme } from '../theme'
import { openGoal, useGoal } from '../data/goal'
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
import { GoalSheet } from './project/Goal'
import { Mark } from './project/Mark'
import { scope } from './project/scope'
import { start } from '../data/app'

/** A Project as the server describes it; the screen below is also called `Project`. */
type ProjectRecord = projects.Project

/** A Project's row: its colour, its name, what is in it, and how many Threads wait on the Person. */
function ProjectRow({ project, needing }: { project: ProjectRecord; needing: number }) {
  const go = useGo()
  return (
    <Row
      leading={<Mark id={project.id} />}
      title={project.name}
      detail={
        ProjectWork.guards.Completed(project.work)
          ? `Done · ${projects.countThreads(project.threadCount).toLowerCase()}`
          : projects.countThreads(project.threadCount).toLowerCase()
      }
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
 * One Project's page: which one it is (its colour and name), what is known about it, where its
 * work stands, then its Threads with their live state, the Projects inside it and, in a Company,
 * the people in its Threads. All of it is read live, so a Thread someone else files here appears
 * without a refresh. A Project the Person can no longer see says so instead of
 * drawing an empty page under a stale name.
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
            title="Project not found"
            line="It may belong to another space."
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
        No threads yet. Threads you start here are filed in this project.
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

/**
 * Where the Project's work stands: what done means, the next step and the dated progress, or that
 * it is done and what shows it. Vivid records it from the conversation; the Person sets the goal,
 * corrects it (pressing the goal), marks it done or reopens it here (`project/Goal.tsx`). A
 * Project that only groups Threads offers to set a goal and invents none. Proof from a Thread
 * opens that Thread.
 */
function Work({ project, now }: { project: ProjectRecord; now: number }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const openThread = useOpenThread()
  const reading = useGoal()
  const form = goal.formFor(reading, project.id)
  const edit = () => openGoal(data, project.id, 'Goal')
  const stands = ProjectWork.match(project.work, {
    Unspecified: () => (
      <Section title="Goal">
        <Row
          wrap
          leading={<Target size={18} color={c.primary} strokeWidth={1.75} />}
          title="Set a goal"
          detail="Say what done looks like, and Vivid keeps track of where it stands."
          onPress={edit}
        />
      </Section>
    ),
    Active: (work) => (
      <View style={{ gap: 12 }}>
        <Section title="Where it stands">
          <Row wrap title={work.objective} detail="Goal" onPress={edit} />
          <Row wrap title={work.nextStep} detail="Next" />
        </Section>
        <View style={styles.wrap}>
          <Button
            icon={Check}
            label="Mark done"
            onPress={() => openGoal(data, project.id, 'Done')}
          />
        </View>
      </View>
    ),
    Completed: (work) => {
      const [source] = work.proof.sources
      const when = `Done · ${relativeTime(work.completedAt, now)}`
      return (
        <View style={{ gap: 12 }}>
          <Section title="Where it stands">
            <Row wrap title={work.objective} detail="Goal" />
            {ProjectEvidence.match(source, {
              ThreadMessage: ({ threadId }) => (
                <Row
                  wrap
                  title={work.proof.summary}
                  detail={`${when} · see the message`}
                  onPress={() => openThread(threadId)}
                />
              ),
              Person: () => <Row wrap title={work.proof.summary} detail={when} />,
            })}
          </Section>
          <View style={styles.wrap}>
            <Button icon={RotateCcw} label="Reopen" onPress={edit} />
          </View>
        </View>
      )
    },
  })
  return (
    <>
      {stands}
      <Progress project={project} now={now} />
      {Option.isSome(form) && <GoalSheet project={project} form={form.value} reading={reading} />}
    </>
  )
}

/** How many lines of progress the page shows before the Person asks for the rest. */
const PROGRESS_SHOWN = 5

/**
 * The Project's dated progress, newest first: each line Vivid recorded as the work moved. The
 * latest few show; the rest open on request, so a long-running Project does not bury its Threads.
 */
function Progress({ project, now }: { project: ProjectRecord; now: number }) {
  const [all, setAll] = useState(false)
  const lines = projects.progressOf(project)
  if (lines.length === 0) return null
  const shown = all ? lines : lines.slice(0, PROGRESS_SHOWN)
  return (
    <View style={{ gap: 4 }}>
      <Section title="Progress">
        {shown.map((line) => (
          <Row
            key={`${line.at}-${line.text}`}
            wrap
            title={line.text}
            detail={relativeTime(line.at, now)}
          />
        ))}
      </Section>
      {lines.length > PROGRESS_SHOWN && (
        <View style={styles.wrap}>
          <Button
            kind="ghost"
            label={all ? 'Show fewer' : `Show all ${lines.length} updates`}
            onPress={() => setAll(!all)}
          />
        </View>
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
  function begin() {
    return start(
      Effect.gen(function* () {
        commit()
        scope.enter(project.id)
        const id = ThreadId.make(randomUUID())
        const result = yield* data.changing((client) =>
          client.CreateThread({ id, title: UNTITLED, projectId: project.id }),
        )
        if (Result.isFailure(result)) {
          setRefused(
            Option.some('Unable to start a thread here. Check your connection and try again.'),
          )
          return
        }
        openThread(id)
      }),
    )
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
        <Button icon={Plus} label="New project inside" onPress={() => setCreating(true)} />
      </View>
      <Work project={project} now={now} />
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
