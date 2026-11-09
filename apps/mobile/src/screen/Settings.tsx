import { useAtomSet } from '@effect/atom-react'
import {
  LocationSharing,
  PatchSettingsRequest,
  Settings as SettingsRecord,
  ChannelStanding,
  Workspace,
  type ChannelLink,
  type Theme,
  mayChangeAppearance,
} from '@vivid/contracts'
import { channelWords, locating, naming, notifying } from '@vivid/state'
import { Data, Effect, Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { Linking, ScrollView, Switch, View } from 'react-native'
import { followThemeAtom } from '../data/appearance'
import { reportsWords, runningWords } from '../data/build'
import { door } from '../data/door'
import { warn } from '../data/haptics'
import { refusalOf, useLive, useLiveData, useLiveValue, type LiveData } from '../data/live'
import { turnNotificationsOff, turnNotificationsOn, useNotifying } from '../data/notifying'
import { turnLocationOff, turnLocationOn, useLocating } from '../data/locating'
import { running, version, writeMoment } from '../data/running'
import { serverName } from '../data/server'
import { openNaming, useNaming } from '../data/name'
import { leaveAtom } from '../data/signing'
import { reports } from '../data/telemetry'
import { useAppearance } from '../data/vivid'
import { Avatar, pictureOf } from '../ui/Avatar'
import { Face } from '../ui/Face'
import { Screen } from '../ui/Screen'
import { Row, Section } from '../ui/List'
import { Live } from '../ui/Live'
import { NameSheet } from '../ui/Sheet'
import { confirmDestructive, Label, Notice, Segmented, Skeleton, styles } from '../ui/ui'
import { useGo, useMe } from '../workspace'
import { useTheme } from '../theme'
import { Record } from './settings/Record'
import { Devices } from './settings/Devices'
import { Name } from './settings/Name'
import { Rules } from './settings/Rules'
import { Work } from './settings/Work'
import { Customise } from './vivid/Customise'
import { Themes } from './settings/Themes'
import { useFlow } from './integration/flow'
import { start } from '../data/app'

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies ReadonlyArray<{ value: Theme; label: string }>

/** What is open over Settings. One thing at a time. */
type Over = Data.TaggedEnum<{
  Nothing: {}
  Devices: {}
  Zone: {}
  Customise: {}
  Rules: {}
  Record: {}
  Work: {}
}>
const Over = Data.taggedEnum<Over>()

/**
 * What belongs to the workspace and is done in a sheet over Settings: what Vivid may do without
 * asking, and what it did. Each row opened the web app in the phone's browser before; the server
 * answers both over the app's own connection, so they are done here, where the Person already
 * is. Integrations is the row before them and a screen of its own (`Shared`).
 */
const IN_PLACE = [
  { title: 'Rules', detail: 'What Vivid needs to ask you about first.', over: Over.Rules() },
  { title: 'Record', detail: 'Vivid’s actions and who they were for.', over: Over.Record() },
] as const satisfies ReadonlyArray<{ title: string; detail: string; over: Over }>

/**
 * Settings: the Person's name and own preferences and what Vivid has kept about them, which are the same
 * on every device; this phone's connection; what belongs to the workspace they are working in;
 * and the way out.
 */
export function Settings() {
  const me = useMe()
  const data = useLiveData()
  const go = useGo()
  const settings = useLive(data.live.settings)
  const [over, setOver] = useState<Over>(Over.Nothing())
  const close = () => setOver(Over.Nothing())
  const flow = useFlow()
  const setSearch = useAtomSet(data.serviceSearch)
  // The name sheet is the session's naming machine, not one of the sheets in `over`.
  const renaming = useNaming()

  /**
   * Opens the Integrations page as a new visit. The search is the session's, so the catalog's
   * answer stays warm, and the flow is the shell's, so a card in a Thread can use it; what was
   * typed and what earlier presses left said are that visit's, and the next one starts from the
   * services most people want. It is done by the press, so the page needs no effect to do it.
   */
  const openIntegrations = () => {
    setSearch('')
    flow.rest()
    go.navigate('Integrations')
  }

  const leave = () =>
    confirmDestructive({
      title: 'Sign out of this phone?',
      detail: 'Your threads stay where they are. You will need to sign in here again.',
      action: 'Sign out',
      onConfirm: () => {
        warn()
        door.set(leaveAtom, data.session)
      },
    })

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column]}
      >
        <Section title="You">
          <Row
            leading={<Avatar name={me.person.name} image={pictureOf(me.person)} size={40} />}
            title={me.person.name}
            detail={me.person.email}
          />
          <Row
            title="Your name"
            detail="What Vivid calls you, and what others see beside your messages."
            wrap
            onPress={() => openNaming(data)}
          />
          <Row
            title="What Vivid knows"
            detail="What Vivid remembers about you. Correct or remove anything."
            onPress={() => go.navigate('Memory')}
          />
          <Row
            title="What Vivid is doing"
            detail="What runs while you are away, and a way to stop it."
            onPress={() => setOver(Over.Work())}
          />
        </Section>
        <VividRow workspace={me.workspace} onCustomise={() => setOver(Over.Customise())} />
        <Section title="Devices">
          <Row
            title="Your computers"
            detail="Choose which of your computers Vivid can use."
            onPress={() => setOver(Over.Devices())}
          />
        </Section>
        <TextVivid onOpen={() => go.navigate('Texting')} />
        <Live state={settings} loading={<Skeleton rows={3} />}>
          {(value) => <Preferences settings={value} onZone={() => setOver(Over.Zone())} />}
        </Live>
        {/* Where this phone's Vivid is means nothing to a Person; a developer checks it here. */}
        {__DEV__ && (
          <Section title="This phone">
            <Row title="Server" detail={serverName(data.session.server)} />
          </Section>
        )}
        <Shared
          workspace={me.workspace}
          onPeople={() => go.navigate('People')}
          onIntegrations={openIntegrations}
          onOpen={setOver}
        />
        <Section title="Account">
          <Row title="Sign out" danger onPress={leave} />
        </Section>
        <ThisApp />
      </ScrollView>
      {Over.$is('Devices')(over) && <Devices onClose={close} />}
      {Over.$is('Zone')(over) && <Zone onClose={close} />}
      {Over.$is('Customise')(over) && <Customise onClose={close} />}
      {Over.$is('Rules')(over) && <Rules onClose={close} />}
      {Over.$is('Record')(over) && <Record onClose={close} />}
      {Over.$is('Work')(over) && <Work onClose={close} />}
      {naming.isOpen(renaming) && <Name current={me.person.name} />}
    </Screen>
  )
}

/**
 * What this phone is running: the app's version, and the update it has taken since it was
 * installed (`data/build.ts`). It is last on the page, where a phone's own Settings says the
 * same about itself, and it is text: there is nothing here to press.
 *
 * It is here so that "the update is out" can be checked on the phone. An update is taken in the
 * background and starts the next time the app does, so until this line changes, what was sent has
 * not started here yet.
 *
 * The last line says whether this install can send its errors and crashes. That needs a part only
 * an install carries (`data/telemetry.ts`), and two installs with and without it say the same
 * version, so this line is the only place the difference shows.
 */
function ThisApp() {
  return (
    <Section title="This app">
      {Option.isSome(version) && <Row title="Version" detail={version.value} />}
      <Row title="Update" detail={runningWords(running, writeMoment)} wrap />
      <Row title="Error reports" detail={reportsWords(reports())} wrap />
    </Section>
  )
}

/**
 * Vivid as it is here: its face, its name, and the way to change them. In a Company only an owner
 * or admin is offered the change, because everyone there shares one Vivid; a member is told so
 * and the row is not a button.
 */
function VividRow({ workspace, onCustomise }: { workspace: Workspace; onCustomise: () => void }) {
  const { name } = useAppearance()
  const editable = mayChangeAppearance(workspace)
  return (
    <Section title="Vivid">
      <Row
        leading={<Face size={40} label="" />}
        title={name}
        detail={
          editable
            ? 'Change Vivid’s name and colour everywhere it appears.'
            : 'Only an owner or admin of this company can change its name and colour.'
        }
        wrap
        onPress={editable ? onCustomise : undefined}
      />
    </Section>
  )
}

/**
 * One app's part of the "Text Vivid" row. A connected app says the number to text, because that is
 * what the Person came for and it saves opening the screen to read it; any other standing is said
 * in its usual word.
 */
const standingOf = ({ channel, standing }: ChannelLink) =>
  ChannelStanding.guards.Connected(standing)
    ? `${channel}: text ${standing.textTo}`
    : `${channel}: ${channelWords(standing).toLowerCase()}`

/**
 * The way to texting Vivid from a messages app. The row says where each app stands, read from
 * the same live list the screen behind it draws, so "connected" is seen without opening it. Before
 * that list has answered it says what the screen is for instead of guessing a standing.
 */
function TextVivid({ onOpen }: { onOpen: () => void }) {
  const data = useLiveData()
  const channels = useLiveValue(data.live.channels)
  const standings = Option.match(channels, {
    onNone: () => [],
    onSome: (value) => value.channels.map(standingOf),
  })
  return (
    <Section title="Text Vivid">
      <Row
        title="iMessage and WhatsApp"
        detail={
          standings.length === 0
            ? 'Connect your number, then text Vivid from your phone.'
            : standings.join(' · ')
        }
        wrap
        onPress={onOpen}
      />
    </Section>
  )
}

/**
 * Who the Person shares with here: in a Company, the way to its people; in their own space, how
 * to make one. Sharing only exists inside a Company, so the two are different rows.
 */
function Sharing({ workspace, onPeople }: { workspace: Workspace; onPeople: () => void }) {
  return Workspace.match(workspace, {
    Personal: () => (
      <Row
        title="You are working in your own space"
        detail="To share threads, a library and integrations, create a company from the menu on Home."
      />
    ),
    Company: () => (
      <Row title="People" detail="Members, invitations and roles." onPress={onPeople} />
    ),
  })
}

/**
 * What belongs to the workspace the Person is working in, under that workspace's name as the web
 * app has it. Integrations, rules and the record exist in a Company and in a Person's own space
 * alike. Integrations is a screen of its own; the other two open a sheet over this screen
 * (`IN_PLACE`). None of them leaves the app.
 */
function Shared({
  workspace,
  onPeople,
  onIntegrations,
  onOpen,
}: {
  workspace: Workspace
  onPeople: () => void
  /** Goes to the Integrations page. */
  onIntegrations: () => void
  /** Opens one of the workspace's sheets over Settings. */
  onOpen: (over: Over) => void
}) {
  return (
    <Section
      title={Workspace.match(workspace, {
        Personal: () => 'Your space',
        Company: ({ company }) => company.name,
      })}
    >
      <Sharing workspace={workspace} onPeople={onPeople} />
      <Row
        title="Integrations"
        detail="The services Vivid can use for you."
        onPress={onIntegrations}
      />
      {IN_PLACE.map((sheet) => (
        <Row
          key={sheet.title}
          title={sheet.title}
          detail={sheet.detail}
          onPress={() => onOpen(sheet.over)}
        />
      ))}
    </Section>
  )
}

/** One setting with a control too wide to sit beside its name: the name, a line, then the control. */
function Setting({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children: ReactNode
}) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 10 }}>
      <View style={{ gap: 1 }}>
        <Label>{title}</Label>
        <Label size="label" tone="ink-2">
          {detail}
        </Label>
      </View>
      {children}
    </View>
  )
}

/**
 * Saves the one setting that was changed and shows it at once. Only that field is sent, and only
 * that field is expected to change: sending all three from what this screen happens to hold wrote
 * a stale value back over a change made on another device a moment ago.
 *
 * The expectation is laid over whatever the live settings are when it is read, not over the
 * settings this screen was drawn with, for the same reason.
 */
const saveSettings = (data: LiveData, edit: PatchSettingsRequest) =>
  data.changing(
    (client) => client.PatchSettings(edit),
    () =>
      data.live.settings.expect(
        (current) =>
          new SettingsRecord({
            personId: current.personId,
            theme: edit.theme === undefined ? current.theme : edit.theme,
            timezone: edit.timezone === undefined ? current.timezone : edit.timezone,
            // Not a phone setting: carried through as the server has it.
            egress: current.egress,
            location: current.location,
          }),
      ),
  )

/**
 * How Vivid looks, the time zone it reads "tomorrow at 9" in, and whether it tells the Person
 * when something needs them. A change shows at once and the server's next result confirms it; a
 * refused change is put back and said.
 */
function Preferences({ settings, onZone }: { settings: SettingsRecord; onZone: () => void }) {
  const data = useLiveData()
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  function save(edit: PatchSettingsRequest) {
    return start(
      Effect.gen(function* () {
        setRefused(refusalOf(yield* saveSettings(data, edit)))
      }),
    )
  }

  return (
    <>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Section title="Preferences">
        <Setting title="Appearance" detail="Light or dark, on this phone and your other devices.">
          <Segmented
            label="Appearance"
            value={settings.theme}
            options={THEMES}
            onChange={(theme) => {
              // The phone changes at once; the Person's other devices follow their settings.
              door.set(followThemeAtom, theme)
              void save(new PatchSettingsRequest({ theme }))
            }}
          />
        </Setting>
        <Setting title="Theme" detail="Vivid’s colours on this phone.">
          <Themes />
        </Setting>
        <Away />
        <Whereabouts location={settings.location} />
        <Row
          title="Time zone"
          detail={`${settings.timezone.replaceAll('_', ' ')}. Times like “tomorrow at 9” use this.`}
          onPress={onZone}
        />
      </Section>
    </>
  )
}

/**
 * The time zone, written as its IANA name. The server is what knows every zone, so it is what
 * says whether a name is one; the sheet stays open with the server's sentence when it is not.
 */
function Zone({ onClose }: { onClose: () => void }) {
  const data = useLiveData()
  const settings = useLiveValue(data.live.settings)
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (Option.isNone(settings)) return null
  return (
    <NameSheet
      title="Time zone"
      detail={`Enter a time zone name. This phone is in ${here}.`}
      label="Time zone"
      initial={settings.value.timezone}
      placeholder={here}
      action="Save"
      maxLength={64}
      onClose={onClose}
      onSave={(timezone) =>
        saveSettings(data, new PatchSettingsRequest({ timezone })).pipe(Effect.map(refusalOf))
      }
    />
  )
}

const HERE = 'On this phone, even when Vivid is closed.'

/** The row's words for each reading of the machine (`@vivid/state` `notifying.ts`). */
const awayDetail = (reading: notifying.Reading): string =>
  notifying.Reading.match(reading, {
    Starting: () => HERE,
    Unsupported: () => 'Notifications while Vivid is closed are not available on this build.',
    Blocked: () => 'Notifications are off for Vivid in this phone’s settings. Open them to allow.',
    Off: () => HERE,
    TurningOn: () => HERE,
    On: () => HERE,
    TurningOff: () => HERE,
    Kept: () => 'Still on: Vivid could not be reached to turn it off. Try again.',
    Refused: ({ reason }) =>
      ({
        Dismissed: 'The question was closed without an answer. Turn it on to be asked again.',
        Unavailable: 'This phone could not be set up for notifications. Try again.',
        Unreachable: 'Vivid could not be reached. Try again.',
      })[reason],
  })

/**
 * Whether this phone is notified while Vivid is closed (`data/notifying.ts`). It belongs to this
 * phone: a browser or another phone is turned on there. The switch is held while the phone or
 * the server is being waited on, and the machine refuses a press then as well. Once the Person
 * refused, only the phone's own settings can allow it, so the row opens them.
 */
function Away() {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const reading = useNotifying()
  const blocked = notifying.Reading.guards.Blocked(reading)
  return (
    <Row
      title="Notifications"
      detail={awayDetail(reading)}
      wrap
      onPress={blocked ? () => void Linking.openSettings() : undefined}
      trailing={
        <Switch
          accessibilityLabel="Notifications"
          value={notifying.isOn(reading)}
          disabled={
            blocked || notifying.isWaiting(reading) || notifying.Reading.guards.Unsupported(reading)
          }
          trackColor={{ true: c.primary, false: c['subtle-strong'] }}
          onValueChange={(on) => (on ? turnNotificationsOn(data) : turnNotificationsOff(data))}
        />
      }
    />
  )
}

const OPEN_ONLY = 'Read only while Vivid is open.'

/**
 * The row's words: why the last press did not finish, else what the Person shares now. A place
 * the phone named is said back, so they can see what Vivid is told.
 */
const sharingDetail = (reading: locating.Reading, location: LocationSharing): string =>
  Option.match(locating.refusalOf(reading), {
    onSome: (reason) =>
      ({
        Blocked: 'Location is off for Vivid in this phone’s settings. Open them to allow.',
        Dismissed: 'The question was closed without an answer. Turn it on to be asked again.',
        Unavailable: 'This phone could not say where it is. Try again.',
        Unreachable: 'Vivid could not be reached. Try again.',
      })[reason],
    onNone: () =>
      LocationSharing.match(location, {
        Off: () => `For things near you, travel times and bookings. ${OPEN_ONLY}`,
        Waiting: () => `On. ${OPEN_ONLY}`,
        Known: ({ reading: last }) =>
          last.place === null ? `On. ${OPEN_ONLY}` : `Near ${last.place}. ${OPEN_ONLY}`,
      }),
  })

/**
 * Whether Vivid is told where the Person is (`data/locating.ts`). Off until they turn it on, and
 * the phone's own question is asked only then. The switch is held while the phone or the server
 * is being waited on. Once the Person refused the question, only the phone's settings can allow
 * it, so the row opens them.
 */
function Whereabouts({ location }: { location: LocationSharing }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const reading = useLocating()
  const blocked = Option.contains(locating.refusalOf(reading), 'Blocked')
  return (
    <Row
      title="Share my location"
      detail={sharingDetail(reading, location)}
      wrap
      onPress={blocked ? () => void Linking.openSettings() : undefined}
      trailing={
        <Switch
          accessibilityLabel="Share my location"
          value={locating.shows(reading, !LocationSharing.guards.Off(location))}
          disabled={locating.isWaiting(reading)}
          trackColor={{ true: c.primary, false: c['subtle-strong'] }}
          onValueChange={(on) => (on ? turnLocationOn(data) : turnLocationOff(data))}
        />
      }
    />
  )
}
