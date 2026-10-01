import type { CompanyMembership, MeResponse, Thread, ThreadId } from '@vivid/contracts'
import { SwitchWorkspaceRequest, ThreadAudience, Workspace } from '@vivid/contracts'
import { Option, Result } from 'effect'
import {
  Archive,
  ArchiveRestore,
  Bell,
  Building2,
  Check,
  ChevronsUpDown,
  FolderKanban,
  Library,
  PanelLeft,
  Pencil,
  Plus,
  Repeat2,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  Trash2,
  Users,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { change, live, useLiveValue } from '../data/live'
import { Route, router } from '../data/route'
import { Avatar, Faces } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { Dialog, DialogActions, DialogField } from '../ui/Dialog'
import { Face } from '../ui/Face'
import { Menu, MenuDivider, MenuItem, MenuLabel } from '../ui/Menu'
import { StatusLabel } from '../ui/Status'

/* ── Row geometry ─────────────────────────────────────────────
   36  a full line: rows and headings that lead with a mark. Navigates → hover fill.
   32  the tool rows, only.
   28  a caption: no mark, no fill. Ink brightens on hover.
   78  a card: a Thread that needs someone or is being worked on.           */
const FULL = 'h-(--row-h)'
const TOOL = 'h-(--tool-row-h)'
const CAPTION = 'h-(--caption-h)'
const HOVER = 'hover:bg-wash-hover'
const ROW =
  'group/row relative flex w-full cursor-pointer items-center gap-2.5 rounded-row px-2.5 text-left outline-none select-none transition-colors duration-(--dur-fast)'

type Dialogue =
  | { readonly kind: 'none' }
  | { readonly kind: 'company' }
  | { readonly kind: 'rename'; readonly thread: Thread }
  | { readonly kind: 'delete'; readonly thread: Thread }

/**
 * The rail: where the Person is working, the four places beside Threads, and every Thread they can
 * see, ordered by what needs them. It reads live data and owns none: a Thread moves between lanes
 * because the server says its attention changed, not because something here remembered to move it.
 */
export function Sidebar({
  me,
  route,
  open,
  onHide,
  onSearch,
  onNotifications,
  unread,
}: {
  me: MeResponse
  route: Route
  /** Hidden by width rather than unmounted, so collapsing and returning both animate. */
  open: boolean
  onHide: () => void
  onSearch: () => void
  onNotifications: () => void
  unread: number
}) {
  const [dialogue, setDialogue] = useState<Dialogue>({ kind: 'none' })
  const threads = useLiveValue(live.threads)
  const working = Option.match(threads, {
    onNone: () => false,
    onSome: (value) => value.threads.some((thread) => thread.attention === 'Working'),
  })
  const close = () => setDialogue({ kind: 'none' })

  return (
    <aside
      inert={!open}
      className={cn(
        'hidden h-full shrink-0 flex-col overflow-hidden bg-surface-1 transition-width duration-(--dur-base) ease-out md:flex',
        open ? 'w-(--sidebar-w) hairline-r' : 'w-0',
      )}
    >
      {/* The inner column keeps its full width while the aside narrows, so nothing reflows. */}
      <div className="flex h-full w-(--sidebar-w) shrink-0 flex-col">
        <div className="flex h-(--topbar-h) shrink-0 items-center px-2">
          <RailButton label="Hide sidebar (⌘B)" onClick={onHide}>
            <PanelLeft className="size-4" />
          </RailButton>
          <span className="flex-1" />
          <RailButton label="Search (⌘K)" onClick={onSearch}>
            <Search className="size-4" />
          </RailButton>
          <RailButton label="Notifications" onClick={onNotifications}>
            <Bell className="size-4" />
            {unread > 0 && (
              <i className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent ring-2 ring-surface-1" />
            )}
          </RailButton>
        </div>

        <div className="px-2">
          <WorkspaceSwitcher
            me={me}
            working={working}
            onCreateCompany={() => setDialogue({ kind: 'company' })}
          />
          <ToolRow
            icon={<SquarePen className="size-4" strokeWidth={1.6} />}
            label="New thread"
            active={Route.$is('New')(route)}
            onClick={() => router.go(Route.New())}
          />
          <ToolRow
            icon={<Repeat2 className="size-4" strokeWidth={1.6} />}
            label="Routines"
            active={Route.$is('Routines')(route)}
            onClick={() => router.go(Route.Routines())}
          />
          <ToolRow
            icon={<FolderKanban className="size-4" strokeWidth={1.6} />}
            label="Projects"
            active={Route.$is('Projects')(route)}
            onClick={() => router.go(Route.Projects())}
          />
          <ToolRow
            icon={<Library className="size-4" strokeWidth={1.6} />}
            label="Library"
            active={Route.$is('Library')(route)}
            onClick={() => router.go(Route.Library())}
          />
        </div>

        <nav className="mt-2 min-h-0 flex-1 scrollbar-hidden overflow-y-auto scroll-fade-y px-2 pb-2">
          {Option.isNone(threads) ? (
            <ThreadSkeleton />
          ) : (
            <ThreadLanes
              threads={threads.value.threads}
              active={Route.$is('Thread')(route) ? route.id : null}
              onRename={(thread) => setDialogue({ kind: 'rename', thread })}
              onDelete={(thread) => setDialogue({ kind: 'delete', thread })}
            />
          )}
        </nav>

        <button
          onClick={() => router.openSettings(Option.some('general'))}
          className={cn(ROW, FULL, HOVER, 'm-2 mt-0 w-auto')}
        >
          <Avatar name={me.person.name} image={me.person.image ?? null} size={22} />
          <span className="min-w-0 flex-1 truncate text-label text-ink-2 group-hover/row:text-ink">
            {me.person.name}
          </span>
          <SettingsIcon className="size-4 text-ink-4 group-hover/row:text-ink-2" />
        </button>
      </div>

      {dialogue.kind === 'company' && <CreateCompany onClose={close} />}
      {dialogue.kind === 'rename' && <RenameThread thread={dialogue.thread} onClose={close} />}
      {dialogue.kind === 'delete' && <DeleteThread thread={dialogue.thread} onClose={close} />}
    </aside>
  )
}

function RailButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className="relative inline-flex size-8 cursor-pointer items-center justify-center rounded-control text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
    >
      {children}
    </button>
  )
}

/**
 * Where the Person is working, and the way to somewhere else. Their own space is always first.
 * A Company appears only because they made one or were invited to one; the last entry is the only
 * place in the product a Company is created, and it asks for nothing but a name.
 */
function WorkspaceSwitcher({
  me,
  working,
  onCreateCompany,
}: {
  me: MeResponse
  working: boolean
  onCreateCompany: () => void
}) {
  const [open, setOpen] = useState(false)
  const here = Workspace.match(me.workspace, {
    Personal: () => 'Vivid',
    Company: ({ company }) => company.name,
  })
  const inCompany = Workspace.guards.Company(me.workspace)
  const activeCompany = Workspace.guards.Company(me.workspace) ? me.workspace.company.id : null

  function enter(to: 'personal' | CompanyMembership) {
    setOpen(false)
    void change((client) =>
      client.SwitchWorkspace({
        to:
          to === 'personal'
            ? SwitchWorkspaceRequest.cases.Personal.make({})
            : SwitchWorkspaceRequest.cases.Company.make({ companyId: to.company.id }),
      }),
    )
    // The list of Threads is about to be a different list; the address should not point into the
    // one the Person just left.
    router.go(Route.New())
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen(true)} className={cn(ROW, FULL, HOVER)} aria-haspopup="menu">
        <span className="relative inline-flex size-5.5 items-center justify-center">
          <Face size={20} mood={working ? 'thinking' : 'neutral'} />
        </span>
        <span className="min-w-0 flex-1 truncate text-title text-ink">{here}</span>
        <ChevronsUpDown className="size-3.5 text-ink-4 group-hover/row:text-ink-2" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} className="w-64">
        <MenuLabel>Your space</MenuLabel>
        <MenuItem
          icon={<Avatar name={me.person.name} image={me.person.image ?? null} size={16} />}
          hint={inCompany ? undefined : <Check className="size-3.5 text-ink-2" />}
          selected={!inCompany}
          onSelect={() => enter('personal')}
        >
          {me.person.name}
        </MenuItem>
        {me.companies.length > 0 && <MenuLabel>Companies</MenuLabel>}
        {me.companies.map((membership) => (
          <MenuItem
            key={membership.company.id}
            icon={<Building2 className="size-4" strokeWidth={1.6} />}
            hint={
              membership.company.id === activeCompany ? (
                <Check className="size-3.5 text-ink-2" />
              ) : undefined
            }
            selected={membership.company.id === activeCompany}
            onSelect={() => enter(membership)}
          >
            {membership.company.name}
          </MenuItem>
        ))}
        <MenuDivider />
        <MenuItem
          icon={<Plus className="size-4" />}
          onSelect={() => {
            setOpen(false)
            onCreateCompany()
          }}
        >
          Create a company
        </MenuItem>
      </Menu>
    </div>
  )
}

function CreateCompany({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)

  async function create() {
    const result = await change((client) => client.CreateCompany({ name: name.trim() }))
    if (Result.isFailure(result)) {
      setRefusal('The company could not be created. Try again.')
      return
    }
    onClose()
    router.go(Route.New())
  }

  return (
    <Dialog
      title="Create a company"
      description="A shared space for you and the people you work with. Your own threads, notes and connections stay yours."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <DialogField
          label="Company name"
          value={name}
          onChange={setName}
          placeholder="Acme"
          maxLength={80}
        />
        {refusal !== null && (
          <p role="alert" className="mt-2 text-label text-danger">
            {refusal}
          </p>
        )}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={name.trim().length === 0}>
            Create company
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function RenameThread({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const [title, setTitle] = useState(thread.title)
  return (
    <Dialog title="Rename thread" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const next = title.trim()
          if (next.length > 0 && next !== thread.title) patchThread(thread.id, { title: next })
          onClose()
        }}
      >
        <DialogField label="Title" value={title} onChange={setTitle} />
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={title.trim().length === 0}>
            Rename
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function DeleteThread({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  return (
    <Dialog
      title="Delete this thread?"
      description={`“${thread.title}” and everything in it will be gone for everyone who can see it. This cannot be undone.`}
      onClose={onClose}
    >
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          Keep it
        </Button>
        <Button
          variant="control"
          onClick={() => {
            onClose()
            if (Route.$is('Thread')(router.route())) router.replace(Route.New())
            void change(
              (client) => client.DeleteThread({ id: thread.id }),
              () =>
                live.threads.expect((current) => ({
                  threads: current.threads.filter((candidate) => candidate.id !== thread.id),
                })),
            )
          }}
        >
          Delete thread
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Changes a Thread and shows the change before the server has confirmed it. */
function patchThread(
  id: ThreadId,
  patch: { readonly title?: string; readonly archived?: boolean },
) {
  void change(
    (client) => client.PatchThread({ id, patch }),
    () =>
      live.threads.expect((current) => ({
        threads: current.threads.map((thread) =>
          thread.id === id ? { ...thread, ...patch } : thread,
        ),
      })),
  )
}

const DAY = 86_400_000

/** Midnight at the start of the day a moment falls in, in the Person's own clock. */
const startOfDay = (moment: number) => {
  const date = new Date(moment)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Which quiet band a Thread belongs in, by when it last moved. */
function band(updatedAt: number, now: number): 'Today' | 'Yesterday' | 'This week' | 'Earlier' {
  const days = Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return days < 7 ? 'This week' : 'Earlier'
}

function relativeTime(updatedAt: number, now: number) {
  const updated = new Date(updatedAt)
  const days = Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY)
  if (days <= 0)
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
      updated,
    )
  if (days < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(updated)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(updated)
}

const BANDS = ['Today', 'Yesterday', 'This week', 'Earlier'] as const

/**
 * Every Thread, in the order a busy Person should look at them: what is waiting on them, what
 * Vivid is working on, then everything else by day. The first two are cards because they are few
 * and they matter; the rest are single lines.
 */
function ThreadLanes({
  threads,
  active,
  onRename,
  onDelete,
}: {
  threads: ReadonlyArray<Thread>
  active: ThreadId | null
  onRename: (thread: Thread) => void
  onDelete: (thread: Thread) => void
}) {
  const [archivedOpen, setArchivedOpen] = useState(false)
  // Read once when the list mounts: grouping by day does not need to tick.
  const [now] = useState(() => Date.now())
  const current = threads.filter((thread) => !thread.archived)
  const archived = threads.filter((thread) => thread.archived)
  const needsYou = current.filter((thread) => thread.attention === 'NeedsYou')
  const working = current.filter((thread) => thread.attention === 'Working')
  const rest = current.filter(
    (thread) => thread.attention !== 'NeedsYou' && thread.attention !== 'Working',
  )
  const row = (thread: Thread, variant: 'card' | 'line') => (
    <li key={thread.id} className={variant === 'card' ? 'py-0.5' : undefined}>
      <ThreadRow
        thread={thread}
        variant={variant}
        active={thread.id === active}
        now={now}
        onRename={() => onRename(thread)}
        onDelete={() => onDelete(thread)}
      />
    </li>
  )

  if (threads.length === 0) {
    return (
      <p className="px-2.5 pt-3 text-label font-meta text-ink-4">
        Threads you start will appear here.
      </p>
    )
  }

  return (
    <>
      {needsYou.length > 0 && (
        <section>
          <Caption label="Needs you" count={needsYou.length} />
          <ul className="flex flex-col">{needsYou.map((thread) => row(thread, 'card'))}</ul>
        </section>
      )}
      {working.length > 0 && (
        <section>
          <Caption label="Working" count={working.length} />
          <ul className="flex flex-col">{working.map((thread) => row(thread, 'card'))}</ul>
        </section>
      )}
      {BANDS.map((name) => {
        const inBand = rest.filter((thread) => band(thread.updatedAt, now) === name)
        if (inBand.length === 0) return null
        return (
          <section key={name}>
            <Caption label={name} />
            <ul className="flex flex-col gap-px">{inBand.map((thread) => row(thread, 'line'))}</ul>
          </section>
        )
      })}
      {archived.length > 0 && (
        <section>
          <button
            onClick={() => setArchivedOpen((value) => !value)}
            className={cn(ROW, FULL, HOVER, 'mt-2 text-ink-3 hover:text-ink')}
            aria-expanded={archivedOpen}
          >
            <span className="inline-flex size-5.5 items-center justify-center">
              <Archive className="size-4" />
            </span>
            <span className="min-w-0 flex-1 text-label">Archived</span>
            <span className="text-meta font-meta text-ink-4">{archived.length}</span>
          </button>
          {archivedOpen && (
            <ul className="flex flex-col gap-px pb-2">
              {archived.map((thread) => row(thread, 'line'))}
            </ul>
          )}
        </section>
      )}
    </>
  )
}

/** Who else is in a Thread, as faces for named people and a mark for the whole Company. */
function Audience({ thread }: { thread: Thread }) {
  return ThreadAudience.match(thread.audience, {
    Private: () => null,
    People: ({ participants }) => <Faces people={participants} size={16} />,
    Company: () => (
      <Users className="size-3.5 shrink-0 text-ink-4" aria-label="Shared with the company" />
    ),
  })
}

function ThreadRow({
  thread,
  variant,
  active,
  now,
  onRename,
  onDelete,
}: {
  thread: Thread
  variant: 'card' | 'line'
  active: boolean
  now: number
  onRename: () => void
  onDelete: () => void
}) {
  const unread = thread.attention === 'Unread' && !active
  const open = () => router.go(Route.Thread({ id: thread.id }))
  const actions = (
    <RowActions
      thread={thread}
      onRename={onRename}
      onDelete={onDelete}
      onArchive={() => patchThread(thread.id, { archived: !thread.archived })}
    />
  )

  if (variant === 'card') {
    return (
      <div className="group/thread relative">
        <button
          onClick={open}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'relative block h-(--card-row-h) w-full cursor-pointer rounded-card px-2.5 py-2 text-left transition-surface duration-(--dur-fast) outline-none select-none',
            active
              ? 'bg-surface-3 smooth-shadow-ring-sm'
              : 'bg-surface-2 smooth-shadow-ring-xs hover:bg-wash-hover hover:smooth-shadow-ring-sm',
          )}
        >
          <span className="flex h-5 items-center gap-1.5">
            <Audience thread={thread} />
            <span className="flex-1" />
            <span className="transition-opacity group-focus-within/thread:opacity-0 group-hover/thread:opacity-0">
              <StatusLabel status={thread.attention === 'NeedsYou' ? 'attention' : 'working'} />
            </span>
          </span>
          <span className="mt-0.5 block truncate text-title text-ink">{thread.title}</span>
          <span className="mt-0.5 block truncate text-label font-meta text-ink-3">
            {thread.preview}
          </span>
        </button>
        {actions}
      </div>
    )
  }

  return (
    <div className="group/thread relative">
      <button
        onClick={open}
        aria-current={active ? 'page' : undefined}
        className={cn(ROW, FULL, active ? 'bg-wash-selected' : HOVER)}
      >
        <span className="inline-flex size-5.5 shrink-0 items-center justify-center">
          <i className={cn('size-1.5 rounded-full', unread ? 'bg-accent' : 'bg-line-4')} />
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-label',
            unread
              ? 'font-strong text-ink'
              : active
                ? 'text-ink'
                : 'text-ink-2 group-hover/row:text-ink',
          )}
        >
          {thread.title}
        </span>
        <Audience thread={thread} />
        <time className="shrink-0 text-meta font-meta text-ink-4 tabular-nums transition-opacity group-focus-within/thread:opacity-0 group-hover/thread:opacity-0">
          {relativeTime(thread.updatedAt, now)}
        </time>
      </button>
      {actions}
    </div>
  )
}

/** What can be done to a Thread from the list. At rest the row shows its time; on hover, these. */
function RowActions({
  thread,
  onRename,
  onArchive,
  onDelete,
}: {
  thread: Thread
  onRename: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const action =
    'inline-flex size-6 cursor-pointer items-center justify-center rounded-xs text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-pressed hover:text-ink'
  return (
    <span className="pointer-events-none absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-control bg-surface-1 opacity-0 transition-opacity group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100">
      <button aria-label={`Rename ${thread.title}`} onClick={onRename} className={action}>
        <Pencil className="size-3.5" />
      </button>
      <button
        aria-label={`${thread.archived ? 'Restore' : 'Archive'} ${thread.title}`}
        onClick={onArchive}
        className={action}
      >
        {thread.archived ? (
          <ArchiveRestore className="size-3.5" />
        ) : (
          <Archive className="size-3.5" />
        )}
      </button>
      <button
        aria-label={`Delete ${thread.title}`}
        onClick={onDelete}
        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-xs text-ink-3 transition-colors duration-(--dur-fast) hover:bg-danger-soft hover:text-danger"
      >
        <Trash2 className="size-3.5" />
      </button>
    </span>
  )
}

function ToolRow({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        ROW,
        TOOL,
        active ? 'bg-wash-selected text-ink' : cn(HOVER, 'text-ink-2 hover:text-ink'),
      )}
    >
      <span
        className={cn(
          'inline-flex size-5.5 items-center justify-center',
          active ? 'text-ink' : 'text-ink-3 group-hover/row:text-ink',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-label">{label}</span>
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

/** The list's shape while the first result is on its way: lines, not the empty-state sentence. */
function ThreadSkeleton() {
  return (
    <ul className="flex flex-col gap-2 px-2.5 pt-3" aria-hidden>
      {['w-40', 'w-32', 'w-44', 'w-28'].map((width) => (
        <li key={width} className={cn('h-3 rounded-full bg-wash-hover', width)} />
      ))}
    </ul>
  )
}
