import { useAtomValue } from '@effect/atom-react'
import {
  LocationSharing,
  PatchSettingsRequest,
  Settings,
  type MeResponse,
  type Theme,
} from '@vivid/contracts'
import { locating, notifying } from '@vivid/state'
import { Effect, Option, Result } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import { LogOut } from 'lucide-react'
import { useState } from 'react'
import { reload, signOut } from '../../data/account'
import { changing, live, LiveState, useLive } from '../../data/live'
import { act, running } from '../../data/app'
import { desktopVersion, pageWords, serverWords } from '../../data/build'
import { sessionEnded } from '../../data/ending'
import { theme } from '../../data/theme'
import { mayCustomise, useAppearance } from '../../data/vivid'
import { turnNotificationsOff, turnNotificationsOn, useNotifying } from '../../data/notifying'
import { turnLocationOff, turnLocationOn, useLocating } from '../../data/locating'
import { PersonAvatar } from '../../ui/Person'
import { Button } from '../../ui/button'
import { Face } from '../../ui/Face'
import { Segmented } from '../../ui/Segmented'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select'
import { Customise } from '../vivid/Customise'
import { Egress } from './Egress'
import { Name } from './Name'
import { Awaiting, Refusal, Row, Section } from './Parts'

const THEMES = [
  { value: 'system', label: 'System', name: 'Follow the system' },
  { value: 'light', label: 'Light', name: 'Light' },
  { value: 'dark', label: 'Dark', name: 'Dark' },
] as const satisfies ReadonlyArray<{ value: Theme; label: string; name: string }>

/** Every zone the platform knows, so the list is never out of date with the runtime that uses it. */
const ZONES = ['UTC', ...Intl.supportedValuesOf('timeZone')]

/**
 * The Person's own settings: what they are called, how Vivid looks, the time zone it reads "tomorrow at 9" in, whether
 * it tells them when something needs them, and the way out. They are the same in every workspace.
 */
export function General({ me }: { me: MeResponse }) {
  const settings = useLive(live.settings)
  const [stuck, setStuck] = useState(false)

  /** Signs out, and says so when it did not happen: a reload would land them still signed in. */
  function leave() {
    return Effect.gen(function* () {
      const left = yield* running(signOut)
      if (Result.isFailure(left)) {
        setStuck(true)
        return
      }
      // Nothing of this Person stays in the browser for whoever opens it next. It is erased
      // before the page reloads, or the reload would start from it.
      yield* sessionEnded
      reload('/')
    })
  }

  return (
    <>
      <Section title="You">
        <div className="flex items-center gap-3 px-4 py-3">
          <PersonAvatar name={me.person.name} image={me.person.image ?? null} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-title font-title text-ink">{me.person.name}</span>
            <span className="block truncate text-label text-ink-3">{me.person.email}</span>
          </span>
          <Button variant="ghost" onClick={() => void act(leave())}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        </div>
        {stuck && (
          <p role="alert" className="px-4 pb-3 text-label text-danger">
            Couldn’t reach Vivid to sign you out. You’re still signed in. Try again.
          </p>
        )}
        <Name current={me.person.name} />
      </Section>
      <VividSection me={me} />
      {LiveState.$is('Ready')(settings) ? (
        <Preferences settings={settings.value} />
      ) : (
        <Awaiting state={settings} />
      )}
      <ThisApp />
    </>
  )
}

/**
 * Which build is on screen (`data/build.ts`). It is last on the page, where the phone's Settings
 * says the same about itself, and it is text: there is nothing here to press.
 *
 * It is here so that "it is merged" and "it is deployed" can be checked where the Person is. The
 * server's line is apart from the page's because they can differ: a page left open keeps running
 * the build it was loaded with, and the desktop app runs the page it was installed with.
 */
function ThisApp() {
  const server = useLive(live.build)
  return (
    <Section title="This app">
      {Option.isSome(desktopVersion) && <DesktopVersion version={desktopVersion.value} />}
      <Row label="Build">
        <Value>{pageWords}</Value>
      </Row>
      <Row label="Server">
        {LiveState.$match(server, {
          // Still, and the width of a short commit, so the row does not jump when it answers.
          Loading: () => <i aria-hidden className="h-3 w-14 rounded-full bg-wash-hover" />,
          Ready: ({ value }) => <Value>{serverWords(value)}</Value>,
          Failed: ({ failure }) => <Value>{failure.message}</Value>,
        })}
      </Row>
    </Section>
  )
}

/** The desktop app's own version, which only a new install changes. */
function DesktopVersion({ version }: { version: Atom.Atom<AsyncResult.AsyncResult<string>> }) {
  const result = useAtomValue(version)
  return <Row label="Version">{AsyncResult.isSuccess(result) && <Value>{result.value}</Value>}</Row>
}

/** A value read out on the right of a row, quieter than what it names. */
function Value({ children }: { children: string }) {
  return <span className="text-label text-ink-3 tabular-nums">{children}</span>
}

/**
 * Vivid as it is here: its face, its name, and the way to change them. In a Company only an owner
 * or admin is offered the change, because everyone there shares one Vivid; a member is told so.
 */
function VividSection({ me }: { me: MeResponse }) {
  const { name } = useAppearance()
  const [customising, setCustomising] = useState(false)
  const editable = mayCustomise(me)
  return (
    <Section title="Vivid">
      <div className="flex items-center gap-3 px-4 py-3">
        <Face size={40} label="" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-title font-title text-ink">{name}</span>
          <span className="block text-label text-pretty text-ink-3">
            {editable
              ? 'Change Vivid’s name and colour everywhere it appears.'
              : 'Only an owner or admin of this company can change its name and colour.'}
          </span>
        </span>
        {editable && (
          <Button variant="outline" aria-haspopup="dialog" onClick={() => setCustomising(true)}>
            Customise
          </Button>
        )}
      </div>
      {customising && <Customise onClose={() => setCustomising(false)} />}
    </Section>
  )
}

function Preferences({ settings }: { settings: Settings }) {
  const egress = useLive(live.egress)
  const [unsaved, setUnsaved] = useState(false)
  /**
   * Saves the one setting that was changed and shows it at once. Only that field is sent: sending
   * all three from what this screen happens to hold would write back a stale value over a change
   * made on another device a moment ago.
   *
   * When the save does not land the control goes back to what the server has, and this says so.
   * It used to go back in silence, which read as a click that did nothing.
   */
  function save(edit: PatchSettingsRequest) {
    return Effect.gen(function* () {
      setUnsaved(false)
      const saved = yield* changing(
        (client) => client.PatchSettings(edit),
        () =>
          live.settings.expect(
            (current) =>
              new Settings({
                personId: current.personId,
                theme: edit.theme === undefined ? current.theme : edit.theme,
                timezone: edit.timezone === undefined ? current.timezone : edit.timezone,
                egress: edit.egress === undefined ? current.egress : edit.egress,
                location: current.location,
              }),
          ),
      )
      if (Result.isFailure(saved)) setUnsaved(true)
    })
  }
  // The platform's list leaves out UTC, and a zone saved elsewhere may be one this browser does
  // not list; the Person's own zone is always an option, or the select would show a different one.
  // Each zone with the words it is shown in: the platform writes "New_York". The list is what
  // lets the closed select show those words and not the raw value.
  const zones = (ZONES.includes(settings.timezone) ? ZONES : [settings.timezone, ...ZONES]).map(
    (zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }),
  )
  return (
    <>
      <Refusal
        message={unsaved ? 'Couldn’t reach Vivid, so that change wasn’t saved. Try again.' : null}
      />
      <Section title="Preferences">
        <Row label="Appearance" detail="How Vivid looks on this device and your other devices.">
          <Segmented
            label="Appearance"
            value={settings.theme}
            options={THEMES}
            onChange={(next) => {
              theme.set(next)
              void act(save(new PatchSettingsRequest({ theme: next })))
            }}
          />
        </Row>
        <Row label="Time zone" detail="Times like “tomorrow at 9” use this.">
          <Select
            value={settings.timezone}
            items={zones}
            // A select can be emptied in principle; this one always holds a zone, so only a
            // zone is ever saved.
            onValueChange={(zone) => {
              if (zone !== null) void act(save(new PatchSettingsRequest({ timezone: zone })))
            }}
          >
            <SelectTrigger size="sm" aria-label="Time zone" className="max-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {zones.map((zone) => (
                  <SelectItem key={zone.value} value={zone.value}>
                    {zone.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Row>
        {Option.isNone(desktopVersion) && <Away />}
        {Option.isNone(desktopVersion) && <Whereabouts location={settings.location} />}
        <Egress
          enabled={settings.egress}
          status={egress}
          onChange={(egress) => void act(save(new PatchSettingsRequest({ egress })))}
        />
      </Section>
    </>
  )
}

/** What this browser's row says, and the one thing it offers to do, when it offers one. */
interface AwayWords {
  readonly detail: string
  readonly action: Option.Option<{ readonly label: string; readonly press: () => void }>
}

const HERE = 'In this browser, even when Vivid is closed.'
const turnOn = Option.some({ label: 'Turn on', press: turnNotificationsOn })
const turnOff = Option.some({ label: 'Turn off', press: turnNotificationsOff })

/** The row's words for each reading of the machine (`@vivid/state` `notifying.ts`). */
const awayWords = (reading: notifying.Reading): AwayWords =>
  notifying.Reading.match(reading, {
    Starting: () => ({ detail: HERE, action: Option.none() }),
    Unsupported: () => ({
      detail: 'This browser cannot notify you while Vivid is closed.',
      action: Option.none(),
    }),
    Blocked: () => ({
      detail: 'This browser blocks notifications from Vivid. Allow them in its site settings.',
      action: turnOn,
    }),
    Off: () => ({ detail: HERE, action: turnOn }),
    TurningOn: () => ({ detail: HERE, action: turnOff }),
    On: () => ({ detail: HERE, action: turnOff }),
    TurningOff: () => ({ detail: HERE, action: turnOn }),
    Kept: () => ({
      detail: 'Still on: Vivid could not be reached to turn it off. Try again.',
      action: turnOff,
    }),
    Refused: ({ reason }) => ({
      detail: {
        Dismissed: 'The question was closed without an answer. Turn it on to be asked again.',
        Unavailable: 'This browser could not be set up for notifications. Try again.',
        Unreachable: 'Vivid could not be reached. Try again.',
      }[reason],
      action: turnOn,
    }),
  })

/**
 * Whether this browser is notified while Vivid is closed (`data/notifying.ts`). It belongs to
 * this browser: another browser or the phone is turned on there. The desktop app has no such
 * notifications and does not show the row. The button is held while the browser or the server is
 * being waited on, and the machine refuses a press then as well.
 */
function Away() {
  const reading = useNotifying()
  const { detail, action } = awayWords(reading)
  return (
    <Row label="Notify me when something needs me" detail={detail}>
      {Option.isSome(action) && (
        <Button
          variant="outline"
          disabled={notifying.isWaiting(reading)}
          onClick={action.value.press}
        >
          {action.value.label}
        </Button>
      )}
    </Row>
  )
}

const OPEN_ONLY = 'Read only while Vivid is open.'
const shareOn = Option.some({ label: 'Turn on', press: turnLocationOn })
const shareOff = Option.some({ label: 'Turn off', press: turnLocationOff })

/**
 * The row's words for the machine (`@vivid/state` `locating.ts`) and what the Person shares now,
 * and the press it offers: the one that changes what the switch shows.
 */
const whereaboutsWords = (reading: locating.Reading, location: LocationSharing): AwayWords => {
  const on = locating.shows(reading, !LocationSharing.guards.Off(location))
  const action = on ? shareOff : shareOn
  return Option.match(locating.refusalOf(reading), {
    onSome: (reason) => ({
      detail: {
        Blocked: 'This browser blocks location for Vivid. Allow it in its site settings.',
        Dismissed: 'The question was closed without an answer. Turn it on to be asked again.',
        Unavailable: 'This browser could not say where it is. Try again.',
        Unreachable: 'Vivid could not be reached. Try again.',
      }[reason],
      action,
    }),
    onNone: () => ({
      detail: on
        ? `On. ${OPEN_ONLY}`
        : `For things near you, travel times and bookings. ${OPEN_ONLY}`,
      action,
    }),
  })
}

/**
 * Whether Vivid is told where the Person is (`data/locating.ts`). Off until they turn it on, and
 * the browser's own question is asked only then. The desktop app cannot read where it is and does
 * not show the row. The button is held while the browser or the server is being waited on.
 */
function Whereabouts({ location }: { location: LocationSharing }) {
  const reading = useLocating()
  const { detail, action } = whereaboutsWords(reading, location)
  return (
    <Row label="Share my location" detail={detail}>
      {Option.isSome(action) && (
        <Button
          variant="outline"
          disabled={locating.isWaiting(reading)}
          onClick={action.value.press}
        >
          {action.value.label}
        </Button>
      )}
    </Row>
  )
}
