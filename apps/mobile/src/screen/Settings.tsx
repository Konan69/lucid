import { useAtomSet } from '@effect/atom-react'
import {
  PatchSettingsRequest,
  Settings as SettingsRecord,
  ChannelStanding,
  Workspace,
  type ChannelLink,
  type Theme,
  mayChangeAppearance,
} from '@vivid/contracts'
import { channelWords } from '@vivid/state'
import { Data, Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { ScrollView, Switch, View } from 'react-native'
import { followThemeAtom } from '../data/appearance'
import { runningWords } from '../data/build'
import { door } from '../data/door'
import { warn } from '../data/haptics'
import { refusalOf, useLive, useLiveData, useLiveValue, type LiveData } from '../data/live'
import { running, version, writeMoment } from '../data/running'
import { serverName } from '../data/server'
import { leaveAtom } from '../data/signing'
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
import { Rules } from './settings/Rules'
import { Customise } from './vivid/Customise'
import { Themes } from './settings/Themes'
import { useFlow } from './integration/flow'

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies ReadonlyArray<{ value: Theme; label: string }>

/** What is open over Settings. One thing at a time. */
type Over = Data.TaggedEnum<{
  Nothing: {}
  Zone: {}
  Customise: {}
  Rules: {}
  Record: {}
}>
const Over = Data.taggedEnum<Over>()

/**
 * What belongs to the workspace and is done in a sheet over Settings: what Vivid may do without
 * asking, and what it did. Each row opened the web app in the phone's browser before; the server
 * answers both over the app's own connection, so they are done here, where the Person already
 * is. Integrations is the row before them and a screen of its own (`Shared`).
 */
const IN_PLACE = [
  { title: 'Rules', detail: 'What Vivid must ask about first.', over: Over.Rules() },
  { title: 'Record', detail: 'What Vivid did, and for whom.', over: Over.Record() },
] as const satisfies ReadonlyArray<{ title: string; detail: string; over: Over }>

/**
 * Settings: the Person's own preferences and what Vivid has kept about them, which are the same
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
            title="What Vivid knows"
            detail="What it has kept about you, to correct or remove."
            onPress={() => go.navigate('Memory')}
          />
        </Section>
        <VividRow workspace={me.workspace} onCustomise={() => setOver(Over.Customise())} />
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
      {Over.$is('Zone')(over) && <Zone onClose={close} />}
      {Over.$is('Customise')(over) && <Customise onClose={close} />}
      {Over.$is('Rules')(over) && <Rules onClose={close} />}
      {Over.$is('Record')(over) && <Record onClose={close} />}
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
 */
function ThisApp() {
  return (
    <Section title="This app">
      {Option.isSome(version) && <Row title="Version" detail={version.value} />}
      <Row title="Update" detail={runningWords(running, writeMoment)} wrap />
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
            ? 'Its name and colour, wherever it appears.'
            : 'An owner or admin of this Company chooses its name and colour.'
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
      <Row title="People" detail="Who is here, invitations and roles." onPress={onPeople} />
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
  data.change(
    (client) => client.PatchSettings(edit),
    () =>
      data.live.settings.expect(
        (current) =>
          new SettingsRecord({
            personId: current.personId,
            theme: edit.theme === undefined ? current.theme : edit.theme,
            timezone: edit.timezone === undefined ? current.timezone : edit.timezone,
            notify: edit.notify === undefined ? current.notify : edit.notify,
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
  const { colors: c } = useTheme()
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  async function save(edit: PatchSettingsRequest) {
    setRefused(refusalOf(await saveSettings(data, edit)))
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
        <Setting title="Theme" detail="The colours Vivid is painted in on this phone.">
          <Themes />
        </Setting>
        <Row
          title="Notifications"
          detail="Tell me when something finishes or needs me."
          trailing={
            // The system's own switch, in the theme's primary: on or off is what it is for.
            <Switch
              accessibilityLabel="Notifications"
              value={settings.notify}
              trackColor={{ true: c.primary, false: c['subtle-strong'] }}
              onValueChange={(notify) => void save(new PatchSettingsRequest({ notify }))}
            />
          }
        />
        <Row
          title="Time zone"
          detail={`${settings.timezone.replaceAll('_', ' ')}. Routines and “tomorrow at 9” use this.`}
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
      detail={`Write a zone by its name, like ${here}, which is where this phone is.`}
      label="Time zone"
      initial={settings.value.timezone}
      placeholder={here}
      action="Save"
      maxLength={64}
      onClose={onClose}
      onSave={async (timezone) =>
        refusalOf(await saveSettings(data, new PatchSettingsRequest({ timezone })))
      }
    />
  )
}
