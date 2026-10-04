import { ChannelStanding, type Channel, type ChannelLink } from '@vivid/contracts'
import {
  channelWords,
  codeEnding,
  connectChannel,
  disconnectChannel,
  FIRST_TEXT,
  makeWhen,
  MESSENGER,
  messageLink,
  textingSettled,
  textingUnreached,
  thisReader,
  type Composer,
} from '@vivid/state'
import { Option } from 'effect'
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Linking, Platform, ScrollView, View } from 'react-native'
import { useNow } from '../../data/foreground'
import { confirm, warn } from '../../data/haptics'
import { useLive, useLiveData, type LiveData } from '../../data/live'
import { MOBILE_TYPOGRAPHY } from '../../data/typography'
import { Copy } from '../../ui/Copy'
import { Header, Screen } from '../../ui/Header'
import { Section } from '../../ui/List'
import { Live } from '../../ui/Live'
import { ServiceMark } from '../../ui/Mark'
import {
  Button,
  confirmDestructive,
  Dot,
  Field,
  Label,
  Labelled,
  MONO,
  Notice,
  Skeleton,
  styles,
} from '../../ui/ui'
import { useGo } from '../../workspace'

const when = makeWhen(thisReader())

/**
 * Which form of `sms:` link this phone's messaging app reads: Apple's Messages takes the body
 * after `&`, Android's takes the standard `?`. See `messageLink`.
 */
const COMPOSER: Composer = Platform.OS === 'ios' ? 'apple' : 'standard'

/** A channel's mark is filed under its name in lower case (`@vivid/marks`). */
const markOf = (channel: Channel) => channel.toLowerCase()

type Standing<Tag extends ChannelStanding['_tag']> = Extract<ChannelStanding, { _tag: Tag }>

/**
 * What a connect control is given to act with, so it can be drawn with none of this attached.
 * Each answers with the one sentence to show when it was refused, and with nothing when it was not.
 *
 * It is declared here and not beside the shared programs (`@vivid/state`), because a Promise is
 * what an event handler awaits: that is this app's boundary, and the shared package only describes
 * work as Effects.
 */
export interface TextingActs {
  /** Gives the Person's number to a channel, or asks for a new code for the same number. */
  readonly connect: (channel: Channel, written: string) => Promise<Option.Option<string>>
  /** Takes the Person's number off a channel. */
  readonly disconnect: (channel: Channel) => Promise<Option.Option<string>>
}

/** The shared programs, run on this session's socket, each answer laid over its live list. */
const actsOf = (data: LiveData): TextingActs => {
  const settled = textingSettled(data.live.channels)
  return {
    connect: (channel, written) => data.run(connectChannel(channel, written)).then(settled),
    disconnect: (channel) => data.run(disconnectChannel(channel)).then(settled),
  }
}

/**
 * Text Vivid: the Person gives their own phone number, texts a short code from that phone, and
 * from then on writes to Vivid from their messages app the way they write to anyone.
 *
 * It is the phone's half of the web app's section of the same name, on the same live query and
 * the same wording (`@vivid/state`). It is laid out for a phone: this is usually the very phone
 * being connected, so the code is not something to carry anywhere. "Open Messages" writes the
 * text, addressed, and the Person presses Send.
 */
export function Texting() {
  const data = useLiveData()
  const go = useGo()
  const channels = useLive(data.live.channels)
  // One set of actions for the session, so a control's handlers are not rebuilt on every result.
  const acts = useMemo(() => actsOf(data), [data])
  return (
    <Screen>
      <Header title="Text Vivid" onBack={go.goBack} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.page, styles.column]}
      >
        <Label size="label" tone="ink-2">
          Connect your own number, then text Vivid from your phone the way you text anyone.
        </Label>
        <Live state={channels} loading={<Skeleton rows={3} />}>
          {(value) => <TextingChannels links={value.channels} acts={acts} />}
        </Live>
      </ScrollView>
    </Screen>
  )
}

/** One group for each messaging app, in the order the server lists them. */
export function TextingChannels({
  links,
  acts,
}: {
  links: ReadonlyArray<ChannelLink>
  acts: TextingActs
}) {
  return (
    <>
      {links.map((link) => (
        <ChannelControl key={link.channel} link={link} acts={acts} />
      ))}
    </>
  )
}

/** What a control is in the middle of asking the server, which holds its buttons meanwhile. */
type Asking = 'nothing' | 'connecting' | 'disconnecting'

/**
 * One messaging app and everything a Person does with it here. What it draws is decided by where
 * the channel stands; a refusal from the last thing asked is said once underneath, in the group.
 */
export function ChannelControl({ link, acts }: { link: ChannelLink; acts: TextingActs }) {
  const { channel, standing } = link
  const [asking, setAsking] = useState<Asking>('nothing')
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  /** Asks once, holds the buttons until the answer, then says the refusal if there was one. */
  async function ask(what: Exclude<Asking, 'nothing'>, made: Promise<Option.Option<string>>) {
    setAsking(what)
    setRefused(Option.none())
    // A call that dies instead of answering is still Vivid not being reached.
    const said = await made.catch(() => Option.some(textingUnreached))
    // A code arriving is the one answer here worth feeling: the next thing to do has appeared.
    if (Option.isNone(said) && what === 'connecting') confirm()
    setRefused(said)
    setAsking('nothing')
  }

  const connect = (written: string) => void ask('connecting', acts.connect(channel, written))
  const disconnect = () => void ask('disconnecting', acts.disconnect(channel))
  const words = channelWords(standing)

  return (
    <Section title={channel}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 14 }}>
        {ChannelStanding.guards.Unavailable(standing) && (
          <Head channel={channel} quiet words={words}>
            {/* Shown, not hidden, so a Person looking for iMessage finds it and reads why there
                is nothing to press: it is text, and looks like text. */}
            This Vivid is not set up for {channel} yet.
          </Head>
        )}
        {ChannelStanding.guards.NotConnected(standing) && (
          <NotConnected channel={channel} words={words} asking={asking} onConnect={connect} />
        )}
        {ChannelStanding.guards.Confirming(standing) && (
          <Confirming
            channel={channel}
            standing={standing}
            asking={asking}
            onAgain={() => connect(standing.address)}
            onOther={disconnect}
            onUnopened={setRefused}
          />
        )}
        {ChannelStanding.guards.Connected(standing) && (
          <Connected
            channel={channel}
            standing={standing}
            asking={asking}
            onDisconnect={disconnect}
            onUnopened={setRefused}
          />
        )}
        {Option.isSome(refused) && <Notice message={refused.value} />}
      </View>
    </Section>
  )
}

/** The head of a group: the app's mark, where it stands in a word, and one sentence about it. */
function Head({
  channel,
  words,
  quiet = false,
  dot,
  children,
}: {
  channel: Channel
  words: string
  /** A channel that cannot be used here: its mark steps back with it. */
  quiet?: boolean
  dot?: ReactNode
  children: ReactNode
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <View style={{ opacity: quiet ? 0.45 : 1 }}>
        <ServiceMark service={markOf(channel)} size={36} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {dot}
          <Label tone={quiet ? 'ink-3' : 'ink'}>{words}</Label>
        </View>
        <Label size="label" tone="ink-2">
          {children}
        </Label>
      </View>
    </View>
  )
}

/** The Person's own number and "Connect". One press is one request: the button holds meanwhile. */
function NotConnected({
  channel,
  words,
  asking,
  onConnect,
}: {
  channel: Channel
  words: string
  asking: Asking
  onConnect: (written: string) => void
}) {
  const [written, setWritten] = useState('')
  const busy = asking !== 'nothing'
  // Not held back while the field is empty: a primary button that looks switched off reads as
  // "this does not work". An empty number is answered like any other that cannot be reached.
  const ready = !busy
  return (
    <>
      <Head channel={channel} words={words}>
        Give the number of the phone you will text from.
      </Head>
      <Labelled label="Your phone number, with its country code">
        <Field
          accessibilityLabel={`Your phone number for ${channel}`}
          value={written}
          placeholder="+234 801 234 5678"
          keyboardType="phone-pad"
          inputMode="tel"
          autoComplete="tel"
          textContentType="telephoneNumber"
          returnKeyType="done"
          // The longest number there is, written with every space and bracket a person might add.
          maxLength={32}
          onChangeText={setWritten}
          onSubmitEditing={() => {
            if (ready) onConnect(written)
          }}
        />
      </Labelled>
      <Button
        kind="primary"
        morph
        label={busy ? 'Connecting…' : `Connect ${channel}`}
        disabled={!ready}
        onPress={() => onConnect(written)}
      />
    </>
  )
}

/**
 * Hands a link to the phone, and says so in the group if the phone would not take it (no
 * messaging app, or a tablet that cannot send a text). The number and code stay on screen to copy.
 */
const open = (
  channel: Channel,
  link: string,
  onUnopened: (said: Option.Option<string>) => void,
) => {
  onUnopened(Option.none())
  void Linking.openURL(link).then(
    () => undefined,
    () =>
      onUnopened(
        Option.some(`${MESSENGER[channel]} could not be opened here. Copy the number instead.`),
      ),
  )
}

/**
 * The number is given and not yet proved: the Person texts the code from that phone. On a phone
 * that is one press: "Open Messages" writes the text, addressed, with the code as its body. The
 * number and the code are still shown large, each with its own copy, for a Person connecting a
 * different phone from the one in their hand.
 *
 * Nothing here counts down. When the code ends is said as a time, and the screen changes once,
 * at that moment (`codeEnding`): the code steps back and asking for a new one becomes the action.
 * When the text arrives the live list says `Connected` and this is replaced without being asked.
 */
function Confirming({
  channel,
  standing,
  asking,
  onAgain,
  onOther,
  onUnopened,
}: {
  channel: Channel
  standing: Standing<'Confirming'>
  asking: Asking
  onAgain: () => void
  onOther: () => void
  onUnopened: (said: Option.Option<string>) => void
}) {
  // One store for one code; a new code is a new `expiresAt` and a new store.
  const ending = useMemo(() => codeEnding(standing.expiresAt), [standing.expiresAt])
  const ended = useSyncExternalStore(ending.subscribe, ending.read, ending.read)
  const at = when(standing.expiresAt, useNow())
  const busy = asking !== 'nothing'
  const again = asking === 'connecting' ? 'Getting a new code…' : 'Get a new code'
  return (
    <>
      <Head channel={channel} words={channelWords(standing)}>
        From the phone with {standing.address}, text this code to this number.
      </Head>
      <Figure name="Text this number" value={standing.textTo} spent={false} />
      <Figure name="This code" value={standing.code} spent={ended} />
      <Label accessibilityLiveRegion="polite" size="label" tone="ink-2">
        {ended ? `This code ended at ${at}. Get a new one.` : `The code works until ${at}.`}
      </Label>
      {!ended && (
        <Button
          kind="primary"
          label={`Open ${MESSENGER[channel]}`}
          onPress={() =>
            open(
              channel,
              messageLink(channel, COMPOSER, standing.textTo, Option.some(standing.code)),
              onUnopened,
            )
          }
        />
      )}
      <Button
        kind={ended ? 'primary' : 'plain'}
        morph
        label={again}
        disabled={busy}
        onPress={onAgain}
      />
      <Button kind="ghost" label="Use a different number" disabled={busy} onPress={onOther} />
    </>
  )
}

/**
 * One thing to send: what it is, the value in the fixed-width face, and a button that copies it.
 * The value can be selected by hand as well. A code that has ended is struck through and cannot
 * be copied, so an old code is never the one that gets sent.
 */
function Figure({ name, value, spent }: { name: string; value: string; spent: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Label size="caption" tone="ink-3">
          {name}
        </Label>
        <Label
          selectable={!spent}
          tone={spent ? 'ink-4' : 'ink'}
          style={{
            ...MOBILE_TYPOGRAPHY.title,
            fontFamily: MONO,
            textDecorationLine: spent ? 'line-through' : 'none',
          }}
        >
          {value}
        </Label>
      </View>
      {!spent && <Copy name={name} read={() => value} />}
    </View>
  )
}

/**
 * A connected channel. What a Person does with one is text Vivid, and this is usually the very
 * phone that does it: the filled button opens the messaging app on a first message (`FIRST_TEXT`)
 * to Vivid's number, so the first text is one press and "Send". The number is shown large above
 * it with its copy (the same `Figure` the code is shown in), for a Person who texts from another
 * phone, and for when the app would not open. Their own number and since when are said in the
 * head. Disconnecting stops Vivid answering that phone, so it is last, in the danger colour, and
 * the system asks before it is done.
 */
function Connected({
  channel,
  standing,
  asking,
  onDisconnect,
  onUnopened,
}: {
  channel: Channel
  standing: Standing<'Connected'>
  asking: Asking
  onDisconnect: () => void
  onUnopened: (said: Option.Option<string>) => void
}) {
  const since = when(standing.since, useNow())
  const askToDisconnect = () =>
    confirmDestructive({
      title: `Disconnect ${channel}?`,
      detail: `Vivid will stop answering texts from ${standing.address}. You can connect it again at any time.`,
      action: `Disconnect ${channel}`,
      onConfirm: () => {
        warn()
        onDisconnect()
      },
    })
  return (
    <>
      <Head
        channel={channel}
        words={`${channelWords(standing)} · ${since}`}
        dot={<Dot tone="status-success" />}
      >
        Vivid answers texts from {standing.address}.
      </Head>
      <Figure name="Vivid’s number" value={standing.textTo} spent={false} />
      <Button
        kind="primary"
        label={`Open ${MESSENGER[channel]}`}
        onPress={() =>
          open(
            channel,
            messageLink(channel, COMPOSER, standing.textTo, Option.some(FIRST_TEXT)),
            onUnopened,
          )
        }
      />
      <Button
        kind="danger"
        morph
        label={asking === 'disconnecting' ? 'Disconnecting…' : `Disconnect ${channel}`}
        disabled={asking !== 'nothing'}
        onPress={askToDisconnect}
      />
    </>
  )
}
