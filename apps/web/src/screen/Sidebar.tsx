import {
  Archive,
  ArchiveRestore,
  Pin,
  Pencil,
  Plus,
  Search,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  Repeat2,
  Library,
  ListFilter,
  AlarmClock,
  Check,
  FolderKanban,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { doneCount, conversations, type Conversation } from '../data/fixtures'
import { countProjects, projects, type Project } from '../data/projects'
import type { RuntimeConversation } from '@vivid/state'

/* T3's sidebar rule: every thread row carries its project. Here, the
   conversation's project name sits beside the title, quiet but present. */
const projectByConversation = new Map<string, Project>(
  projects.flatMap((p) => p.conversations.map((title): [string, Project] => [title, p])),
)
function ProjectMark({ title }: { title: string }) {
  const project = projectByConversation.get(title)
  return project ? <ProjectChip name={project.name} /> : null
}

function ProjectChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-rail-label min-w-0 shrink-0 items-center gap-1 text-meta font-meta text-ink-4">
      <i className="size-1.5 shrink-0 rounded-full bg-ink-4/60" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  )
}
import { Avatar } from '../ui/Avatar'
import { cn } from '../ui/cn'
import { Face } from '../ui/Face'
import { StatusDot, StatusLabel } from '../ui/Status'
import { ToolMarks } from '../ui/Marks'

/* ── Row geometry (Open Session's three heights) ──────────────
   36  a full line: rows and headings that lead with a mark. Navigates → hover fill.
   32  the tool rows, only.
   28  a caption: no mark, no fill. Ink brightens on hover.
   78  a card: T3's variant for a conversation that matters.                 */
const FULL = 'h-(--row-h)'
const TOOL = 'h-(--tool-row-h)'
const CAPTION = 'h-(--caption-h)'
const HOVER = 'hover:bg-wash-hover'
const ROW =
  'group/row relative flex w-full items-center gap-2.5 rounded-row px-2.5 text-left outline-none select-none transition-colors duration-(--dur-fast)'

import { laneConversations, type Lane } from '@vivid/state'

export function Sidebar({
  activeId,
  runtimeConversations,
  onArchive,
  onDelete,
  onRename,
  onSelect,
  onOpenSettings,
  workingCount,
}: {
  activeId: string | null
  runtimeConversations: RuntimeConversation[]
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onSelect: (id: string) => void
  onOpenSettings: () => void
  workingCount: number
}) {
  const demoConversations = conversations.filter((conversation) =>
    ['t2', 't4', 't5'].includes(conversation.id),
  )
  const { lanes } = laneConversations(demoConversations)
  const [doneOpen, setDoneOpen] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<RuntimeConversation | null>(null)
  const activeConversations = runtimeConversations.filter((conversation) => !conversation.archived)
  const archivedConversations = runtimeConversations.filter((conversation) => conversation.archived)
  return (
    <aside className="hidden h-full w-(--sidebar-w) shrink-0 flex-col bg-surface-1 hairline-r md:flex">
      <SidebarHeader workingCount={workingCount} onSelect={onSelect} />

      {/* Band header: a heading with controls. Full line, no fill. */}
      <div className="mt-3 flex h-(--row-h) shrink-0 items-center gap-1 pr-2 pl-4.5">
        <span className="flex-1 text-label text-ink">Conversations</span>
        <button
          aria-label="Filter"
          className="inline-flex size-7 items-center justify-center rounded-control text-ink-3 hover:text-ink"
        >
          <ListFilter className="size-4" />
        </button>
        <button
          aria-label="New conversation"
          onClick={() => onSelect('new')}
          className="inline-flex size-7 items-center justify-center rounded-control text-ink-3 hover:text-ink"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto scroll-fade-y px-2 pb-2">
        <section>
          <ul className="flex flex-col gap-1 pt-1">
            {activeConversations.map((conversation) => (
              <li key={conversation.id}>
                <RuntimeRow
                  conversation={conversation}
                  active={conversation.id === activeId}
                  onArchive={() => onArchive(conversation.id, true)}
                  onDelete={() => onDelete(conversation.id)}
                  onRename={() => setRenameTarget(conversation)}
                  onSelect={() => onSelect(conversation.id)}
                />
              </li>
            ))}
          </ul>
        </section>

        <DemoLanes lanes={lanes} activeId={activeId} onSelect={onSelect} />

        <DoneSection open={doneOpen} onToggle={() => setDoneOpen((v) => !v)} />

        <button
          onClick={() => setArchivedOpen((open) => !open)}
          className={cn(ROW, FULL, HOVER, 'mt-2 text-ink-3 hover:text-ink')}
        >
          <span className="inline-flex size-5.5 items-center justify-center">
            <Archive className="size-4" />
          </span>
          <span className="min-w-0 flex-1 text-label">Archived</span>
          {archivedConversations.length > 0 && (
            <span className="text-meta font-meta text-ink-4">{archivedConversations.length}</span>
          )}
        </button>
        {archivedOpen && (
          <ul className="flex flex-col gap-1 pb-2">
            {archivedConversations.length === 0 ? (
              <li className="px-2.5 py-2 text-meta text-ink-4">No archived conversations</li>
            ) : (
              archivedConversations.map((conversation) => (
                <li key={conversation.id}>
                  <RuntimeRow
                    conversation={conversation}
                    active={conversation.id === activeId}
                    onArchive={() => onArchive(conversation.id, false)}
                    onDelete={() => onDelete(conversation.id)}
                    onRename={() => setRenameTarget(conversation)}
                    onSelect={() => onSelect(conversation.id)}
                  />
                </li>
              ))
            )}
          </ul>
        )}
      </nav>

      <button onClick={onOpenSettings} className={cn(ROW, FULL, HOVER, 'm-2 mt-0 w-auto')}>
        <Avatar name="You" size={22} />
        <span className="min-w-0 flex-1 truncate text-label text-ink-2">You</span>
        <span className="text-meta font-meta text-ink-4">Personal</span>
      </button>
      {renameTarget && (
        <RenameDialog
          conversation={renameTarget}
          onCancel={() => setRenameTarget(null)}
          onSave={(title) => {
            onRename(renameTarget.id, title)
            setRenameTarget(null)
          }}
        />
      )}
    </aside>
  )
}

/** Keeps the navigation strip and product entry points independent from conversation state. */
function SidebarHeader({
  workingCount,
  onSelect,
}: {
  workingCount: number
  onSelect: (id: string) => void
}) {
  return (
    <>
      {/* Nav strip */}
      <div className="flex h-(--topbar-h) shrink-0 items-center px-2">
        <button
          aria-label="Hide sidebar"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <PanelLeft className="size-4" />
        </button>
        <span className="flex-1" />
        <button
          aria-label="Back"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          aria-label="Forward"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-4"
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          aria-label="Search"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <Search className="size-4" />
        </button>
      </div>

      <div className="px-2">
        <button className={cn(ROW, FULL, HOVER)}>
          <span className="relative inline-flex size-5.5 items-center justify-center">
            <Face size={20} mood={workingCount > 0 ? 'thinking' : 'neutral'} />
            <i
              className="absolute -right-px -bottom-px size-2 rounded-full bg-success ring-2 ring-surface-1"
              aria-label="Online"
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-title text-ink">Vivid</span>
          <ChevronDown className="size-4 text-ink-3" />
        </button>

        {/* Product entry points, phrased in the user's language. */}
        <ToolRow
          icon={<Repeat2 className="size-4" strokeWidth={1.6} />}
          label="Routines"
          onClick={() => onSelect('routines')}
        />
        <ToolRow
          icon={<FolderKanban className="size-4" strokeWidth={1.6} />}
          label="Projects"
          onClick={() => onSelect('projects')}
        >
          <span className="text-meta font-meta text-ink-4">{countProjects(projects)}</span>
        </ToolRow>
        <ToolRow
          icon={<Library className="size-4" strokeWidth={1.6} />}
          label="Library"
          onClick={() => onSelect('library')}
        />
      </div>
    </>
  )
}

/** Renders fixture conversation lanes without mixing them into runtime conversation controls. */
function DemoLanes({
  lanes,
  activeId,
  onSelect,
}: {
  lanes: Array<Lane & { items: Conversation[] }>
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return lanes.map((lane) => (
    <section key={lane.key}>
      <Caption label={lane.label} count={lane.count ? lane.items.length : undefined} />
      <ul className="flex flex-col gap-px">
        {lane.items.map((t) => (
          <li key={t.id} className={lane.variant === 'card' ? 'py-0.5' : undefined}>
            {lane.variant === 'card' ? (
              <CardRow
                conversation={t}
                active={t.id === activeId}
                onSelect={() => onSelect(`demo:${t.id}`)}
              />
            ) : (
              <SlimRow
                conversation={t}
                active={t.id === activeId}
                onSelect={() => onSelect(`demo:${t.id}`)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  ))
}

/** Owns the disclosure for settled demo conversations while preserving its existing copy. */
function DoneSection({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <section>
      <button
        onClick={onToggle}
        className={cn(
          'mt-2 flex w-full items-center gap-1.5 px-2.5 text-meta font-title text-ink-4 hover:text-ink-2',
          CAPTION,
        )}
      >
        <Check className="size-3.5" />
        Done <span className="font-meta">{doneCount}</span>
      </button>
      {open && (
        <p className="px-2.5 pb-2 text-meta font-meta text-ink-4">
          Conversations you've settled. They keep their history.
        </p>
      )}
    </section>
  )
}

function RenameDialog({
  conversation,
  onCancel,
  onSave,
}: {
  conversation: RuntimeConversation
  onCancel: () => void
  onSave: (title: string) => void
}) {
  const [title, setTitle] = useState(conversation.title)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSave(title)
        }}
        className="w-full max-w-sm rounded-panel bg-surface-1 p-4 smooth-shadow-ring-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-conversation-title"
      >
        <h2 id="rename-conversation-title" className="text-dialog font-title text-ink">
          Rename conversation
        </h2>
        <input
          autoFocus
          required
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          className="mt-3 h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs outline-none focus:smooth-shadow-ring-sm"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-control px-3 text-label text-ink-3 hover:bg-wash-hover"
          >
            Cancel
          </button>
          <button
            disabled={!title.trim()}
            className="h-9 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent disabled:opacity-50"
          >
            Rename
          </button>
        </div>
      </form>
    </div>
  )
}

function RuntimeRow({
  conversation,
  active,
  onSelect,
  onArchive,
  onDelete,
  onRename,
}: {
  conversation: RuntimeConversation
  active: boolean
  onSelect: () => void
  onArchive: () => void
  onDelete: () => void
  onRename: () => void
}) {
  return (
    <div className="group/runtime relative">
      <button
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative block h-(--card-row-h) w-full rounded-card px-2.5 py-2 text-left transition-surface duration-(--dur-fast) outline-none select-none',
          active
            ? 'bg-surface-3 smooth-shadow-ring-sm'
            : 'bg-surface-2 smooth-shadow-ring-xs hover:bg-wash-hover hover:smooth-shadow-ring-sm',
        )}
      >
        <span className="flex h-5 items-center gap-1.5">
          <Face size={16} mood="neutral" />
          <span className="flex-1" />
          <time className="text-meta font-meta text-ink-4 tabular-nums transition-opacity group-focus-within/runtime:opacity-0 group-hover/runtime:opacity-0">
            {relativeTime(conversation.updatedAt)}
          </time>
        </span>
        <span className="mt-0.5 block truncate text-title text-ink/90">{conversation.title}</span>
        <span className="mt-0.5 block truncate text-label font-meta text-ink-3">
          {conversation.preview}
        </span>
      </button>
      <span className="pointer-events-none absolute top-1.5 right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/runtime:pointer-events-auto group-focus-within/runtime:opacity-100 group-hover/runtime:pointer-events-auto group-hover/runtime:opacity-100">
        <button
          aria-label={`Rename ${conversation.title}`}
          onClick={onRename}
          className="inline-flex size-6 items-center justify-center rounded-xs text-ink-3 hover:bg-wash-pressed hover:text-ink"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          aria-label={`${conversation.archived ? 'Restore' : 'Archive'} ${conversation.title}`}
          onClick={onArchive}
          className="inline-flex size-6 items-center justify-center rounded-xs text-ink-3 hover:bg-wash-pressed hover:text-ink"
        >
          {conversation.archived ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
        </button>
        <button
          aria-label={`Delete ${conversation.title}`}
          onClick={onDelete}
          className="inline-flex size-6 items-center justify-center rounded-xs text-ink-3 hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="size-3.5" />
        </button>
      </span>
    </div>
  )
}

function relativeTime(updatedAt: number) {
  const today = new Date()
  const updated = new Date(updatedAt)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfUpdated = new Date(
    updated.getFullYear(),
    updated.getMonth(),
    updated.getDate(),
  ).getTime()
  const days = Math.round((startOfToday - startOfUpdated) / 86_400_000)
  if (days === 0)
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
      updated,
    )
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7)
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(updated)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(updated)
}

function ToolRow({
  icon,
  label,
  children,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  children?: React.ReactNode
  onClick?: () => void
}) {
  return (
    <button onClick={onClick} className={cn(ROW, TOOL, HOVER, 'text-ink-2 hover:text-ink')}>
      <span className="inline-flex size-5.5 items-center justify-center text-ink-3 group-hover/row:text-ink">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-label">{label}</span>
      {children}
    </button>
  )
}

function Caption({ label, count }: { label: string; count?: number }) {
  return (
    <h3
      className={cn(
        'mt-1 flex items-center gap-1.5 px-2.5 text-meta font-title text-ink-3',
        CAPTION,
      )}
    >
      {label}
      {count !== undefined && <span className="font-meta text-ink-4">{count}</span>}
    </h3>
  )
}

/* ── Recede rule (T3): in-flight and read-ready rows fade as a whole; the
      status label keeps its hue. Prominence is for rows that need a human. ── */
function recedes(t: Conversation, active: boolean) {
  const inFlight = t.status === 'working' || t.status === 'attention' || t.status === 'approve'
  return (t.status === 'ready' || inFlight) && !t.unread && !active
}

function SlimRow({
  conversation: t,
  active,
  onSelect,
  snoozed,
}: {
  conversation: Conversation
  active: boolean
  onSelect: () => void
  snoozed?: boolean
}) {
  const quiet = recedes(t, active)
  return (
    <button
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={cn(
        ROW,
        FULL,
        active ? 'bg-wash-selected' : HOVER,
        quiet && 'opacity-75 hover:opacity-100',
      )}
    >
      <span className="inline-flex size-5.5 shrink-0 items-center justify-center">
        <StatusDot status={t.status} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-label',
          t.unread
            ? 'font-strong text-ink'
            : active
              ? 'text-ink'
              : 'text-ink-2 group-hover/row:text-ink',
        )}
      >
        {t.title}
      </span>
      <ProjectMark title={t.title} />
      {/* Status slot: status at rest, actions on hover. Same width, nothing shifts. */}
      <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
        <span className="flex items-center gap-1 text-meta font-meta text-ink-4 tabular-nums transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0">
          {snoozed ? (
            <span className="text-working">{t.snoozeUntil}</span>
          ) : t.status !== 'ready' ? (
            <StatusLabel status={t.status} />
          ) : (
            t.time
          )}
        </span>
        <RowActions />
      </span>
    </button>
  )
}

function CardRow({
  conversation: t,
  active,
  onSelect,
}: {
  conversation: Conversation
  active: boolean
  onSelect: () => void
}) {
  const quiet = recedes(t, active)
  return (
    <button
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group/row relative block h-(--card-row-h) w-full rounded-card px-2.5 py-2 text-left transition-colors duration-(--dur-fast) outline-none select-none',
        active
          ? 'bg-surface-3 smooth-shadow-ring-sm'
          : 'bg-surface-2 smooth-shadow-ring-xs hover:bg-wash-hover hover:smooth-shadow-ring-sm',
        quiet && 'opacity-80 hover:opacity-100',
      )}
    >
      {/* Line 1: context + status slot */}
      <span className="flex h-5 items-center gap-1.5">
        <ToolMarks tools={t.tools ?? []} size={14} />
        <span className="flex-1" />
        {t.pinned && <Pin className="size-3 shrink-0 text-ink-4" aria-label="Pinned" />}
        <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-center justify-end">
          <span className="flex items-center gap-1 transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0">
            {t.status === 'ready' ? (
              <span className="text-meta font-meta text-ink-4 tabular-nums">{t.time}</span>
            ) : (
              <StatusLabel status={t.status}>
                {t.status === 'working' && t.startedAt !== undefined && (
                  <Ticking startedAt={t.startedAt} />
                )}
              </StatusLabel>
            )}
          </span>
          <RowActions />
        </span>
      </span>
      {/* Line 2: title, with the project it lives in, T3-style */}
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            'min-w-0 shrink truncate text-title',
            t.unread ? 'font-strong text-ink' : 'text-ink/90',
          )}
        >
          {t.title}
        </span>
        <ProjectMark title={t.title} />
      </span>
      {/* Line 3: the last thing said */}
      <span className="mt-0.5 block truncate text-label font-meta text-ink-3">{t.preview}</span>
    </button>
  )
}

function RowActions() {
  return (
    <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
      <i
        title="Pin"
        className="inline-flex size-6 items-center justify-center rounded-xs text-ink-3 hover:bg-wash-pressed hover:text-ink"
      >
        <Pin className="size-3.5" />
      </i>
      <i
        title="Snooze"
        className="inline-flex size-6 items-center justify-center rounded-xs text-ink-3 hover:bg-wash-pressed hover:text-ink"
      >
        <AlarmClock className="size-3.5" />
      </i>
      <i
        title="Done"
        className="inline-flex size-6 items-center justify-center rounded-xs text-ink-3 hover:bg-wash-pressed hover:text-ink"
      >
        <Check className="size-3.5" />
      </i>
    </span>
  )
}

/** T3's WorkingDuration: mono, tabular, ticking once a second. */
function Ticking({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((now - startedAt) / 1000))
  const m = Math.floor(s / 60)
  return (
    <span className="ml-0.5 font-mono font-meta text-ink-3">
      {m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`}
    </span>
  )
}
