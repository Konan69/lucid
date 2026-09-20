import {
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Layers,
  MessagesSquare,
  Plus,
  Search,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { findProject, pathTo, projects, type Project } from '../data/projects'
import { Avatar } from '../ui/Avatar'
import { cn } from '../ui/cn'

/* Projects: real work containers, not tags (docs/12). Two views:
   the shelf of projects, and a project's own page — its conversations, its
   child projects, its people. Child projects inherit members,
   permissions, context, and service access; the page says so. */
export function Projects() {
  const [openId, setOpenId] = useState<string | null>(null)
  const open = openId ? findProject(openId) : null

  return open ? (
    <ProjectPage
      project={open}
      trail={pathTo(open.id)}
      onBack={() => setOpenId(null)}
      onOpen={setOpenId}
    />
  ) : (
    <ProjectShelf onOpen={setOpenId} />
  )
}

/* ── Shelf: every top-level project, one card each ─────────── */

function ProjectShelf({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <section
      className="flex h-full min-w-0 flex-1 flex-col bg-surface-0"
      style={{ boxShadow: 'var(--content-edge-shadow, none)' }}
    >
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        <h1 className="min-w-0 flex-1 text-title font-title text-ink">Projects</h1>
        <button
          aria-label="Search projects"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <Search className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-230 px-5 pt-1 pb-10 sm:px-8">
          <p className="px-0.5 text-meta font-meta text-ink-4">
            Work that spans teams. Vivid keeps each project&apos;s conversations, people, and
            context together.
          </p>

          <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} onOpen={onOpen} />
            ))}
            <li>
              <button className="flex size-full min-h-32 flex-col items-start rounded-card p-4 text-left ring-line transition-[background-color,box-shadow] duration-(--dur-fast) hover:bg-surface-2 hover:shadow-ring-xs">
                <span className="inline-flex size-8 items-center justify-center rounded-control bg-surface-2 text-ink-3">
                  <Plus className="size-4" />
                </span>
                <span className="mt-2.5 text-title text-ink-3">New project</span>
                <span className="mt-0.5 text-meta font-meta text-ink-4">
                  Name it, add people, start a conversation
                </span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </section>
  )
}

function ProjectCard({ project: p, onOpen }: { project: Project; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(p.id)}
      className="group/card flex h-full flex-col overflow-hidden rounded-card bg-surface-2 text-left shadow-ring-sm transition-[background-color,box-shadow,transform] duration-(--dur-fast) hover:-translate-y-0.5 hover:bg-wash-hover hover:shadow-ring-md"
    >
      {/* Cover: art + the project's mark. Children announce themselves here. */}
      <span className="relative flex h-24 items-end overflow-hidden bg-surface-2">
        <img src={p.cover} alt="" className="absolute inset-0 size-full object-cover" />
        <span
          aria-hidden
          className="absolute inset-0 bg-linear-to-t from-surface-2/70 to-transparent"
        />
        {p.children && p.children.length > 0 && (
          <span className="relative z-10 m-2 inline-flex items-center gap-1.5 rounded-full bg-surface-1/85 px-2.5 py-1 text-meta font-title text-ink shadow-ring-xs backdrop-blur-sm">
            <Layers className="size-3 text-accent-ink" />
            {p.children.length} {p.children.length === 1 ? 'sub-project' : 'sub-projects'}
          </span>
        )}
      </span>

      <span className="flex flex-1 flex-col p-4">
        <span className="text-meta font-meta text-ink-4 tabular-nums">{p.lastActive}</span>
        <span className="mt-1 block truncate text-title text-ink">{p.name}</span>
        <span className="mt-0.5 line-clamp-2 text-label text-ink-3">{p.brief}</span>
        <span className="mt-auto flex items-center gap-2.5 pt-3">
          <span className="inline-flex items-center gap-1 text-meta font-meta text-ink-4">
            <MessagesSquare className="size-3.5" />
            {p.conversations.length}
          </span>
          {p.teams.length > 0 && (
            <span className="inline-flex min-w-0 items-center gap-1 text-meta font-meta text-ink-4">
              <Users className="size-3.5" />
              <span className="truncate">{p.teams.join(', ')}</span>
            </span>
          )}
          <span className="ml-auto flex -space-x-1.5">
            {p.members.slice(0, 3).map((m) => (
              <Avatar key={m.name} name={m.name} size={18} />
            ))}
            {p.members.length > 3 && (
              <span className="inline-flex size-4.5 items-center justify-center rounded-full bg-surface-3 text-meta font-meta text-ink-3 ring-2 ring-surface-0">
                +{p.members.length - 3}
              </span>
            )}
          </span>
        </span>
        {p.children && p.children.length > 0 && (
          <span className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-line-1 pt-2.5">
            {p.children.map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-meta font-meta text-ink-3 shadow-ring-xs"
              >
                <ChevronRight className="size-2.5 text-ink-4" />
                {c.name}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  )
}

/* ── Page: one project — conversations, children, people ─────────── */

function ProjectPage({
  project: p,
  trail,
  onBack,
  onOpen,
}: {
  project: Project
  trail: Project[]
  onBack: () => void
  onOpen: (id: string) => void
}) {
  return (
    <section
      className="flex h-full min-w-0 flex-1 flex-col bg-surface-0"
      style={{ boxShadow: 'var(--content-edge-shadow, none)' }}
    >
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        <button
          onClick={onBack}
          aria-label="Back to projects"
          className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <ChevronLeft className="size-4" />
        </button>
        <nav className="flex min-w-0 flex-1 items-center gap-1 text-title">
          {trail.map((t) => (
            <span key={t.id} className="flex min-w-0 items-center gap-1">
              <button onClick={() => onOpen(t.id)} className="truncate text-ink-3 hover:text-ink">
                {t.name}
              </button>
              <ChevronRight className="size-3.5 shrink-0 text-ink-4" />
            </span>
          ))}
          <span className="truncate font-title text-ink">{p.name}</span>
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-180 px-5 pt-2 pb-10 sm:px-8">
          <div className="flex items-center gap-3">
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
              <FolderKanban className="size-5" strokeWidth={1.7} />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-page font-title text-ink">{p.name}</h1>
              <p className="truncate text-label text-ink-3">{p.brief}</p>
            </div>
          </div>

          <ProjectConversations project={p} />

          {p.children && p.children.length > 0 && (
            <Section
              title="Sub-projects"
              note={`They share ${p.name}'s people, permissions, and context`}
            >
              <ul className="grid gap-2 sm:grid-cols-2">
                {p.children.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => onOpen(c.id)}
                      className="group/sub w-full rounded-card bg-surface-2 p-3.5 text-left shadow-ring-sm transition-[background-color,box-shadow,transform] duration-(--dur-fast) hover:-translate-y-0.5 hover:bg-wash-hover hover:shadow-ring-md"
                    >
                      <span className="flex items-center gap-2">
                        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-xs bg-accent-soft text-accent-ink">
                          <FolderKanban className="size-3.5" strokeWidth={1.7} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-title text-ink">
                          {c.name}
                        </span>
                        <ChevronRight className="size-3.5 shrink-0 text-ink-4 transition-transform duration-(--dur-fast) group-hover/sub:translate-x-0.5" />
                      </span>
                      <span className="mt-1 block truncate text-meta font-meta text-ink-4">
                        {c.brief}
                      </span>
                      <span className="mt-2 flex items-center gap-2.5">
                        <span className="inline-flex items-center gap-1 text-meta font-meta text-ink-4">
                          <MessagesSquare className="size-3.5" />
                          {c.conversations.length}
                        </span>
                        <span className="ml-auto flex -space-x-1.5">
                          {c.members.slice(0, 3).map((m) => (
                            <Avatar key={m.name} name={m.name} size={16} />
                          ))}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            title="People"
            note={p.teams.length ? `Teams: ${p.teams.join(', ')}` : 'Individual members only'}
          >
            <div className="flex flex-wrap gap-2">
              {p.members.map((m) => (
                <span
                  key={m.name}
                  className="flex items-center gap-2 rounded-full bg-surface-2 py-1 pr-3 pl-1 shadow-ring-xs"
                >
                  <Avatar name={m.name} size={22} />
                  <span className="text-label text-ink-2">{m.name}</span>
                </span>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </section>
  )
}

/** Renders the project conversation list separately so the page only composes its sections. */
function ProjectConversations({ project: p }: { project: Project }) {
  return (
    <Section title="Conversations" note={`${p.conversations.length} in this project`}>
      <ul className="flex flex-col gap-px">
        {p.conversations.map((t, i) => (
          <li key={t}>
            <button
              className={cn(
                'group/row flex w-full items-center gap-2.5 rounded-row px-2.5 py-2 text-left transition-colors duration-(--dur-fast) outline-none select-none hover:bg-wash-hover',
                i === 0 && 'bg-surface-2',
              )}
            >
              <i
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  i === 0 ? 'bg-working' : 'bg-line-2',
                )}
              />
              <span className="min-w-0 flex-1 truncate text-label text-ink">{t}</span>
              <span className="text-meta font-meta text-ink-4 tabular-nums">
                {i === 0 ? p.lastActive : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <div className="mt-7">
      <div className="mb-1 flex items-baseline gap-2.5 border-t border-line-1 px-0.5 pt-4">
        <h2 className="text-label font-title text-ink-2">{title}</h2>
        {note && <p className="truncate text-meta font-meta text-ink-4">{note}</p>}
        <button
          aria-label={`New in ${title}`}
          className="ml-auto inline-flex size-6 items-center justify-center rounded-xs text-ink-4 hover:text-ink"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {children}
    </div>
  )
}
