import {
  DisplaySource,
  textOf,
  type ConversationMessage,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import { offeredReplies } from '@vivid/state'
import { Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { AlarmClock, Eye } from 'lucide-react-native'
import type { Say } from '../../data/delivery'
import { useNow } from '../../data/foreground'
import {
  isStreaming,
  momentOf,
  picturesOf,
  Segment,
  segmentsOf,
  Speaker,
  speakerOf,
  type Around,
} from '../../data/message'
import { when } from '../../data/when'
import { useTheme } from '../../theme'
import { ANSWERED, SAID } from '../../ui/motion/morph'
import { EDGE, Face, Label, MONO, radius } from '../../ui/ui'
import { Cards } from './Cards'
import { Replies } from './Replies'
import { Said, Voice } from './Said'
import { Reply } from './Words'

/**
 * One message in a Thread, drawn by who it is from (`data/message.ts` decides that). A Person's
 * words are a bubble: the reader's own on the right, anyone else's on the left under their name.
 * Vivid's are a run of bubbles, with the cards its work left between them. A follow-up that woke Vivid is
 * a quiet line saying why it spoke. The answer to a question of Vivid's is not a
 * message of the conversation; the Thread draws it as a row of its own (`Replied`,
 * `Question.tsx`).
 */
export function Message({
  thread,
  message,
  around,
  detail,
  working,
  fresh,
  latest,
  unsent,
  settled,
  onContinue,
}: {
  thread: ThreadId
  message: ConversationMessage
  around: Around
  detail: Option.Option<ThreadDetail>
  working: boolean
  /**
   * Whether it arrived in the last moments, while the Thread was on screen (`Transcript`,
   * `screen/Chat.tsx`). Only then does it arrive with motion; everything that was already in the
   * Thread is drawn whole.
   */
  fresh: boolean
  /** Whether this is the newest visible message, matching the web reply’s answerability. */
  latest: boolean
  /** The ids of the messages written here that did not arrive (`failedSends` of the stream). */
  unsent: ReadonlySet<string>
  /** Whether the runtime has settled the submission this reply answers. A finished part does
   * not settle the response. The server runs a display's program only from a settled reply. */
  settled: boolean
  onContinue: Say
}) {
  return Speaker.$match(speakerOf(message, around), {
    Me: () => (
      <Arriving arrival={fresh ? 'said' : 'there'}>
        <Said
          text={textOf(message)}
          pictures={picturesOf(message, around.hosted)}
          voice={unsent.has(message.id) ? Voice.Unsent() : Voice.Mine()}
        />
      </Arriving>
    ),
    Member: ({ name }) => (
      <Said
        text={textOf(message)}
        pictures={picturesOf(message, around.hosted)}
        voice={Voice.Theirs({ name })}
      />
    ),
    Vivid: ({ answering }) => (
      <Arriving arrival={fresh ? 'answered' : 'there'}>
        <FromVivid
          thread={thread}
          message={message}
          answering={answering}
          detail={detail}
          around={around}
          working={working}
          latest={latest}
          settled={settled}
          onContinue={onContinue}
        />
      </Arriving>
    ),
    Wake: ({ reason, name }) => <Wake reason={reason} name={name} />,
    Saw: ({ name }) => <Saw name={name} text={textOf(message)} />,
    Notice: ({ failed }) => <Aside text={textOf(message)} failed={failed} />,
    Silent: () => null,
  })
}

/** How each kind of arrival comes onto the screen; one that was already there does not. */
const ARRIVAL = { said: SAID, answered: ANSWERED, there: undefined } as const

/**
 * A message's row, with how it arrives. The Person's own words rise into place and Vivid's fade
 * in, when they have just arrived; T3 Code mobile's feed does the same for a message stamped in
 * the last three seconds (`ThreadFeed.tsx`, `isFreshTimestamp`).
 *
 * How it arrives is decided once, when the row is first drawn, and kept: the motion belongs to
 * the arrival, and a row must not be told it is no longer fresh in the middle of it.
 */
function Arriving({ arrival, children }: { arrival: keyof typeof ARRIVAL; children: ReactNode }) {
  const [entering] = useState(ARRIVAL[arrival])
  return <Animated.View entering={entering}>{children}</Animated.View>
}

const WAKE = {
  'follow-up': { Icon: AlarmClock, label: 'Time to follow up' },
} as const

/** Why Vivid spoke when nobody had: a follow-up fell due. */
function Wake({ reason, name }: { reason: keyof typeof WAKE; name: Option.Option<string> }) {
  const { colors: c } = useTheme()
  const { Icon, label } = WAKE[reason]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon size={14} strokeWidth={1.7} color={c['foreground-secondary']} />
      <Label size="caption" tone="ink-2" style={{ flexShrink: 1 }}>
        {Option.match(name, { onNone: () => label, onSome: (named) => `${label} · ${named}` })}
      </Label>
    </View>
  )
}

/**
 * The event a Watch woke Vivid with, as Vivid saw it: a quiet line with the Watch's name, then the
 * event whole, in the fixed-width face because it is the Integration's own data, selectable so it
 * can be copied. The Feed card's Thread opens here, so this is where a Person reads what caused it.
 */
function Saw({ name, text }: { name: Option.Option<string>; text: string }) {
  const { colors: c } = useTheme()
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Eye size={14} strokeWidth={1.7} color={c['foreground-secondary']} />
        <Label size="caption" tone="ink-2" style={{ flexShrink: 1 }}>
          {Option.match(name, {
            onNone: () => 'What Vivid saw',
            onSome: (named) => `What Vivid saw · ${named}`,
          })}
        </Label>
      </View>
      <View
        style={{
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: radius.control,
          borderWidth: EDGE,
          borderColor: c.border,
          backgroundColor: c.subtle,
        }}
      >
        <Label size="label" tone="ink-2" selectable style={{ fontFamily: MONO }}>
          {text}
        </Label>
      </View>
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
        borderWidth: EDGE,
        borderColor: c.border,
        backgroundColor: c.subtle,
      }}
    >
      <Label size="label" tone="ink-2">
        {failed ? `Vivid could not finish that. ${text}` : text}
      </Label>
    </View>
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
    <Label size="micro" tone="foreground-tertiary" style={{ marginTop: 2 }}>
      {when(moment, now)}
    </Label>
  )
}

/**
 * Vivid's reply, as a run of messages: each stretch of words is a bubble of its own, and the work
 * between two stretches shows only where it left the Person something (a card). Its face stands
 * once, at the foot of the run, as Messages draws a run of bubbles from one sender. The steps it
 * took are not drawn: the working bubble says the one it is on while it works (`ui/Thinking.tsx`),
 * and the owner asked that nothing of them stay in the Thread (26 October 2026).
 */
function FromVivid({
  thread,
  message,
  answering,
  detail,
  around,
  working,
  latest,
  settled,
  onContinue,
}: {
  thread: ThreadId
  message: ConversationMessage
  answering: Option.Option<string>
  detail: Option.Option<ThreadDetail>
  around: Around
  working: boolean
  latest: boolean
  settled: boolean
  onContinue: Say
}) {
  const segments = segmentsOf(message)
  const moment = momentOf(message)
  // Only the newest reply can still be in the making; an older one is whole.
  const making = latest && working
  const streaming = isStreaming(message)
  // A reply with nothing to show yet is not drawn: the working bubble already says Vivid is on it.
  if (segments.length === 0 && Option.isNone(answering)) return null
  // Live and settled replies share an id, so a display already names the reply the server reads.
  const source = DisplaySource.cases.ThreadMessage.make({ thread, message: message.id })
  // Only the newest reply, once Vivid has finished it, offers its replies to tap.
  const offered = latest && !working && !streaming ? offeredReplies(message) : []
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
        <View style={{ marginBottom: Option.isSome(moment) ? 18 : 2 }}>
          <Face size={24} mood={streaming ? 'thinking' : 'neutral'} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          {Option.isSome(answering) && (
            <Label size="caption" tone="ink-2" style={{ marginBottom: 2 }}>
              Answering {answering.value}
            </Label>
          )}
          {segments.map((segment, at) =>
            Segment.$match(segment, {
              Words: ({ text }) => (
                <Reply
                  key={`words-${at}`}
                  source={source}
                  text={text}
                  // Only the last stretch can still be arriving; the ones before it are whole.
                  streaming={streaming && at === segments.length - 1}
                  making={making}
                  settled={settled}
                  live={latest && !working}
                  onSay={onContinue}
                />
              ),
              Work: ({ tools }) => (
                <Cards
                  key={`work-${at}`}
                  tools={tools}
                  detail={detail}
                  me={around.me}
                  live={latest && !working}
                  onContinue={onContinue}
                />
              ),
            }),
          )}
          {Option.isSome(moment) && <Stamp moment={moment.value} />}
        </View>
      </View>
      {offered.length > 0 && <Replies replies={offered} onSay={onContinue} />}
    </View>
  )
}
