import type { FlueConversationMessage } from '@flue/sdk'
import type { ThreadDetail } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { useState } from 'react'
import { Linking, View } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { AlarmClock, ChevronDown, ChevronRight, Repeat2 } from 'lucide-react-native'
import { CITATION_ADDRESS, linkCitations, openDocument } from '../../data/documents'
import { useLiveData } from '../../data/live'
import {
  isStreaming,
  momentOf,
  Speaker,
  speakerOf,
  stepsOf,
  stepsSummary,
  textOf,
  toolsOf,
  type Around,
  type Step,
} from '../../data/message'
import { MOBILE_TYPOGRAPHY } from '../../data/typography'
import { useTheme } from '../../theme'
import { Avatar } from '../../ui/Avatar'
import { Dot, Face, HAIRLINE, Label, Press, radius } from '../../ui/ui'
import { Cards } from './Cards'

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

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
  onContinue,
}: {
  message: FlueConversationMessage
  around: Around
  detail: Option.Option<ThreadDetail>
  working: boolean
  onContinue: (text: string) => void
}) {
  return Speaker.$match(speakerOf(message, around), {
    Me: () => <Said text={textOf(message)} from={Option.none()} mine />,
    Member: ({ name }) => <Said text={textOf(message)} from={name} mine={false} />,
    Vivid: ({ answering }) => (
      <FromVivid
        message={message}
        answering={answering}
        detail={detail}
        around={around}
        working={working}
        onContinue={onContinue}
      />
    ),
    Wake: ({ reason, name }) => <Wake reason={reason} name={name} />,
    Notice: ({ failed }) => <Aside text={textOf(message)} failed={failed} />,
    Silent: () => null,
  })
}

/**
 * A Person's words. The reader's own sit on the right with the corner nearest the composer
 * squared off, which is what ties a bubble to where it was typed. Someone else's sit on the left
 * under their name; a message the server delivered without a name is drawn without one, never
 * with an invented one.
 */
function Said({ text, from, mine }: { text: string; from: Option.Option<string>; mine: boolean }) {
  const { colors: c } = useTheme()
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
          style={{
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: radius.panel,
            borderBottomRightRadius: mine ? 6 : radius.panel,
            borderTopLeftRadius: mine ? radius.panel : 6,
            backgroundColor: c['surface-2'],
            borderWidth: HAIRLINE,
            borderColor: c['line-2'],
          }}
        >
          <Label selectable size="reading">
            {text}
          </Label>
        </View>
      </View>
    </View>
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
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  const summary = stepsSummary(steps, working)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={{ marginBottom: 6 }}>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        // The line is short; the slop makes it as easy to hit as any other control.
        hitSlop={{ top: 10, bottom: 10, right: 16 }}
        onPress={() => setOpen((shown) => !shown)}
        containerStyle={{ alignSelf: 'flex-start' }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24 }}
      >
        <Chevron pointerEvents="none" size={15} strokeWidth={1.8} color={c['ink-3']} />
        {summary === 'Working' && <Dot tone="status-working" size={6} />}
        <Label size="label" tone="ink-3">
          {summary}
        </Label>
      </Press>
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
  const { colors: c } = useTheme()
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
    if (!/^https?:\/\//iu.test(address)) return
    void Linking.openURL(address).then(
      () => undefined,
      () => setUnopened(Option.some('That link could not be opened.')),
    )
  }

  return (
    <>
      <Markdown
        onLinkPress={(address) => {
          open(address)
          // The Thread has handled the link; the renderer must not also follow it.
          return false
        }}
        style={{
          body: { color: c.ink, ...MOBILE_TYPOGRAPHY.reading },
          paragraph: { marginTop: 0, marginBottom: 10 },
          heading1: { ...MOBILE_TYPOGRAPHY.title, marginTop: 6, marginBottom: 8 },
          heading2: { ...MOBILE_TYPOGRAPHY.headline, marginTop: 6, marginBottom: 6 },
          heading3: { ...MOBILE_TYPOGRAPHY.footnote, marginTop: 4, marginBottom: 4 },
          bullet_list: { marginBottom: 10 },
          ordered_list: { marginBottom: 10 },
          code_inline: { backgroundColor: c['surface-2'], color: c.ink },
          fence: { backgroundColor: c['surface-well'], color: c.ink, borderColor: c['line-2'] },
          code_block: {
            backgroundColor: c['surface-well'],
            color: c.ink,
            borderColor: c['line-2'],
          },
          link: { color: c['accent-ink'] },
          blockquote: { backgroundColor: c['surface-2'], borderColor: c['line-3'] },
          hr: { backgroundColor: c['line-2'] },
          table: { borderColor: c['line-2'] },
          tr: { borderColor: c['line-2'] },
        }}
      >
        {linkCitations(text)}
      </Markdown>
      {Option.isSome(unopened) && (
        <Label size="label" tone="status-danger">
          {unopened.value}
        </Label>
      )}
    </>
  )
}

/** Vivid's reply: who it was answering, what it did, what it said, and what it is asking. */
function FromVivid({
  message,
  answering,
  detail,
  around,
  working,
  onContinue,
}: {
  message: FlueConversationMessage
  answering: Option.Option<string>
  detail: Option.Option<ThreadDetail>
  around: Around
  working: boolean
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
        <Cards tools={tools} detail={detail} me={around.me} onContinue={onContinue} />
        {Option.isSome(moment) && (
          <Label size="micro" tone="ink-4" style={{ marginTop: 2 }}>
            {clock.format(moment.value)}
          </Label>
        )}
      </View>
    </View>
  )
}
