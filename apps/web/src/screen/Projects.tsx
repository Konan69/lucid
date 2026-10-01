import type { ProjectId, Thread, ThreadId } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { ChevronRight, FolderKanban, Layers, MessagesSquare, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { change, live, LiveState, useLive } from '../data/live'
import * as projectsData from '../data/projects'
import { Button, IconButton } from '../ui/Button'
import { cn } from '../ui/cn'
import { Dialog, DialogActions, DialogField } from '../ui/Dialog'
import { Field, Select } from '../ui/Field'
import { Live } from '../ui/Live'
import { Notice } from '../ui/Notice'
import { Skeleton } from '../ui/Skeleton'
import { BAR } from './bar'

type Project = projectsData.Project

/** How a Thread is opened, when the shell has said how. Without it Threads are listed as text. */
type Opener = Option.Option<(id: ThreadId) => void>

/** A new Project being named, and the Project it will sit inside, if any. */
interface NewProject {
  readonly parentId: ProjectId | null
}

/**
 * Projects: where work is filed. The shelf shows the top-level Projects; a Project's page shows
 * the Threads filed in it and the Projects inside it.
 *
 * Everything drawn comes from `live.projects` and `live.threads`. `onOpenThread` opens one of a
 * Project's Threads; until the shell passes it, those Threads are listed but are not links.
 */
export function Projects({ onOpenThread }: { onOpenThread?: (id: ThreadId) => void }) {
  const [openId, setOpenId] = useState<Option.Option<ProjectId>>(Option.none())
  const [creating, setCreating] = useState<Option.Option<NewProject>>(Option.none())
  const state = useLive(live.projects)

  return LiveState.$match(state, {
    Loading: () => (
      <Pane header={<Title>Projects</Title>}>
        <Skeleton of="card" count={4} />
      </Pane>
    ),
    Failed: ({ failure }) => (
      <Pane header={<Title>Projects</Title>}>
        <Notice>{failure.message}</Notice>
      </Pane>
    ),
    Ready: ({ value }) => (
      <ProjectsReady
        projects={value.projects}
        // A Project open here can be removed somewhere else; its page then falls back to the shelf.
        open={Option.flatMap(openId, (id) => projectsData.findProject(value.projects, id))}
        creating={creating}
        onOpen={setOpenId}
        onCreating={setCreating}
        opener={Option.fromUndefinedOr(onOpenThread)}
      />
    ),
  })
}

/** The screen's frame: a top bar, and a scrolling body at the width every list screen uses. */
function Pane({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <header className={BAR}>{header}</header>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-230 px-5 pt-1 pb-10 sm:px-8">{children}</div>
      </div>
    </section>
  )
}

function Title({ children }: { children: ReactNode }) {
  return <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{children}</h1>
}

/** The shelf or one Project's page, and the dialog that names a new Project over either. */
function ProjectsReady({
  projects,
  open,
  creating,
  onOpen,
  onCreating,
  opener,
}: {
  projects: ReadonlyArray<Project>
  open: Option.Option<Project>
  creating: Option.Option<NewProject>
  onOpen: (id: Option.Option<ProjectId>) => void
  onCreating: (creating: Option.Option<NewProject>) => void
  opener: Opener
}) {
  /**
   * A Project gets its id from the server, so this waits for it. The answer can arrive before the
   * live query's next result; showing the Project the server just returned, as a change already
   * accepted, lets its page open at once.
   */
  async function create(name: string, parentProjectId: ProjectId | null) {
    const result = await change((client) => client.CreateProject({ name, parentProjectId }))
    if (Result.isFailure(result)) return Option.some(result.failure.message)
    live.projects.expect(projectsData.confirmed(result.success))(true)
    onCreating(Option.none())
    onOpen(Option.some(result.success.id))
    return Option.none<string>()
  }

  const openProject = (project: Project) => onOpen(Option.some(project.id))
  return (
    <>
      {Option.isSome(open) ? (
        <ProjectPage
          project={open.value}
          projects={projects}
          onOpen={openProject}
          onBack={() => onOpen(Option.fromNullOr(open.value.parentProjectId))}
          onCreate={() => onCreating(Option.some({ parentId: open.value.id }))}
          opener={opener}
        />
      ) : (
        <ProjectShelf
          projects={projects}
          onOpen={openProject}
          onCreate={() => onCreating(Option.some({ parentId: null }))}
        />
      )}
      {Option.isSome(creating) && (
        <NewProjectDialog
          projects={projects}
          parentId={creating.value.parentId}
          onCreate={create}
          onClose={() => onCreating(Option.none())}
        />
      )}
    </>
  )
}

// ── The shelf ────────────────────────────────────────────────────────────────

/** Every top-level Project as a card, or one sentence and the way to make the first. */
function ProjectShelf({
  projects,
  onOpen,
  onCreate,
}: {
  projects: ReadonlyArray<Project>
  onOpen: (project: Project) => void
  onCreate: () => void
}) {
  const top = projectsData.projectsIn(projects, null)
  return (
    <Pane
      header={
        <>
          <Title>Projects</Title>
          <IconButton label="New project" onClick={onCreate}>
            <Plus className="size-4" />
          </IconButton>
        </>
      }
    >
      {top.length === 0 ? (
        <div className="mt-3 flex flex-col items-center rounded-card bg-surface-2 px-6 py-10 text-center smooth-shadow-ring-xs">
          <FolderKanban className="size-5 text-ink-4" />
          <p className="mt-2 mb-4 max-w-sm text-label text-ink-3">
            No Projects yet. A Project keeps the Threads about one piece of work together.
          </p>
          <Button icon={<Plus className="size-3.5" />} onClick={onCreate}>
            New project
          </Button>
        </div>
      ) : (
        <>
          <p className="px-0.5 text-meta font-meta text-ink-3">
            Each Project keeps the Threads about one piece of work together.
          </p>
          <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {top.map((project) => (
              <li key={project.id}>
                <ProjectCard
                  project={project}
                  inside={projectsData.projectsIn(projects, project.id).length}
                  onOpen={() => onOpen(project)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </Pane>
  )
}

/** One Project: its name, how many Threads are filed in it, and when one of them last moved. */
function ProjectCard({
  project,
  inside,
  onOpen,
}: {
  project: Project
  /** How many Projects sit directly inside this one. */
  inside: number
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/card flex size-full cursor-pointer flex-col rounded-card bg-surface-2 p-4 text-left smooth-shadow-ring-xs transition-press duration-(--dur-fast) hover:bg-wash-hover"
    >
      <span className="flex items-center gap-2.5">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
          <FolderKanban className="size-4" strokeWidth={1.7} />
        </span>
        <span className="min-w-0 flex-1 truncate text-title text-ink">{project.name}</span>
        <ChevronRight className="size-3.5 shrink-0 text-ink-4 transition-transform duration-(--dur-fast) group-hover/card:translate-x-0.5" />
      </span>
      <span className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta font-meta text-ink-3">
        <span className="inline-flex items-center gap-1">
          <MessagesSquare className="size-3.5" />
          {projectsData.countThreads(project.threadCount)}
        </span>
        {inside > 0 && (
          <span className="inline-flex items-center gap-1">
            <Layers className="size-3.5" />
            {inside} inside
          </span>
        )}
        <time className="ml-auto tabular-nums">
          Moved {projectsData.formatMoved(project.updatedAt)}
        </time>
      </span>
    </button>
  )
}

// ── One Project ──────────────────────────────────────────────────────────────

/** One Project's page: the way back up, the Threads filed in it, and the Projects inside it. */
function ProjectPage({
  project,
  projects,
  onOpen,
  onBack,
  onCreate,
  opener,
}: {
  project: Project
  projects: ReadonlyArray<Project>
  onOpen: (project: Project) => void
  onBack: () => void
  onCreate: () => void
  opener: Opener
}) {
  const inside = projectsData.projectsIn(projects, project.id)
  return (
    <Pane
      header={
        <>
          <IconButton label="Back" onClick={onBack}>
            <ChevronRight className="size-4 rotate-180" />
          </IconButton>
          <nav className="flex min-w-0 flex-1 items-center gap-1 text-title">
            {projectsData.trailTo(projects, project).map((above) => (
              <span key={above.id} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpen(above)}
                  className="cursor-pointer truncate rounded-xs text-ink-3 transition-colors duration-(--dur-fast) hover:text-ink"
                >
                  {above.name}
                </button>
                <ChevronRight className="size-3.5 shrink-0 text-ink-4" />
              </span>
            ))}
            <h1 className="truncate font-title text-ink">{project.name}</h1>
          </nav>
        </>
      }
    >
      <ProjectThreads project={project} opener={opener} />
      <Section
        title="Projects inside"
        note={inside.length === 0 ? 'None yet.' : `${inside.length} in ${project.name}`}
        action={
          <Button variant="quiet" size="sm" icon={<Plus className="size-3.5" />} onClick={onCreate}>
            New project
          </Button>
        }
      >
        <ul className="grid gap-2.5 sm:grid-cols-2">
          {inside.map((child) => (
            <li key={child.id}>
              <ProjectCard
                project={child}
                inside={projectsData.projectsIn(projects, child.id).length}
                onOpen={() => onOpen(child)}
              />
            </li>
          ))}
        </ul>
      </Section>
    </Pane>
  )
}

/** What a Thread needs from the Person, said only when it needs something. */
const ATTENTION = {
  NeedsYou: { label: 'Needs you', tone: 'text-attention', dot: 'bg-attention' },
  Working: { label: 'Working', tone: 'text-working', dot: 'animate-status-pulse bg-working' },
  Unread: { label: 'New', tone: 'text-accent-ink', dot: 'bg-accent' },
  Quiet: { label: '', tone: 'text-ink-3', dot: 'bg-line-4' },
} satisfies Record<Thread['attention'], { label: string; tone: string; dot: string }>

/**
 * The Threads filed in a Project that the Person can open, from the live list of their Threads. A
 * Project also counts Threads the Person is not in; those are counted here and never listed.
 */
function ProjectThreads({ project, opener }: { project: Project; opener: Opener }) {
  const threads = useLive(live.threads)
  return (
    <Section title="Threads" note={projectsData.countThreads(project.threadCount)} action={null}>
      <Live state={threads} loading={<Skeleton of="row" count={3} />}>
        {(list) => {
          const filed = projectsData.threadsIn(list, project.id)
          const hidden = projectsData.hiddenThreads(project, filed)
          return (
            <>
              {filed.length === 0 && hidden === 0 && (
                <p className="px-0.5 text-label text-ink-3">No Threads are filed here yet.</p>
              )}
              <ul className="flex flex-col gap-px">
                {filed.map((thread) => (
                  <li key={thread.id}>
                    <ThreadRow thread={thread} opener={opener} />
                  </li>
                ))}
              </ul>
              {hidden > 0 && (
                <p className="mt-1 px-0.5 text-meta font-meta text-ink-3">
                  {projectsData.countThreads(hidden)} here {hidden === 1 ? 'is' : 'are'} not shared
                  with you.
                </p>
              )}
            </>
          )
        }}
      </Live>
    </Section>
  )
}

/** One Thread in a Project. It is a link when the shell says how to open a Thread, text if not. */
function ThreadRow({ thread, opener }: { thread: Thread; opener: Opener }) {
  const attention = ATTENTION[thread.attention]
  const row = (
    <>
      <i className={cn('size-1.5 shrink-0 rounded-full', attention.dot)} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-label text-ink">{thread.title}</span>
      {attention.label !== '' && (
        <span className={cn('text-meta font-title', attention.tone)}>{attention.label}</span>
      )}
      <time className="text-meta font-meta text-ink-3 tabular-nums">
        {projectsData.formatMoved(thread.updatedAt)}
      </time>
    </>
  )
  if (Option.isNone(opener)) {
    return <div className="flex items-center gap-2.5 px-2.5 py-2">{row}</div>
  }
  return (
    <button
      type="button"
      onClick={() => opener.value(thread.id)}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-row px-2.5 py-2 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover"
    >
      {row}
    </button>
  )
}

/** A titled part of a Project's page, with a quieter note and room for one action. */
function Section({
  title,
  note,
  action,
  children,
}: {
  title: string
  note: string
  action: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mt-6 first:mt-2">
      <div className="mb-2 flex items-center gap-2.5 border-t border-line-1 px-0.5 pt-4">
        <h2 className="text-label font-title text-ink-2">{title}</h2>
        <p className="min-w-0 flex-1 truncate text-meta font-meta text-ink-3">{note}</p>
        {action}
      </div>
      {children}
    </div>
  )
}

// ── A new Project ────────────────────────────────────────────────────────────

/** The select value for "not inside another Project"; no Project id is the empty string. */
const TOP = ''

/**
 * Names a new Project and says what it sits inside, if anything. It waits for the server, and a
 * refusal is shown beside the field in the server's words with what was typed still there.
 */
function NewProjectDialog({
  projects,
  parentId,
  onCreate,
  onClose,
}: {
  projects: ReadonlyArray<Project>
  parentId: ProjectId | null
  onCreate: (name: string, parentProjectId: ProjectId | null) => Promise<Option.Option<string>>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [inside, setInside] = useState(parentId)
  const [pending, setPending] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  async function submit() {
    setPending(true)
    setRefused(Option.none())
    const message = await onCreate(name.trim(), inside)
    // On success the dialog has been closed by `onCreate` and there is nothing left to update.
    if (Option.isNone(message)) return
    setRefused(message)
    setPending(false)
  }

  return (
    <Dialog title="New project" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="flex flex-col gap-3"
      >
        <DialogField
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Office move"
          maxLength={80}
        />
        {projects.length > 0 && (
          <Field label="Inside" hint="optional">
            <Select
              value={inside === null ? TOP : inside}
              onChange={(event) => {
                const chosen = projects.find((each) => each.id === event.currentTarget.value)
                setInside(chosen === undefined ? null : chosen.id)
              }}
            >
              <option value={TOP}>No other Project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {Option.isSome(refused) && <Notice>{refused.value}</Notice>}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || name.trim() === ''}>
            Create project
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
