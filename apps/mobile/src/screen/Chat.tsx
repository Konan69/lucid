import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useFlueAgent, type UseFlueAgentOptions } from '@flue/react'
import type { FlueConversationMessage } from '@flue/sdk'
import {
  ThreadAudience,
  Workspace,
  type Thread,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import { draftPlace, titleFromMessage, workspaceKey } from '@vivid/state'
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
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { MessageCircleDashed, Share2, Users } from 'lucide-react-native'
import { deliveryOf, type Delivery, type Say, type Unsent } from '../data/delivery'
import { again, First, firstKey, isOnItsWay, isSettled, withFirst } from '../data/first'
import { commit } from '../data/haptics'
import { draft, useDraft } from '../data/drafts'
import { useDrawerOpened } from '../data/drawer'
import { inFront, onForeground } from '../data/foreground'
import { LiveState, refusalOf, useLiveData, useLiveWhen } from '../data/live'
import { isShown, lastWordsOf, type Around } from '../data/message'
import { endingOf, newestRun } from '../data/outcome'
import { Stand, standIn } from '../data/stand'
import { conversation, firstWay, say, UNDELIVERED, UNTITLED } from '../data/threads'
import { Composer } from '../ui/Composer'
import { BarRoom, NO_ACTIONS, NOBODY, VividAtTop, VividBar, type BarAction } from '../ui/Bar'
import { Screen } from '../ui/Screen'
import { AboveKeyboardBelowBar } from '../ui/Keyboard'
import { HANG } from '../ui/Presence'
import { Dots } from '../ui/Dots'
import { Thinking, THINKING_CLEAR, THINKING_ROOM } from '../ui/Thinking'
import {
  Button,
  EDGE,
  Empty,
  Face,
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
import { useFirst, useFront, useMe } from '../workspace'
import { Message } from './chat/Message'
import { Opening } from './home/First'
import { Share } from './chat/Share'

/**
 * One Thread: the conversation with Vivid, and everything live around it. It is drawn in the
 * first screen's place (`screen/Home.tsx`), not as a screen of its own; `writing` says its
 * composer takes the keyboard over from the one a first message was typed in.
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
 *
 * A Thread started from the greeting is drawn here before the server has it, with its first
 * words already in the conversation (`data/first.ts`). Until those words are with Vivid nothing
 * is asked of the server about the Thread and nobody is said to be present in it: there may be
 * no such Thread yet.
 */
export function Chat({ id, writing }: { id: ThreadId; writing: boolean }) {
  const data = useLiveData()
  const looking = useLooking()
  const first = useFirst(id)
  const settled = isSettled(first)
  const detail = useLiveWhen(settled, looking ? data.seenThread(id) : data.live.thread.get(id))
  if (LiveState.$is('Failed')(detail)) return <Gone />
  return (
    <>
      {looking && settled && <Present id={id} />}
      <Conversation
        key={id}
        id={id}
        writing={writing}
        first={first}
        detail={LiveState.$is('Ready')(detail) ? Option.some(detail.value) : Option.none()}
      />
    </>
  )
}

/**
 * Whether the Person is looking at this Thread: the first screen, where it is drawn, is the one
 * on top, and the app is in front.
 *
 * A native stack keeps a screen mounted under whatever is pushed over it, and an app in the
 * background can go on receiving for a while. Being mounted used to be taken for looking, so a
 * Thread the Person had left behind went on marking its replies read and saying they were there,
 * and the server, believing it, sent no notification for work they had not seen. The open menu
 * counts as covering it for the same reason.
 */
function useLooking(): boolean {
  const focused = useIsFocused()
  const front = useAtomValue(inFront)
  // The menu is drawn over the first screen without taking its focus, and it covers the Thread.
  const covered = useDrawerOpened()
  return focused && front && !covered
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

/**
 * A Thread that is not there, or not this Person's to see. The two look the same on purpose. The
 * way on is a new Thread: this is the first screen, so there is nowhere to go back to.
 */
function Gone() {
  const front = useFront()
  return (
    <Screen>
      <VividBar inverted={false} present={NOBODY} actions={NO_ACTIONS} />
      <VividAtTop stand={Stand.Resting({ mood: 'happy' })} />
      {/* A scroller, so the system keeps these words clear of a glass bar as it does a list. */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: GUTTER }}
      >
        <Empty
          icon={MessageCircleDashed}
          title="This thread is not here"
          line="It may have been deleted, or it is in a space you are not working in right now."
          room="page"
        >
          <Button kind="primary" label="New thread" onPress={() => front.fresh()} />
        </Empty>
      </ScrollView>
    </Screen>
  )
}

/** Who can see a Thread, in a sentence, for whoever cannot see the mark that says so. */
const audienceWords = (thread: Thread): string =>
  ThreadAudience.match(thread.audience, {
    Private: () => 'Only you can see this thread',
    People: ({ participants }) => `Shared with ${participants.length + 1} people`,
    Company: () => 'Everyone in the company can see this thread',
  })

/**
 * The top of a Thread: the bar (`VividBar`) and, floating in its middle, Vivid's avatar with how
 * it stands under it (`VividAtTop`): waiting for the Person, simply there, or who else is
 * writing (`standIn`). At the end of the bar: who else is looking, who the Thread is shared
 * with, and the way to call Vivid. The way to a new Thread and to Vivid's computer are in
 * Vivid's own menu, under its avatar (`ui/Presence.tsx`); a new Thread is also in the menu the
 * bar starts with.
 *
 * A Thread with nothing in it yet has Vivid in the middle of the page instead (`opening`), as
 * the first screen has, so it is not also drawn up here.
 *
 * The Thread's title is not here. The bar's middle is Vivid's, as the owner asked, and the title
 * is where the Person chose the Thread: its row in the menu.
 */
function Top({
  thread,
  present,
  working,
  opening,
  listed,
  onShare,
}: {
  thread: Option.Option<Thread>
  present: ThreadDetail['present']
  /** The Thread has no words yet, so the page is Vivid's greeting and the avatar is in it. */
  opening: boolean
  /** Vivid is answering on this phone right now, which the Thread's record may not say yet. */
  working: boolean
  /** The Thread's upside-down list is on screen, for the system's edge effect (`VividBar`). */
  listed: boolean
  onShare: () => void
}) {
  const me = useMe()
  const others = present.filter((seen) => seen.person.id !== me.person.id)
  const typing = others.filter((seen) => seen.typing)
  const attention: Thread['attention'] = working
    ? 'Working'
    : Option.match(thread, { onNone: () => 'Quiet', onSome: (value) => value.attention })
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
    <>
      <VividBar
        // A Thread's list is upside down, which the system's edge effect cannot be given. It is
        // said only once the list is there, and so said again for every list: the system is
        // told to leave a scroller alone only at the moment this changes (`NO_SCROLL_EDGES`).
        inverted={listed}
        present={others.map((seen) => seen.person)}
        actions={Option.match(sharing, {
          onNone: () => NO_ACTIONS,
          onSome: (share) => [share],
        })}
      />
      {!opening && (
        <VividAtTop
          stand={standIn(
            attention,
            typing.map((seen) => seen.person.name),
          )}
        />
      )}
    </>
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
  // A delivery is on its way and has not been answered. In a private Thread the stream says so
  // itself the moment it is sent. In a shared one the message goes to the server first, and
  // nothing on this phone says Vivid has it until the Thread's record comes back; for that
  // moment this is what the top of the screen goes by.
  const [pending, setPending] = useState(false)
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
    setPending(true)
    // A Thread started without a name takes its first message as one. A refusal is not said: the
    // Person did not ask for this, the Thread keeps the title it had, and the next message tries
    // again because the title is still the unnamed one.
    if (Option.exists(thread, (value) => value.title === UNTITLED)) {
      void data.change((sdk) =>
        sdk.PatchThread({ id, patch: { title: titleFromMessage(delivery.words) } }),
      )
    }
    return deliver(delivery).then((why) => {
      setPending(false)
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
    pending,
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
function Conversation({
  id,
  writing,
  first,
  detail,
}: {
  id: ThreadId
  writing: boolean
  /** The words the Thread was started with on this phone, when it was (`data/first.ts`). */
  first: Option.Option<First>
  detail: Option.Option<ThreadDetail>
}) {
  // The name this Person or their Company gave Vivid, live.
  const vivid = useAppearance()
  const me = useMe()
  const data = useLiveData()
  const front = useFront()
  const client = useMemo(() => conversation(data.session, id), [data.session, id])
  // The conversation is opened only once the Thread's first words are with Vivid. Before that
  // there may be no Thread, and after it the stream's first look finds the message already
  // there, as it did when a Thread was only opened once it had started.
  const settled = isSettled(first)
  const agent = useFlueAgent(settled ? { client } : UNOPENED)
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
  // Whether the conversation's list has been laid out, which is when the bar can speak for it.
  const [listed, setListed] = useState(false)
  const thread = Option.map(detail, (value) => value.thread)
  const sending = useSend(id, thread, agent, place)
  const { shared } = sending
  const working = isWorking(agent.status, thread)
  const stopping = useStop(id, working)
  const around: Around = {
    me: me.person.id,
    shared,
    runs: Option.match(detail, { onNone: () => [], onSome: (value) => value.runs }),
  }
  const shown = withFirst(id, first, {
    messages: agent.messages.filter(isShown),
    ready: agent.historyReady,
  })
  // First words count as on their way from the send until the Thread's own two sources have both
  // spoken: after that, whether Vivid is working is theirs to say. Without the second half the
  // thinking would stop for the moment between the server taking the words and the Thread's
  // record arriving.
  // A conversation that could not be read has spoken too: it will not become ready, and the
  // trouble under it says why.
  const read = agent.historyReady || agent.error !== undefined
  const starting = isOnItsWay(first, read && Option.isSome(detail))
  // Thinking starts at the send; the composer's button waits for Vivid to have really started.
  const thinking = working || sending.pending || starting
  const page = pageOf(agent.historyReady, shown.length, thinking)
  // The stream keeps a message it could not send, under the id it showed it with, so the Thread
  // can draw it as not sent instead of as said. Sending again clears the list. First words that
  // did not arrive are drawn the same way, under their own key.
  const lost = Option.filter(first, First.$is('Unsent'))
  const undelivered = new Set([...agent.failedSends.map((send) => send.id), ...lostKeys(id, lost)])

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

  const trouble = troubleOf({
    lost,
    unsent: sending.unsent,
    error: Option.fromUndefinedOr(agent.error),
    onFirst: () => void again(firstWay(data), front.firsts, id),
    onSay: (words) => void speak(words),
    onOpen: () => agent.refresh(),
  })

  const ended = endedOf(working, shown, around, (words) => void speak(words))

  return (
    <AboveKeyboardBelowBar>
      <Top
        thread={thread}
        present={Option.match(detail, { onNone: () => [], onSome: (value) => value.present })}
        working={thinking}
        opening={page === 'Opening'}
        listed={listed && page === 'Conversation'}
        onShare={() => setSharing(true)}
      />
      <View ref={wake} style={{ flex: 1 }}>
        <Messages
          messages={shown}
          page={page}
          working={working}
          thinking={thinking}
          rising={Option.map(first, ({ start }) => ({ id: firstKey(id), at: start.at }))}
          onListed={() => setListed(true)}
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
        autoFocus={writing}
        placeholder={shared ? `Message everyone and ${vivid.name}` : `Message ${vivid.name}`}
        working={working}
        // Nothing more can be said in a Thread until its first words are with Vivid; what is
        // typed meanwhile stays in the composer.
        disabled={!settled}
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

/** No conversation to open yet. One value, so the hook is not handed a new one each render. */
const UNOPENED: UseFlueAgentOptions = {}

/** Something that went wrong under the conversation: what to say, and the one thing to do. */
interface Trouble {
  readonly message: string
  readonly action: string
  readonly onAct: () => void
}

/**
 * Whether Vivid is at work in a Thread: the conversation's stream says so on this phone, or the
 * Thread's record does, which is how work started anywhere else is known here.
 */
const isWorking = (
  status: ReturnType<typeof useFlueAgent>['status'],
  thread: Option.Option<Thread>,
): boolean =>
  status === 'submitted' ||
  status === 'streaming' ||
  Option.exists(thread, (value) => value.attention === 'Working')

/**
 * How the newest Run ended, when it ended without an answer; said once Vivid has stopped, where
 * the answer would have been. "Try again" says the Person's last words again, as a new message.
 */
const endedOf = (
  working: boolean,
  shown: ReadonlyArray<FlueConversationMessage>,
  around: Around,
  onSay: (words: string) => void,
): Option.Option<Ended> =>
  Option.map(
    working ? Option.none() : Option.flatMap(newestRun(around.runs), endingOf),
    (ending): Ended => ({
      words: ending.words,
      onAgain: ending.again
        ? Option.map(lastWordsOf(shown, around), (words) => () => onSay(words))
        : Option.none(),
    }),
  )

/**
 * What went wrong at the foot of the conversation, and the one thing to do about it. First words
 * that did not arrive come first, since nothing else can be said until they have: their button
 * sends them again from where they stopped. Then a later message that did not arrive: its button
 * sends those words again, as the same delivery. Otherwise it is the conversation's own stream
 * that failed, and its button opens it again. Sending is felt, from here as from the composer's
 * own button.
 */
const troubleOf = (at: {
  readonly lost: Option.Option<Extract<First, { readonly _tag: 'Unsent' }>>
  readonly unsent: Option.Option<Unsent>
  readonly error: Option.Option<Error>
  readonly onFirst: () => void
  readonly onSay: (words: string) => void
  readonly onOpen: () => void
}): Option.Option<Trouble> =>
  Option.firstSomeOf([
    Option.map(at.lost, (unsent): Trouble => ({
      message: unsent.why,
      action: 'Send again',
      onAct: () => {
        commit()
        at.onFirst()
      },
    })),
    Option.map(at.unsent, (unsent): Trouble => ({
      message: unsent.why,
      action: 'Send again',
      onAct: () => {
        commit()
        at.onSay(unsent.words)
      },
    })),
    Option.map(at.error, (error): Trouble => ({
      message: error.message,
      action: 'Try again',
      onAct: at.onOpen,
    })),
  ])

/** The key first words that did not arrive are drawn under, so they are drawn as not sent. */
const lostKeys = (id: ThreadId, lost: Option.Option<First>): ReadonlyArray<string> =>
  Option.match(lost, { onNone: () => [], onSome: () => [firstKey(id)] })

/** A Run that ended without an answer: what to say, and the way to ask again when that can help. */
interface Ended {
  readonly words: string
  readonly onAgain: Option.Option<() => void>
}

interface MessagesProps {
  readonly messages: ReadonlyArray<FlueConversationMessage>
  readonly page: Page
  readonly working: boolean
  /** Vivid is at work or about to be: from the send, before the Thread's record says so. */
  readonly thinking: boolean
  /**
   * The message that left the composer before this list was drawn, and when: a Thread's first
   * words, which are already in the list the first time it is laid out and still rise into it.
   */
  readonly rising: Option.Option<{ readonly id: string; readonly at: number }>
  /** The list has been laid out. */
  readonly onListed: () => void
  readonly ended: Option.Option<Ended>
  readonly trouble: Option.Option<Trouble>
  readonly around: Around
  readonly detail: Option.Option<ThreadDetail>
  /** The ids of the messages written here that did not arrive. */
  readonly unsent: ReadonlySet<string>
  readonly onContinue: Say
}

/**
 * What a Thread's page is. It is decided once (`pageOf`) for everything that depends on it: the
 * list or what stands in its place, and whether Vivid's avatar floats at the top of the screen or
 * stands in the middle of the page. Decided in two places, the two could disagree, and the page
 * would then show two avatars or none.
 *
 * - `Outline`: the Thread is still opening and nothing is known to be in it.
 * - `Opening`: it has opened and has no words: Vivid's greeting, with its avatar in the middle.
 * - `Conversation`: it has words, or Vivid is thinking about the first of them.
 */
type Page = 'Outline' | 'Opening' | 'Conversation'

/** `said` is how many messages are shown; `thinking` starts at a send, before the record says so. */
const pageOf = (ready: boolean, said: number, thinking: boolean): Page => {
  if (said > 0 || thinking) return 'Conversation'
  return ready ? 'Opening' : 'Outline'
}

/**
 * The conversation. A Thread with nothing in it is its outline or its invitation; otherwise the
 * list (`Transcript`). The two are separate components so the list can hold state of its own.
 */
function Messages(props: MessagesProps) {
  if (props.page === 'Conversation') return <Transcript {...props} />
  return <Blank ready={props.page === 'Opening'} />
}

/** How far from the newest words still counts as reading them, in points. */
const FOLLOWING = 80

/**
 * The list is inverted, newest at the bottom: the platform then keeps the view on the newest words
 * by itself as they stream in, and holds the Person's place when they have scrolled up to read.
 * Nothing runs per token.
 *
 * The list sits in a box of its own that clips it, between the bar and the composer. Both are
 * siblings of the box, not overlays, so the list's viewport is exactly what is left under the bar
 * and above the composer and the keyboard; a
 * card taller than that scrolls inside it and can never be drawn behind the composer. When the
 * viewport changes size (the keyboard opening or closing, the composer growing a line) and the
 * Person is at the newest words, they are put back on them, so the newest card is not left half
 * above the edge.
 *
 * The box starts under the bar, not behind it. The list used to run up behind the glass bar with
 * the bar's room as its last row, and on the owner's iPhone that did two things (his screenshots
 * of 6 October 2026, iOS 26, dark): the words ran through Vivid's capsule and the bar's buttons,
 * and the whole conversation was drawn at about a fifth of its strength. The second is the
 * system's scroll edge effect, which takes an upside-down list behind a bar to be under that bar
 * from end to end (`NO_SCROLL_EDGES`, `ui/stack.ts`). Switching the effect off through the screen
 * did not hold: react-native-screens sets it when the option changes and when the screen is put
 * in its stack, on the scroll view that is there at that moment (`RNSScreen.mm`,
 * `updateContentScrollViewEdgeEffectsIfExists`, called from the props update and from
 * `willMoveToParentViewController`), and this list is mounted later, after the Thread's outline. A list that is never behind the
 * bar has nothing for the system to soften. Where it meets the bar it fades out over a few
 * points (`TopFade`), so words leave softly instead of being cut. Not seen on an iPhone from
 * here: there is no iOS device or simulator to run it on.
 *
 * That was not all of it: with the keyboard up the conversation was still blurred (the owner,
 * 7 October 2026). A list that was never told otherwise keeps the system's effect on all four
 * of its edges, and the keyboard is one more thing for an edge to soften against. So the list is
 * also told, every time one is laid out (`onListed`, which is what makes the bar say `inverted`).
 * Two things here exist for that telling to reach it. The library looks for the screen's
 * scroller down the first child of each view and nowhere else (`RNSScrollViewFinder`,
 * `findScrollViewInFirstDescendantChainFrom`), so the list's box is the first child here and the
 * bar's room, which is above it on screen, is written after it (`column-reverse`). And the room
 * the thinking bubble needs is kept inside the list, not made between the list and the composer.
 *
 * A message that has just arrived comes in with motion, and nothing else does (`Message`,
 * `fresh`). The reference decides that from the message's own time (T3 Code mobile
 * `ThreadFeed.tsx`, `isFreshTimestamp`, three seconds). The conversation's stream does not stamp
 * a Person's words, so the list keeps which messages it already had (`known`): those it was first
 * drawn with, less a Thread's first words while they are within that window of their send
 * (`rising`). Whatever comes after is new, until the list is next scrolled.
 *
 * When the Person has scrolled away and words arrive, their place is held and a "Latest messages"
 * action with the real count of arrivals brings them back. Whether they are away is kept as the
 * message count at the moment they left; it changes only when they cross the threshold.
 */
function Transcript(props: MessagesProps) {
  const { messages, working, thinking, rising } = props
  const list = useRef<FlatList<FlueConversationMessage>>(null)
  const [awayAt, setAwayAt] = useState<Option.Option<number>>(Option.none())
  const arrived = Option.match(awayAt, {
    onNone: () => 0,
    onSome: (seen) => messages.length - seen,
  })
  // The messages that are not new here. Those the list was first drawn with are not, except a
  // Thread's first words when they were sent a moment ago; the clock is read once, when the list
  // is made, and never while rendering.
  const [known, setKnown] = useState<ReadonlySet<string>>(() => {
    const now = Date.now()
    const risen = (key: string) =>
      Option.exists(rising, (first) => first.id === key && now - first.at < FRESH)
    return new Set(messages.map((message) => message.id).filter((key) => !risen(key)))
  })

  function follow(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const near = event.nativeEvent.contentOffset.y < FOLLOWING
    // A row is only ever drawn a second time after the list has moved, so moving it is when
    // everything in it stops being new: a message scrolled back to does not arrive again.
    setKnown((current) =>
      messages.every((message) => current.has(message.id))
        ? current
        : new Set(messages.map((message) => message.id)),
    )
    setAwayAt((current) => {
      if (near) return Option.isNone(current) ? current : Option.none()
      return Option.isSome(current) ? current : Option.some(messages.length)
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

  // Vivid has been asked and has not begun: the newest thing in the Thread is not its reply.
  const newest = messages[messages.length - 1]
  const awaited =
    thinking && Option.isNone(props.trouble) && newest !== undefined && newest.role !== 'assistant'

  return (
    // The list's box is written first and drawn second: see the note above about the scroller.
    <View style={{ flex: 1, flexDirection: 'column-reverse' }}>
      <View style={{ flex: 1, overflow: 'hidden' }} onLayout={resized}>
        <FlatList
          ref={list}
          inverted
          // Newest first is what an inverted list draws at the bottom.
          data={messages.toReversed()}
          keyExtractor={(message) => message.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onLayout={props.onListed}
          onScroll={follow}
          scrollEventThrottle={32}
          contentContainerStyle={[
            styles.column,
            {
              paddingHorizontal: GUTTER - 4,
              // The list is upside down, so its top is the foot of the conversation: the room
              // the thinking bubble floats in, kept whether or not it is there.
              paddingTop: THINKING_ROOM,
              paddingBottom: 16,
              gap: 22,
            },
          ]}
          // The last thing in an inverted list is the first thing on screen: the room Vivid's
          // avatar hangs into, so the oldest words rest under its name and not behind it.
          ListFooterComponent={<View style={{ height: HANG }} />}
          // The first thing in an inverted list is the last thing on screen.
          ListHeaderComponent={
            <Tail awaited={awaited} ended={props.ended} trouble={props.trouble} />
          }
          renderItem={({ item, index }) => (
            <Message
              message={item}
              around={props.around}
              detail={props.detail}
              working={working}
              fresh={!known.has(item.id)}
              latest={index === 0}
              unsent={props.unsent}
              onContinue={props.onContinue}
            />
          )}
        />
        <TopFade />
        {/* Always there, so the bubble inside it can fade out when the work ends. */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: THINKING_CLEAR,
            alignItems: 'center',
          }}
        >
          {thinking && <Thinking />}
        </View>
        {arrived > 0 && <LatestButton count={arrived} lifted={thinking} onPress={latest} />}
      </View>
      <BarRoom />
    </View>
  )
}

/**
 * How long after they are sent a Thread's first words still count as arriving, in milliseconds:
 * the reference's `FRESH_ENTRY_WINDOW_MS`. A Thread opened again later than that draws them whole.
 */
const FRESH = 3000

/**
 * How far under the bar the conversation fades out, in points: as far as Vivid's avatar and its
 * name hang below the bar (`HANG`), and a little more for the words to come back in.
 */
const FADE = HANG + 28

/**
 * The top edge of the conversation: the page's own colour, strong behind Vivid's avatar and its
 * name and gone a little under them, so a line scrolling up leaves softly and is never read
 * through the name. It is a picture and takes no touches.
 */
function TopFade() {
  const { colors: c } = useTheme()
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: FADE }}
    >
      <Svg width="100%" height={FADE}>
        <Defs>
          <LinearGradient id="conversation-top" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.screen} stopOpacity={1} />
            {/* Solid as far as the name reaches, so no line is read through or beside it. */}
            <Stop offset={HANG / FADE} stopColor={c.screen} stopOpacity={1} />
            <Stop offset="1" stopColor={c.screen} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={FADE} fill="url(#conversation-top)" />
      </Svg>
    </View>
  )
}

/** The way back to the newest words after reading up, with how many arrived while away. */
function LatestButton({
  count,
  lifted,
  onPress,
}: {
  count: number
  /** The thinking bubble is in the room at the foot, so this stands above it. */
  lifted: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: lifted ? THINKING_ROOM + 4 : 12,
        alignItems: 'center',
      }}
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
        {/* Clear of Vivid's avatar and its name, which hang below the bar. */}
        <View style={[styles.column, { paddingHorizontal: GUTTER, paddingTop: HANG + 20 }]}>
          <Skeleton rows={4} />
        </View>
      </View>
    )
  }
  return (
    <View style={{ flex: 1 }}>
      <BarRoom />
      <Opening mood="happy" title="What should I take off your plate?" />
    </View>
  )
}

/**
 * What sits under the newest message: Vivid about to speak, that its last Run came to nothing,
 * or that something did not arrive. That Vivid is thinking is also said in a bubble floating
 * over the foot of the list, where it stays while the conversation is read (`ui/Thinking.tsx`).
 */
function Tail({
  awaited,
  ended,
  trouble,
}: {
  /** Vivid has been asked and its reply has not begun. */
  awaited: boolean
  ended: Option.Option<Ended>
  trouble: Option.Option<Trouble>
}) {
  return (
    <View style={{ gap: 12 }}>
      {awaited && <Waiting />}
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

/**
 * Where Vivid's reply will be, before it has begun: its face, as beside every reply, and three
 * dots bouncing where the words will start (`ui/Dots.tsx`). The place used to be empty from the
 * send until the first word, and the owner asked for the dots there (7 October 2026). It is laid
 * out as a reply is (`FromVivid`, `screen/chat/Message.tsx`), so the reply takes its place
 * without anything moving.
 *
 * It says nothing to a screen reader: the thinking bubble already says Vivid is thinking.
 */
function Waiting() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', gap: 10 }}
    >
      <View style={{ marginTop: 1 }}>
        <Face size={24} mood="thinking" label="" />
      </View>
      <Dots />
    </View>
  )
}
