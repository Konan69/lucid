import { Workspace, type MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { X } from 'lucide-react'
import { router, type SettingsSection } from '../data/route'
import { IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import { PlaceMark, type Place } from './Place'
import { PRESS } from './motion'
import { Connections } from './settings/Connections'
import { Devices } from './settings/Devices'
import { General } from './settings/General'
import { Memory } from './settings/Memory'
import { People } from './settings/People'
import { Record } from './settings/Record'
import { Rules } from './settings/Rules'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog'
import { useSurface } from '../ui/Layer'

interface Entry {
  readonly id: SettingsSection
  readonly label: string
  /** The place this section is, which is where its colour and glyph come from. */
  readonly place: Place
}

const YOURS: ReadonlyArray<Entry> = [
  { id: 'general', label: 'General', place: 'general' },
  { id: 'memory', label: 'What Vivid knows', place: 'memory' },
  { id: 'devices', label: 'Devices', place: 'devices' },
]
const SHARED: ReadonlyArray<Entry> = [
  { id: 'people', label: 'People', place: 'people' },
  { id: 'connections', label: 'Integrations', place: 'integrations' },
  { id: 'rules', label: 'Rules', place: 'rules' },
  { id: 'record', label: 'Record', place: 'record' },
]

const TITLE = {
  general: 'General',
  devices: 'Devices',
  people: 'People',
  connections: 'Integrations',
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
    // The app draws Settings only while a section is in the address, so it is open from its first
    // render; sent away (Escape, a click outside, its close button) it leaves, and only then is
    // the section taken out of the address.
    <Dialog {...useSurface(close)}>
      <DialogContent
        showCloseButton={false}
        // Narrow: Settings is the whole screen, the way a phone shows it. Wide: a panel over the
        // page, 16 clear of the window on every side, with sections down the left and the chosen
        // one beside them. Narrow, there is no room for a column, so the sections become one
        // scrolling strip above the content. It is as large as a desktop window allows (1024 by
        // 760), because Integrations is a grid of tiles and a short panel showed one row of them;
        // a smaller window still clamps it to itself. It is placed by its edges and not from its
        // centre, so the box between them is what the two limits clamp, and its one row is as
        // tall as it is, so the sections scroll inside it.
        flush
        className="inset-0 m-auto size-auto max-h-none max-w-none translate-none grid-rows-1 overflow-hidden sm:inset-4 sm:max-h-190 sm:max-w-5xl"
      >
        {/* The panel's own name. What is on screen is the open section's title, in the header. */}
        <DialogTitle className="sr-only">Settings</DialogTitle>
        {/* Settings fills its panel to the edge (`flush`): the column of sections and the pane
            each have their own fill. */}
        <div className="flex min-h-0 flex-col overflow-hidden sm:flex-row">
          {/* The strip fades at its far edge and ends in spare room, so a section cut off there
            reads as "there is more this way" and the last one can still be scrolled clear. */}
          <nav className="flex shrink-0 scrollbar-hidden gap-0.5 overflow-x-auto bg-surface-1 scroll-fade-end p-2 pr-10 hairline-b sm:w-52 sm:flex-col sm:overflow-x-visible sm:scroll-fade-none sm:pr-2 sm:hairline-r">
            <Group label="You" entries={YOURS} current={section} />
            <Group label={place} entries={SHARED} current={section} />
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
            <header className="flex h-(--topbar-h) shrink-0 items-center px-5">
              <h2 className="flex-1 text-title font-title text-ink">{TITLE[section]}</h2>
              <DialogClose render={<IconButton label="Close" />}>
                <X className="size-4" />
              </DialogClose>
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
      </DialogContent>
    </Dialog>
  )
}

/**
 * Brings the open section's tab into view. On a narrow screen the sections are one scrolling
 * strip, and a section opened from a link (or the last one in the row) would otherwise be chosen
 * and out of sight. Wide, every section is already visible and this moves nothing.
 */
const reveal = (tab: HTMLButtonElement | null) => {
  if (tab !== null) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
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
      <p className="hidden truncate px-2.5 pt-3 pb-1 text-meta font-meta text-ink-3 sm:block">
        {label}
      </p>
      {entries.map((entry) => (
        <button
          key={entry.id}
          onClick={() => router.openSettings(Option.some(entry.id))}
          aria-current={entry.id === current ? 'page' : undefined}
          ref={entry.id === current ? reveal : undefined}
          className={cn(
            'flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-row px-2 text-left text-label whitespace-nowrap sm:w-full',
            PRESS,
            entry.id === current
              ? 'bg-wash-selected font-title text-ink'
              : 'text-ink-2 hover:bg-wash-hover hover:text-ink',
          )}
        >
          <PlaceMark place={entry.place} size={22} />
          {entry.label}
        </button>
      ))}
    </>
  )
}
