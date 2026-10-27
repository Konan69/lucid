import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react'
import {
  textOf,
  ThreadAudience,
  type ConversationMessage,
  type ConversationState,
  type MeResponse,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import {
  asking,
  conversationIn,
  draftPlace,
  makeTurns,
  thisReader,
  inThread,
  isLive,
  isTooLong,
  lasting,
  QUIET_MS,
  readingOf,
  sending,
  streamSaid,
  titleFromMessage,
  TOO_LONG,
  workspaceKey,
  type Following,
} from '@vivid/state'
import { Option } from 'effect'
import { ArrowDown } from 'lucide-react'
import { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { openedFor, useArrival } from '../data/arrival'
import { act } from '../data/app'
import { change, changing, LiveState, presentIn, seenThread, typingIn, useLive } from '../data/live'
import { offerNotifications } from '../data/notifying'
import { router } from '../router'
import { link } from '../data/runtime'
import { orSay } from '../data/said'
import {
  conversationOf,
  halted,
  reopenConversation,
  say as deliver,
  sayAgain,
  useSending,
} from '../data/sending'
import { FirstWords, useFirstWords, useLanded } from '../data/threads'
import { Button } from '../ui/button'
import { ranBadly } from '../ui/Alive'
import { Face } from '../ui/Face'
import { arriving } from '../ui/settle'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Asks, useAsks } from './thread/Allow'
import type { Asking } from './thread/asking'
import type { Picture } from './thread/Attach'
import { Composer } from './thread/Composer'
import { isBlank, Message, Replied, Said, spokenOf, type ThreadContext } from './thread/Message'
import { newestRun, Outcome } from './thread/Outcome'
import { Layout } from './thread/Layout'
import { Doing, stepIn } from './thread/Doing'

/**
 * One Thread: the conversation with Vivid, and everything live around it.
 *
 * Two live queries feed this screen. The words come from the Thread's conversation
 * (`conversationOf`, `data/sending.ts`), change by change, whichever runtime holds the Thread.
 * Everything else (who is in the Thread, who Vivid acted for, what is waiting on someone, who is
 * looking right now) comes from the Thread's own query. Neither is fetched and neither is
 * refreshed by hand.
 */
export function Thread({
  id,
  me,
  panelOpen,
  onTogglePanel,
}: {
  id: ThreadId
  me: MeResponse
  panelOpen: boolean
  onTogglePanel: () => void
}) {
  const detail = useLive(seenThread(id))
  // One value for one answer from the server: the rows below are drawn again when what they are
  // given changes, and a new `Option` around the same record on every render would be a change.
  // It follows the record, which is the same object until the server answers again; the state
  // around it is made anew by each read (`liveStateOf`).
  const record = LiveState.$is('Ready')(detail) ? detail.value : undefined
  const known = useMemo(() => Option.fromUndefinedOr(record), [record])
  const first = useFirstWords(id)
  const landed = useLanded(id)
  // A Thread whose first words are still on their way may not exist on the server yet. It is not
  // gone, it is arriving, and what the Person just wrote is already on screen.
  if (LiveState.$is('Failed')(detail) && !travelling(first)) return <Gone />
  return (
    <Conversation
      // The conversation is drawn afresh once a new Thread's first words have landed: the rows
      // that are there when it is drawn do not rise into place, and the Person's own first
      // words were already on screen.
      key={landed ? `${id}:landed` : id}
      id={id}
      me={me}
      first={first}
      detail={known}
      panelOpen={panelOpen}
      onTogglePanel={onTogglePanel}
    />
  )
}

/** Whether first words are still on their way and so the Thread may not exist on the server yet. */
const travelling = (first: FirstWords): boolean =>
  FirstWords.$is('Sending')(first) || FirstWords.$is('Unsent')(first)

/** A Thread that is not there, or not this Person's to see. The two look the same on purpose. */
function Gone() {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-surface-0 px-6 text-center">
      <Face size={40} mood="neutral" />
      <h1 className="text-title font-title text-ink">This thread is not here</h1>
      <p className="max-w-sm text-label text-ink-3">
        It may have been deleted, or it is in a space you are not working in right now.
      </p>
      <Button variant="outline" onClick={() => void router.navigate({ to: '/' })}>
        Start a new thread
      </Button>
    </section>
  )
}

/** The reply Vivid is on: the newest message, when it is Vivid's. */
const replyIn = (visible: ReadonlyArray<ConversationMessage>) =>
  Option.filter(Option.fromUndefinedOr(visible.at(-1)), (message) => message.role === 'assistant')

/**
 * What is said under a conversation that cannot be followed: that Vivid cannot be reached, or,
 * when the server refused the conversation for its size, that it is too long to open.
 */
const unreachedWords = (reading: LiveState<Following>) =>
  isTooLong(reading) ? TOO_LONG : 'Vivid can’t be reached right now.'

/**
 * Stops Vivid in this Thread, and says so when the server did not take it. The Thread's own
 * sending is told first, so nothing still waiting to be sent from this page goes after the stop.
 */
const stop = (id: ThreadId) => {
  halted(id)
  void act(
    orSay(
      changing((sdk) => sdk.StopThread({ id })),
      'Vivid could not be stopped just now. Try again.',
    ),
  )
}

/** The title shown while a new Thread's first words are still in flight. */
const arrivingTitle = (first: FirstWords): Option.Option<string> =>
  FirstWords.$match(first, {
    Settled: () => Option.none(),
    Sending: ({ words }) => Option.some(titleFromMessage(words)),
    Unsent: ({ words }) => Option.some(titleFromMessage(words)),
  })

/** Keeps card attribution and pending questions tied to the same live Thread snapshot. */
function contextFor({
  thread,
  detail,
  me,
  shared,
  runs,
}: {
  thread: ThreadId
  detail: Option.Option<ThreadDetail>
  me: MeResponse['person']['id']
  shared: boolean
  runs: ThreadContext['runs']
}): ThreadContext {
  return {
    thread,
    me,
    shared,
    runs,
    approvals: Option.match(detail, { onNone: () => [], onSome: (value) => value.approvals }),
    requests: Option.match(detail, { onNone: () => [], onSome: (value) => value.requests }),
  }
}

/**
 * The ids of the submissions the conversation has settled, in whatever way they ended
 * (completed, failed or aborted). They come from the same state as the words drawn beside them,
 * so a reply that had ended is drawn as ended from the first frame, and one that had not still
 * waits. Kept the same until one settles.
 */
const settledIn = (settlements: ConversationState['settlements']) => {
  // The state keeps the same list until a submission settles (`changed`, `@vivid/state`
  // `conversation.ts`), so the set made for it is kept and the rows are not drawn again for a
  // set that only looks new.
  const known = settledSets.get(settlements)
  if (known !== undefined) return known
  const made: ReadonlySet<string> = new Set(
    settlements.map((settlement) => settlement.submissionId),
  )
  settledSets.set(settlements, made)
  return made
}
const settledSets = new WeakMap<ReadonlyArray<object>, ReadonlySet<string>>()

/**
 * The rows of the conversation in the order they happened (`asking.linesOf`, `@vivid/state`):
 * each message, and each answer to a question of Vivid's as a row of its own where it was given.
 * An answer is keyed by its request, so it stays the same row, and does not arrive a second
 * time, when the message that delivered it turns up and gives it its lasting place.
 *
 * `said` is the whole conversation and `visible` the messages of it that are drawn. Answers are
 * placed against the whole of it, because the message that delivers an answer to Vivid is one
 * that is never drawn itself (`sourceOf`, `@vivid/state`): the answer's row stands where it is.
 *
 * It is drawn again only when the lists, what the Thread carries beside them, or whether Vivid is
 * working changes. The frame around it is drawn again far more often (Vivid's face changes its
 * look every few seconds, and at the first key the Person types), and each time used to build
 * every row again.
 */
const turnsOf = makeTurns(thisReader())

const Rows = memo(function Rows({
  said,
  visible,
  context,
  working,
  settled,
  onContinue,
}: {
  said: ReadonlyArray<ConversationMessage>
  visible: ReadonlyArray<ConversationMessage>
  context: ThreadContext
  working: boolean
  /** The submissions the conversation has settled (`settledIn`); a reply's displays wait for its own. */
  settled: ReadonlySet<string>
  onContinue: (text: string, pictures?: ReadonlyArray<Picture>) => void
}) {
  const newest = visible.at(-1)
  const drawn = new Map(visible.map((message) => [message.id, message]))
  const turns = turnsOf(
    said.map((message) => ({
      id: message.id,
      mine: message.role === 'user',
      at: spokenOf(message).at,
    })),
    Date.now(),
  )
  // The Person's newest message, and whether Vivid has taken it up: it is working, or it has
  // already said something after it.
  const mine = [...visible].reverse().find((message) => message.role === 'user')
  const takenUp = mine !== undefined && (working || newest !== mine)
  return asking.linesOf(said.map(spokenOf), context.requests).map((line) =>
    asking.Line.$match(line, {
      Answer: ({ request }) => (
        // `data-arrives`: a row that lands while the Thread is open rises into place; the ones
        // already here when it opens do not move (`arriving`, on the list below).
        <li key={`answer:${request.id}`} data-arrives>
          <Replied request={request} me={context.me} />
        </li>
      ),
      Said: ({ key }) => {
        const message = drawn.get(key)
        if (message === undefined) return null
        const latest = message === newest
        const turn = turns.get(key)
        return (
          // A reply with nothing to show yet draws nothing (`FromVivid`), and its row then takes
          // no room either, so the line at the foot does not jump when the reply begins.
          <li key={key} data-arrives className="empty:hidden">
            {turn !== undefined && (
              <p className="mb-4 text-center text-meta font-meta text-ink-3 tabular-nums">{turn}</p>
            )}
            <Message
              message={message}
              context={context}
              // Only the newest message can be the one Vivid is working on, so the others are
              // not told when work starts and stops, and are not drawn again for it.
              working={working && latest}
              latest={latest}
              // A reply that names no submission was never part of one, so nothing is pending.
              settled={message.submissionId === undefined || settled.has(message.submissionId)}
              onContinue={onContinue}
            />
            {/* Under the Person's newest message only, as a messenger keeps "Read" under the last
                thing sent: Vivid has it. An unsent message has its own dashed look instead. */}
            {message === mine && takenUp && (
              <p className="mt-1 pe-1 text-end text-meta font-meta text-ink-3">Seen</p>
            )}
          </li>
        )
      },
    }),
  )
})

/** Keeps the conversation's message rows together, including deliveries still on their way. */
function ConversationMessages({
  ready,
  empty,
  working,
  failure,
  onRetry,
  said,
  visible,
  context,
  onContinue,
  unsent,
  lastSaid,
  onUnsentAgain,
  ended,
  onSay,
  hero,
  settled,
}: {
  hero: React.ReactNode
  settled: ReadonlySet<string>
  ready: boolean
  empty: boolean
  working: boolean
  failure: string | null
  onRetry: () => void
  /** The whole conversation, drawn or not: answers are placed against all of it (`Rows`). */
  said: ReadonlyArray<ConversationMessage>
  visible: ReadonlyArray<ConversationMessage>
  context: ThreadContext
  onContinue: (text: string, pictures?: ReadonlyArray<Picture>) => void
  /** What did not arrive, in the order it was written (`sending.Drawing`). */
  unsent: ReadonlyArray<sending.Unsent>
  lastSaid: Option.Option<string>
  onUnsentAgain: () => void
  ended: ReturnType<typeof newestRun>
  onSay: (text: string, pictures?: ReadonlyArray<Picture>) => void
}) {
  return (
    <Messages
      hero={hero}
      ready={ready}
      empty={empty}
      working={working}
      reply={replyIn(visible)}
      // Transport details stay in the log; the Person gets a clear reason and a retry action.
      failure={failure}
      onRetry={onRetry}
    >
      <Rows
        said={said}
        visible={visible}
        context={context}
        working={working}
        settled={settled}
        onContinue={onContinue}
      />
      {marked(unsent, context.shared).map((failed) => (
        <NotSent
          key={failed.delivery.key}
          words={failed.delivery.words}
          pictures={failed.delivery.pictures}
          // A private Thread already shows its own message; a shared one waits for server echo.
          shown={Option.contains(lastSaid, failed.delivery.words)}
          why={failed.why}
          // Everything that did not arrive goes again, in the order it was written, each as
          // the delivery it is, key and all: the same delivery to the server.
          onAgain={onUnsentAgain}
        />
      ))}
      {Option.isSome(ended) && (
        <Outcome run={ended.value} onAgain={Option.map(lastSaid, (words) => () => onSay(words))} />
      )}
    </Messages>
  )
}

/**
 * The deliveries that did not arrive that get the line saying so. A private Thread draws its
 * own words in the conversation, so one line under the last of them speaks for all; a shared
 * Thread draws none ahead, so each is shown with its words.
 */
const marked = (unsent: ReadonlyArray<sending.Unsent>, shared: boolean) =>
  shared ? unsent : unsent.slice(-1)

/**
 * The messages of a conversation that are drawn: the ones that belong in a Thread on every
 * surface (`inThread` in `@vivid/state`, which leaves out what the runtime says to itself and
 * the model), and not the ones with nothing in them.
 */
const shownIn = (messages: ReadonlyArray<ConversationMessage>) =>
  messages.filter((message) => inThread(message) && !isBlank(message))

/** A conversation that has not been read: one list, so nothing drawn from it looks new. */
const NOTHING_SAID: ReadonlyArray<ConversationMessage> = []

/**
 * What has been said in a Thread, as its screen draws it: the conversation's own messages and
 * what this page has sent into it.
 *
 * - `reading`: the conversation's query as it stands, which is what says the link is broken.
 * - `conversation`: its state, once it has arrived whole. The Thread's one conversation is
 *   usually open already: the router began it on the way here (`data/warm.ts`), so the first
 *   frame has the words and not an empty Thread.
 * - `drawn`: what the Thread draws of both (`sending.drawing`): the conversation with this
 *   page's own words in it from the moment they are sent, what did not arrive, and whether
 *   something sent is still owed its place. In a shared Thread the server turns a message into
 *   one that says who spoke, so nothing is drawn ahead of it and it is drawn when it comes
 *   back. Words that did not arrive are kept by the Thread's sending, never dropped, until
 *   something is sent.
 * - `visible`: the messages of it that are drawn (`shownIn`).
 *
 * Each is the same value until what it is made from changes, so nothing drawn from it is drawn
 * again for a value that only looks new.
 */
function useSaid(id: ThreadId, shared: boolean, runs: ThreadContext['runs']) {
  const reading = useLive(conversationOf(id))
  // The same state object until the conversation says something new; the reading around it is
  // made anew at each render (`liveStateOf`).
  const heard = Option.getOrUndefined(conversationIn(reading))
  const conversation = useMemo(() => Option.fromUndefinedOr(heard), [heard])
  const live = isLive(reading)
  const outgoing = useSending(id)
  const drawn = useMemo(
    () =>
      sending.drawing({
        messages: Option.match(conversation, {
          onNone: () => NOTHING_SAID,
          onSome: (now) => now.messages,
        }),
        live,
        sending: outgoing,
        runs,
        ahead: !shared,
      }),
    [conversation, live, outgoing, runs, shared],
  )
  const visible = useMemo(() => shownIn(drawn.said), [drawn.said])
  return { reading, conversation, drawn, visible }
}

function Conversation({
  id,
  me,
  first,
  detail,
  panelOpen,
  onTogglePanel,
}: {
  id: ThreadId
  me: MeResponse
  /** A new Thread's first words, while they are still on their way to the conversation. */
  first: FirstWords
  detail: Option.Option<ThreadDetail>
  panelOpen: boolean
  onTogglePanel: () => void
}) {
  // Being on this screen is what makes the Person present in the Thread; see `presentIn`.
  useAtomMount(presentIn(id))
  const setTyping = useAtomSet(typingIn(id))
  const thread = Option.map(detail, (value) => value.thread)
  const shared = Option.exists(thread, (value) => !ThreadAudience.guards.Private(value.audience))
  // A Thread started without a name takes its first message as one. It is read here, beside
  // `shared` and before anything is remembered by either: React's compiler takes every later
  // reading of `thread` as one that may change what was read from it before, and then cannot
  // keep a `useMemo` or `useCallback` that names `shared`.
  const unnamed = Option.exists(thread, (value) => value.title === 'New thread')
  // The same list until the server answers again, so nothing drawn from it changes meanwhile.
  const runs = useMemo(
    () => Option.match(detail, { onNone: () => [], onSome: (value) => value.runs }),
    [detail],
  )
  const { reading, conversation, drawn, visible } = useSaid(id, shared, runs)
  const ready = Option.isSome(conversation)
  // The Thread the server just opened for Vivid to speak first in already has a Run going. Until
  // the Thread's own record arrives to say so, that is known from having opened it, so the page
  // shows Vivid thinking from its first frame and never an empty Thread.
  const opening = useArrival(openedFor(id)) && Option.isNone(thread)
  // Whether Vivid is at work is one rule for every surface (`sending.isWorking`); the two
  // things only this page knows are beside it.
  const working =
    opening ||
    FirstWords.$is('Sending')(first) ||
    sending.isWorking({
      owed: drawn.owed,
      conversation,
      attention: Option.map(thread, (value) => value.attention),
    })
  // Made once per answer from the server, not once per streamed token: every row is given it,
  // and a new one would draw every row again (`Message`).
  const context = useMemo(
    () => contextFor({ thread: id, detail, me: me.person.id, shared, runs }),
    [id, detail, me.person.id, shared, runs],
  )

  /**
   * Sends words under a key that names this one delivery. A send whose answer was lost on the way
   * back is "not sent" as far as this page can tell; sending it again under the same key is the
   * same delivery to the server, not a second message and a second Run.
   *
   * It is the same function until what it sends through changes (`useCallback`), as are `say` and
   * `halt` below: the rows and the composer are given them, and are not drawn again for a
   * function that only looks new.
   */
  const send = useCallback(
    (text: string, key: string, pictures: ReadonlyArray<Picture>) => {
      // In the press itself, so the browser may ask: once only, while the Person was never asked.
      offerNotifications()
      if (unnamed) {
        void change((sdk) => sdk.PatchThread({ id, patch: { title: titleFromMessage(text) } }))
      }
      deliver({ thread: id, key, words: text, pictures })
    },
    [id, unnamed],
  )

  /** Says something new: a delivery of its own. */
  const say = useCallback(
    (text: string, pictures: ReadonlyArray<Picture> = []) =>
      send(text, crypto.randomUUID(), pictures),
    [send],
  )
  const halt = useCallback(() => stop(id), [id])

  const lastSaid = lastWords(visible, me)
  const ended = working ? Option.none() : newestRun(runs)
  const { unsent } = drawn
  const cut = useCut(reading, {
    // Words drawn in the conversation that did not arrive; a shared Thread draws none ahead.
    unsent: !shared && unsent.length > 0,
    // Until a new Thread's first words have landed the server may not have the Thread at all,
    // and says so; that is the Thread arriving, not a conversation out of reach.
    arriving: !FirstWords.$is('Settled')(first),
  })
  return (
    <Layout
      id={id}
      me={me}
      thread={thread}
      arriving={arrivingTitle(first)}
      present={Option.match(detail, { onNone: () => [], onSome: (value) => value.present })}
      working={working}
      usingTool={working && Option.isSome(Option.flatMap(replyIn(visible), stepIn))}
      // What Vivid's face answers for: words that did not arrive, a server that cannot be
      // reached, a Run that ended without an answer.
      failed={cut || unsent.length > 0 || Option.exists(ended, ranBadly)}
      panelOpen={panelOpen}
      onTogglePanel={onTogglePanel}
    >
      {(hero) => (
        <Column
          place={draftPlace(me.person.id, {
            workspace: workspaceKey(me.workspace),
            thread: Option.some(id),
          })}
          me={me.person.id}
          approvals={context.approvals}
          requests={context.requests}
          working={working}
          // A picture goes with a message straight to Vivid; a shared Thread's messages take
          // another path that cannot carry one yet.
          pictures={!shared}
          onSay={say}
          onStop={halt}
          onTyping={setTyping}
        >
          <ConversationMessages
            hero={hero}
            ready={ready}
            empty={visible.length === 0 && !FirstWords.$is('Unsent')(first)}
            working={working}
            failure={cut ? unreachedWords(reading) : null}
            onRetry={() => reopenConversation(id)}
            said={drawn.said}
            visible={visible}
            context={context}
            settled={settledIn(
              Option.match(conversation, {
                onNone: () => [],
                onSome: (state) => state.settlements,
              }),
            )}
            onContinue={say}
            unsent={unsent}
            lastSaid={lastSaid}
            onUnsentAgain={() => sayAgain(id)}
            ended={ended}
            onSay={say}
          />
        </Column>
      )}
    </Layout>
  )
}

/**
 * The Thread's column: the conversation, the one banner attached to the composer while Vivid is
 * asking something of this Person (`Asks`, `thread/Allow.tsx`: an Approval first, then a
 * question), and the composer. The banner is in the column's flow, so the conversation ends
 * above it.
 *
 * While an Approval is up the composer is the ordinary composer: no question is up as far as
 * this column can tell (`useAsks`), so what is sent is a message and the button sends it.
 *
 * It also decides what the composer does. With words written it sends them, and nearly always
 * that is an ordinary message, a waiting request or not: the server withdraws the request when
 * it takes the message, the banner folds away, and Vivid reads the message right after its own
 * questions, so "skip that, just do this" and an answer in the Person's own words are the same
 * thing to send. The one exception is a question that offers no options and takes words: there
 * the words are that question's answer and the banner moves on (`written`,
 * `thread/asking.ts`). With nothing written while a question is up, the composer's button moves
 * on from the question (`onward`), since the banner has no button of its own.
 */
function Column({
  place,
  me,
  approvals,
  requests,
  working,
  pictures,
  onSay,
  onStop,
  onTyping,
  children,
}: {
  /** Where the composer's unsent words are kept. */
  place: string
  me: MeResponse['person']['id']
  /** Every Approval Vivid has asked for in this Thread, oldest first. */
  approvals: ThreadContext['approvals']
  /** Every request Vivid has made in this Thread, oldest first. */
  requests: ThreadContext['requests']
  working: boolean
  /** Whether a picture can be sent from the composer. */
  pictures: boolean
  /** Says something new in the Thread: an ordinary message. */
  onSay: (text: string, pictures: ReadonlyArray<Picture>) => void
  onStop: () => void
  onTyping: (typing: boolean) => void
  /** The conversation. */
  children: React.ReactNode
}) {
  const { allowing, asked } = useAsks(approvals, requests, me)
  const { written, onward, backward } = asked
  const reply = useCallback(
    (text: string, sent: ReadonlyArray<Picture>) => {
      if (!written(text)) onSay(text, sent)
    },
    [written, onSay],
  )
  const footer = useOnward(asked.progress, asked.answering, onward, backward)
  return (
    <>
      {children}
      <Asks allowing={allowing} asked={asked} />
      <Composer
        place={place}
        // While a request from Vivid waits, what is sent from here is the reply to it.
        placeholder={asked.waiting ? 'Reply' : 'Message Vivid'}
        working={working}
        pictures={pictures}
        onSend={reply}
        onStop={onStop}
        onTyping={onTyping}
        asked={footer}
      />
    </>
  )
}

/**
 * What the composer's footer is given while a question is up (`Onward`, `thread/Composer.tsx`):
 * where the Person is in the questions, whether they may move on, and the two moves. It is one
 * value until one of those changes, so the composer is not drawn again for a value that only
 * looks new; with no question up it is nothing.
 */
function useOnward(
  progress: Asking['progress'],
  answering: boolean,
  onNext: () => void,
  onBack: () => void,
) {
  const up = Option.isSome(progress)
  const first = Option.exists(progress, (now) => now.first)
  const last = Option.exists(progress, (now) => now.last)
  const ready = Option.exists(progress, (now) => now.canAdvance) && !answering
  return useMemo(
    () => (up ? { first, last, ready, onNext, onBack } : undefined),
    [up, first, last, ready, onNext, onBack],
  )
}

/** What this Person last said in the Thread, which is what "Try again" says again. */
function lastWords(messages: ReadonlyArray<ConversationMessage>, me: MeResponse) {
  const mine = messages.filter(
    (message) =>
      message.role === 'user' ||
      (message.signal !== undefined &&
        message.signal.tagName === 'message' &&
        message.signal.attributes.person === me.person.id),
  )
  return Option.map(Option.fromUndefinedOr(mine.at(-1)), textOf)
}

/**
 * Whether the conversation is out of reach in a way worth saying. A link that is already being
 * opened again is not said while this page's own socket still reaches the server: a deploy or a
 * sleeping laptop cuts it for a second and the next link begins with the conversation whole.
 */
const useCut = (
  conversation: LiveState<Following>,
  at: { readonly unsent: boolean; readonly arriving: boolean },
) => {
  const reach = useAtomValue(link.atom)
  const reading = readingOf(at.arriving ? LiveState.Loading() : conversation, {
    unsent: at.unsent,
  })
  const held = useMemo(() => lasting(reading === 'CatchingUp', QUIET_MS), [reading])
  const late = useSyncExternalStore(held.subscribe, held.read, held.read)
  return streamSaid(reading, { socketLost: reach === 'lost', late })
}

/**
 * Words that left this page and did not arrive. They stay where they were written, marked, with
 * the one thing to do about it; a message a Person typed is never silently lost.
 */
function NotSent({
  words,
  pictures,
  shown,
  why,
  onAgain,
}: {
  words: string
  pictures: sending.Delivery['pictures']
  /** Whether the conversation above already shows these words. */
  shown: boolean
  /** The server's own sentence for why, when it gave one meant for the Person. */
  why: Option.Option<string>
  onAgain: () => void
}) {
  return (
    <li className="flex flex-col items-end gap-1.5">
      {!shown && (
        <div className="w-full">
          <Said
            text={words}
            mine
            unsent
            pictures={pictures.map((picture) => ({
              url: `data:${picture.mimeType};base64,${picture.data}`,
              name: Option.getOrElse(Option.fromUndefinedOr(picture.filename), () => ''),
            }))}
          />
        </div>
      )}
      <p role="alert" className="text-meta font-meta text-danger">
        {Option.getOrElse(why, () => 'Not sent.')}{' '}
        <button
          onClick={onAgain}
          className="cursor-pointer rounded-xs underline underline-offset-4 hover:text-ink focus-visible:text-ink"
        >
          Send again
        </button>
      </p>
    </li>
  )
}

/** How far back, in pixels, counts as having left the newest message: a little over a screen of text. */
const AWAY_PX = 480

/** Whether this Person has asked their system for less motion. */
const STILL = matchMedia('(prefers-reduced-motion: reduce)')

/**
 * The scrolling column. It follows the newest message unless the Person has scrolled away, and
 * once they have, one press brings them back to it without touching what they were typing.
 */
function Messages({
  ready,
  empty,
  working,
  reply,
  failure,
  onRetry,
  children,
  hero,
}: {
  hero: React.ReactNode
  ready: boolean
  /** Nothing has been said here yet, by anyone. */
  empty: boolean
  working: boolean
  /** The reply Vivid is on, when the newest message is its; the line under it says its step. */
  reply: Option.Option<ConversationMessage>
  failure: string | null
  onRetry: () => void
  children: React.ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  // Whether the Person has scrolled well away from the newest message, to read something earlier.
  const [away, setAway] = useState(false)
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        // No fade at the top edge, where Vivid's name sits: the owner asked for none (26 October
        // 2026, kept by Vivid in its notes of his bug reports).
        className="flex flex-1 flex-col-reverse overflow-y-auto px-4 sm:px-6"
        // Reversed column: the browser keeps the view pinned to the newest message by itself, with
        // no scroll effect to run on every streamed token. In a reversed column the newest message
        // is at scroll position zero and reading back goes negative.
        onScroll={(event) => setAway(Math.abs(event.currentTarget.scrollTop) > AWAY_PX)}
      >
        {/* The gutter is on the scroller, not the column, so the messages and the composer below
          them are exactly the same width at every window size. */}
        <ol
          ref={arriving}
          className="mx-auto flex min-h-full w-full max-w-(--thread-max-w) shrink-0 flex-col gap-5 pb-5 sm:pb-6"
        >
          {/* Vivid at the top, part of the conversation: it scrolls away with it. No padding above
            it: the bar already leaves room, and the owner asked twice for the face to sit higher. */}
          {hero}
          {/* Not while Vivid is working: the line at the foot is the truer thing to show. */}
          {!ready && empty && !working && (
            <li className="py-12 text-center text-label text-ink-3" aria-busy>
              Opening the thread…
            </li>
          )}
          {ready && empty && !working && (
            // Under the hero, which is Vivid's face and name: the line is what it says to start.
            <li className="text-center font-display text-page tracking-display text-ink">
              What should I take off your plate?
            </li>
          )}
          {children}
          {/* The one place a Thread says what Vivid is on, for as long as it works: the step it
              is taking in the newest reply, or that it is thinking. Vivid's face is not drawn
              beside it; a reply's face stands at the foot of the reply itself. */}
          {working && <Doing reply={reply} />}
          {failure !== null && (
            <li className="flex items-center gap-3 rounded-panel bg-danger-soft px-4 py-3 text-label text-danger ring-line">
              <span className="min-w-0 flex-1">{failure}</span>
              <button className="cursor-pointer font-title underline" onClick={onRetry}>
                Reconnect
              </button>
            </li>
          )}
        </ol>
      </div>
      {away && (
        // A floating glass disc, not the standard icon button, so it keeps its own classes and
        // takes the tooltip that says what it does.
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Jump to the latest message"
                // Pressing it must not take the keyboard out of the composer mid-sentence.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (scroller.current !== null) {
                    // A Person who asked for less motion gets there at once; CSS cannot reach this.
                    scroller.current.scrollTo({
                      top: 0,
                      behavior: STILL.matches ? 'auto' : 'smooth',
                    })
                  }
                }}
                className="absolute bottom-3 left-1/2 z-10 inline-flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full text-ink-2 lift glass transition-pop duration-(--dur-base) ease-out hover:text-ink active:scale-96 starting:translate-y-1 starting:opacity-0"
              />
            }
          >
            <ArrowDown className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Jump to latest</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
