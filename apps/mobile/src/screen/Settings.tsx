import {
  PatchSettingsRequest,
  Settings as SettingsRecord,
  Workspace,
  type Theme,
} from '@vivid/contracts'
import { Data, Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { Linking, ScrollView, View } from 'react-native'
import { followThemeAtom } from '../data/appearance'
import { door } from '../data/door'
import { warn } from '../data/haptics'
import { refusalOf, useLive, useLiveData, useLiveValue, type LiveData } from '../data/live'
import { connectionsAddress, recordAddress, rulesAddress, serverName } from '../data/server'
import { leaveAtom } from '../data/signing'
import { Avatar, pictureOf } from '../ui/Avatar'
import { Header, Screen } from '../ui/Header'
import { Row, Section } from '../ui/List'
import { Live } from '../ui/Live'
import { NameSheet } from '../ui/Sheet'
import { confirmDestructive, Label, Notice, Segmented, Skeleton, styles } from '../ui/ui'
import { useGo, useMe } from '../workspace'
import { Devices } from './settings/Devices'

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies ReadonlyArray<{ value: Theme; label: string }>

const SWITCH = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const

/**
 * The parts of Settings that are done in the web app, which the server also serves: each row
 * opens that section in the phone's browser instead of pretending the phone can do it.
 */
const IN_BROWSER = [
  {
    title: 'Integrations',
    detail: 'Connect services in your browser.',
    address: connectionsAddress,
  },
  { title: 'Rules', detail: 'What Vivid must ask about first.', address: rulesAddress },
  { title: 'Record', detail: 'What Vivid did, and for whom.', address: recordAddress },
] as const

/** What is open over Settings. One thing at a time. */
type Over = Data.TaggedEnum<{ Nothing: {}; Zone: {}; Devices: {} }>
const Over = Data.taggedEnum<Over>()

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

  const leave = () =>
    confirmDestructive({
      title: 'Sign out of this phone?',
      detail:
        'Your threads stay where they are. You will need a code or your password to sign in here again.',
      action: 'Sign out',
      onConfirm: () => {
        warn()
        door.set(leaveAtom, data.session)
      },
    })

  return (
    <Screen>
      <Header title="Settings" onBack={go.goBack} />
      <ScrollView contentContainerStyle={[styles.page, styles.column]}>
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
        <Live state={settings} loading={<Skeleton rows={3} />}>
          {(value) => <Preferences settings={value} onZone={() => setOver(Over.Zone())} />}
        </Live>
        <Section title="This phone">
          <Row title="Server" detail={serverName(data.session.server)} />
          <Row
            title="Sign in another device"
            detail="Enter the code it shows, and it signs in as you."
            onPress={() => setOver(Over.Devices())}
          />
        </Section>
        <Shared workspace={me.workspace} onPeople={() => go.navigate('People')} />
        <Section title="Account">
          <Row title="Sign out" danger onPress={leave} />
        </Section>
      </ScrollView>
      {Over.$is('Devices')(over) && <Devices onClose={close} />}
      {Over.$is('Zone')(over) && <Zone onClose={close} />}
    </Screen>
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
        detail="To share threads, a library and integrations, create a company from the switcher at the top of Home."
      />
    ),
    Company: () => (
      <Row title="People" detail="Who is here, invitations and roles." onPress={onPeople} />
    ),
  })
}

/**
 * What belongs to the workspace the Person is working in, under that workspace's name as the web
 * app has it. Connections, rules and the record exist in a Company and in a Person's own space
 * alike and are done in the web app, so those rows leave for the browser and are marked as
 * leaving.
 */
function Shared({ workspace, onPeople }: { workspace: Workspace; onPeople: () => void }) {
  const data = useLiveData()
  const [unopened, setUnopened] = useState<Option.Option<string>>(Option.none())

  /** Hands an address to the phone's browser, and says so here if the phone would not take it. */
  const open = (address: string) => {
    setUnopened(Option.none())
    void Linking.openURL(address).then(
      () => undefined,
      () => setUnopened(Option.some('That page could not be opened in your browser.')),
    )
  }

  return (
    <>
      {Option.isSome(unopened) && <Notice message={unopened.value} />}
      <Section
        title={Workspace.match(workspace, {
          Personal: () => 'Your space',
          Company: ({ company }) => company.name,
        })}
      >
        <Sharing workspace={workspace} onPeople={onPeople} />
        {IN_BROWSER.map((page) => (
          <Row
            key={page.title}
            outside
            title={page.title}
            detail={page.detail}
            onPress={() => open(page.address(data.session.server))}
          />
        ))}
      </Section>
    </>
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
        <Label size="label" tone="ink-3">
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
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  async function save(edit: PatchSettingsRequest) {
    setRefused(refusalOf(await saveSettings(data, edit)))
  }

  return (
    <>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Section title="Preferences">
        <Setting title="Appearance" detail="How Vivid looks on this phone and your other devices.">
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
        <Setting title="Notifications" detail="Tell me when something finishes or needs me.">
          <Segmented
            label="Notifications"
            value={settings.notify ? 'on' : 'off'}
            options={SWITCH}
            onChange={(next) => void save(new PatchSettingsRequest({ notify: next === 'on' }))}
          />
        </Setting>
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
