import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react'
import {
  ApprovalDecision,
  ThreadAudience,
  Workspace,
  type Approval,
  type ApprovalId,
  type ConversationMessage,
  type InputAnswer,
  type InputRequest,
  type InputRequestId,
  type PersonId,
  type Thread,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import {
  approvalUp,
  asking as model,
  attaching,
  conversationIn,
  draftPlace,
  isTooLong,
  lasting,
  QUIET_MS,
  readingOf,
  sending as outbox,
  streamSaid,
  titleFromMessage,
  TOO_LONG,
  withFirst,
  workspaceKey,
  type ApprovalUp,
  type Following,
  makeTurns,
  thisReader,
} from '@vivid/state'
import { type Array as Arr, Effect, Option, Result } from 'effect'
import { randomUUID } from 'expo-crypto'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { useIsFocused } from '@react-navigation/native'
import Animated, {
  scrollTo,
  useAnimatedStyle,
  useAnimatedReaction,
  useAnimatedRef,
  useSharedValue,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated'
import { MessageCircleDashed, Share2, Users } from 'lucide-react-native'
import { clearTray, pastePictures, removeFile, useTray } from '../data/attach'
import { useMicrophone } from '../data/dictation'
import { deliveryOf, type Say, type Unsent } from '../data/delivery'
import { again, First, firstKey, isOnItsWay, isSettled, standInOf } from '../data/first'
import { readingPlace, type Anchor } from '../data/reading'
import { commit, confirm, warn } from '../data/haptics'
import { draft, useDraft } from '../data/drafts'
import { useDrawerOpened } from '../data/drawer'
import { inFront, onCatchUp } from '../data/foreground'
import { drawnFrom } from '../data/heard'
import { heardIn } from '../data/hearing'
import { LiveState, useLiveData, useLiveValue, useLiveWhen } from '../data/live'
import {
  doingOf,
  isShown,
  lastWordsOf,
  momentOf,
  Speaker,
  speakerOf,
  type Around,
} from '../data/message'
import { endingOf, newestRun } from '../data/outcome'
import { Stand, standIn } from '../data/stand'
import { firstWay, UNDELIVERED, UNTITLED } from '../data/threads'
import { bearer } from '../data/transport'
import { Composer, type Onward } from '../ui/Composer'
import { BarRoom, NO_ACTIONS, NOBODY, VividAtTop, VividBar, type BarAction } from '../ui/Bar'
import { Screen } from '../ui/Screen'
import { AboveKeyboardBelowBar } from '../ui/Keyboard'
import { HANG } from '../ui/Presence'
import { Floating } from '../ui/Floating'
import { THINKING, THINKING_ROOM } from '../ui/Thinking'
import { Logo } from './integration/Logo'
import { Button, Empty, GUTTER, Label, Notice, Skeleton, styles } from '../ui/ui'
import { useAppearance } from '../data/vivid'
import { useFirst, useFront, useGo, useMe } from '../workspace'
import { Allow } from './chat/Allow'
import {
  ApprovalHold,
  approvalHoldOf,
  Deciding,
  isDeciding,
  refusedAfter,
  wasRefused,
} from './chat/asked'
import {
  anchorAt,
  arrivedOf,
  isAway,
  newestOf,
  newestWords,
  offsetFor,
  replying,
  scrolledOf,
  type Laid,
  type Scrolled,
} from './chat/away'
import { Choices } from './chat/Choices'
import { Message } from './chat/Message'
import { Replied, spokenOf } from './chat/Question'
import { Opening } from './home/First'
import { Share } from './chat/Share'
import { start } from '../data/app'

/**
 * One Thread: the conversation with Vivid, and everything live around it. It is drawn in the
 * first screen's place (`screen/Home.tsx`), not as a screen of its own; `writing` says its
 * composer takes the keyboard over from the one a first message was typed in.
 *
 * Two live queries feed this screen. The words come from the Thread's conversation
 * (`live.conversation`, `data/live.ts`), change by change, whichever runtime holds the Thread.
 * Everything else (who is in the Thread, who Vivid acted for, what is waiting on someone, who is
 * looking right now) comes from the Thread's own query. Neither is fetched and neither is
 * refreshed by hand.
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
      <VividBar conversation={false} present={NOBODY} actions={NO_ACTIONS} />
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
  /** The Thread's conversation is on screen, for the system's edge effect (`VividBar`). */
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
        // A Thread's conversation runs behind the bar with no fade, as the owner asked, so the
        // system is told to draw no edge on it. It is said only once the scroller is there, and so
        // said again for each: the system is told to leave a scroller alone only at that moment.
        conversation={listed}
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

  function stop() {
    // The Thread's sending first, so nothing still waiting to leave this phone goes after it.
    data.sending.stopped(id)
    return start(
      Effect.gen(function* () {
        setRefused(false)
        const result = yield* data.changing((sdk) => sdk.StopThread({ id }))
        setRefused(Result.isFailure(result))
      }),
    )
  }

  return { refused, stop }
}

/**
 * Sending in one Thread, and what the Thread draws of its conversation with it.
 *
 * Each message goes out under a key that names it (`data/delivery.ts`), through the Thread's
 * machine (`data/sending.ts`). When it does not arrive the machine keeps its words, its pictures
 * and its key together, so sending those words again, from the button under the conversation or
 * from the composer, is the same delivery to the server and never a second message. Nothing of
 * it is kept here: what is on its way and what did not arrive are read from the machine.
 *
 * What is drawn (`drawing`, `@vivid/state`) is the conversation with this phone's own words in
 * it from the moment they are sent. Until the conversation has been read, that is what this
 * phone last heard in the Thread (`data/hearing.ts`), with the same words laid over it: its
 * words are on the first frame, and something sent before the conversation arrives is not
 * hidden behind what was kept. In a shared Thread the server turns a message into one that says
 * who spoke, so nothing is drawn ahead of it.
 *
 * `ready` is only that there is something to draw; `live` that it is the conversation as the
 * server has it now.
 */
function useSend(
  id: ThreadId,
  place: string,
  at: {
    readonly detail: Option.Option<ThreadDetail>
    /** The conversation's query as it stands (`useFollowed`). */
    readonly reading: LiveState<Following>
  },
) {
  const data = useLiveData()
  const me = useMe()
  const { detail, reading } = at
  const state = useAtomValue(data.sending.stateIn(id))
  const thread = Option.map(detail, (value) => value.thread)
  const shared = Option.exists(thread, (value) => !ThreadAudience.guards.Private(value.audience))
  // What is drawn from: the conversation, or until it has been read what the phone kept of it
  // (`drawnFrom`, `data/heard.ts`), never for a conversation the server has refused.
  const from = drawnFrom(
    reading,
    heardIn({ origin: data.session.server, person: me.person.id }, id),
  )
  const drawn = outbox.drawing({
    messages: from.messages,
    live: from.live,
    sending: state,
    runs: runsOf(detail),
    ahead: !shared,
  })
  // The one delivery the foot of the conversation speaks of: the first that is not known to
  // have arrived. Sending it again sends everything that is not, in the order it was written.
  // What a Person is told is the one thing they can act on, whatever the server said.
  const unsent = Option.map(Option.fromUndefinedOr(drawn.unsent[0]), ({ delivery }): Unsent => ({
    words: delivery.words,
    pictures: delivery.pictures,
    key: delivery.key,
    why: UNDELIVERED,
  }))

  /** Renames a Thread that has no name after the words being sent into it. */
  function name(words: string) {
    // A Thread started without a name takes its first message as one. A refusal is not said: the
    // Person did not ask for this, the Thread keeps the title it had, and the next message tries
    // again because the title is still the unnamed one.
    if (Option.exists(thread, (value) => value.title === UNTITLED)) {
      void data.change((sdk) => sdk.PatchThread({ id, patch: { title: titleFromMessage(words) } }))
    }
  }

  /**
   * Sends words. When they are the words of something that did not arrive, however they got
   * back into the Person's hands (the retry button, or the composer the words were put back
   * in), everything that did not arrive goes again, each as the delivery it is. Any other words
   * are a new message with a key of their own.
   */
  function say(words: string, pictures: ReadonlyArray<attaching.Picture>) {
    name(words)
    const delivery = deliveryOf(unsent, words, pictures, randomUUID)
    const retried = drawn.unsent.some((failed) => failed.delivery.key === delivery.key)
    const sent = retried
      ? data.sending.again(id, { seen: drawn.seen, key: delivery.key })
      : data.sending.say({ delivery: { thread: id, ...delivery }, seen: drawn.seen })
    return sent.then((arrived) => {
      // Nothing in a shared Thread shows words that did not arrive, so they go back into the
      // composer, and so back into what the phone keeps, unless the Person has started
      // writing something else there since.
      if (!arrived && shared && draft.in(place).length === 0) draft.keep(place, words)
      return arrived
    })
  }

  return {
    shared,
    said: drawn.said,
    ready: from.ready,
    live: from.live,
    settled: from.settled,
    /**
     * Whether Vivid is at work, by the one rule every surface shares (`isWorking`,
     * `@vivid/state`): from what this phone has sent, what the conversation says, and what the
     * Thread's record says, which is how work started anywhere else is known here.
     */
    working: outbox.isWorking({
      owed: drawn.owed,
      conversation: conversationIn(reading),
      attention: Option.map(thread, (value) => value.attention),
    }),
    /**
     * A delivery is on its way and has not been answered: until the server answers, nothing
     * more is sent from here.
     */
    pending: outbox.isWaiting(state),
    unsent,
    /**
     * The ids the messages that did not arrive are drawn under, so they are drawn as not sent.
     * A shared Thread draws none of its own words ahead, so there is no such row in it.
     */
    undelivered: shared ? [] : drawn.unsent.map((failed) => outbox.sentId(failed.delivery)),
    /**
     * Sends words: as the delivery still in doubt when they are its words, else as a new one.
     * Answers whether they arrived.
     */
    say,
  }
}

/**
 * The request from Vivid whose card is up over the composer, and answering it.
 *
 * `up` is the request that should be up (`upOf`). The card holds one request at a time and lets
 * go of it only once it has slid away, so the next request's card rises after the last has
 * settled (`holdOf`). What it holds follows `up` while rendering, which is React's own way to
 * follow a value without an effect: a free card takes the request that is up.
 *
 * The answers to a request's questions go to the server together, once the card has one for
 * each (`chat/Choices.tsx`). They are kept as on their way until the request's record says it
 * is answered: it is the record that takes the card away, not the call returning, so rows that
 * woke up between the two could not be pressed a second time.
 *
 * Each send is one `Attempt`, and what ends is that attempt and nothing else (`afterFailure`).
 * A request can be settled somewhere else while its answers from here are still in flight; the
 * next request is then up and may be answered before the first call comes back refused. That
 * late refusal used to clear whatever was on its way, which woke the second request's rows in
 * the middle of its own send. One request also takes one send at a time (`mayAnswer`). Which
 * requests have a call in flight is kept in a ref, read when a press happens and never while
 * rendering, because two presses can land before React has drawn the first.
 *
 * A refusal is kept with what to say and the question it names (`refusedOf`), against the
 * request it was for, and is not said about any other.
 *
 * Where the Person is in the request's questions is kept here too (`kept`, `draftingOf`), and
 * not in the card, because the composer has a part in one case: a question that offers no
 * options is answered from it (`Foot`, `replyOf`). In every other case what is sent from the
 * composer is an ordinary message, which the server answers by withdrawing the request.
 */
function useAsking(up: Option.Option<InputRequest>) {
  const data = useLiveData()
  const [held, setHeld] = useState(up)
  const [pending, setPending] = useState<Option.Option<model.Attempt>>(Option.none())
  const [refused, setRefused] = useState<Option.Option<model.Refusal>>(Option.none())
  // Where the Person is in the questions of the request the card holds (`draftingOf`).
  const [kept, setKept] = useState<Option.Option<model.Kept>>(Option.none())
  const flying = useRef(new Set<InputRequestId>())
  const attempts = useRef(0)
  const hold = model.holdOf(held, up)
  if (model.Hold.$is('Free')(hold) && Option.isSome(up)) setHeld(up)
  // One function for the life of the Thread: the card's slide is timed again when it changes.
  const release = useCallback(() => setHeld(Option.none()), [])

  /** Sends a request's answers, one for each of its questions in their order. */
  function answer(id: InputRequestId, answers: Arr.NonEmptyReadonlyArray<InputAnswer>) {
    return start(
      Effect.gen(function* () {
        if (!model.mayAnswer(flying.current, id)) return
        flying.current.add(id)
        attempts.current += 1
        const tried: model.Attempt = { attempt: attempts.current, id }
        commit()
        setRefused(Option.none())
        setPending(Option.some(tried))
        const result = yield* data.changing((client) => client.AnswerInput({ id, answers }))
        flying.current.delete(id)
        if (Result.isSuccess(result)) return
        setPending((current) => model.afterFailure(current, tried.attempt))
        setRefused(Option.some(model.refusedOf(tried, result.failure)))
      }),
    )
  }

  /** What is kept against one request, when it is about that request. */
  const about = <One extends { readonly id: InputRequestId }>(
    held: Option.Option<One>,
    id: InputRequestId,
  ) => Option.filter(held, (one) => one.id === id)

  /** Where the Person is in one request's questions, with a new refusal's question put back up. */
  const draftingIn = (request: InputRequest) => model.draftingOf(request, kept, refused)

  return {
    hold,
    draftingIn,
    /** Keeps where the Person is in one request, as having seen the last refusal. */
    draft: (id: InputRequestId, drafting: model.Kept['drafting']) =>
      setKept(Option.some({ id, drafting, heeded: Option.map(refused, (one) => one.attempt) })),
    /** The request whose card is up, and where the Person is in it: what the composer reads. */
    up: Option.map(Option.filter(Option.some(hold), model.Hold.$is('Up')), ({ request }) => ({
      request,
      drafting: draftingIn(request),
    })),
    /** A request is waiting on this Person, whether or not its card is up yet. */
    waiting: Option.isSome(up),
    /** The answers to one request are on their way. */
    sendingTo: (id: InputRequestId) => Option.isSome(about(pending, id)),
    /** The answers to the request that is up are on their way, so nothing else is sent. */
    answering: Option.exists(
      Option.filter(Option.some(hold), model.Hold.$is('Up')),
      ({ request }) => Option.isSome(about(pending, request.id)),
    ),
    /** What to say when the last answers to the request that is up did not go through. */
    refusal: Option.flatMap(Option.filter(Option.some(hold), model.Hold.$is('Up')), ({ request }) =>
      about(refused, request.id),
    ),
    answer,
    release,
  }
}

/**
 * The Approval whose banner is up over the composer, and deciding it.
 *
 * `up` is the Approval that should be up (`approvalUp`, `@vivid/state`): the oldest still waiting
 * on this Person. The banner holds one at a time and lets go of it only once it has slid away,
 * so one settled here or on another device slides away, and the next rises after it
 * (`approvalHoldOf`). What it holds follows `up` while rendering, as a question's banner does
 * (`useAsking`).
 *
 * A decision quotes the digest of the record the banner is drawn from, so a banner drawn from
 * an older proposal cannot allow a newer one. It is kept as on its way until the Approval's
 * record says it is settled, which is what takes the banner away (`Deciding`). One Approval
 * takes one decision at a time: which have a call in flight is kept in a ref, read when a press
 * happens and never while rendering, because two presses can land before React has drawn the
 * first, and the second would come back refused. The end of a call only ever ends its own try
 * (`refusedAfter`). The phone answers a yes and a no differently in the hand as well as on
 * screen.
 *
 * Until 12 October 2026 the buttons were on a card in the conversation (`chat/Cards.tsx`), which
 * kept its own refusal and no try: it could be pressed twice, and a late answer wrote over
 * whatever the card then said.
 */
function useAllowing(up: Option.Option<ApprovalUp>) {
  const data = useLiveData()
  const [held, setHeld] = useState(up)
  const [deciding, setDeciding] = useState<Deciding>(Deciding.Idle())
  const flying = useRef(new Set<ApprovalId>())
  const attempts = useRef(0)
  const hold = approvalHoldOf(held, up)
  if (ApprovalHold.$is('Free')(hold) && Option.isSome(up)) setHeld(up)
  // One function for the life of the Thread: the banner's slide is timed again when it changes.
  const release = useCallback(() => setHeld(Option.none()), [])

  /** Sends one decision about one Approval, as it was shown. */
  function decide(approval: Approval, decision: ApprovalDecision) {
    return start(
      Effect.gen(function* () {
        if (flying.current.has(approval.id)) return
        flying.current.add(approval.id)
        attempts.current += 1
        const attempt = attempts.current
        if (ApprovalDecision.guards.Deny(decision)) warn()
        else confirm()
        setDeciding(Deciding.Flying({ attempt, id: approval.id }))
        const result = yield* data.changing((client) =>
          client.DecideApproval({ id: approval.id, digest: approval.digest, decision }),
        )
        flying.current.delete(approval.id)
        if (Result.isFailure(result)) setDeciding((now) => refusedAfter(now, attempt))
      }),
    )
  }

  return {
    hold,
    /**
     * No Approval is up or sliding away, so the place over the composer is a question's to take.
     */
    free: ApprovalHold.$is('Free')(hold) && Option.isNone(up),
    /** A decision about one Approval is on its way. */
    decidingOn: (id: ApprovalId) => isDeciding(deciding, id),
    /** The last decision about the Approval that is up did not go through. */
    refused: ApprovalHold.$is('Up')(hold) && wasRefused(deciding, hold.up.approval.id),
    decide,
    release,
  }
}

/**
 * What waits on this Person in a Thread: an Approval, and a request's questions. There is one
 * place over the composer and an Approval comes first, so a request is up only while no Approval
 * is up or still sliding away. With no request up, the composer under an Approval is the
 * ordinary one (`Foot`): it is handed nothing to move on with, and what it sends is a message.
 */
function useWaiting(detail: Option.Option<ThreadDetail>, me: PersonId) {
  const allowing = useAllowing(approvalUp(approvalsOf(detail), me))
  const asking = useAsking(allowing.free ? model.upOf(requestsOf(detail), me) : Option.none())
  return { allowing, asking }
}

/** What is said over the composer when a decision about an Approval did not go through. */
const UNDECIDED = 'This was already decided, or it changed. Look again.'

/**
 * The banner over the composer, for what it holds: an Approval (`useAllowing`, `chat/Allow.tsx`)
 * or the questions of a request (`useAsking`, `chat/Choices.tsx`), up or sliding away. There is
 * one place and an Approval comes first, as in the reference (T3 Code web `ChatComposer.tsx`,
 * the `activePendingApproval` branch): a question is not up while an Approval is
 * (`Conversation`). A question's banner that was up when an Approval arrived slides away
 * before the Approval's rises, and a waiting question's rises once the Approval's has gone.
 *
 * Each is keyed by what it holds, so each starts closed, with nothing picked, and measures
 * itself.
 *
 * It is drawn as a child of the Thread's column (`Conversation`), which holds the conversation
 * and the composer and ends at the keyboard, and it is anchored to the composer's measured dock
 * (`dock`). Until the dock has been laid out there is nothing to anchor to, and no banner.
 */
function Raised({
  asking,
  allowing,
  dock,
  covered,
}: {
  asking: ReturnType<typeof useAsking>
  allowing: ReturnType<typeof useAllowing>
  /** The height of the composer's dock, once it has been laid out. */
  dock: Option.Option<number>
  covered: SharedValue<number>
}) {
  if (Option.isNone(dock)) return null
  const question = model.Hold.$match(asking.hold, {
    Free: () => Option.none(),
    Up: ({ request }) => Option.some({ request, leaving: false }),
    Leaving: ({ request }) => Option.some({ request, leaving: true }),
  })
  if (Option.isNone(question)) {
    return (
      <>
        <RaisedApproval allowing={allowing} dock={dock.value} covered={covered} />
      </>
    )
  }
  const { request, leaving } = question.value
  return (
    <Choices
      key={request.id}
      request={request}
      leaving={leaving}
      busy={asking.sendingTo(request.id)}
      drafting={asking.draftingIn(request)}
      dock={dock.value}
      covered={covered}
      onDraft={(next) => asking.draft(request.id, next)}
      onSend={(answers) => void asking.answer(request.id, answers)}
      onGone={asking.release}
    />
  )
}

/** The Approval's banner, for what it holds: the one that is up, or the one sliding away. */
function RaisedApproval({
  allowing,
  dock,
  covered,
}: {
  allowing: ReturnType<typeof useAllowing>
  dock: number
  covered: SharedValue<number>
}) {
  const banner = (up: ApprovalUp, leaving: boolean) => (
    <Allow
      key={up.approval.id}
      up={up}
      leaving={leaving}
      busy={allowing.decidingOn(up.approval.id)}
      dock={dock}
      covered={covered}
      onDecide={(decision) => void allowing.decide(up.approval, decision)}
      onGone={allowing.release}
    />
  )
  return ApprovalHold.$match(allowing.hold, {
    Free: () => null,
    Up: ({ up }) => banner(up, false),
    Leaving: ({ up }) => banner(up, true),
  })
}

/**
 * The height of the composer's dock as it was last laid out, which is what the banner over it
 * is anchored to (`Raised`), and the way to say it was laid out. Nothing until the first
 * layout. A layout that changed nothing is not a new height, and draws nothing again.
 */
function useDock() {
  const [dock, setDock] = useState<Option.Option<number>>(Option.none())
  const onDock = useCallback(
    (height: number) =>
      setDock((now) => (Option.contains(now, height) ? now : Option.some(height))),
    [],
  )
  return [dock, onDock] as const
}

/** No questions: a Thread whose detail has not arrived. One value, not a new list each render. */
const NO_REQUESTS: ReadonlyArray<InputRequest> = []

/** No Approvals: a Thread whose detail has not arrived. One value, not a new list each render. */
const NO_APPROVALS: ReadonlyArray<Approval> = []

/** The Thread's Approvals, oldest first, once its live detail carries them. */
const approvalsOf = (detail: Option.Option<ThreadDetail>): ReadonlyArray<Approval> =>
  Option.match(detail, { onNone: () => NO_APPROVALS, onSome: (value) => value.approvals })

/** The Thread's Input requests, oldest first, once its live detail carries them. */
const requestsOf = (detail: Option.Option<ThreadDetail>): ReadonlyArray<InputRequest> =>
  Option.match(detail, { onNone: () => NO_REQUESTS, onSome: (value) => value.requests })

/**
 * A Thread's conversation as its screen follows it (`live.conversation`, `data/live.ts`). It is
 * asked for only once the Thread's first words are with Vivid: before that there may be no
 * Thread, and a query for one that is not there ends for good.
 *
 * A phone suspends the app when it is not in front, and its socket with it; a network that
 * changes or a server that is replaced cuts it too. Coming back, or reaching the server again,
 * has the conversation asked for again (`reopen`), which begins with it whole; what is on screen
 * stays until it answers. `wake` is the ref that does it for as long as the view it is given to
 * is mounted (`onCatchUp`), and no longer.
 */
function useFollowed(id: ThreadId, settled: boolean) {
  const data = useLiveData()
  const followed = data.live.conversation.get(id)
  const reading = useLiveWhen(settled, followed)
  const reopen = useCallback(() => data.registry.refresh(followed.atom), [data, followed])
  const wake = useMemo(() => onCatchUp(reopen), [reopen])
  return { reading, reopen, wake }
}

/** No Runs: a Thread whose detail has not arrived. One value, not a new list each render. */
const NO_RUNS: ThreadDetail['runs'] = []

/** The Thread's Runs, once its live detail carries them. */
const runsOf = (detail: Option.Option<ThreadDetail>): ThreadDetail['runs'] =>
  Option.match(detail, { onNone: () => NO_RUNS, onSome: (value) => value.runs })

/**
 * One Thread's conversation: its words, the composer under them, and what is live around both. It
 * is keyed by the Thread (`Chat`), so everything held here, the stream and the delivery that is in
 * doubt included, belongs to that one Thread and to nothing opened after it.
 *
 * The conversation and the composer share one column, which ends at the keyboard. A question's
 * choices are laid over that column between the two (`Raised`): over the conversation, under the
 * composer, and inside the column's bounds at every point, which is what lets them be touched on
 * Android.
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
  const me = useMe()
  const data = useLiveData()
  const front = useFront()
  // The conversation is opened only once the Thread's first words are with Vivid. Before that
  // there may be no Thread, and after it the conversation's first look finds the message already
  // there, as it did when a Thread was only opened once it had started.
  const settled = isSettled(first)
  const { reading, reopen, wake } = useFollowed(id, settled)
  // What is typed here and not sent is kept on the phone under this Thread's name, so it is still
  // in the composer after leaving the Thread or closing the app.
  const place = threadPlace(me, id)
  const typed = useDraft(place)
  const setTyping = useAtomSet(data.typingIn(id))
  const [sharing, setSharing] = useState(false)
  // Whether the conversation's list has been laid out, which is when the bar can speak for it.
  const [listed, setListed] = useState(false)
  const thread = Option.map(detail, (value) => value.thread)
  const sending = useSend(id, place, { detail, reading })
  const { shared, working, ready } = sending
  // What waits on this Person, which rises from behind the composer as a banner (`Raised`).
  const { allowing, asking } = useWaiting(detail, me.person.id)
  // How far the choices stand over the foot of the conversation, which keeps that much clear.
  const covered = useSharedValue(0)
  const [dock, onDock] = useDock()
  const stopping = useStop(id, working)
  const around = useAround(id, detail, shared)
  const shown = withFirst(standInOf(id, first), {
    messages: sending.said.filter(isShown),
    ready: sending.live,
  })
  // First words count as on their way from the send until the Thread's own two sources have both
  // spoken: after that, whether Vivid is working is theirs to say. Without the second half the
  // thinking would stop for the moment between the server taking the words and the Thread's
  // record arriving.
  // A conversation that could not be read has spoken too: it will not become ready, and the
  // trouble under it says why.
  const read = !LiveState.$is('Loading')(reading)
  const starting = isOnItsWay(first, read && Option.isSome(detail))
  // Thinking starts at the send; the composer's button waits for Vivid to have really started.
  const thinking = working || sending.pending || starting
  const page = pageOf(ready, shown.length, thinking)
  // The Thread's sending keeps a message that did not arrive under the id it showed it with, so
  // the Thread can draw it as not sent instead of as said. First words that did not arrive are
  // drawn the same way, under their own key.
  const lost = Option.filter(first, First.$is('Unsent'))
  // The submissions the conversation has settled, from the same reading as what is said; a
  // reply's displays wait for its own (`Message`, `settled`).
  const settledIds = new Set(sending.settled)
  const undelivered = new Set([...sending.undelivered, ...lostKeys(id, lost)])

  function type(next: string) {
    // Whether there is something typed is part of what the Thread's presence says; see
    // `presentIn`. The atom ignores a value it already holds, so every keystroke is fine.
    setTyping(next.length > 0)
    draft.keep(place, next)
  }

  /** Says something in the Thread. Words that are on their way leave the composer they were in. */
  const sayWith = (words: string, pictures: ReadonlyArray<attaching.Picture>) => {
    if (typed.trim() === words) type('')
    return sending.say(words, pictures)
  }
  const speak: Say = (words) => sayWith(words, [])

  const ended = endedOf(working, shown, around, (words) => void speak(words))

  const trouble = troubleOf({
    lost,
    unsent: sending.unsent,
    cut: useCut(reading, !shared && Option.isSome(sending.unsent)),
    words: isTooLong(reading) ? TOO_LONG : UNREACHED,
    onFirst: () => void start(again(firstWay(data), front.firsts, id)),
    onSay: (words) => void speak(words),
    onOpen: reopen,
  })

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
      <View style={{ flex: 1 }}>
        <View ref={wake} style={{ flex: 1 }}>
          <Messages
            id={id}
            messages={shown}
            page={page}
            working={working}
            thinking={thinking}
            rising={Option.map(first, (words) => ({ id: firstKey(id), at: words.start.at }))}
            onListed={() => setListed(true)}
            ended={ended}
            trouble={trouble}
            around={around}
            detail={detail}
            unsent={undelivered}
            settled={settledIds}
            covered={covered}
            foot={Option.getOrElse(dock, () => 0)}
            onContinue={speak}
          />
        </View>
        <Raised asking={asking} allowing={allowing} dock={dock} covered={covered} />
        <Foot
          typed={typed}
          writing={writing}
          shared={shared}
          working={working}
          // Nothing more can be said in a Thread until its first words are with Vivid; what is
          // typed meanwhile stays in the composer.
          waits={held(settled, sending.pending || asking.answering)}
          asking={asking}
          undecided={allowing.refused}
          stopping={stopping}
          thread={id}
          place={place}
          onType={type}
          onSpeak={sayWith}
          onDock={onDock}
        />
      </View>
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

/** What a Thread carries beside its messages, which attribution and pictures are read from. */
function useAround(id: ThreadId, detail: Option.Option<ThreadDetail>, shared: boolean): Around {
  const me = useMe()
  const { session } = useLiveData()
  return {
    me: me.person.id,
    shared,
    runs: runsOf(detail),
    hosted: { server: session.server, thread: id, asking: bearer(session.token) },
  }
}

/**
 * The foot of a Thread: the composer, and over it what could not be done from it (an answer or
 * a decision that did not go through, a Stop that was refused).
 *
 * What the composer sends is nearly always an ordinary message in the Thread, a waiting request
 * or not. While a request waits it says "Reply": the server withdraws the request when it takes
 * the message, the banner slides away with whatever was picked in it, and Vivid reads the message
 * right after its own questions, so "skip that, just do this" and an answer in the Person's own
 * words are the same thing to send. The one exception is a question that offers no options and
 * takes words: there the reply is that question's answer, and the banner moves on (`reply`).
 *
 * With nothing written while a request is up, the composer moves on from the question instead:
 * the banner has no button of its own (`onward`; `chat/Choices.tsx`).
 */
function Foot({
  thread,
  place,
  typed,
  writing,
  shared,
  working,
  waits,
  asking,
  undecided,
  stopping,
  onType,
  onSpeak,
  onDock,
}: {
  thread: ThreadId
  /** Where this Thread's draft is kept, which is also whose dictation this composer shows. */
  place: string
  typed: string
  writing: boolean
  shared: boolean
  working: boolean
  /** Words must wait in the composer (`held`). */
  waits: boolean
  asking: ReturnType<typeof useAsking>
  /** The last decision about the Approval that is up did not go through (`useAllowing`). */
  undecided: boolean
  stopping: ReturnType<typeof useStop>
  onType: (words: string) => void
  /** Says words in the Thread with the pictures the tray carries. */
  onSpeak: (words: string, pictures: ReadonlyArray<attaching.Picture>) => Promise<boolean>
  /**
   * The composer's dock was laid out this tall: it grows with what is typed, and loses the home
   * indicator's inset when the keyboard covers it.
   */
  onDock: (height: number) => void
}) {
  // The name this Person or their Company gave Vivid, live.
  const vivid = useAppearance()
  const data = useLiveData()
  const go = useGo()
  const tray = useTray(thread)
  const microphone = useMicrophone(place)
  /**
   * Sends what was typed, as what it means now (`replyOf`). Nearly always that is an ordinary
   * message. For a question that offers no options it is that question's answer: the words
   * leave the composer, the card moves on, and on the last question every answer is sent.
   */
  function reply(words: string) {
    model.Reply.$match(model.replyOf(asking.up, words), {
      Message: () => {
        // Documents are named in the words and pictures travel beside them; the tray starts
        // again from none. A message that does not arrive keeps its pictures (`deliveryOf`).
        const carried = attaching.carriedBy(tray)
        void onSpeak(
          [words, ...carried.lines].filter((line) => line.length > 0).join('\n'),
          carried.pictures,
        )
        clearTray(data, thread, shared)
      },
      Answer: ({ drafting, step }) => {
        onType('')
        Option.map(asking.up, ({ request }) => {
          asking.draft(request.id, model.Step.$is('Next')(step) ? step.asking : drafting)
          if (model.Step.$is('Send')(step)) void asking.answer(request.id, step.answers)
        })
      },
    })
  }

  /**
   * What the composer's trailing end is given while a question is up (`Onward`,
   * `ui/Composer.tsx`): where the Person is in the questions, whether they may move on, and the
   * two moves. Moving on is the next question, or from the last every answer sent
   * (`asking.advance`); going back keeps every pick. With no request up it is nothing.
   */
  const onward = Option.map(asking.up, ({ request, drafting }): Onward => {
    const progress = model.progressOf(request.questions, drafting)
    return {
      first: progress.first,
      last: progress.last,
      offers: progress.question.options.length > 0,
      ready: progress.canAdvance && !waits,
      onNext: () =>
        model.Step.$match(model.advance(request.questions, drafting), {
          Stay: () => undefined,
          Next: ({ asking: next }) => asking.draft(request.id, next),
          Send: ({ answers }) => void asking.answer(request.id, answers),
        }),
      onBack: () => asking.draft(request.id, model.back(drafting)),
    }
  })

  return (
    // Over the foot of the conversation, which scrolls on behind it: nothing is drawn behind the
    // composer but the words themselves, as in T3 Code mobile (`ThreadDetailScreen.tsx`, the
    // absolute composer overlay). Until 26 October 2026 the composer stood under the conversation
    // on a strip of its own, which the owner read as a fill behind it.
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
      {Option.isSome(asking.refusal) && (
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <Notice message={asking.refusal.value.words} />
        </View>
      )}
      {undecided && (
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <Notice message={UNDECIDED} />
        </View>
      )}
      {stopping.refused && (
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <Notice message="Vivid could not be stopped just now. Try again." />
        </View>
      )}
      <View onLayout={(event) => onDock(event.nativeEvent.layout.height)}>
        <Composer
          value={typed}
          autoFocus={writing}
          placeholder={placeholderOf(asking.waiting, shared, vivid.name)}
          working={working}
          disabled={waits}
          onChange={onType}
          // Emptying the composer, which `onSpeak` does, is also what removes this Thread's kept
          // draft.
          onSend={() => reply(typed.trim())}
          onStop={() => void stopping.stop()}
          asked={Option.getOrUndefined(onward)}
          attachments={Option.some({
            tray,
            onAttach: () => go.navigate('Add', { thread, shared }),
            onRemove: (key: string) => removeFile(data, thread, shared, key),
            onPaste: (uris: ReadonlyArray<string>) => pastePictures(data, thread, shared, uris),
          })}
          dictation={microphone}
        />
      </View>
    </View>
  )
}

/** Where a Thread's unsent words are kept on this phone, for this Person and workspace. */
const threadPlace = (me: ReturnType<typeof useMe>, id: ThreadId) =>
  draftPlace(me.person.id, { workspace: workspaceKey(me.workspace), thread: Option.some(id) })

/**
 * Whether words must wait in the composer: until the Thread's first words are with Vivid, and
 * while a send, or an answer to a question of Vivid's, is on its way. One delivery is in doubt at a time (`useSend` keeps one), so a
 * second waits for the first to be answered, which takes a moment.
 */
const held = (settled: boolean, pending: boolean): boolean => !settled || pending

/**
 * What the empty composer says. While a request from Vivid waits on the Person (`asked`), what
 * they send is their reply to it, in place of the card's answers, so it says "Reply"; otherwise
 * it says who a message goes to.
 */
const placeholderOf = (asked: boolean, shared: boolean, vivid: string): string => {
  if (asked) return 'Reply'
  return shared ? `Message everyone and ${vivid}` : `Message ${vivid}`
}

/** Something that went wrong under the conversation: what to say, and the one thing to do. */
interface Trouble {
  readonly message: string
  readonly action: string
  readonly onAct: () => void
}

/**
 * How the newest Run ended, when it ended without an answer; said once Vivid has stopped, where
 * the answer would have been. "Try again" says the Person's last words again, as a new message.
 */
const endedOf = (
  working: boolean,
  shown: ReadonlyArray<ConversationMessage>,
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
 * Whether the conversation is out of reach in a way worth saying. A link that is already being
 * opened again is not said while the app's own socket still reaches the server (`streamSaid`).
 * `unsent` is that words drawn in the conversation did not arrive (`readingOf`).
 */
const useCut = (conversation: LiveState<Following>, unsent: boolean) => {
  const link = useAtomValue(useLiveData().link)
  const reading = readingOf(conversation, { unsent })
  const held = useMemo(() => lasting(reading === 'CatchingUp', QUIET_MS), [reading])
  const late = useSyncExternalStore(held.subscribe, held.read, held.read)
  return streamSaid(reading, { socketLost: link === 'lost', late })
}

/** What a Person is told when the conversation cannot be followed. */
const UNREACHED = 'Vivid can’t be reached right now.'

/**
 * What went wrong at the foot of the conversation, and the one thing to do about it. First words
 * that did not arrive come first, since nothing else can be said until they have: their button
 * sends them again from where they stopped. Then a later message that did not arrive: its button
 * sends those words again, as the same delivery. Otherwise it is the conversation's own link
 * that is cut, and its button opens it again; a link that is already being opened again says
 * nothing. Sending is felt, from here as from the composer's own button.
 */
const troubleOf = (at: {
  readonly lost: Option.Option<Extract<First, { readonly _tag: 'Unsent' }>>
  readonly unsent: Option.Option<Unsent>
  /** The conversation is out of reach in a way worth saying (`useCut`). */
  readonly cut: boolean
  /** What is said when it is: that Vivid cannot be reached, or that the Thread is too long. */
  readonly words: string
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
    at.cut
      ? Option.some<Trouble>({ message: at.words, action: 'Try again', onAct: at.onOpen })
      : Option.none(),
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
  readonly messages: ReadonlyArray<ConversationMessage>
  readonly page: Page
  readonly working: boolean
  /** Vivid is at work or about to be: from the send, before the Thread's record says so. */
  readonly thinking: boolean
  /**
   * The message that left the composer before this list was drawn, and when: a Thread's first
   * words, which are already in the list the first time it is laid out and still rise into it.
   */
  readonly rising: Option.Option<{ readonly id: string; readonly at: number }>
  /** The Thread whose conversation this is, for where the Person was reading in it (`reading`). */
  readonly id: ThreadId
  /** The list has been laid out. */
  readonly onListed: () => void
  readonly ended: Option.Option<Ended>
  readonly trouble: Option.Option<Trouble>
  readonly around: Around
  readonly detail: Option.Option<ThreadDetail>
  /** The ids of the messages written here that did not arrive. */
  readonly unsent: ReadonlySet<string>
  /** The submissions the conversation has settled. */
  readonly settled: ReadonlySet<string>
  /**
   * How far the banner over the composer (a question's choices, an Approval) stands over the
   * foot of the conversation, in points (`chat/Banner.tsx`). The conversation keeps that much more clear under its newest words.
   */
  readonly covered: SharedValue<number>
  /**
   * The height of the composer's dock, which floats over the foot of the conversation as T3 Code
   * mobile's does (`ThreadDetailScreen.tsx`, the composer overlay whose height is the list's end
   * inset). The conversation keeps that much clear under its newest words and scrolls behind it.
   */
  readonly foot: number
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
  return <Blank ready={props.page === 'Opening'} foot={props.foot} />
}

/**
 * The conversation, oldest words first, in a scroller that is the right way up and is kept on its
 * newest words by hand: each time its content grows or its viewport changes size while the Person
 * is at the newest words, it is put back on them (`settle`). Nothing runs per token; the content's
 * height changes when a line is added, and that is when it moves.
 *
 * It was an upside-down list until 8 October 2026, which the platform keeps on its newest words by
 * itself. On the owner's iPhone (iOS 26) the system drew its scroll edge effect across the whole
 * of that list: the conversation was blurred whenever it was scrolled away from one end and sharp
 * again when pulled past it. A list turned over with a transform has its own top at the foot of
 * the screen, and the effect is measured from there. Three attempts to switch the effect off
 * through the screen (`NO_SCROLL_EDGES`, `ui/stack.ts`) did not hold on his phone, and the one
 * component that sets it on a scroller directly (react-native-screens' `ScrollViewMarker`) is not
 * compiled into the installed app. A scroller that is not turned over gives the system nothing to
 * get wrong, which is also how the reference is built (T3 Code mobile `ThreadFeed.tsx` is not
 * inverted). Not seen on an iPhone from here: there is no iOS device or simulator to run it on.
 *
 * Every message is drawn, none is recycled: the platform's recycling list cannot be opened at its
 * end without knowing every row's height. The reference uses a list library made for that
 * (`@legendapp/list`); moving to it is the way to make a very long Thread cheap to open.
 *
 * The scroller is not shown until it has first been put on its newest words (`placed`), so a
 * Thread never opens on its oldest words and jumps.
 *
 * It runs the whole height of the screen, behind the bar and behind the composer, as T3 Code
 * mobile's feed does, and keeps the bar's height and Vivid's hang clear above its oldest words and
 * the composer's dock clear under its newest (`foot`), inside the scroller, so at rest nothing is
 * covered and the words scroll on under both. Until 26 October 2026 it was a box between the two,
 * which left a strip of plain page behind Vivid's avatar and another behind the composer; the
 * owner asked why either was there. The words pass under the avatar with no fade, as he asked
 * that day too, so the pill under the avatar is an opaque bubble (`ui/Presence.tsx`).
 * react-native-screens looks for the screen's scroller down the first child of each view and
 * nowhere else (`RNSScrollViewFinder`), so the scroller stays the first child here, and the bar
 * asks it to leave its edges alone once it is laid out (`onListed`). The room the thinking bubble
 * needs is kept inside the scroller as well.
 *
 * A message that has just arrived comes in with motion, and nothing else does (`Message`,
 * `fresh`). The reference decides that from the message's own time (T3 Code mobile
 * `ThreadFeed.tsx`, `isFreshTimestamp`, three seconds). The conversation's stream does not stamp
 * a Person's words, so the scroller keeps which messages it already had (`known`): those it was
 * first drawn with, less a Thread's first words while they are within that window of their send
 * (`rising`). Whatever comes after is new, until the conversation is next scrolled.
 *
 * When the Person has scrolled away (`isAway`, `chat/away.ts`) their place is held, and a round
 * button comes out of the thinking bubble, or stands alone in its place, to bring them back
 * (`Floating`, `ui/Floating.tsx`). Words that arrive meanwhile put a dot on it; how many is said
 * only to a screen reader. Until 10 October 2026 that was a "Latest messages" button with the
 * count on it, stacked over the bubble and shown only once something had arrived. Whether they
 * are away is kept as the newest message at the moment they left, and what arrived is what came
 * after it (`arrivedSince`): a history that loads in above, as a Thread opened from what the phone
 * kept does, adds nothing new. It changes only when they cross the threshold.
 *
 * While a question's choices are up over the foot of the conversation, that much more is kept
 * clear under the newest words, and the floating row rides up by the same. Both follow the card
 * on the UI thread (`covered`), with nothing asked of JavaScript while it moves:
 * - the room at the end of the scroller is the card's coverage (`room`), as T3 Code mobile adds
 *   its card's coverage to its list's end inset as a shared value (`ThreadDetailScreen.tsx`,
 *   `combinedContentInsetEndAdjustment`). A scroll view's own end inset exists only on iOS, so
 *   here the room is a view after everything said, whose height is that shared value;
 * - while the Person is at the newest words (`following`), the scroller is put on its new end in
 *   the same frame (`scrollTo` in a reaction), so the words rise exactly with the card. A Person
 *   who has scrolled up is left where they are: only the room under the conversation changes.
 * The reference's list library does the second part itself. Vivid's scroller is the platform's,
 * so the end is worked out here from its two heights, kept as shared values when they change.
 * Putting the scroller back on its end from JavaScript is kept for what JavaScript causes, new
 * words and a viewport that changed size (`settle`), and is asked by the height of everything
 * said, never by the room: while the card moves, nothing is asked of JavaScript at all. It used
 * to be asked on every frame of the glide, and under load the newest words trailed the card.
 *
 * A Thread the Person scrolled up in and left opens again where they were reading
 * (`data/reading.ts`), on the row they were reading, with the button back to the newest words
 * already out: neither the history loading in above nor a reply that arrived meanwhile moves it
 * (`useReadingPlace`). Until 20 October 2026 every opening went to the newest words.
 *
 * The card is laid over the conversation on both platforms (`chat/Choices.tsx`), so this is the
 * same on both.
 */
function Transcript(props: MessagesProps) {
  const { id, messages, working, thinking, rising } = props
  // Where the Person was reading when they last left this Thread, if its row is among those the
  // Thread opens with; a row that is not cannot be waited for, and the Thread opens on its end.
  const [opened] = useState(() =>
    Option.filter(readingPlace.of(id), (anchor) => drawsRow(messages, props.around, anchor.key)),
  )
  const { list, room, body, port, following, offset } = useEndRoom(props.covered, opened)
  const place = useReadingPlace(id, opened, list, (key) => drawsRow(messages, props.around, key))
  // Whether the scroller has been put in its place once, which is when it is shown.
  const [placed, setPlaced] = useState(false)
  // The Person asked to be taken back to the newest words and is on the way there. Until they
  // arrive, passing through older words is not having scrolled away.
  const returning = useRef(false)
  // A Thread opened where the Person was reading is one they are away from its newest words in.
  const [awayAt, setAwayAt] = useState(() => Option.flatMap(opened, () => newestOf(messages)))
  const arrived = arrivedOf(awayAt, messages)
  const { known, moved } = useKnown(messages, rising)

  function follow(event: NativeSyntheticEvent<NativeScrollEvent>) {
    // Before it is first put on its newest words it is at its oldest, which is not the Person
    // having scrolled away.
    if (!placed) return
    const scrolled = scrolledOf(event.nativeEvent)
    const near = !isAway(scrolled)
    moved()
    if (near) returning.current = false
    // The way back to the newest words passes through older ones: none of them is where the
    // Person was reading.
    if (returning.current) return
    place.seen(scrolled)
    offset.set(scrolled.offset)
    following.set(near)
    setAwayAt((current) => {
      if (near) return Option.isNone(current) ? current : Option.none()
      return Option.isSome(current) ? current : newestOf(messages)
    })
  }

  /**
   * The content grew or the viewport changed size (a new line, the keyboard, the composer growing):
   * stay on the newest words when that is where the Person was. Never animated, so words that
   * stream in do not chase a moving target.
   */
  function settle() {
    if (list.current === null) return
    const at = place.hold()
    if (at === 'Unmeasured') return
    // A reply coming in is not followed down (`replying`); past the foot the Person is away.
    const free = at === 'Free' && Option.isNone(awayAt)
    if (free && !replying(working, messages)) list.current.scrollToEnd({ animated: false })
    else if (free && isAway({ offset: offset.get(), content: body.get(), viewport: port.get() })) {
      following.set(false)
      setAwayAt(newestOf(messages))
    }
    if (!placed) setPlaced(true)
  }

  function latest() {
    place.release()
    returning.current = true
    following.set(true)
    setAwayAt(Option.none())
    if (list.current !== null) list.current.scrollToEnd({ animated: true })
  }

  return (
    <View style={{ flex: 1, overflow: 'hidden' }} onLayout={settle}>
      <Animated.ScrollView
        ref={list}
        keyboardShouldPersistTaps="handled"
        // "on-drag", not "interactive": an interactive dismiss moves the keyboard with the
        // finger, and React Native's `KeyboardAvoidingView` on iOS hears only keyboardWillShow
        // and keyboardWillHide (`Libraries/Components/Keyboard/KeyboardAvoidingView.js`), not
        // the frames in between. The composer stayed at the keyboard's full height while the
        // keyboard was dragged half down, with the conversation showing through the gap (seen
        // on an iPhone, 26 October 2026). On drag the keyboard leaves in one animation the
        // composer rides. T3 Code mobile keeps "interactive" only under `KeyboardStickyView`,
        // from a native module this build does not ship.
        keyboardDismissMode="on-drag"
        onLayout={(event) => {
          port.set(event.nativeEvent.layout.height)
          // Settled again once the viewport it is settled against is current: the box around
          // it settles first, a frame before this height is known, and a place the Person was
          // reading at is worked out from it (`useReadingPlace`).
          settle()
          props.onListed()
        }}
        onScroll={follow}
        // The room under the conversation grows on the UI thread, and the scroller is put on
        // its new end in that same frame (`useEndRoom`). The platform holds that scroll to the
        // content's height as it was laid out last, a frame ago. While the banner glides the
        // next frame makes it up; when the whole rise lands in one frame (a Thread opened
        // under load: measured on Android on 12 October 2026, the room went from 0 to 193
        // points in one step) nothing came after it, and the newest words stayed behind the
        // banner. The content's own size changing is the one event that always follows the
        // last growth, so the scroller is put back on its end from it as well.
        onContentSizeChange={settle}
        // A finger on the conversation takes over from a return that was under way, and from
        // the place the Thread was opened at.
        onScrollBeginDrag={() => {
          returning.current = false
          place.release()
        }}
        scrollEventThrottle={32}
        // The bar is clear of the scroll bar by the room at the top; the composer is not.
        scrollIndicatorInsets={{ bottom: props.foot }}
        style={{ opacity: placed ? 1 : 0 }}
        // A Thread with few words keeps them at the foot, beside the composer.
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}
      >
        {/* Everything said, in a view of its own: its height is what the scroller's end is
              worked out from, and its growing is when the scroller is put back on that end. */}
        <View
          onLayout={(event) => {
            body.set(event.nativeEvent.layout.height)
            place.body(event.nativeEvent.layout.y)
            settle()
          }}
          style={[styles.column, saidRoom(thinking, props.foot)]}
        >
          {/* The bar and the room Vivid's avatar hangs into, so the oldest words rest under
                its name. One child, so the gap between messages is not put between the two. */}
          <View>
            <BarRoom />
            <View style={{ height: HANG }} />
          </View>
          <Rows
            {...{ thread: id, messages, settled: props.settled }}
            lines={model.linesOf(messages.map(spokenOf), requestsOf(props.detail))}
            known={known}
            around={props.around}
            detail={props.detail}
            working={working}
            unsent={props.unsent}
            onContinue={props.onContinue}
            onRow={(key, laid) => {
              if (place.row(key, laid)) settle()
            }}
          />
          <Tail ended={props.ended} trouble={props.trouble} />
        </View>
        {/* The room a question's choices are covering, after everything said (`useEndRoom`). */}
        <Animated.View style={room} />
      </Animated.ScrollView>
      {/* Standing on the composer, which floats over the foot of the box. */}
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: props.foot }}
      >
        <Floating
          thinking={thinking}
          doing={useDoing(messages, working)}
          away={Option.isSome(awayAt)}
          arrived={arrived > 0}
          label={newestWords(arrived)}
          lift={props.covered}
          onNewest={latest}
        />
      </View>
    </View>
  )
}

/**
 * The room around everything said in a Thread. At the foot: the room the thinking bubble floats
 * in, kept only while it is there, and the composer's dock, which floats over the foot. Until
 * 12 October 2026 the bubble's room was kept always, so that the bubble moved nothing as it came
 * and went; at rest that left 42 points of nothing under Vivid's last words, and the owner called
 * it out. The bubble arrives with a send, which moves the conversation anyway, and the scroller
 * is put back on its end when this height changes (`settle`).
 */
const saidRoom = (thinking: boolean, foot: number) => ({
  paddingHorizontal: GUTTER - 4,
  paddingTop: 16,
  paddingBottom: (thinking ? THINKING_ROOM : END_ROOM) + foot,
  gap: 22,
})

/**
 * What the working bubble says and shows: the step Vivid is on, in its own words, with the logo
 * of the Integration it works through (the account named by the step, found among the Person's
 * live connections), or "Thinking" and Vivid's orb while it is on no step.
 */
function useDoing(messages: ReadonlyArray<ConversationMessage>, working: boolean) {
  const data = useLiveData()
  const connections = useLiveValue(data.live.connections)
  const doing = doingOf(messages, working)
  const listed = Option.match(connections, { onNone: () => [], onSome: (list) => list.connections })
  const account = Option.flatMap(doing, (now) => now.account)
  const connection = Option.flatMap(account, (named) =>
    Option.fromUndefinedOr(listed.find((each) => each.account === named)),
  )
  return {
    words: Option.match(doing, { onNone: () => THINKING, onSome: (now) => now.words }),
    lead: Option.map(connection, (each) => (
      <Logo service={each.service} mark={Option.fromNullishOr(each.mark)} size={20} />
    )),
  }
}

/** Whether the list draws a row for the message `key` (`Rows` draws none for a silent one). */
const drawsRow = (
  messages: ReadonlyArray<ConversationMessage>,
  around: Around,
  key: string,
): boolean => messages.some((message) => message.id === key && !silent(message, around))

/** A message that is not drawn, as an answer or an Approval's outcome, told by its card. */
const silent = (message: ConversationMessage, around: Around): boolean =>
  Speaker.$is('Silent')(speakerOf(message, around))

/**
 * The messages of a conversation that are not new here (`Transcript`). Those the list was first
 * drawn with are not, except a Thread's first words when they were sent a moment ago; the clock is
 * read once, when the list is made, and never while rendering. A row is only ever drawn a second
 * time after the list has moved, so moving it (`moved`) is when everything in it stops being new:
 * a message scrolled back to does not arrive again.
 */
function useKnown(messages: ReadonlyArray<ConversationMessage>, rising: MessagesProps['rising']) {
  const [known, setKnown] = useState<ReadonlySet<string>>(() => {
    const now = Date.now()
    const risen = (key: string) =>
      Option.exists(rising, (first) => first.id === key && now - first.at < FRESH)
    return new Set(messages.flatMap((message) => (risen(message.id) ? [] : [message.id])))
  })
  const moved = () =>
    setKnown((current) =>
      messages.every((message) => current.has(message.id))
        ? current
        : new Set(messages.map((message) => message.id)),
    )
  return { known, moved }
}

/**
 * Where the Person was reading in a Thread (`data/reading.ts`), kept as they scroll and given back
 * when the Thread opens again.
 *
 * The place is the row at the top of the viewport and how far into it the viewport starts. Each
 * time the list is settled, and each time a row is laid out while a place is held, the list is put
 * back on that row: the history loading in above moves the row and the list follows it, and words
 * arriving below move neither, so what the Person is reading stays still. A drag or asking for the
 * newest words lets go (`release`). `hold` answers `Free` when nothing is held, `Unmeasured` while
 * the row, which is drawn, is not laid out yet, and `Held` once the list is on the row.
 */
function useReadingPlace(
  id: ThreadId,
  opened: Option.Option<Anchor>,
  list: AnimatedRef<Animated.ScrollView>,
  draws: (key: string) => boolean,
) {
  const pinned = useRef(opened)
  // Where each message row is laid out within everything said, and where everything said starts
  // within the scroller (below its top only while the conversation is shorter than the viewport).
  // Kept in refs: nothing is drawn from them, they are read when the list is settled.
  const rows = useRef(new Map<string, Laid>())
  const top = useRef(0)
  return {
    hold: (): 'Free' | 'Unmeasured' | 'Held' =>
      Option.match(pinned.current, {
        onNone: () => 'Free',
        onSome: (anchor) => {
          // The row is gone from the list (a message renamed by the conversation): the place
          // can no longer be kept, and the list stays where it is.
          if (!draws(anchor.key)) {
            pinned.current = Option.none()
            return 'Free'
          }
          return Option.match(offsetFor(anchor, rows.current), {
            onNone: () => 'Unmeasured',
            onSome: (y) => {
              if (list.current === null) return 'Unmeasured'
              list.current.scrollTo({ y: Math.max(0, top.current + y), animated: false })
              return 'Held'
            },
          })
        },
      }),
    /** A row was laid out. Answers whether the list is held at a place, to be settled again. */
    row: (key: string, laid: Laid): boolean => {
      rows.current.set(key, { y: laid.y, height: laid.height })
      return Option.isSome(pinned.current)
    },
    body: (y: number) => {
      top.current = y
    },
    release: () => {
      pinned.current = Option.none()
    },
    /** Keeps where the Person is reading, or that they are at the newest words. */
    seen: (scrolled: Scrolled) => {
      const at = isAway(scrolled)
        ? anchorAt(rows.current, scrolled.offset - top.current)
        : Option.none<Anchor>()
      Option.match(at, {
        onNone: () => readingPlace.drop(id),
        onSome: (anchor) => readingPlace.keep(id, anchor),
      })
    },
  }
}

/**
 * The room at the end of a conversation's scroller that follows a question's choices, and the
 * scroller kept on its newest words as that room changes, both on the UI thread (`Transcript`
 * says why).
 *
 * `room` is the style of a view after everything said, as tall as the card is covering. `body`
 * is the height of everything said, `port` the scroller's viewport and `following` whether the
 * Person is at the newest words; the scroller's own events keep the three. The scroller's end is
 * worked out from them, not read from its content size: the room is changing in this very frame,
 * and what the scroller would report is a frame old.
 */
function useEndRoom(covered: SharedValue<number>, opened: Option.Option<Anchor>) {
  const list = useAnimatedRef<Animated.ScrollView>()
  const body = useSharedValue(0)
  const port = useSharedValue(0)
  // A Thread opened where the Person was reading is not at its newest words.
  const following = useSharedValue(Option.isNone(opened))
  // How far down the Person has scrolled, kept as they scroll (`Transcript`, `follow`).
  const offset = useSharedValue(0)
  const room = useAnimatedStyle(() => ({ height: covered.get() }))
  useAnimatedReaction(
    () => covered.get(),
    (now, before) => {
      // Nothing to follow on the first run, and a Person who has scrolled up is not pulled down.
      if (before === null || now === before || !following.get()) return
      scrollTo(list, 0, Math.max(0, body.get() + now - port.get()), false)
    },
  )
  return { list, room, body, port, following, offset }
}

/** What is kept clear under the newest words while nothing floats there. */
const END_ROOM = 10

/** The time lines above the turns of the conversation (`makeTurns`, `@vivid/state`). */
const turnsOf = makeTurns(thisReader())

/**
 * The rows of the conversation in the order they happened (`asking.linesOf`, `@vivid/state`): each
 * message, and each answer to a question of Vivid's as a row of its own where it was given. An
 * answer is keyed by its request, so it stays the same row, and does not arrive a second time,
 * when the message that delivered it turns up and gives it its lasting place.
 */
function Rows({
  thread,
  messages,
  lines,
  known,
  around,
  detail,
  working,
  unsent,
  settled,
  onContinue,
  onRow,
}: {
  thread: ThreadId
  messages: ReadonlyArray<ConversationMessage>
  lines: ReadonlyArray<model.Line>
  /** The messages that are not new here (`Transcript`). */
  known: ReadonlySet<string>
  around: Around
  detail: Option.Option<ThreadDetail>
  working: boolean
  unsent: ReadonlySet<string>
  /** The submissions the conversation has settled. */
  settled: ReadonlySet<string>
  onContinue: Say
  /** Where each row is laid out, for where the Person is reading (`useReadingPlace`). */
  onRow: (key: string, laid: Laid) => void
}) {
  const newest = messages[messages.length - 1]
  const byKey = new Map(messages.map((message) => [message.id, message]))
  const turns = turnsOf(
    messages.map((message) => ({
      id: message.id,
      mine: message.role === 'user',
      at: momentOf(message),
    })),
    Date.now(),
  )
  // The Person's newest message, and whether Vivid has taken it up: it is working, or it has
  // already said something after it. Under that message only, it says "Seen", as a messenger
  // keeps "Read" under the last thing sent (the web does the same, `Thread.tsx`).
  const mine = [...messages].reverse().find((message) => message.role === 'user')
  const takenUp = mine !== undefined && (working || newest !== mine)
  // Each message row sits in a plain view that only reports where it is laid out. It carries the
  // row's key, so a row is never drawn again for it, and no style, so the column's gap and
  // alignment fall on it as they fell on the row. Places are kept by message (`data/reading.ts`);
  // an answer's row above or below one moves it like any other row.
  const placed = (key: string, row: ReactNode, turn: Option.Option<string>, seen: boolean) => (
    <View key={key} onLayout={(event) => onRow(key, event.nativeEvent.layout)}>
      {Option.isSome(turn) && (
        <Label size="caption" tone="ink-3" style={{ textAlign: 'center', marginBottom: 14 }}>
          {turn.value}
        </Label>
      )}
      {row}
      {seen && (
        <Label
          size="caption"
          tone="ink-3"
          style={{ textAlign: 'right', marginTop: 4, marginRight: 4 }}
        >
          Seen
        </Label>
      )}
    </View>
  )
  return lines.map((line) =>
    model.Line.$match(line, {
      Answer: ({ request }) => (
        <Replied key={`answer:${request.id}`} request={request} me={around.me} />
      ),
      Said: ({ key }) => {
        const message = byKey.get(key)
        // A message that is not drawn takes no row, so it takes no place in the column's gap.
        return message === undefined || silent(message, around)
          ? null
          : placed(
              key,
              <Message
                thread={thread}
                message={message}
                around={around}
                detail={detail}
                working={working}
                fresh={!known.has(key)}
                latest={message === newest}
                unsent={unsent}
                // A reply that names no submission was never part of one, so nothing is pending.
                settled={message.submissionId === undefined || settled.has(message.submissionId)}
                onContinue={onContinue}
              />,
              Option.fromUndefinedOr(turns.get(key)),
              message === mine && takenUp,
            )
      },
    }),
  )
}

/**
 * How long after they are sent a Thread's first words still count as arriving, in milliseconds:
 * the reference's `FRESH_ENTRY_WINDOW_MS`. A Thread opened again later than that draws them whole.
 */
const FRESH = 3000

/** A Thread with nothing in it: its outline while it opens, then Vivid waiting to be asked. */
function Blank({ ready, foot }: { ready: boolean; foot: number }) {
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
      {/* The composer floats over the foot, so the middle is the middle of what it leaves. */}
      <View style={{ height: foot }} />
    </View>
  )
}

/**
 * What sits under the newest message: Vivid about to speak, that its last Run came to nothing,
 * or that something did not arrive. That Vivid is thinking is also said in a bubble floating
 * over the foot of the list, where it stays while the conversation is read (`ui/Floating.tsx`).
 */
function Tail({
  ended,
  trouble,
}: {
  ended: Option.Option<Ended>
  trouble: Option.Option<Trouble>
}) {
  // Nothing to say is nothing drawn: an empty row here still took the column's 22-point gap
  // under the newest words (measured on the emulator, 12 October 2026). Vivid about to answer is
  // said by the working bubble alone; the face and dots that stood here went (26 October 2026).
  if (Option.isNone(ended) && Option.isNone(trouble)) return null
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
