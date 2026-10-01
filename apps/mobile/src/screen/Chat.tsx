import { useFlueAgent } from '@flue/react'
import type { FlueConversationMessage } from '@flue/sdk'
import {
  ThreadAudience,
  Workspace,
  type MeResponse,
  type Thread,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import { titleFromMessage } from '@vivid/state'
import { Option, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { useMemo, useState } from 'react'
import { FlatList, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Share2, Users } from 'lucide-react-native'
import { onForeground } from '../data/foreground'
import { LiveState, useLive, useLiveData } from '../data/live'
import { isShown, isStreaming, type Around } from '../data/message'
import { conversation, say, UNTITLED } from '../data/threads'
import { Composer } from '../ui/Composer'
import { Header, Screen } from '../ui/Header'
import { AboveKeyboard } from '../ui/Keyboard'
import { Button, Empty, Face, GUTTER, IconButton, Label, Notice, Skeleton, styles } from '../ui/ui'
import { useGo, useMe, type Routes } from '../workspace'
import { Message } from './chat/Message'
import { Share } from './chat/Share'

/**
 * One Thread: the conversation with Vivid, and everything live around it.
 *
 * Two sources feed this screen. The words come from Flue's stream through the server's gateway,
 * token by token. Everything else (who is in the Thread, who Vivid acted for, what is waiting on
 * someone, who is looking right now) comes from the Thread's live query, and reading that query
 * is also what marks the Thread read. Neither is fetched and neither is refreshed by hand.
 */
export function Chat({ route }: NativeStackScreenProps<Routes, 'Chat'>) {
  const data = useLiveData()
  const { id } = route.params
  const detail = useLive(data.seenThread(id))
  if (LiveState.$is('Failed')(detail)) return <Gone />
  return (
    <Conversation
      key={id}
      id={id}
      detail={LiveState.$is('Ready')(detail) ? Option.some(detail.value) : Option.none()}
    />
  )
}

/** A Thread that is not there, or not this Person's to see. The two look the same on purpose. */
function Gone() {
  const go = useGo()
  return (
    <Screen>
      <Header title="Thread" onBack={go.goBack} />
      <Empty
        title="This thread is not here"
        detail="It may have been deleted, or it is in a space you are not working in right now."
      >
        <Button label="Back to threads" onPress={go.goBack} />
      </Empty>
    </Screen>
  )
}

/** What the header says under the title: who is writing, who is here, or who it is shared with. */
function standingOf(thread: Thread, detail: ThreadDetail, me: MeResponse): Option.Option<string> {
  const others = detail.present.filter((seen) => seen.person.id !== me.person.id)
  const typing = others.filter((seen) => seen.typing)
  if (typing.length > 0) {
    return Option.some(`${typing.map((seen) => seen.person.name).join(', ')} typing…`)
  }
  if (others.length > 0) {
    return Option.some(`${others.map((seen) => seen.person.name).join(', ')} here now`)
  }
  return ThreadAudience.match(thread.audience, {
    Private: () => Option.none(),
    People: ({ participants }) => Option.some(`Shared with ${participants.length + 1} people`),
    Company: () =>
      Workspace.match(me.workspace, {
        Personal: () => Option.none(),
        Company: ({ company }) => Option.some(`Everyone in ${company.name}`),
      }),
  })
}

function Conversation({ id, detail }: { id: ThreadId; detail: Option.Option<ThreadDetail> }) {
  const me = useMe()
  const data = useLiveData()
  const go = useGo()
  const client = useMemo(() => conversation(data.session, id), [data.session, id])
  const agent = useFlueAgent({ client })
  // A phone suspends the app when it is not in front, and the stream with it; coming back
  // catches the conversation up. The subscription lives exactly as long as this view does.
  const wake = useMemo(() => onForeground(() => agent.refresh()), [agent])
  const [draft, setDraft] = useState('')
  const [sharing, setSharing] = useState(false)
  const [undelivered, setUndelivered] = useState<Option.Option<string>>(Option.none())
  const thread = Option.map(detail, (value) => value.thread)
  const shared = Option.exists(thread, (value) => !ThreadAudience.guards.Private(value.audience))
  const working =
    agent.status === 'submitted' ||
    agent.status === 'streaming' ||
    Option.exists(thread, (value) => value.attention === 'Working')
  const around: Around = {
    me: me.person.id,
    shared,
    runs: Option.match(detail, { onNone: () => [], onSome: (value) => value.runs }),
  }

  function send(text: string) {
    setUndelivered(Option.none())
    // A Thread started without a name takes its first message as one.
    if (Option.exists(thread, (value) => value.title === UNTITLED)) {
      void data.change((sdk) => sdk.PatchThread({ id, patch: { title: titleFromMessage(text) } }))
    }
    if (!shared) {
      // The hook shows the message at once and keeps it, marked, if it did not arrive.
      void agent.sendMessage(text).then(
        () => undefined,
        () => undefined,
      )
      return
    }
    // In a shared Thread the server turns the message into an attributed one, so it is sent
    // plainly and drawn when it comes back.
    void say(data, { id, body: text, key: randomUUID() }).then((result) => {
      if (Result.isSuccess(result)) return
      setUndelivered(Option.some(result.failure.message))
      setDraft((current) => (current.length === 0 ? text : current))
    })
  }

  function type(next: string) {
    // Only the edges are reported: starting to type and clearing the field.
    if ((next.length === 0) !== (draft.length === 0)) {
      void data.change((sdk) => sdk.ReportPresence({ threadId: id, typing: next.length > 0 }))
    }
    setDraft(next)
  }

  return (
    <AboveKeyboard>
      <Header
        title={Option.match(thread, { onNone: () => '', onSome: (value) => value.title })}
        subtitle={Option.getOrUndefined(
          Option.flatMap(detail, (value) => standingOf(value.thread, value, me)),
        )}
        onBack={go.goBack}
        trailing={
          Option.isSome(thread) && Workspace.guards.Company(me.workspace) ? (
            <IconButton
              icon={shared ? Users : Share2}
              label="Choose who can see this thread"
              // Only its creator may change who a Thread is shared with.
              disabled={thread.value.createdBy.id !== me.person.id}
              onPress={() => setSharing(true)}
            />
          ) : undefined
        }
      />
      <View ref={wake} style={{ flex: 1 }}>
        <Messages
          messages={agent.messages.filter(isShown)}
          ready={agent.historyReady}
          working={working}
          failure={Option.orElse(undelivered, () =>
            Option.map(Option.fromUndefinedOr(agent.error), (error) => error.message),
          )}
          around={around}
          detail={detail}
          onRetry={() => agent.refresh()}
          onContinue={send}
        />
      </View>
      <Composer
        value={draft}
        placeholder={shared ? 'Message everyone and Vivid' : 'Message Vivid'}
        working={working}
        disabled={false}
        onChange={type}
        onSend={() => {
          const text = draft.trim()
          type('')
          send(text)
        }}
        onStop={() => void data.change((sdk) => sdk.StopThread({ id }))}
      />
      {sharing && Option.isSome(thread) && Workspace.guards.Company(me.workspace) && (
        <Share
          thread={thread.value}
          company={me.workspace.company.name}
          me={me.person.id}
          onClose={() => setSharing(false)}
        />
      )}
    </AboveKeyboard>
  )
}

interface MessagesProps {
  readonly messages: ReadonlyArray<FlueConversationMessage>
  readonly ready: boolean
  readonly working: boolean
  readonly failure: Option.Option<string>
  readonly around: Around
  readonly detail: Option.Option<ThreadDetail>
  readonly onRetry: () => void
  readonly onContinue: (text: string) => void
}

/**
 * The conversation. The list is inverted, newest at the bottom: the platform then keeps the view
 * on the newest words by itself as they stream in, and holds the Person's place when they have
 * scrolled up to read. No scroll position is managed here and nothing runs per token.
 */
function Messages(props: MessagesProps) {
  const { messages, ready, working } = props
  if (messages.length === 0 && !working) return <Blank ready={ready} />
  const streaming = messages.some((message) => message.role === 'assistant' && isStreaming(message))
  return (
    <FlatList
      inverted
      // Newest first is what an inverted list draws at the bottom.
      data={messages.toReversed()}
      keyExtractor={(message) => message.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={[
        styles.column,
        { paddingHorizontal: GUTTER - 4, paddingVertical: 16, gap: 22 },
      ]}
      // The first thing in an inverted list is the last thing on screen.
      ListHeaderComponent={
        <Tail working={working && !streaming} failure={props.failure} onRetry={props.onRetry} />
      }
      renderItem={({ item }) => (
        <Message
          message={item}
          around={props.around}
          detail={props.detail}
          working={working}
          onContinue={props.onContinue}
        />
      )}
    />
  )
}

/** A Thread with nothing in it: its outline while it opens, then Vivid waiting to be asked. */
function Blank({ ready }: { ready: boolean }) {
  if (!ready) {
    return (
      <View style={[styles.column, { paddingHorizontal: GUTTER, paddingTop: 28 }]}>
        <Skeleton rows={4} />
      </View>
    )
  }
  return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <Empty title="Vivid is ready" detail="What should I take off your plate?" mood="happy" />
    </View>
  )
}

/** What sits under the newest message: that Vivid is thinking, or that something did not arrive. */
function Tail({
  working,
  failure,
  onRetry,
}: {
  working: boolean
  failure: Option.Option<string>
  onRetry: () => void
}) {
  return (
    <View style={{ gap: 12 }}>
      {working && (
        <View
          accessibilityLiveRegion="polite"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          <Face size={24} mood="thinking" />
          <Label tone="ink-3">Thinking…</Label>
        </View>
      )}
      {Option.isSome(failure) && (
        <View style={{ gap: 8 }}>
          <Notice message={failure.value} />
          <Button
            label="Try again"
            onPress={onRetry}
            containerStyle={{ alignSelf: 'flex-start' }}
          />
        </View>
      )}
    </View>
  )
}
