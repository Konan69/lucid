import { Workspace, type MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import {
  Brain,
  Link2,
  MonitorSmartphone,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { router, type SettingsSection } from '../data/route'
import { IconButton } from '../ui/Button'
import { cn } from '../ui/cn'
import { Connections } from './settings/Connections'
import { Devices } from './settings/Devices'
import { General } from './settings/General'
import { Memory } from './settings/Memory'
import { People } from './settings/People'
import { Record } from './settings/Record'
import { Rules } from './settings/Rules'

interface Entry {
  readonly id: SettingsSection
  readonly label: string
  readonly icon: ReactNode
}

const YOURS: ReadonlyArray<Entry> = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal className="size-4" /> },
  { id: 'memory', label: 'What Vivid knows', icon: <Brain className="size-4" /> },
  { id: 'devices', label: 'Devices', icon: <MonitorSmartphone className="size-4" /> },
]
const SHARED: ReadonlyArray<Entry> = [
  { id: 'people', label: 'People', icon: <Users className="size-4" /> },
  { id: 'connections', label: 'Connections', icon: <Link2 className="size-4" /> },
  { id: 'rules', label: 'Rules', icon: <ShieldCheck className="size-4" /> },
  { id: 'record', label: 'Record', icon: <ScrollText className="size-4" /> },
]

const TITLE = {
  general: 'General',
  devices: 'Devices',
  people: 'People',
  connections: 'Connections',
  rules: 'Rules',
  memory: 'What Vivid knows',
  record: 'Record',
} satisfies Record<SettingsSection, string>

/**
 * Settings, over whatever the Person was doing. The left column is in two groups because there
 * are two kinds of setting: what is the Person's own and follows them everywhere, and what belongs
 * to the workspace they are in. The open section is in the address, so it can be linked to.
 */
export function Settings({
  me,
  section,
  deviceCode,
}: {
  me: MeResponse
  section: SettingsSection
  deviceCode: string
}) {
  const close = () => router.openSettings(Option.none())
  const place = Workspace.match(me.workspace, {
    Personal: () => 'Your space',
    Company: ({ company }) => company.name,
  })
  return (
    <div
      role="presentation"
      className="fixed inset-0 z-40 flex animate-fade-in items-center justify-center bg-scrim p-4 backdrop-blur-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex size-full max-h-160 max-w-4xl animate-rise-in overflow-hidden rounded-panel bg-surface-1 smooth-shadow-ring-lg"
      >
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 bg-surface-1 p-2 hairline-r">
          <Group label="You" entries={YOURS} current={section} />
          <Group label={place} entries={SHARED} current={section} />
        </nav>
        <div className="flex min-w-0 flex-1 flex-col bg-surface-0">
          <header className="flex h-(--topbar-h) shrink-0 items-center px-5">
            <h2 className="flex-1 text-title font-title text-ink">{TITLE[section]}</h2>
            <IconButton label="Close" onClick={close}>
              <X className="size-4" />
            </IconButton>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
            {section === 'general' && <General me={me} />}
            {section === 'devices' && <Devices initialCode={deviceCode} />}
            {section === 'people' && <People me={me} />}
            {section === 'connections' && <Connections me={me} />}
            {section === 'rules' && <Rules me={me} />}
            {section === 'memory' && <Memory />}
            {section === 'record' && <Record />}
          </div>
        </div>
      </div>
    </div>
  )
}

function Group({
  label,
  entries,
  current,
}: {
  label: string
  entries: ReadonlyArray<Entry>
  current: SettingsSection
}) {
  return (
    <>
      <p className="truncate px-2.5 pt-3 pb-1 text-meta font-meta text-ink-3">{label}</p>
      {entries.map((entry) => (
        <button
          key={entry.id}
          onClick={() => router.openSettings(Option.some(entry.id))}
          aria-current={entry.id === current ? 'page' : undefined}
          className={cn(
            'flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-row px-2.5 text-left text-label transition-colors duration-(--dur-fast)',
            entry.id === current
              ? 'bg-wash-selected text-ink'
              : 'text-ink-2 hover:bg-wash-hover hover:text-ink',
          )}
        >
          <span className="text-ink-3">{entry.icon}</span>
          {entry.label}
        </button>
      ))}
    </>
  )
}
