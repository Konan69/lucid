import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useFlueAgent } from '@flue/react'
import type { FlueConversationMessage } from '@flue/sdk'
import {
  ThreadAudience,
  Workspace,
  type Thread,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import type { FaceMood } from '@vivid/marks'
import { draftPlace, standingWords, titleFromMessage, workspaceKey } from '@vivid/state'
import { Option, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { useMemo, useState } from 'react'
import { FlatList, View } from 'react-native'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Share2, Users } from 'lucide-react-native'
import { deliveryOf, type Delivery, type Unsent } from '../data/delivery'
import { commit } from '../data/haptics'
import { draft, useDraft } from '../data/drafts'
import { inFront, onForeground } from '../data/foreground'
import { LiveState, refusalOf, useLive, useLiveData } from '../data/live'
import { isShown, isStreaming, lastWordsOf, type Around } from '../data/message'
import { endingOf, newestRun } from '../data/outcome'
import { conversation, say, UNDELIVERED, UNTITLED } from '../data/threads'
import { Faces } from '../ui/Avatar'
import { Composer } from '../ui/Composer'
import { Header, Screen } from '../ui/Header'
import { AboveKeyboard } from '../ui/Keyboard'
import {
  Button,
  Empty,
  Face,
  GUTTER,
  IconButton,
  Label,
  Notice,
  Skeleton,
  styles,
  type Tone,
} from '../ui/ui'
import { useGo, useMe, type Routes } from '../workspace'
import { Message } from './chat/Message'
import { Share } from './chat/Share'

/**
 * One Thread: the conversation with Vivid, and everything live around it.
 *
 * Two sources feed this screen. The words come from Flue's stream through the server's gateway,
 * token by token. Everything else (who is in the Thread, who Vivid acted for, what is waiting on
 * someone, who is looking right now) comes from the Thread's live query. Neither is fetched and
 * neither is refreshed by hand.
 *
 * Looking at the Thread is what marks it read and what makes the Person present in it, and both
 * are said only while they really are looking (`useLooking`). The screen reads the query that
 * marks the Thread read (`seenThread`) then, and the Thread's plain query otherwise: the same
 * detail is drawn either way, and a reply that lands while the screen is covered stays unread.
 */
export function Chat({ route }: NativeStackScreenProps<Routes, 'Chat'>) {
  const data = useLiveData()
  const { id } = route.params
  const looking = useLooking()
  const detail = useLive(looking ? data.seenThread(id) : data.live.thread.get(id))
  if (LiveState.$is('Failed')(detail)) return <Gone />
  return (
    <>
      {looking && <Present id={id} />}
      <Conversation
        key={id}
        id={id}
        detail={LiveState.$is('Ready')(detail) ? Option.some(detail.value) : Option.none()}
      />
    </>
  )
}

/**
 * Whether the Person is looking at this screen: it is the one on top, and the app is in front.
 *
 * A native stack keeps a screen mounted under whatever is pushed over it, and an app in the
 * background can go on receiving for a while. Being mounted used to be taken for looking, so a
 * Thread the Person had left behind went on marking its replies read and saying they were there,
 * and the server, believing it, sent no notification for work they had not seen.
 */
function useLooking(): boolean {
  const focused = useIsFocused()
  const front = useAtomValue(inFront)
  return focused && front
}

/**
 * Says "I am here" in a Thread for exactly as long as it is drawn (`presentIn`). It draws nothing;
 * being a component is what lets the screen start and stop it by whether the Person is looking,
 * with no effect to run.
 */
function Present({ id }: { id: ThreadId }) {
  const data = useLiveData()
  useAtomMount(data.presentIn(id))
  return null
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

/**
 * How Vivid is doing in a Thread, beside the words for it (`standingWords`, shared with the web):
 * the look on its face, and the ink the line under the title is said in.
 */
const STANDING = {
  Working: { mood: 'thinking', tone: 'status-working' },
  NeedsYou: { mood: 'neutral', tone: 'status-attention' },
  Unread: { mood: 'happy', tone: 'ink-3' },
  Quiet: { mood: 'neutral', tone: 'ink-3' },
} as const satisfies Record<Thread['attention'], { mood: FaceMood; tone: Tone }>

/** Who can see a Thread, in a sentence, for whoever cannot see the mark that says so. */
const audienceWords = (thread: Thread): string =>
  ThreadAudience.match(thread.audience, {
    Private: () => 'Only you can see this thread',
    People: ({ participants }) => `Shared with ${participants.length + 1} people`,
    Company: () => 'Everyone in the company can see this thread',
  })

/**
 * The top of a Thread. Vivid is in it, not just named by it: its face, the Thread's title, and a
 * line saying how it is doing right now (here, working, waiting for the Person). While someone
 * else is writing, the line says that instead, because it is the thing about to change the
 * Thread. On the right: who else is looking, and who the Thread is shared with.
 */
function Top({
  thread,
  present,
  working,
  onShare,
}: {
  thread: Option.Option<Thread>
  present: ThreadDetail['present']
  /** Vivid is answering on this phone right now, which the Thread's record may not say yet. */
  working: boolean
  onShare: () => void
}) {
  const me = useMe()
  const go = useGo()
  const others = present.filter((seen) => seen.person.id !== me.person.id)
  const typing = others.filter((seen) => seen.typing)
  const attention: Thread['attention'] = working
    ? 'Working'
    : Option.match(thread, { onNone: () => 'Quiet', onSome: (value) => value.attention })
  const standing = STANDING[attention]
  const someoneTyping = typing.length > 0
  return (
    <Header
      leading={<Face size={28} mood={standing.mood} />}
      title={Option.match(thread, { onNone: () => '', onSome: (value) => value.title })}
      subtitle={
        someoneTyping
          ? `${typing.map((seen) => seen.person.name).join(', ')} typing…`
          : standingWords[attention]
      }
      subtitleTone={someoneTyping ? 'ink-3' : standing.tone}
      onBack={go.goBack}
      trailing={
        <>
          {others.length > 0 && (
            <View style={{ marginRight: 4 }}>
              <Faces people={others.map((seen) => seen.person)} size={20} />
            </View>
          )}
          {Option.isSome(thread) && Workspace.guards.Company(me.workspace) && (
            <IconButton
              icon={ThreadAudience.guards.Private(thread.value.audience) ? Share2 : Users}
              label={`${audienceWords(thread.value)}. Choose who can see this thread`}
              // Only its creator may change who a Thread is shared with.
              disabled={thread.value.createdBy.id !== me.person.id}
              onPress={onShare}
            />
          )}
        </>
      }
    />
  )
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

/**
 * Sending in one Thread, and the one delivery from here that is not known to have arrived.
 *
 * Each message goes out under a key that names it (`data/delivery.ts`). When it does not arrive,
 * its words and its key are kept together here, so sending those words again, from the button
 * under the conversation or from the composer, is the same delivery to the server and never a
 * second message. It used to be sent again under a new key, which could run the work twice, and
 * the button beside the refusal only reconnected the conversation and sent nothing.
 */
function useSend(
  id: ThreadId,
  thread: Option.Option<Thread>,
  agent: ReturnType<typeof useFlueAgent>,
  place: string,
) {
  const data = useLiveData()
  const [unsent, setUnsent] = useState<Option.Option<Unsent>>(Option.none())
  const shared = Option.exists(thread, (value) => !ThreadAudience.guards.Private(value.audience))

  /**
   * Hands one delivery to the server and answers with why it did not arrive, when it did not. In
   * a shared Thread the server turns the message into an attributed one, so it is sent plainly
   * and drawn when it comes back; in a private one the hook shows it at once and keeps it in the
   * conversation if it fails.
   */
  const deliver = ({ words, key }: Delivery): Promise<Option.Option<string>> =>
    shared
      ? say(data, { id, body: words, key }).then(refusalOf)
      : agent.sendMessage(words, { idempotencyKey: key }).then(
          () => Option.none(),
          () => Option.some(UNDELIVERED),
        )

  function send(delivery: Delivery) {
    setUnsent(Option.none())
    // A Thread started without a name takes its first message as one. A refusal is not said: the
    // Person did not ask for this, the Thread keeps the title it had, and the next message tries
    // again because the title is still the unnamed one.
    if (Option.exists(thread, (value) => value.title === UNTITLED)) {
      void data.change((sdk) =>
        sdk.PatchThread({ id, patch: { title: titleFromMessage(delivery.words) } }),
      )
    }
    void deliver(delivery).then((why) => {
      if (Option.isNone(why)) return
      setUnsent(Option.some({ ...delivery, why: why.value }))
      // Nothing in a shared Thread shows words that did not arrive, so they go back into the
      // composer, and so back into what the phone keeps, unless the Person has started writing
      // something else there since.
      if (shared && draft.in(place).length === 0) draft.keep(place, delivery.words)
    })
  }

  return {
    shared,
    unsent,
    /** Sends words: as the delivery still in doubt when they are its words, else as a new one. */
    say: (words: string) => send(deliveryOf(unsent, words, randomUUID)),
  }
}

/**
 * One Thread's conversation: its words, the composer under them, and what is live around both. It
 * is keyed by the Thread (`Chat`), so everything held here, the stream and the delivery that is in
 * doubt included, belongs to that one Thread and to nothing opened after it.
 */
function Conversation({ id, detail }: { id: ThreadId; detail: Option.Option<ThreadDetail> }) {
  const me = useMe()
  const data = useLiveData()
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
  const setTyping = useAtomSet(data.typingIn(id))
  const [sharing, setSharing] = useState(false)
  const thread = Option.map(detail, (value) => value.thread)
  const sending = useSend(id, thread, agent, place)
  const { shared } = sending
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
  const shown = agent.messages.filter(isShown)
  // The stream keeps a message it could not send, under the id it showed it with, so the Thread
  // can draw it as not sent instead of as said. Sending again clears the list.
  const undelivered = new Set(agent.failedSends.map((send) => send.id))

  function type(next: string) {
    // Whether there is something typed is part of what the Thread's presence says; see
    // `presentIn`. The atom ignores a value it already holds, so every keystroke is fine.
    setTyping(next.length > 0)
    draft.keep(place, next)
  }

  /** Says something in the Thread. Words that are on their way leave the composer they were in. */
  function speak(words: string) {
    if (typed.trim() === words) type('')
    sending.say(words)
  }

  // What went wrong at the foot of the conversation, and the one thing to do about it. A message
  // that did not arrive comes first: its button sends those words again, as the same delivery.
  // Otherwise it is the conversation's own stream that failed, and its button opens it again.
  const trouble = Option.orElse(
    Option.map(sending.unsent, (unsent): Trouble => ({
      message: unsent.why,
      action: 'Send again',
      onAct: () => {
        // Sending is felt, from here as from the composer's own button.
        commit()
        speak(unsent.words)
      },
    })),
    () =>
      Option.map(Option.fromUndefinedOr(agent.error), (error): Trouble => ({
        message: error.message,
        action: 'Try again',
        onAct: () => agent.refresh(),
      })),
  )

  // How the newest Run ended, when it ended without an answer; said once Vivid has stopped, where
  // the answer would have been. "Try again" says the Person's last words again, as a new message.
  const ended = Option.map(
    working ? Option.none() : Option.flatMap(newestRun(around.runs), endingOf),
    (ending): Ended => ({
      words: ending.words,
      onAgain: ending.again
        ? Option.map(lastWordsOf(shown, around), (words) => () => speak(words))
        : Option.none(),
    }),
  )

  return (
    <AboveKeyboard>
      <Top
        thread={thread}
        present={Option.match(detail, { onNone: () => [], onSome: (value) => value.present })}
        working={working}
        onShare={() => setSharing(true)}
      />
      <View ref={wake} style={{ flex: 1 }}>
        <Messages
          messages={shown}
          ready={agent.historyReady}
          working={working}
          ended={ended}
          trouble={trouble}
          around={around}
          detail={detail}
          unsent={undelivered}
          onContinue={speak}
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
        // Emptying the composer, which `speak` does, is also what removes this Thread's kept draft.
        onSend={() => speak(typed.trim())}
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

/** Something that went wrong under the conversation: what to say, and the one thing to do. */
interface Trouble {
  readonly message: string
  readonly action: string
  readonly onAct: () => void
}

/** A Run that ended without an answer: what to say, and the way to ask again when that can help. */
interface Ended {
  readonly words: string
  readonly onAgain: Option.Option<() => void>
}

interface MessagesProps {
  readonly messages: ReadonlyArray<FlueConversationMessage>
  readonly ready: boolean
  readonly working: boolean
  readonly ended: Option.Option<Ended>
  readonly trouble: Option.Option<Trouble>
  readonly around: Around
  readonly detail: Option.Option<ThreadDetail>
  /** The ids of the messages written here that did not arrive. */
  readonly unsent: ReadonlySet<string>
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
        <Tail working={working && !streaming} ended={props.ended} trouble={props.trouble} />
      }
      renderItem={({ item }) => (
        <Message
          message={item}
          around={props.around}
          detail={props.detail}
          working={working}
          unsent={props.unsent}
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

/**
 * What sits under the newest message: that Vivid is thinking, that its last Run came to nothing,
 * or that something did not arrive.
 */
function Tail({
  working,
  ended,
  trouble,
}: {
  working: boolean
  ended: Option.Option<Ended>
  trouble: Option.Option<Trouble>
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
      {Option.isSome(ended) && (
        <View style={{ gap: 8 }}>
          <Label size="label" tone="ink-3">
            {ended.value.words}
          </Label>
          {Option.isSome(ended.value.onAgain) && (
            <Button
              label="Try again"
              onPress={ended.value.onAgain.value}
              containerStyle={{ alignSelf: 'flex-start' }}
            />
          )}
        </View>
      )}
      {Option.isSome(trouble) && (
        <View style={{ gap: 8 }}>
          <Notice message={trouble.value.message} />
          <Button
            label={trouble.value.action}
            onPress={trouble.value.onAct}
            containerStyle={{ alignSelf: 'flex-start' }}
          />
        </View>
      )}
    </View>
  )
}
