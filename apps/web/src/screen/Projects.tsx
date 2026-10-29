import {
  ProjectWork,
  type Project,
  type ProjectId,
  type Thread,
  type ThreadId,
} from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { Option } from 'effect'
import { ChevronRight, Plus, SquarePen } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { live, LiveState, useLive } from '../data/live'
import { router } from '../router'
import { scope } from '../data/scope'
import { PersonAvatar } from '../ui/Person'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'
import { Live } from '../ui/Live'
import { Alert } from '../ui/alert'
import { SkeletonList } from '../ui/skeleton'
import { StatusLabel } from '../ui/Status'
import { BAR } from './bar'
import { CreateProject } from './project/Create'
import { Mark } from './project/Mark'
import { relativeTime } from './sidebar/Threads'

/**
 * Projects: one Project's own page, or the list of all of them.
 *
 * A Project is a piece of work with Threads in it. Its page says which one it is (its colour and
 * name), what is known about it (how many Threads, how many are waiting on the Person, when it
 * last moved), where its work stands when Vivid has recorded it (what done means, the latest
 * dated progress and the next step, or that it is done and what shows it), and then lists its
 * Threads with their live state, the Projects inside it and, in a Company, the people in its
 * Threads. It says nothing the server does not: a Project that only groups Threads draws no goal.
 *
 * Everything comes from `live.projects` and `live.threads`. Which Project is open belongs to the
 * address (`open`), so the sidebar can link to one and the back button leaves it.
 */
export function Projects({
  open: openId,
  onOpen,
  onOpenThread,
}: {
  open: Option.Option<ProjectId>
  onOpen: (open: Option.Option<ProjectId>) => void
  onOpenThread: (id: ThreadId) => void
}) {
  const state = useLive(live.projects)
  /** Opening a Project is scoping to it, wherever it was opened from. */
  const open = (id: ProjectId) => {
    scope.enter(id)
    onOpen(Option.some(id))
  }
  const shelf = () => onOpen(Option.none())

  return LiveState.$match(state, {
    Loading: () => (
      <Pane bar={<Crumb onClick={shelf}>Projects</Crumb>}>
        <SkeletonList of="row" count={4} />
      </Pane>
    ),
    Failed: ({ failure }) => (
      <Pane bar={<Crumb onClick={shelf}>Projects</Crumb>}>
        <Alert variant="destructive">{failure.message}</Alert>
      </Pane>
    ),
    Ready: ({ value }) =>
      // A Project open here can be gone from this workspace; its page then gives way to the list.
      Option.match(
        Option.flatMap(openId, (id) => projectsData.findProject(value.projects, id)),
        {
          onNone: () => <Shelf projects={value.projects} onOpen={open} />,
          onSome: (project) => (
            <ProjectPage
              // A different Project is a different page: nothing half-open carries over.
              key={project.id}
              project={project}
              projects={value.projects}
              onOpen={open}
              onShelf={shelf}
              onOpenThread={onOpenThread}
            />
          ),
        },
      ),
  })
}

/** The screen's frame: the bar, and a scrolling body at the width every list screen uses. */
function Pane({ bar, children }: { bar: ReactNode; children: ReactNode }) {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <header className={BAR}>
        <nav className="flex min-w-0 flex-1 items-center gap-1 text-title">{bar}</nav>
      </header>
      <div className="min-h-0 flex-1 scroll-fade-y overflow-y-auto">
        <div className="mx-auto w-full max-w-180 px-5 pt-4 pb-12 sm:px-8">{children}</div>
      </div>
    </section>
  )
}

/** One step of the way back up, in the bar: the list of Projects, or a Project above this one. */
function Crumb({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer truncate rounded-xs font-title text-ink-3 transition-colors duration-(--dur-fast) hover:text-ink"
    >
      {children}
    </button>
  )
}

/** A list on the page: one raised surface with an edge, its rows parted by hairlines. */
const LIST = 'overflow-hidden rounded-card bg-surface-2 edge divide-y divide-line-1'
/** A row of such a list that goes somewhere. */
const LINK =
  'flex w-full cursor-pointer items-center gap-3 px-4 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover focus-visible:-outline-offset-2'

// ── Every Project ────────────────────────────────────────────────────────────

/**
 * Every top-level Project, by name. It is reached from the sidebar when there are more Projects
 * than its group shows; with none it is one sentence and the way to make the first, not a picture.
 */
function Shelf({
  projects,
  onOpen,
}: {
  projects: ReadonlyArray<Project>
  onOpen: (id: ProjectId) => void
}) {
  const [creating, setCreating] = useState(false)
  const threads = useLive(live.threads)
  const top = projectsData.projectsIn(projects, null)
  const mine = LiveState.$is('Ready')(threads) ? threads.value.threads : []
  return (
    <Pane bar={<h1 className="truncate font-title text-ink">Projects</h1>}>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-label font-meta text-pretty text-ink-3">
          A project keeps the threads about one piece of work together.
        </p>
        <Button variant="outline" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          New project
        </Button>
      </div>
      {top.length > 0 && (
        <ul className={cn(LIST, 'mt-4')}>
          {top.map((project) => (
            <li key={project.id} className="motion-enter">
              <ProjectLine
                project={project}
                needing={projectsData.needingYou(mine, project.id)}
                onOpen={() => onOpen(project.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <CreateProject
          inside={null}
          onMade={(project) => onOpen(project.id)}
          onClose={() => setCreating(false)}
        />
      )}
    </Pane>
  )
}

/** One Project in a list on the page: its colour, its name, what is in it, what is waiting. */
function ProjectLine({
  project,
  needing,
  onOpen,
}: {
  project: Project
  needing: number
  onOpen: () => void
}) {
  return (
    <button type="button" onClick={onOpen} className={cn(LINK, 'group/line h-12')}>
      <Mark id={project.id} />
      <span className="min-w-0 flex-1 truncate text-label text-ink">{project.name}</span>
      {needing > 0 && <StatusLabel status="attention">{` · ${needing}`}</StatusLabel>}
      <span className="text-meta font-meta text-ink-3 tabular-nums">
        {projectsData.countThreads(project.threadCount).toLowerCase()}
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-ink-4 transition-transform duration-(--dur-fast) group-hover/line:translate-x-0.5" />
    </button>
  )
}

// ── One Project ──────────────────────────────────────────────────────────────

/**
 * One Project's page. The bar holds the way back up; the head says which Project this is and
 * what is known about it; then its Threads, the Projects inside it and the people in it.
 */
function ProjectPage({
  project,
  projects,
  onOpen,
  onShelf,
  onOpenThread,
}: {
  project: Project
  projects: ReadonlyArray<Project>
  onOpen: (id: ProjectId) => void
  onShelf: () => void
  onOpenThread: (id: ThreadId) => void
}) {
  const [creating, setCreating] = useState(false)
  const threads = useLive(live.threads)
  const inside = projectsData.projectsIn(projects, project.id)
  const mine = LiveState.$is('Ready')(threads) ? threads.value.threads : []
  return (
    <Pane
      bar={
        <>
          <Crumb onClick={onShelf}>Projects</Crumb>
          {projectsData.trailTo(projects, project).map((above) => (
            <span key={above.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3.5 shrink-0 text-ink-4" />
              <Crumb onClick={() => onOpen(above.id)}>{above.name}</Crumb>
            </span>
          ))}
        </>
      }
    >
      <header className="flex items-start gap-3">
        {/* Dropped to the middle of the name's first line, whatever the name wraps to. */}
        <Mark id={project.id} size="page" className="mt-2" />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-page font-strong text-balance wrap-anywhere text-ink">
            {project.name}
          </h1>
          <p className="mt-1.5 text-label font-meta text-ink-3">
            <Standing project={project} needing={projectsData.needingYou(mine, project.id)} />
          </p>
        </div>
        <Button
          onClick={() => {
            // The first screen files what is written there in the scoped Project.
            scope.enter(project.id)
            void router.navigate({ to: '/' })
          }}
        >
          <SquarePen className="size-3.5" />
          New thread
        </Button>
      </header>

      <Work project={project} onOpenThread={onOpenThread} />

      <Part title="Threads">
        <Live state={threads} loading={<SkeletonList of="row" count={3} />}>
          {(list) => (
            <ProjectThreads project={project} list={list.threads} onOpenThread={onOpenThread} />
          )}
        </Live>
      </Part>

      {inside.length > 0 && (
        <Part title="Inside this project">
          <ul className={LIST}>
            {inside.map((child) => (
              <li key={child.id}>
                <ProjectLine
                  project={child}
                  needing={projectsData.needingYou(mine, child.id)}
                  onOpen={() => onOpen(child.id)}
                />
              </li>
            ))}
          </ul>
        </Part>
      )}

      {project.companyId !== null && <People threads={mine} project={project} />}

      {/* The quiet way to split this work up, last on the page: most Projects never need it. */}
      {/* The negative margin takes back the button's own padding less the page's 4px inset, so
          its mark stands on the same left line as the lists above it. */}
      <Button variant="ghost" onClick={() => setCreating(true)} className="mt-6 -ml-2">
        <Plus strokeWidth={1.6} />
        New project inside this one
      </Button>

      {creating && (
        <CreateProject
          inside={project.id}
          onMade={(made) => onOpen(made.id)}
          onClose={() => setCreating(false)}
        />
      )}
    </Pane>
  )
}

/** What is known about a Project, in one line: its Threads, what is waiting, when it last moved. */
function Standing({ project, needing }: { project: Project; needing: number }) {
  // Read once when the page opens: what day the Project moved does not need to tick.
  const [now] = useState(() => Date.now())
  return (
    <>
      {project.threadCount === 0
        ? 'No threads yet'
        : projectsData.countThreads(project.threadCount).toLowerCase()}
      {needing > 0 && (
        <>
          {' · '}
          <span className="font-title text-attention">
            {needing} {needing === 1 ? 'needs' : 'need'} you
          </span>
        </>
      )}
      {' · '}
      <time>moved {relativeTime(project.updatedAt, now)}</time>
    </>
  )
}

/**
 * Where the Project's work stands, as Vivid recorded it from the conversation; there is no form
 * for it. A Project that only groups Threads draws nothing here. The proof of a finished Project
 * is a message in a Thread, so its link opens that Thread; a Member it is not shared with is
 * refused there like at any Thread link.
 */
function Work({
  project,
  onOpenThread,
}: {
  project: Project
  onOpenThread: (id: ThreadId) => void
}) {
  // Read once when the page opens: how long ago progress was made does not need to tick.
  const [now] = useState(() => Date.now())
  return ProjectWork.match(project.work, {
    Unspecified: () => null,
    Active: (work) => {
      const latest = work.progress.at(-1)
      return (
        <Part title="Where it stands">
          <dl className={LIST}>
            <Fact term="Goal">{work.objective}</Fact>
            {latest !== undefined && (
              <Fact term="Latest">
                {latest.text}
                <time className="ml-2 text-meta font-meta text-ink-3 tabular-nums">
                  {relativeTime(latest.at, now)}
                </time>
              </Fact>
            )}
            <Fact term="Next">{work.nextStep}</Fact>
          </dl>
        </Part>
      )
    },
    Completed: (work) => {
      const [source] = work.proof.sources
      return (
        <Part title="Where it stands">
          <dl className={LIST}>
            <Fact term="Goal">{work.objective}</Fact>
            <Fact term="Done">
              {work.proof.summary}
              <time className="ml-2 text-meta font-meta text-ink-3 tabular-nums">
                {relativeTime(work.completedAt, now)}
              </time>
              <span className="mt-1 block">
                <Button variant="link" size="xs" onClick={() => onOpenThread(source.threadId)}>
                  See the message
                </Button>
              </span>
            </Fact>
          </dl>
        </Part>
      )
    },
  })
}

/** One line of a Project's work: what it is, then what Vivid recorded. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 px-4 py-2.5">
      <dt className="w-14 shrink-0 text-meta font-title text-ink-3">{term}</dt>
      <dd className="min-w-0 flex-1 text-label text-pretty wrap-anywhere text-ink">{children}</dd>
    </div>
  )
}

/** A titled part of a Project's page. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 flex h-7 items-center px-1 text-meta font-title text-ink-3">{title}</h2>
      {children}
    </section>
  )
}

/**
 * The Threads filed in a Project that the Person can open, newest first, each with its live
 * state. A Project also counts Threads the Person is not in; those are counted and never listed.
 */
function ProjectThreads({
  project,
  list,
  onOpenThread,
}: {
  project: Project
  list: ReadonlyArray<Thread>
  onOpenThread: (id: ThreadId) => void
}) {
  // Read once when the page opens: what day a Thread moved does not need to tick.
  const [now] = useState(() => Date.now())
  const filed = projectsData.threadsIn({ threads: list }, project.id)
  const hidden = projectsData.hiddenThreads(project, filed)
  return (
    <>
      {filed.length === 0 && hidden === 0 && (
        <p className="px-1 text-label font-meta text-ink-3">
          No threads here yet. Start one and it is filed in this project.
        </p>
      )}
      {filed.length > 0 && (
        <ul className={LIST}>
          {filed.map((thread) => (
            <li key={thread.id} className="motion-enter">
              <button
                type="button"
                onClick={() => onOpenThread(thread.id)}
                className={cn(LINK, 'py-2.5')}
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate text-label text-ink',
                      thread.attention === 'Unread' && 'font-strong',
                    )}
                  >
                    {thread.title}
                  </span>
                  {thread.preview.length > 0 && (
                    <span className="mt-0.5 block truncate text-meta font-meta text-ink-3">
                      {thread.preview}
                    </span>
                  )}
                </span>
                <StatusLabel status={STATUS_OF[thread.attention]} />
                <time className="shrink-0 text-meta font-meta text-ink-3 tabular-nums">
                  {relativeTime(thread.updatedAt, now)}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="mt-2 px-1 text-meta font-meta text-ink-3">
          {hidden === 1
            ? '1 more thread here is not shared with you.'
            : `${hidden} more threads here are not shared with you.`}
        </p>
      )}
    </>
  )
}

/** A Thread's attention as the status the list words: only waiting and working are said. */
const STATUS_OF = {
  NeedsYou: 'attention',
  Working: 'working',
  Unread: 'ready',
  Quiet: 'ready',
} as const satisfies Record<Thread['attention'], 'attention' | 'working' | 'ready'>

/**
 * Who is in a Project's Threads, in a Company. A Project has no members of its own on the server,
 * so this is the people the Person can see in its Threads and it is titled as that.
 */
function People({ project, threads }: { project: Project; threads: ReadonlyArray<Thread> }) {
  const people = projectsData.peopleIn(projectsData.threadsIn({ threads }, project.id))
  if (people.length === 0) return null
  return (
    <Part title="People in these threads">
      <ul className="flex flex-wrap gap-2 px-1">
        {people.map((person) => (
          <li
            key={person.id}
            className="flex h-8 items-center gap-2 rounded-full bg-surface-2 pr-3 pl-1 edge"
          >
            <PersonAvatar name={person.name} image={person.image} size={24} />
            <span className="text-label text-ink-2">{person.name}</span>
          </li>
        ))}
      </ul>
    </Part>
  )
}
