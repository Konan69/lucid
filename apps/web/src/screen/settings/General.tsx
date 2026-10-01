import { Settings, type MeResponse, type Theme } from '@vivid/contracts'
import { LogOut } from 'lucide-react'
import { reload, signOut } from '../../data/account'
import { change, live, LiveState, useLive } from '../../data/live'
import { run } from '../../data/runtime'
import { theme } from '../../data/theme'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { Awaiting, Row, Section } from './Parts'

const THEMES = [
  { value: 'system', label: 'System', name: 'Follow the system' },
  { value: 'light', label: 'Light', name: 'Light' },
  { value: 'dark', label: 'Dark', name: 'Dark' },
] as const satisfies ReadonlyArray<{ value: Theme; label: string; name: string }>

const SWITCH = [
  { value: 'on', label: 'On', name: 'On' },
  { value: 'off', label: 'Off', name: 'Off' },
] as const

/** Every zone the platform knows, so the list is never out of date with the runtime that uses it. */
const ZONES = Intl.supportedValuesOf('timeZone')

/**
 * The Person's own settings: how Vivid looks, the time zone it reads "tomorrow at 9" in, whether
 * it tells them when something needs them, and the way out. They are the same in every workspace.
 */
export function General({ me }: { me: MeResponse }) {
  const settings = useLive(live.settings)
  return (
    <>
      <Section title="You">
        <div className="flex items-center gap-3 px-4 py-3">
          <Avatar name={me.person.name} image={me.person.image ?? null} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-title font-title text-ink">{me.person.name}</span>
            <span className="block truncate text-label text-ink-3">{me.person.email}</span>
          </span>
          <Button
            variant="ghost"
            icon={<LogOut className="size-3.5" />}
            onClick={() => void run(signOut()).then(() => reload('/'))}
          >
            Sign out
          </Button>
        </div>
      </Section>
      {LiveState.$is('Ready')(settings) ? (
        <Preferences settings={settings.value} />
      ) : (
        <Awaiting state={settings} />
      )}
    </>
  )
}

function Preferences({ settings }: { settings: Settings }) {
  /** Saves one changed setting and shows it at once. */
  const save = (next: Settings) =>
    void change(
      (client) =>
        client.PatchSettings({ theme: next.theme, timezone: next.timezone, notify: next.notify }),
      () => live.settings.expect(() => next),
    )
  const withChange = (next: {
    readonly theme: Theme
    readonly timezone: string
    readonly notify: boolean
  }) => new Settings({ personId: settings.personId, ...next })
  const current = { theme: settings.theme, timezone: settings.timezone, notify: settings.notify }
  return (
    <Section title="Preferences">
      <Row label="Appearance" detail="How Vivid looks on this device and your others.">
        <Segmented
          label="Appearance"
          value={settings.theme}
          options={THEMES}
          onChange={(next) => {
            theme.set(next)
            save(withChange({ ...current, theme: next }))
          }}
        />
      </Row>
      <Row label="Time zone" detail="Routines and reminders like “tomorrow at 9” use this.">
        <select
          value={settings.timezone}
          onChange={(event) =>
            save(withChange({ ...current, timezone: event.currentTarget.value }))
          }
          className="h-8 max-w-56 cursor-pointer rounded-control bg-surface-3 px-2 text-label text-ink ring-line outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {ZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Notifications" detail="Tell me when something finishes or needs me.">
        <Segmented
          label="Notifications"
          value={settings.notify ? 'on' : 'off'}
          options={SWITCH}
          onChange={(next) => save(withChange({ ...current, notify: next === 'on' }))}
        />
      </Row>
    </Section>
  )
}
