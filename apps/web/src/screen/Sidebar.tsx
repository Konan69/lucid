import type { CompanyMembership, MeResponse } from '@vivid/contracts'
import { SwitchWorkspaceRequest, Workspace } from '@vivid/contracts'
import { Option, Result } from 'effect'
import {
  Bell,
  Building2,
  Check,
  ChevronsUpDown,
  FolderKanban,
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
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { Dialog, DialogActions, DialogField } from '../ui/Dialog'
import { Face } from '../ui/Face'
import { Menu, MenuDivider, MenuItem, MenuLabel } from '../ui/Menu'
import { FULL, HOVER, ROW, TOOL } from './sidebar/rows'
import { Threads, ThreadSkeleton } from './sidebar/Threads'

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
  const [creatingCompany, setCreatingCompany] = useState(false)
  const threads = useLiveValue(live.threads)
  const working = Option.match(threads, {
    onNone: () => false,
    onSome: (value) => value.threads.some((thread) => thread.attention === 'Working'),
  })

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
            <Threads
              threads={threads.value.threads}
              active={Route.$is('Thread')(route) ? route.id : null}
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

      {creatingCompany && <CreateCompany onClose={() => setCreatingCompany(false)} />}
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
