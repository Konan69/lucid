import { PatchSettingsRequest, Settings, type MeResponse, type Theme } from '@vivid/contracts'
import { Result } from 'effect'
import { LogOut } from 'lucide-react'
import { useState } from 'react'
import { reload, signOut } from '../../data/account'
import { change, live, LiveState, useLive } from '../../data/live'
import { run } from '../../data/app'
import { theme } from '../../data/theme'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { Awaiting, Refusal, Row, Section } from './Parts'

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
const ZONES = ['UTC', ...Intl.supportedValuesOf('timeZone')]

/**
 * The Person's own settings: how Vivid looks, the time zone it reads "tomorrow at 9" in, whether
 * it tells them when something needs them, and the way out. They are the same in every workspace.
 */
export function General({ me }: { me: MeResponse }) {
  const settings = useLive(live.settings)
  const [stuck, setStuck] = useState(false)

  /** Signs out, and says so when it did not happen: a reload would land them still signed in. */
  async function leave() {
    const left = await run(signOut())
    if (Result.isSuccess(left)) reload('/')
    else setStuck(true)
  }

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
            onClick={() => void leave()}
          >
            Sign out
          </Button>
        </div>
        {stuck && (
          <p role="alert" className="px-4 pb-3 text-label text-danger">
            You are still signed in: Vivid could not be reached to sign you out. Try again.
          </p>
        )}
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
  const [unsaved, setUnsaved] = useState(false)
  /**
   * Saves the one setting that was changed and shows it at once. Only that field is sent: sending
   * all three from what this screen happens to hold would write back a stale value over a change
   * made on another device a moment ago.
   *
   * When the save does not land the control goes back to what the server has, and this says so.
   * It used to go back in silence, which read as a click that did nothing.
   */
  async function save(edit: PatchSettingsRequest) {
    setUnsaved(false)
    const saved = await change(
      (client) => client.PatchSettings(edit),
      () =>
        live.settings.expect(
          (current) =>
            new Settings({
              personId: current.personId,
              theme: edit.theme === undefined ? current.theme : edit.theme,
              timezone: edit.timezone === undefined ? current.timezone : edit.timezone,
              notify: edit.notify === undefined ? current.notify : edit.notify,
            }),
        ),
    )
    if (Result.isFailure(saved)) setUnsaved(true)
  }
  // The platform's list leaves out UTC, and a zone saved elsewhere may be one this browser does
  // not list; the Person's own zone is always an option, or the select would show a different one.
  const zones = ZONES.includes(settings.timezone) ? ZONES : [settings.timezone, ...ZONES]
  return (
    <>
      <Refusal
        message={
          unsaved ? 'That change was not saved: Vivid could not be reached. Try again.' : null
        }
      />
      <Section title="Preferences">
        <Row label="Appearance" detail="How Vivid looks on this device and your others.">
          <Segmented
            label="Appearance"
            value={settings.theme}
            options={THEMES}
            onChange={(next) => {
              theme.set(next)
              void save(new PatchSettingsRequest({ theme: next }))
            }}
          />
        </Row>
        <Row label="Time zone" detail="Routines and reminders like “tomorrow at 9” use this.">
          <select
            value={settings.timezone}
            aria-label="Time zone"
            onChange={(event) =>
              void save(new PatchSettingsRequest({ timezone: event.currentTarget.value }))
            }
            className="h-8 max-w-56 cursor-pointer rounded-control bg-surface-3 px-2 text-label text-ink ring-line outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {zones.map((zone) => (
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
            onChange={(next) => void save(new PatchSettingsRequest({ notify: next === 'on' }))}
          />
        </Row>
      </Section>
    </>
  )
}
