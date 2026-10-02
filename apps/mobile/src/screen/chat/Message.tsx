import type { FlueConversationMessage } from '@flue/sdk'
import type { ThreadDetail } from '@vivid/contracts'
import { Data, Option, Result } from 'effect'
import { useState } from 'react'
import { Image, View } from 'react-native'
import { AlarmClock, ChevronDown, ChevronRight, Monitor, Repeat2 } from 'lucide-react-native'
import { CITATION_ADDRESS, linkCitations, openDocument } from '../../data/documents'
import { useNow } from '../../data/foreground'
import { useLiveData } from '../../data/live'
import {
  currentStepOf,
  isStreaming,
  momentOf,
  picturesOf,
  Speaker,
  speakerOf,
  stepsOf,
  stepsSummary,
  textOf,
  toolsOf,
  type Around,
  type MessagePicture,
  type Step,
} from '../../data/message'
import { when } from '../../data/when'
import { useTheme } from '../../theme'
import { Avatar } from '../../ui/Avatar'
import { openWebLink, Prose } from '../../ui/Prose'
import { Sheet } from '../../ui/Sheet'
import { Dot, Face, HAIRLINE, Label, Press, radius } from '../../ui/ui'
import { useGo } from '../../workspace'
import { Cards } from './Cards'

/**
 * One message in a Thread, drawn by who it is from (`data/message.ts` decides that). A Person's
 * words are a bubble: the reader's own on the right, anyone else's on the left under their name.
 * Vivid's are plain text with what it did and what it is asking. A Routine or a follow-up that
 * woke Vivid is a quiet line saying why it spoke.
 */
export function Message({
  message,
  around,
  detail,
  working,
  latest,
  unsent,
  onContinue,
}: {
  message: FlueConversationMessage
  around: Around
  detail: Option.Option<ThreadDetail>
  working: boolean
  /** Whether this is the newest visible message, matching the web reply’s answerability. */
  latest: boolean
  /** The ids of the messages written here that did not arrive (`failedSends` of the stream). */
  unsent: ReadonlySet<string>
  onContinue: (text: string) => void
}) {
  return Speaker.$match(speakerOf(message, around), {
    Me: () => (
      <Said
        text={textOf(message)}
        pictures={picturesOf(message)}
        voice={unsent.has(message.id) ? Voice.Unsent() : Voice.Mine()}
      />
    ),
    Member: ({ name }) => (
      <Said text={textOf(message)} pictures={picturesOf(message)} voice={Voice.Theirs({ name })} />
    ),
    Vivid: ({ answering }) => (
      <FromVivid
        message={message}
        answering={answering}
        detail={detail}
        around={around}
        working={working}
        latest={latest}
        onContinue={onContinue}
      />
    ),
    Wake: ({ reason, name }) => <Wake reason={reason} name={name} />,
    Notice: ({ failed }) => <Aside text={textOf(message)} failed={failed} />,
    Silent: () => null,
  })
}

/**
 * Whose words a bubble holds, which is all that decides how it is drawn.
 *
 * - `Mine`: the reader's own, and with Vivid. The one filled shape in a Thread.
 * - `Unsent`: the reader's own that did not arrive: an outline where a sent message is filled.
 * - `Theirs`: someone else's in a shared Thread, under their name when the server gave one.
 */
type Voice = Data.TaggedEnum<{
  Mine: {}
  Unsent: {}
  Theirs: { readonly name: Option.Option<string> }
}>
const Voice = Data.taggedEnum<Voice>()

/** The corner a bubble squares off: the one nearest whoever said it. */
const TAIL = 6

/**
 * A Person's words. The reader's own sit on the right, filled in Vivid's accent with the corner
 * nearest the composer squared off: in a Thread that is mostly Vivid's plain text, the Person's
 * words are the one filled shape, found at a glance. Words that did not arrive keep their place
 * and their shape but are only an outline, dashed, so nothing unsent is ever mistaken for said;
 * the way to send them again is at the foot of the conversation.
 *
 * Someone else's sit on the left on the neutral surface, under their name; a message the server
 * delivered without a name is drawn without one, never with an invented one.
 *
 * The reader's own bubble has the same one-point edge sent or not (on the filled one it is the
 * fill's own colour), so a message that is sent again does not move when it stops being an
 * outline.
 */
function Said({
  text,
  voice,
  pictures,
}: {
  text: string
  voice: Voice
  pictures: ReadonlyArray<MessagePicture>
}) {
  const { colors: c } = useTheme()
  const paint = Voice.$match(voice, {
    Mine: () => ({ fill: c.accent, edge: c.accent, line: 1, ink: 'ink-on-accent' }) as const,
    Unsent: () => ({ fill: 'transparent', edge: c['line-4'], line: 1, ink: 'ink-2' }) as const,
    Theirs: () =>
      ({ fill: c['surface-2'], edge: c['line-2'], line: HAIRLINE, ink: 'ink' }) as const,
  })
  const unsent = Voice.$is('Unsent')(voice)
  const from = Voice.$is('Theirs')(voice) ? voice.name : Option.none<string>()
  const mine = !Voice.$is('Theirs')(voice)
  return (
    <View
      style={{ flexDirection: 'row', gap: 10, justifyContent: mine ? 'flex-end' : 'flex-start' }}
    >
      {Option.isSome(from) && (
        <View style={{ marginTop: 20 }}>
          <Avatar name={from.value} image={null} size={24} />
        </View>
      )}
      <View style={{ flexShrink: 1, maxWidth: '84%', gap: 4 }}>
        {Option.isSome(from) && (
          <Label size="caption" tone="ink-3" style={{ marginLeft: 4 }}>
            {from.value}
          </Label>
        )}
        <View
          // A screen reader cannot see an outline; it is told the words did not go.
          accessibilityHint={unsent ? 'Not sent' : undefined}
          style={{
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: radius.panel,
            borderBottomRightRadius: mine ? TAIL : radius.panel,
            borderTopLeftRadius: mine ? radius.panel : TAIL,
            backgroundColor: paint.fill,
            borderWidth: paint.line,
            borderStyle: unsent ? 'dashed' : 'solid',
            borderColor: paint.edge,
          }}
        >
          <Pictures pictures={pictures} />
          <Label selectable size="reading" tone={paint.ink}>
            {text}
          </Label>
        </View>
      </View>
    </View>
  )
}

/** A sent picture opens at full size, using the native sheet in place of the web's image link. */
function Pictures({ pictures }: { pictures: ReadonlyArray<MessagePicture> }) {
  const [opened, setOpened] = useState<Option.Option<MessagePicture>>(Option.none())
  if (pictures.length === 0) return null
  // One picture is the point of the message and is drawn large; several are a tidy grid.
  const side = pictures.length === 1 ? 216 : 104
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {pictures.map((picture, index) => (
          <Press
            key={picture.key}
            accessibilityRole="imagebutton"
            accessibilityLabel={Option.getOrElse(
              picture.name,
              () => `Picture ${index + 1} of ${pictures.length}`,
            )}
            accessibilityHint="Opens full size"
            onPress={() => setOpened(Option.some(picture))}
            style={({ pressed }) => ({ opacity: pressed ? 0.82 : 1 })}
          >
            <Image
              source={{ uri: picture.url }}
              resizeMode="cover"
              style={{ width: side, height: side, borderRadius: radius.row }}
            />
          </Press>
        ))}
      </View>
      {Option.isSome(opened) && (
        <Sheet
          title={Option.getOrUndefined(opened.value.name)}
          onClose={() => setOpened(Option.none())}
        >
          <Image
            source={{ uri: opened.value.url }}
            accessibilityLabel={Option.getOrUndefined(opened.value.name)}
            resizeMode="contain"
            style={{ width: '100%', aspectRatio: 1 }}
          />
        </Sheet>
      )}
    </>
  )
}

const WAKE = {
  routine: { Icon: Repeat2, label: 'A routine came due' },
  'follow-up': { Icon: AlarmClock, label: 'Time to follow up' },
} as const

/** Why Vivid spoke when nobody had: a Routine came due, or a follow-up fell due. */
function Wake({ reason, name }: { reason: keyof typeof WAKE; name: Option.Option<string> }) {
  const { colors: c } = useTheme()
  const { Icon, label } = WAKE[reason]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon size={14} strokeWidth={1.7} color={c['ink-3']} />
      <Label size="caption" tone="ink-3" style={{ flexShrink: 1 }}>
        {Option.match(name, { onNone: () => label, onSome: (named) => `${label} · ${named}` })}
      </Label>
    </View>
  )
}

/** Something the runtime said with nobody behind it, such as a reply that could not be finished. */
function Aside({ text, failed }: { text: string; failed: boolean }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: radius.control,
        borderWidth: HAIRLINE,
        borderColor: c['line-2'],
        backgroundColor: c['surface-2'],
      }}
    >
      <Label size="label" tone="ink-3">
        {failed ? `Vivid could not finish that. ${text}` : text}
      </Label>
    </View>
  )
}

const STEP_TONE = {
  running: 'ink-2',
  done: 'ink-2',
  failed: 'status-danger',
} as const satisfies Record<Step['standing'], 'ink-2' | 'status-danger'>

/** What Vivid did while answering, collapsed to one line that opens into each step. */
function Steps({ steps, working }: { steps: ReadonlyArray<Step>; working: boolean }) {
  const { colors: c } = useTheme()
  const go = useGo()
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  const summary = stepsSummary(steps, working)
  const current = currentStepOf(steps, working)
  const busy = Option.isSome(current)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={{ marginBottom: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Press
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          // The line is short; the slop makes it as easy to hit as any other control.
          hitSlop={{ top: 10, bottom: 10 }}
          onPress={() => setOpen((shown) => !shown)}
          containerStyle={{ flexShrink: 1 }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24 }}
        >
          <Chevron pointerEvents="none" size={15} strokeWidth={1.8} color={c['ink-3']} />
          {busy && <Dot tone="status-working" size={6} />}
          <Label size="label" tone="ink-3" style={{ flexShrink: 1 }}>
            {summary}
          </Label>
        </Press>
        {Option.exists(current, (step) => step.onComputer) && (
          <Press
            accessibilityRole="button"
            accessibilityLabel="Watch Vivid work on its Computer"
            // The pill is a quiet 28 points beside the line it belongs to; the slop makes it 44.
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            onPress={() => go.navigate('Computer')}
            style={({ pressed }) => ({
              height: 28,
              paddingHorizontal: 10,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              borderRadius: 14,
              backgroundColor: pressed ? c['wash-pressed'] : c['accent-soft'],
            })}
          >
            <Monitor pointerEvents="none" size={13} strokeWidth={1.9} color={c['accent-ink']} />
            <Label size="caption" tone="accent-ink">
              Watch
            </Label>
          </Press>
        )}
      </View>
      {open && (
        <View
          style={{
            marginTop: 6,
            marginLeft: 7,
            paddingLeft: 14,
            gap: 6,
            borderLeftWidth: HAIRLINE,
            borderLeftColor: c['line-3'],
          }}
        >
          {steps.map((step) => (
            <Label key={step.id} size="label" tone={STEP_TONE[step.standing]}>
              {step.label}
              {Option.isSome(step.detail) && (
                <Label size="label" tone="ink-3">{` · ${step.detail.value}`}</Label>
              )}
            </Label>
          ))}
        </View>
      )}
    </View>
  )
}

/**
 * Vivid's words as formatted text. A citation of something in the Library is a link the Thread
 * opens through the Library (the device downloads the original and hands it to the share sheet);
 * any other web link opens in the browser. A link that could not be opened says so under the text.
 */
function Words({ text }: { text: string }) {
  const data = useLiveData()
  const [unopened, setUnopened] = useState<Option.Option<string>>(Option.none())

  function open(address: string) {
    setUnopened(Option.none())
    if (address.startsWith(CITATION_ADDRESS)) {
      const name = new URL(address).searchParams.get('name')
      if (name === null) return
      const path = `/source?name=${encodeURIComponent(name)}`
      void data.run(openDocument(data.session, path, name)).then((result) => {
        if (Result.isFailure(result)) setUnopened(Option.some(result.failure.message))
      })
      return
    }
    void openWebLink(address).then((opened) => {
      if (!opened) setUnopened(Option.some('That link could not be opened.'))
    })
  }

  return (
    <>
      <Prose text={linkCitations(text)} plain={text} onLink={open} />
      {Option.isSome(unopened) && (
        <Label size="label" tone="status-danger">
          {unopened.value}
        </Label>
      )}
    </>
  )
}

/**
 * When Vivid finished a reply. "Now" is the moment the app last came to the front
 * (`data/foreground.ts`), so a Thread left open overnight stops calling yesterday's replies
 * today's when it is picked up again, and no clock ticks under a Person who is reading.
 */
function Stamp({ moment }: { moment: number }) {
  const now = useNow()
  return (
    <Label size="micro" tone="ink-4" style={{ marginTop: 2 }}>
      {when(moment, now)}
    </Label>
  )
}

/** Vivid's reply: who it was answering, what it did, what it said, and what it is asking. */
function FromVivid({
  message,
  answering,
  detail,
  around,
  working,
  latest,
  onContinue,
}: {
  message: FlueConversationMessage
  answering: Option.Option<string>
  detail: Option.Option<ThreadDetail>
  around: Around
  working: boolean
  latest: boolean
  onContinue: (text: string) => void
}) {
  const text = textOf(message)
  const tools = toolsOf(message)
  const moment = momentOf(message)
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ marginTop: 1 }}>
        <Face size={24} mood={isStreaming(message) ? 'thinking' : 'neutral'} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {Option.isSome(answering) && (
          <Label size="caption" tone="ink-3" style={{ marginBottom: 4 }}>
            Answering {answering.value}
          </Label>
        )}
        <Steps steps={stepsOf(tools)} working={working} />
        {text.length > 0 && <Words text={text} />}
        <Cards
          tools={tools}
          detail={detail}
          me={around.me}
          live={latest && !working}
          onContinue={onContinue}
        />
        {Option.isSome(moment) && <Stamp moment={moment.value} />}
      </View>
    </View>
  )
}
