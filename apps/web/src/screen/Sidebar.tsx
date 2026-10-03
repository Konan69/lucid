import type { CompanyMembership, MeResponse, Project } from '@vivid/contracts'
import { SwitchWorkspaceRequest, Workspace } from '@vivid/contracts'
import { projects as projectsData } from '@vivid/state'
import { Option, Result } from 'effect'
import {
  Bell,
  Building2,
  Check,
  ChevronsUpDown,
  Library,
  PanelLeft,
  Plus,
  Repeat2,
  Search,
  Settings as SettingsIcon,
  SquarePen,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { change, live, useLiveValue } from '../data/live'
import { Route, router } from '../data/route'
import { useScope } from '../data/scope'
import { Avatar } from '../ui/Avatar'
import { cn } from '../ui/cn'
import { Alive } from '../ui/Alive'
import { Menu, MenuDivider, MenuItem, MenuLabel } from '../ui/Menu'
import { settling } from '../ui/settle'
import { sidebar } from '../data/sidebar'
import { ScopeChip } from './project/Chip'
import { FULL, HOVER, ROW, TOOL } from './sidebar/rows'
import { CreateCompany } from './sidebar/Company'
import { ProjectGroup } from './sidebar/Projects'
import { Threads, ThreadSkeleton } from './sidebar/Threads'

/**
 * The sidebar's right edge, which is dragged to make it wider or narrower. The width follows the
 * pointer directly (the pointer is captured, and the show/hide transition is switched off while
 * dragging, or the edge would trail the hand), is remembered when let go, and goes back to the
 * usual width on a double-click. From the keyboard the arrow keys move it a step at a time.
 */
function Edge() {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      title="Drag to resize. Double-click to reset."
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        document.documentElement.dataset.resizing = 'sidebar'
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) sidebar.widen(event.clientX)
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId)
        delete document.documentElement.dataset.resizing
        sidebar.keepWidth()
      }}
      onDoubleClick={sidebar.usualWidth}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') sidebar.nudge(-16)
        if (event.key === 'ArrowRight') sidebar.nudge(16)
      }}
      className="absolute inset-y-0 right-0 z-10 hidden w-1.5 cursor-col-resize transition-colors duration-(--dur-fast) outline-none hover:bg-wash-pressed focus-visible:bg-accent-soft md:block"
    />
  )
}

/**
 * The rail: where the Person is working, the way to start a Thread, the two places beside Threads
 * (Routines and the Library), every Thread they can see ordered by what needs them, and the Person
 * with their Settings at the foot. Projects are a group of rows above the Threads, each a piece of
 * work with its own colour; choosing one narrows the Threads under it to that Project, and the
 * chip beside the workspace's name says so and leads back to everything. Integrations is reached
 * from Settings or when Vivid offers one in a Thread, and what Vivid knows how to do is Vivid's
 * business, not a place. It reads live data and owns none: a Thread moves between lanes because
 * the server says its attention changed, not because something here remembered to move it.
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
  const [creatingCompany, setCreatingCompany] = useState(false)
  const threads = useLiveValue(live.threads)
  const scoped = useScope()
  const working = Option.match(threads, {
    onNone: () => false,
    onSome: (value) => value.threads.some((thread) => thread.attention === 'Working'),
  })

  return (
    <aside
      inert={!open}
      // Narrow: a drawer over the page that slides by its own width. Wide: a column beside the
      // page that gives up its width. One element, so its contents and their state are the same
      // sidebar either way.
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex h-full w-(--sidebar-w) shrink-0 flex-col overflow-hidden bg-surface-1 transition-pop duration-(--dur-base) ease-out in-data-resizing:transition-none md:relative md:z-auto md:translate-x-0 md:transition-width',
        open ? 'translate-x-0 hairline-r' : '-translate-x-full md:w-0',
      )}
    >
      <Edge />
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
            scoped={scoped}
            onCreateCompany={() => setCreatingCompany(true)}
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
            icon={<Library className="size-4" strokeWidth={1.6} />}
            label="Library"
            active={Route.$is('Library')(route)}
            onClick={() => router.go(Route.Library())}
          />
        </div>

        {/* `settling` keeps the list in one piece as Threads arrive, move and are marked done:
            a row with a new place glides to it and the rows under a gap close up. */}
        <nav
          ref={settling}
          className="mt-2 min-h-0 flex-1 scrollbar-hidden overflow-y-auto scroll-fade-y px-2 pb-2"
        >
          <Work route={route} scoped={scoped} />
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

      {creatingCompany && <CreateCompany onClose={() => setCreatingCompany(false)} />}
    </aside>
  )
}

/**
 * The work in the rail: the Projects, then the Threads, narrowed to the scoped Project when
 * there is one. Nothing of it is drawn until both answers are in: Projects arriving a moment
 * after the Threads would push every Thread down under the Person's pointer.
 */
function Work({ route, scoped }: { route: Route; scoped: Option.Option<Project> }) {
  const threads = useLiveValue(live.threads)
  const projects = useLiveValue(live.projects)
  if (Option.isNone(threads) || Option.isNone(projects)) return <ThreadSkeleton />
  const scopedId = Option.map(scoped, (project) => project.id)
  return (
    <>
      {/* The Projects keep their place as the Threads under them come and go. */}
      <div data-moves="projects">
        <ProjectGroup
          projects={projects.value.projects}
          threads={threads.value.threads}
          scoped={scopedId}
          open={Route.$is('Projects')(route) ? route.open : Option.none()}
        />
      </div>
      <Threads
        threads={projectsData.scopedTo(threads.value.threads, projects.value.projects, scopedId)}
        active={Route.$is('Thread')(route) ? route.id : null}
        empty={Option.match(scoped, {
          onNone: () => 'Threads you start will appear here.',
          onSome: (project) => `No threads in ${project.name} yet. Start one and it is filed here.`,
        })}
      />
    </>
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
 * A Company appears only because they made one or were invited to one; the last entry creates
 * one, says in a line what it gives, and asks for nothing but a name. Settings → People offers the
 * same thing to someone working alone.
 */
function WorkspaceSwitcher({
  me,
  working,
  scoped,
  onCreateCompany,
}: {
  me: MeResponse
  working: boolean
  /** The Project the view is narrowed to; its chip sits beside the workspace's name. */
  scoped: Option.Option<Project>
  onCreateCompany: () => void
}) {
  const [open, setOpen] = useState(false)
  const here = Workspace.match(me.workspace, {
    Personal: () => 'Vivid',
    Company: ({ company }) => company.name,
  })
  const inCompany = Workspace.guards.Company(me.workspace)
  const activeCompany = Workspace.guards.Company(me.workspace) ? me.workspace.company.id : null

  async function enter(to: 'personal' | CompanyMembership) {
    setOpen(false)
    const switched = await change((client) =>
      client.SwitchWorkspace({
        to:
          to === 'personal'
            ? SwitchWorkspaceRequest.cases.Personal.make({})
            : SwitchWorkspaceRequest.cases.Company.make({ companyId: to.company.id }),
      }),
    )
    // Only once the server has moved the Person: a Thread started a moment too early would be
    // made in the space they were leaving. A refused switch leaves them exactly where they were.
    // The list of Threads is then a different list, so the address must not point into the old one.
    if (Result.isSuccess(switched)) router.go(Route.New())
  }

  return (
    <div className="relative flex items-center gap-1">
      <button
        onClick={() => setOpen(true)}
        className={cn(ROW, FULL, HOVER, 'w-auto min-w-0 flex-1')}
        aria-haspopup="menu"
      >
        <span className="relative inline-flex size-5.5 items-center justify-center">
          <Alive size={20} state={working ? 'thinking' : 'idle'} />
        </span>
        {/* Where the Person is, in the face Vivid speaks in: the one line of the rail with a voice. */}
        <span className="min-w-0 flex-1 truncate font-display text-dialog font-strong text-ink">
          {here}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-4 group-hover/row:text-ink-2" />
      </button>
      {Option.isSome(scoped) && <ScopeChip key={scoped.value.id} project={scoped.value} />}
      <Menu open={open} onClose={() => setOpen(false)} className="w-60">
        <MenuLabel>Your space</MenuLabel>
        <MenuItem
          icon={<Avatar name={me.person.name} image={me.person.image ?? null} size={16} />}
          hint={inCompany ? undefined : <Check className="size-3.5 text-ink-2" />}
          selected={!inCompany}
          onSelect={() => void enter('personal')}
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
            onSelect={() => void enter(membership)}
          >
            {membership.company.name}
          </MenuItem>
        ))}
        <MenuDivider />
        {/* The one place a Company is offered outside a Thread and Settings. It is two lines so
            it can say what a Company gives before it is asked for. */}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false)
            onCreateCompany()
          }}
          className="flex w-full cursor-pointer items-start gap-2.5 rounded-row px-2.5 py-2 text-left transition-colors duration-(--dur-fast) outline-none select-none hover:bg-wash-hover focus-visible:bg-wash-hover"
        >
          <span className="mt-px inline-flex size-4 shrink-0 items-center justify-center text-ink-2">
            <Plus className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-label text-ink">Create a company</span>
            <span className="mt-0.5 block text-meta font-meta text-pretty text-ink-3">
              Shared threads, a shared Library and shared rules for the people you work with.
            </span>
          </span>
        </button>
      </Menu>
    </div>
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
