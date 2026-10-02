import { useAtomMount, useAtomSet } from '@effect/atom-react'
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
import { draftPlace, titleFromMessage, workspaceKey } from '@vivid/state'
import { Option, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { useMemo, useState } from 'react'
import { FlatList, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Share2, Users } from 'lucide-react-native'
import { draft, useDraft } from '../data/drafts'
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

/**
 * Stopping Vivid in one Thread, and whether the last Stop went through.
 *
 * A Stop the server refuses, or that never reaches it, leaves Vivid working with nothing on screen
 * to say the press was heard; that used to read as a button that did nothing. The refusal is about
 * the Run that was being stopped: once Vivid is no longer working there is nothing left to try
 * again, and the sentence must not come back when a later Run starts. Resetting state while
 * rendering is React's own way to follow a value without an effect.
 */
function useStop(id: ThreadId, working: boolean) {
  const data = useLiveData()
  const [refused, setRefused] = useState(false)
  if (refused && !working) setRefused(false)

  async function stop() {
    setRefused(false)
    const result = await data.change((sdk) => sdk.StopThread({ id }))
    setRefused(Result.isFailure(result))
  }

  return { refused, stop }
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
  // What is typed here and not sent is kept on the phone under this Thread's name, so it is still
  // in the composer after leaving the Thread or closing the app.
  const place = draftPlace(me.person.id, {
    workspace: workspaceKey(me.workspace),
    thread: Option.some(id),
  })
  const typed = useDraft(place)
  // Being on this screen is what makes the Person present in the Thread.
  useAtomMount(data.presentIn(id))
  const setTyping = useAtomSet(data.typingIn(id))
  const [sharing, setSharing] = useState(false)
  const [undelivered, setUndelivered] = useState<Option.Option<string>>(Option.none())
  const thread = Option.map(detail, (value) => value.thread)
  const shared = Option.exists(thread, (value) => !ThreadAudience.guards.Private(value.audience))
  const working =
    agent.status === 'submitted' ||
    agent.status === 'streaming' ||
    Option.exists(thread, (value) => value.attention === 'Working')
  const stopping = useStop(id, working)
  const around: Around = {
    me: me.person.id,
    shared,
    runs: Option.match(detail, { onNone: () => [], onSome: (value) => value.runs }),
  }

  function send(text: string) {
    setUndelivered(Option.none())
    // A Thread started without a name takes its first message as one. A refusal is not said: the
    // Person did not ask for this, the Thread keeps the title it had, and the next message tries
    // again because the title is still the unnamed one.
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
      // The words go back into the composer, and so back into what the phone keeps, unless the
      // Person has started writing something else there since.
      if (draft.in(place).length === 0) draft.keep(place, text)
    })
  }

  function type(next: string) {
    // Whether there is something typed is part of what the Thread's presence says; see
    // `presentIn`. The atom ignores a value it already holds, so every keystroke is fine.
    setTyping(next.length > 0)
    draft.keep(place, next)
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
      {stopping.refused && (
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <Notice message="Vivid could not be stopped just now. Try again." />
        </View>
      )}
      <Composer
        value={typed}
        placeholder={shared ? 'Message everyone and Vivid' : 'Message Vivid'}
        working={working}
        disabled={false}
        onChange={type}
        onSend={() => {
          const text = typed.trim()
          // Emptying the composer is also what removes this Thread's kept draft.
          type('')
          send(text)
        }}
        onStop={() => void stopping.stop()}
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
