import type { FlueConversationMessage } from '@flue/sdk'
import type { ThreadDetail } from '@vivid/contracts'
import { Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { AlarmClock, ChevronDown, ChevronRight, Monitor, Repeat2 } from 'lucide-react-native'
import type { Say } from '../../data/delivery'
import { useNow } from '../../data/foreground'
import { arrive } from '../../data/computer'
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
  type Step,
} from '../../data/message'
import { when } from '../../data/when'
import { useTheme } from '../../theme'
import { ThinkingOrb } from '../../../vendor/orb'
import { Dots } from '../../ui/Dots'
import { ANSWERED, SAID } from '../../ui/motion/morph'
import { EDGE, Face, HAIRLINE, Label, Press, radius } from '../../ui/ui'
import { useGo } from '../../workspace'
import { Cards } from './Cards'
import { Said, Voice } from './Said'
import { useRevealed } from '../../ui/reveal'
import { Words } from './Words'

/**
 * One message in a Thread, drawn by who it is from (`data/message.ts` decides that). A Person's
 * words are a bubble: the reader's own on the right, anyone else's on the left under their name.
 * Vivid's are plain text with what it did and what it is asking. A Routine or a follow-up that
 * woke Vivid is a quiet line saying why it spoke. The answer to a question of Vivid's is not a
 * message of the conversation; the Thread draws it as a row of its own (`Replied`,
 * `Question.tsx`).
 */
export function Message({
  message,
  around,
  detail,
  working,
  fresh,
  latest,
  unsent,
  onContinue,
}: {
  message: FlueConversationMessage
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
  onContinue: Say
}) {
  return Speaker.$match(speakerOf(message, around), {
    Me: () => (
      <Arriving arrival={fresh ? 'said' : 'there'}>
        <Said
          text={textOf(message)}
          pictures={picturesOf(message)}
          voice={unsent.has(message.id) ? Voice.Unsent() : Voice.Mine()}
        />
      </Arriving>
    ),
    Member: ({ name }) => (
      <Said text={textOf(message)} pictures={picturesOf(message)} voice={Voice.Theirs({ name })} />
    ),
    Vivid: ({ answering }) => (
      <Arriving arrival={fresh ? 'answered' : 'there'}>
        <FromVivid
          message={message}
          answering={answering}
          detail={detail}
          around={around}
          working={working}
          latest={latest}
          onContinue={onContinue}
        />
      </Arriving>
    ),
    Wake: ({ reason, name }) => <Wake reason={reason} name={name} />,
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
  routine: { Icon: Repeat2, label: 'A routine came due' },
  'follow-up': { Icon: AlarmClock, label: 'Time to follow up' },
} as const

/** Why Vivid spoke when nobody had: a Routine came due, or a follow-up fell due. */
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

const STEP_TONE = {
  running: 'ink-2',
  done: 'ink-2',
  failed: 'status-danger',
} as const satisfies Record<Step['standing'], 'ink-2' | 'status-danger'>

/** What Vivid did while answering, collapsed to one line that opens into each step. */
function Steps({ steps, working }: { steps: ReadonlyArray<Step>; working: boolean }) {
  const { colors: c, dark } = useTheme()
  const go = useGo()
  const data = useLiveData()
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
          <Chevron
            pointerEvents="none"
            size={15}
            strokeWidth={1.8}
            color={c['foreground-secondary']}
          />
          {/* The step in hand is the web's working orb (`apps/web/src/screen/thread/Trail.tsx`);
              the summary beside it says what it is, so the orb itself is not announced. */}
          {busy && (
            <ThinkingOrb
              state="working"
              size={20}
              theme={dark ? 'dark' : 'light'}
              accessibilityLabel=""
            />
          )}
          <Label size="label" tone="ink-2" style={{ flexShrink: 1 }}>
            {summary}
          </Label>
        </Press>
        {Option.exists(current, (step) => step.onComputer) && (
          <Press
            accessibilityRole="button"
            accessibilityLabel="Watch Vivid work on its Computer"
            // The pill is a quiet 28 points beside the line it belongs to; the slop makes it 44.
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            onPress={() => {
              // The step says Vivid used its Computer, not that it is still on: going to watch
              // is arriving at it, which turns it on.
              arrive(data)
              go.navigate('Computer')
            }}
            style={({ pressed }) => ({
              height: 28,
              paddingHorizontal: 10,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              borderRadius: 14,
              backgroundColor: pressed ? c['wash-pressed'] : c['thread-selected'],
            })}
          >
            <Monitor pointerEvents="none" size={13} strokeWidth={1.9} color={c['primary-text']} />
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
            borderLeftColor: c.border,
          }}
        >
          {steps.map((step) => (
            <Label key={step.id} size="label" tone={STEP_TONE[step.standing]}>
              {step.label}
              {Option.isSome(step.detail) && (
                <Label size="label" tone="ink-2">{` · ${step.detail.value}`}</Label>
              )}
            </Label>
          ))}
        </View>
      )}
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
  onContinue: Say
}) {
  const text = textOf(message)
  // What is drawn of it: the words arrive in lumps and are let out evenly (`useRevealed`).
  const drawnText = useRevealed(text)
  const tools = toolsOf(message)
  const moment = momentOf(message)
  // A reply that has started and has nothing to show yet: no words, nothing done. The dots say
  // Vivid is about to speak, where the row was a face beside nothing.
  const silent = text.length === 0 && tools.length === 0
  const awaited = silent && (isStreaming(message) || (latest && working))
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ marginTop: 1 }}>
        <Face size={24} mood={isStreaming(message) || awaited ? 'thinking' : 'neutral'} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {Option.isSome(answering) && (
          <Label size="caption" tone="ink-2" style={{ marginBottom: 4 }}>
            Answering {answering.value}
          </Label>
        )}
        <Steps steps={stepsOf(tools)} working={working} />
        {awaited && <Dots />}
        {text.length > 0 && <Words text={drawnText} />}
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
