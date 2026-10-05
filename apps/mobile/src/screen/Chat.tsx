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
import { draftPlace, standingWords, titleFromMessage, workspaceKey } from '@vivid/state'
import { Option, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { useMemo, useRef, useState } from 'react'
import {
  FlatList,
  ScrollView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Share2, Users } from 'lucide-react-native'
import { deliveryOf, type Delivery, type Say, type Unsent } from '../data/delivery'
import { commit } from '../data/haptics'
import { draft, useDraft } from '../data/drafts'
import { inFront, onForeground } from '../data/foreground'
import { LiveState, refusalOf, useLive, useLiveData } from '../data/live'
import { isShown, lastWordsOf, type Around } from '../data/message'
import { endingOf, newestRun } from '../data/outcome'
import { conversation, say, UNDELIVERED, UNTITLED } from '../data/threads'
import { Composer } from '../ui/Composer'
import { Bar, BarRoom, NO_ACTIONS, VividBar, type BarAction } from '../ui/Bar'
import { Screen } from '../ui/Screen'
import { AboveKeyboardBelowBar } from '../ui/Keyboard'
import { Stand, useOrigin, type Origin } from '../ui/Presence'
import {
  Button,
  EDGE,
  Empty,
  GUTTER,
  Label,
  Notice,
  Press,
  Skeleton,
  styles,
  TARGET,
} from '../ui/ui'
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { useGo, useMe, type Routes } from '../workspace'
import { Message } from './chat/Message'
import { useComputerAction } from './Computer'
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
      <Bar title="Thread" actions={NO_ACTIONS} />
      {/* A scroller, so the system keeps these words clear of a glass bar as it does a list. */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: GUTTER }}
      >
        <Empty line="This thread is not here. It may have been deleted, or it is in a space you are not working in right now.">
          <Button label="Back" onPress={go.goBack} />
        </Empty>
      </ScrollView>
    </Screen>
  )
}

/**
 * How Vivid stands at the top of a Thread for each thing the Thread can be waiting on
 * (`ui/Presence.tsx`). At work it is the orb. Waiting for the Person it says so, in the words the
 * web uses (`standingWords`) and in that state's ink, because nothing else on a Thread does.
 * Otherwise it is simply there, under its own name.
 */
const STAND = {
  Working: Stand.Thinking(),
  NeedsYou: Stand.Saying({ words: standingWords.NeedsYou, tone: 'status-attention' }),
  Unread: Stand.Resting({ mood: 'happy' }),
  Quiet: Stand.Resting({ mood: 'happy' }),
} as const satisfies Record<Thread['attention'], Stand>

/** Who can see a Thread, in a sentence, for whoever cannot see the mark that says so. */
const audienceWords = (thread: Thread): string =>
  ThreadAudience.match(thread.audience, {
    Private: () => 'Only you can see this thread',
    People: ({ participants }) => `Shared with ${participants.length + 1} people`,
    Company: () => 'Everyone in the company can see this thread',
  })

/**
 * The top of a Thread (`VividBar`): Vivid in the middle, saying how it is doing right now
 * (thinking, waiting for the Person, or simply there). While someone else is writing, it says
 * that instead, because it is the thing about to change the Thread. At the end of the bar: who
 * else is looking, who the Thread is shared with, and the way to Vivid's computer.
 *
 * The Thread's title is not here. The bar's middle is Vivid's, as the owner asked, and the title
 * is where the Person chose the Thread: its row in the drawer.
 */
function Top({
  thread,
  present,
  working,
  origin,
  onShare,
}: {
  thread: Option.Option<Thread>
  present: ThreadDetail['present']
  /** Vivid is answering on this phone right now, which the Thread's record may not say yet. */
  working: boolean
  /** The composer on this screen, where a send leaves from on its way to the top. */
  origin: Origin
  onShare: () => void
}) {
  const me = useMe()
  const computer = useComputerAction()
  const others = present.filter((seen) => seen.person.id !== me.person.id)
  const typing = others.filter((seen) => seen.typing)
  const attention: Thread['attention'] = working
    ? 'Working'
    : Option.match(thread, { onNone: () => 'Quiet', onSome: (value) => value.attention })
  const someoneTyping = typing.length > 0
  // Who can see the Thread is a choice only inside a Company.
  const sharing = Option.map(
    Option.filter(thread, () => Workspace.guards.Company(me.workspace)),
    (value): BarAction => {
      const alone = ThreadAudience.guards.Private(value.audience)
      return {
        symbol: alone ? 'square.and.arrow.up' : 'person.2',
        icon: alone ? Share2 : Users,
        label: `${audienceWords(value)}. Choose who can see this thread`,
        // Only its creator may change who a Thread is shared with.
        disabled: value.createdBy.id !== me.person.id,
        onPress: onShare,
      }
    },
  )
  return (
    <VividBar
      stand={
        someoneTyping
          ? Stand.Saying({
              words: `${typing.map((seen) => seen.person.name).join(', ')} typing…`,
              tone: 'ink-2',
            })
          : STAND[attention]
      }
      origin={origin}
      present={others.map((seen) => seen.person)}
      actions={Option.match(sharing, {
        onNone: () => [computer],
        onSome: (share) => [share, computer],
      })}
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
    return deliver(delivery).then((why) => {
      if (Option.isNone(why)) return true
      setUnsent(Option.some({ ...delivery, why: why.value }))
      // Nothing in a shared Thread shows words that did not arrive, so they go back into the
      // composer, and so back into what the phone keeps, unless the Person has started writing
      // something else there since.
      if (shared && draft.in(place).length === 0) draft.keep(place, delivery.words)
      return false
    })
  }

  return {
    shared,
    unsent,
    /**
     * Sends words: as the delivery still in doubt when they are its words, else as a new one.
     * Answers whether they arrived.
     */
    say: (words: string) => send(deliveryOf(unsent, words, randomUUID)),
  }
}

/**
 * One Thread's conversation: its words, the composer under them, and what is live around both. It
 * is keyed by the Thread (`Chat`), so everything held here, the stream and the delivery that is in
 * doubt included, belongs to that one Thread and to nothing opened after it.
 */
function Conversation({ id, detail }: { id: ThreadId; detail: Option.Option<ThreadDetail> }) {
  // The name this Person or their Company gave Vivid, live.
  const vivid = useAppearance()
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
  const origin = useOrigin()
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
  const speak: Say = (words) => {
    if (typed.trim() === words) type('')
    return sending.say(words)
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
        void speak(unsent.words)
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
        ? Option.map(lastWordsOf(shown, around), (words) => () => void speak(words))
        : Option.none(),
    }),
  )

  return (
    <AboveKeyboardBelowBar>
      <Top
        thread={thread}
        present={Option.match(detail, { onNone: () => [], onSome: (value) => value.present })}
        working={working}
        origin={origin}
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
        origin={origin}
        value={typed}
        placeholder={shared ? `Message everyone and ${vivid.name}` : `Message ${vivid.name}`}
        working={working}
        disabled={false}
        onChange={type}
        // Emptying the composer, which `speak` does, is also what removes this Thread's kept draft.
        onSend={() => void speak(typed.trim())}
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
    </AboveKeyboardBelowBar>
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
  readonly onContinue: Say
}

/**
 * The conversation. A Thread with nothing in it is its outline or its invitation; otherwise the
 * list (`Transcript`). The two are separate components so the list can hold state of its own.
 */
function Messages(props: MessagesProps) {
  if (props.messages.length === 0 && !props.working) return <Blank ready={props.ready} />
  return <Transcript {...props} />
}

/** How far from the newest words still counts as reading them, in points. */
const FOLLOWING = 80

/**
 * The list is inverted, newest at the bottom: the platform then keeps the view on the newest words
 * by itself as they stream in, and holds the Person's place when they have scrolled up to read.
 * Nothing runs per token.
 *
 * The list sits in a box of its own that clips it. The composer under it is a sibling, not an
 * overlay, so the list's viewport is exactly what is left above the composer and the keyboard; a
 * card taller than that scrolls inside it and can never be drawn behind the composer. When the
 * viewport changes size (the keyboard opening or closing, the composer growing a line) and the
 * Person is at the newest words, they are put back on them, so the newest card is not left half
 * above the edge.
 *
 * When the Person has scrolled away and words arrive, their place is held and a "Latest messages"
 * action with the real count of arrivals brings them back. Whether they are away is kept as the
 * message count at the moment they left; it changes only when they cross the threshold.
 */
function Transcript(props: MessagesProps) {
  const { messages, working } = props
  const list = useRef<FlatList<FlueConversationMessage>>(null)
  const [awayAt, setAwayAt] = useState<Option.Option<number>>(Option.none())
  const arrived = Option.match(awayAt, {
    onNone: () => 0,
    onSome: (seen) => messages.length - seen,
  })

  function follow(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const near = event.nativeEvent.contentOffset.y < FOLLOWING
    setAwayAt((now) => {
      if (near) return Option.isNone(now) ? now : Option.none()
      return Option.isSome(now) ? now : Option.some(messages.length)
    })
  }

  /** The viewport changed size: stay on the newest words when that is where the Person was. */
  function resized() {
    if (Option.isSome(awayAt) || list.current === null) return
    list.current.scrollToOffset({ offset: 0, animated: false })
  }

  function latest() {
    setAwayAt(Option.none())
    if (list.current !== null) list.current.scrollToOffset({ offset: 0, animated: true })
  }

  return (
    <View style={{ flex: 1, overflow: 'hidden' }} onLayout={resized}>
      <FlatList
        ref={list}
        inverted
        // Newest first is what an inverted list draws at the bottom.
        data={messages.toReversed()}
        keyExtractor={(message) => message.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onScroll={follow}
        scrollEventThrottle={32}
        contentContainerStyle={[
          styles.column,
          { paddingHorizontal: GUTTER - 4, paddingVertical: 16, gap: 22 },
        ]}
        // The last thing in an inverted list is the first thing on screen: the room the glass
        // bar stands over, so the oldest words are not left under it (`BarRoom`).
        ListFooterComponent={<BarRoom />}
        // The first thing in an inverted list is the last thing on screen.
        ListHeaderComponent={<Tail ended={props.ended} trouble={props.trouble} />}
        renderItem={({ item, index }) => (
          <Message
            message={item}
            around={props.around}
            detail={props.detail}
            working={working}
            latest={index === 0}
            unsent={props.unsent}
            onContinue={props.onContinue}
          />
        )}
      />
      {arrived > 0 && <LatestButton count={arrived} onPress={latest} />}
    </View>
  )
}

/** The way back to the newest words after reading up, with how many arrived while away. */
function LatestButton({ count, onPress }: { count: number; onPress: () => void }) {
  const { colors: c } = useTheme()
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}
    >
      <Press
        accessibilityRole="button"
        accessibilityLabel={`Latest messages, ${count} new`}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: TARGET,
          paddingLeft: 16,
          paddingRight: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          borderRadius: TARGET / 2,
          borderWidth: EDGE,
          borderColor: c.border,
          backgroundColor: pressed ? c['wash-pressed'] : c['subtle-strong'],
        })}
      >
        <Label size="footnote">Latest messages</Label>
        <View
          style={{
            minWidth: 24,
            height: 24,
            paddingHorizontal: 7,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 12,
            backgroundColor: c.primary,
          }}
        >
          <Label size="caption" tone="ink-on-accent">
            {count}
          </Label>
        </View>
      </Press>
    </View>
  )
}

/** A Thread with nothing in it: its outline while it opens, then Vivid waiting to be asked. */
function Blank({ ready }: { ready: boolean }) {
  if (!ready) {
    return (
      <View>
        <BarRoom />
        <View style={[styles.column, { paddingHorizontal: GUTTER, paddingTop: 28 }]}>
          <Skeleton rows={4} />
        </View>
      </View>
    )
  }
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end', paddingHorizontal: 28, paddingBottom: 8 }}>
      <Label size="title" tone="ink-2" style={{ fontWeight: '400' }}>
        What should I take off your plate?
      </Label>
    </View>
  )
}

/**
 * What sits under the newest message: that Vivid's last Run came to nothing, or that something
 * did not arrive. That Vivid is thinking is not said here: it is at the top of the screen, in
 * Vivid's capsule (`ui/Presence.tsx`), where the orb goes when the Person sends.
 */
function Tail({
  ended,
  trouble,
}: {
  ended: Option.Option<Ended>
  trouble: Option.Option<Trouble>
}) {
  return (
    <View style={{ gap: 12 }}>
      {Option.isSome(ended) && (
        <View style={{ gap: 8 }}>
          <Label size="label" tone="ink-2">
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
