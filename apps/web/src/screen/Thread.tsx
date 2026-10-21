import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useFlueAgent, type FlueConversationMessage } from '@flue/react'
import {
  textOf,
  ThreadAudience,
  type MeResponse,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import {
  asking,
  draftPlace,
  inThread,
  lasting,
  QUIET_MS,
  readingOf,
  streamSaid,
  titleFromMessage,
  workspaceKey,
} from '@vivid/state'
import { Option, Schema } from 'effect'
import { ArrowDown } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { openedFor, useArrival } from '../data/arrival'
import { act } from '../data/app'
import { conversationOf, heardIn } from '../data/conversation'
import { change, changing, LiveState, presentIn, seenThread, typingIn, useLive } from '../data/live'
import { router } from '../router'
import { link } from '../data/runtime'
import { orSay } from '../data/said'
import { FirstWords, firstWords, saidWith, useFirstWords, wordsFor } from '../data/threads'
import { Button } from '../ui/button'
import { Alive, ranBadly } from '../ui/Alive'
import { Face } from '../ui/Face'
import { arriving } from '../ui/settle'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Asks, Hold, useAsks } from './thread/Allow'
import { DeviceAsk } from './thread/Device'
import type { Asking } from './thread/asking'
import type { Picture } from './thread/Attach'
import { Composer } from './thread/Composer'
import { isBlank, Message, Replied, Said, spokenOf, type ThreadContext } from './thread/Message'
import { newestRun, Outcome } from './thread/Outcome'
import { Layout } from './thread/Layout'
import { doingIn } from './thread/Trail'

/**
 * One Thread: the conversation with Vivid, and everything live around it.
 *
 * Two sources feed this screen. The words come from Flue's stream through the server's gateway,
 * token by token. Everything else (who is in the Thread, who Vivid acted for, what is waiting on
 * someone, who is looking right now) comes from the Thread's live query. Neither is fetched and
 * neither is refreshed by hand.
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
  const first = useFirstWords(wordsFor(id))
  // A Thread whose first words are still on their way may not exist on the server yet. It is not
  // gone, it is arriving, and what the Person just wrote is already on screen.
  if (LiveState.$is('Failed')(detail) && !travelling(first)) return <Gone />
  return (
    <Conversation
      // The conversation is observed afresh once a new Thread's first words have landed: the
      // observer that opened with the screen was told there was no conversation yet.
      key={FirstWords.$is('Said')(first) ? `${id}:landed` : id}
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
const replyIn = (visible: ReadonlyArray<FlueConversationMessage>) =>
  Option.filter(Option.fromUndefinedOr(visible.at(-1)), (message) => message.role === 'assistant')

/**
 * Whether the waiting row is needed: Vivid is working and has not begun a reply. Once a reply
 * exists it carries its own signs of life (its steps, "Putting it together…", its words), so the
 * row is only for the moment before, when the one true thing to say is that Vivid is thinking.
 */
const isWaiting = (working: boolean, visible: ReadonlyArray<FlueConversationMessage>) =>
  working && Option.isNone(replyIn(visible))

/** Stops Vivid in this Thread, and says so when the server did not take it. */
const stop = (id: ThreadId) =>
  void act(
    orSay(
      changing((sdk) => sdk.StopThread({ id })),
      'Vivid could not be stopped just now. Try again.',
    ),
  )

/** The title shown while a new Thread's first words are still in flight. */
const arrivingTitle = (first: FirstWords): Option.Option<string> =>
  FirstWords.$match(first, {
    Settled: () => Option.none(),
    Sending: ({ words }) => Option.some(titleFromMessage(words)),
    Unsent: ({ words }) => Option.some(titleFromMessage(words)),
    Said: ({ words }) => Option.some(titleFromMessage(words)),
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
    thread: Option.some(thread),
    me,
    shared,
    runs,
    approvals: Option.match(detail, { onNone: () => [], onSome: (value) => value.approvals }),
    requests: Option.match(detail, { onNone: () => [], onSome: (value) => value.requests }),
  }
}

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
const Rows = memo(function Rows({
  said,
  visible,
  context,
  working,
  onContinue,
}: {
  said: ReadonlyArray<FlueConversationMessage>
  visible: ReadonlyArray<FlueConversationMessage>
  context: ThreadContext
  working: boolean
  onContinue: (text: string, pictures?: ReadonlyArray<Picture>) => void
}) {
  const newest = visible.at(-1)
  const drawn = new Map(visible.map((message) => [message.id, message]))
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
        return (
          <li key={key} data-arrives>
            <Message
              message={message}
              context={context}
              // Only the newest message can be the one Vivid is working on, so the others are
              // not told when work starts and stops, and are not drawn again for it.
              working={working && latest}
              latest={latest}
              onContinue={onContinue}
            />
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
  waiting,
  failure,
  onRetry,
  said,
  visible,
  context,
  onContinue,
  first,
  onFirstAgain,
  unsent,
  lastSaid,
  onUnsentAgain,
  ended,
  onSay,
  hero,
}: {
  hero: React.ReactNode
  ready: boolean
  empty: boolean
  working: boolean
  waiting: boolean
  failure: string | null
  onRetry: () => void
  /** The whole conversation, drawn or not: answers are placed against all of it (`Rows`). */
  said: ReadonlyArray<FlueConversationMessage>
  visible: ReadonlyArray<FlueConversationMessage>
  context: ThreadContext
  onContinue: (text: string, pictures?: ReadonlyArray<Picture>) => void
  first: FirstWords
  onFirstAgain: () => void
  unsent: Option.Option<Unsent>
  lastSaid: Option.Option<string>
  onUnsentAgain: (value: Unsent) => void
  ended: ReturnType<typeof newestRun>
  onSay: (text: string, pictures?: ReadonlyArray<Picture>) => void
}) {
  return (
    <Messages
      hero={hero}
      ready={ready}
      empty={empty}
      working={working}
      waiting={waiting}
      // Transport details stay in the log; the Person gets a clear reason and a retry action.
      failure={failure}
      onRetry={onRetry}
    >
      <Rows
        said={said}
        visible={visible}
        context={context}
        working={working}
        onContinue={onContinue}
      />
      <OnTheirWay first={first} onAgain={onFirstAgain} />
      {Option.isSome(unsent) && (
        <NotSent
          words={unsent.value.words}
          pictures={unsent.value.pictures}
          // A private Thread already shows its own message; a shared one waits for server echo.
          shown={Option.contains(lastSaid, unsent.value.words)}
          why={unsent.value.why}
          onAgain={() => onUnsentAgain(unsent.value)}
        />
      )}
      {Option.isSome(ended) && (
        <Outcome run={ended.value} onAgain={Option.map(lastSaid, (words) => () => onSay(words))} />
      )}
    </Messages>
  )
}

/**
 * The messages of a conversation that are drawn: the ones that belong in a Thread on every
 * surface (`inThread` in `@vivid/state`, which leaves out what the runtime says to itself and
 * the model), and not the ones with nothing in them.
 */
const shownIn = (messages: ReadonlyArray<FlueConversationMessage>) =>
  messages.filter((message) => inThread(message) && !isBlank(message))

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
  // The Thread's one conversation, usually open already: the router began it on the way here
  // (`data/conversation.ts`), so the first frame has the words and not an empty Thread.
  const client = conversationOf(id)
  const agent = useFlueAgent({ client })
  // The hook begins reading in an effect, so on the first frame of every visit it has no words
  // even when the conversation is open and known, and a conversation that was parked is read again
  // (`data/conversation.ts`). Until then the words are taken from the conversation itself
  // (`heardIn`), and the Thread is drawn with them instead of as one that is still opening.
  const heard = heardIn(id)
  const ready = agent.historyReady || Option.isSome(heard)
  const read = agent.historyReady ? agent.messages : Option.getOrElse(heard, () => agent.messages)
  // A new Thread's first words are drawn from the moment they were sent (`saidWith`). The same
  // list until the conversation or the words move.
  const said = useMemo(
    () => saidWith(id, first, read, agent.historyReady),
    [id, first, read, agent.historyReady],
  )
  // Words that were sent from here and refused. They are kept, never dropped, until sent again.
  const [unsent, setUnsent] = useState<Option.Option<Unsent>>(Option.none())
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
  // The Thread the server just opened for Vivid to speak first in already has a Run going. Until
  // the Thread's own record arrives to say so, that is known from having opened it, so the page
  // shows Vivid thinking from its first frame and never an empty Thread.
  const opening = useArrival(openedFor(id)) && Option.isNone(thread)
  const working = workingIn(opening, agent, first, detail)
  // Flue gives the same list until a message changes; the filtered list is kept the same with it.
  const visible = useMemo(() => shownIn(said), [said])
  // Made once per answer from the server, not once per streamed token: every row is given it,
  // and a new one would draw every row again (`Message`).
  const context = useMemo(
    () => contextFor({ thread: id, detail, me: me.person.id, shared, runs }),
    [id, detail, me.person.id, shared, runs],
  )
  // The hook answers with a new object on every streamed token, so `send` cannot depend on
  // `agent`; it depends on this, which is bound once, when the screen is first drawn. Flue types
  // `sendMessage` as a method (`UseFlueAgentResult` in `@flue/react` 2.2.2), so it is bound to
  // what it was read from and never taken off loose. Once is enough: Flue makes one session for
  // one client and gives that session's own `sendMessage` for as long as it lives (`useFlueAgent`
  // and `AgentSession`, same package), the client above is made from `id` alone, and `Thread`
  // keys this component by `id`, so another Thread is another mount and is bound again.
  const [sendMessage] = useState(() => agent.sendMessage.bind(agent))

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
      setUnsent(Option.none())
      if (unnamed) {
        void change((sdk) => sdk.PatchThread({ id, patch: { title: titleFromMessage(text) } }))
      }
      // In a shared Thread the server turns the message into an attributed one, so it is sent
      // plainly and drawn when it comes back; in a private one the hook shows it at once.
      const sending = shared
        ? client.send({ message: { kind: 'user', body: text }, idempotencyKey: key })
        : sendMessage(text, { idempotencyKey: key, images: [...pictures] })
      void sending.catch((refusal) =>
        setUnsent(Option.some({ words: text, key, pictures, why: whyNot(refusal) })),
      )
    },
    [client, id, sendMessage, shared, unnamed],
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
  const cut = useCut(agent)
  return (
    <Layout
      id={id}
      me={me}
      thread={thread}
      arriving={arrivingTitle(first)}
      present={Option.match(detail, { onNone: () => [], onSome: (value) => value.present })}
      working={working}
      doing={working ? Option.flatMap(replyIn(visible), doingIn) : Option.none()}
      // What Vivid's face answers for: words that did not arrive, a server that cannot be
      // reached, a Run that ended without an answer.
      failed={cut || Option.isSome(unsent) || Option.exists(ended, ranBadly)}
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
            waiting={isWaiting(working, visible)}
            failure={cut ? 'Vivid can’t be reached right now.' : null}
            onRetry={() => agent.refresh()}
            said={said}
            visible={visible}
            context={context}
            onContinue={say}
            first={first}
            onFirstAgain={() => firstWords.again(id)}
            unsent={unsent}
            lastSaid={lastSaid}
            onUnsentAgain={(value) => send(value.words, value.key, value.pictures)}
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
      {/* A computer waiting to be allowed is asked about here too, once nothing else is up. */}
      <DeviceAsk free={Hold.$is('Free')(allowing.hold) && asking.Hold.$is('Free')(asked.hold)} />
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
function lastWords(messages: ReadonlyArray<FlueConversationMessage>, me: MeResponse) {
  const mine = messages.filter(
    (message) =>
      message.role === 'user' ||
      (message.signal !== undefined &&
        message.signal.tagName === 'message' &&
        message.signal.attributes !== undefined &&
        message.signal.attributes.person === me.person.id),
  )
  return Option.map(Option.fromUndefinedOr(mine.at(-1)), textOf)
}

/**
 * A new Thread's first words that did not arrive, with the way to send them again. Words that are
 * on their way or arrived are in the conversation itself (`withFirst`).
 */
function OnTheirWay({ first, onAgain }: { first: FirstWords; onAgain: () => void }) {
  return FirstWords.$is('Unsent')(first) ? (
    <NotSent
      words={first.words}
      pictures={[]}
      shown={false}
      why={Option.none()}
      onAgain={onAgain}
    />
  ) : null
}

/**
 * Whether a new Thread's first words still count as on their way to Vivid. They do from the send
 * until the Thread's own two sources, its conversation and its record, have both spoken: after
 * that, whether Vivid is working is theirs to say. Without the second half the Thread stopped
 * saying Vivid is thinking for the moment between the server taking the words and the Thread's
 * record arriving. A conversation that could not be read has spoken too: it will not become
 * ready. The phone's reading of the same (`isOnItsWay`, `apps/mobile/src/data/first.ts`).
 */
/**
 * Whether Vivid is working in the Thread: it was just opened for Vivid to speak first (`opening`),
 * the conversation says a reply is under way, the first words are still on their way, or the
 * Thread's record says so.
 */
const workingIn = (
  opening: boolean,
  agent: Pick<ReturnType<typeof useFlueAgent>, 'status' | 'historyReady' | 'error'>,
  first: FirstWords,
  detail: Option.Option<ThreadDetail>,
): boolean =>
  opening ||
  agent.status === 'submitted' ||
  agent.status === 'streaming' ||
  onItsWay(first, agent, detail) ||
  Option.exists(detail, (value) => value.thread.attention === 'Working')

const onItsWay = (
  first: FirstWords,
  agent: Pick<ReturnType<typeof useFlueAgent>, 'historyReady' | 'error'>,
  detail: Option.Option<ThreadDetail>,
): boolean =>
  FirstWords.$match(first, {
    Settled: () => false,
    Unsent: () => false,
    Sending: () => true,
    Said: () => !((agent.historyReady || agent.error !== undefined) && Option.isSome(detail)),
  })

/** Words that were sent from here and refused, and the reason when the server gave one. */
interface Unsent {
  readonly words: string
  /** The delivery these words were sent as, kept so sending again is the same delivery. */
  readonly key: string
  /** The pictures that went with them, which go again with them. */
  readonly pictures: ReadonlyArray<Picture>
  readonly why: Option.Option<string>
}

/**
 * The one refusal that comes with a sentence for the Person: in a shared Thread, Vivid is still
 * answering someone else, and one response is for one Person. The conversation gateway answers
 * that with 409 and the sentence; any other failure has no words worth showing and reads as
 * "Not sent".
 */
const Busy = Schema.Struct({
  status: Schema.Literal(409),
  body: Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
})
/**
 * Whether the conversation's stream is broken in a way worth saying. A stream Flue is already
 * reopening is not said while this page's own socket still reaches the server: a deploy or a
 * sleeping laptop cuts it for a second and it resumes from where it stopped.
 */
const useCut = (
  agent: Pick<ReturnType<typeof useFlueAgent>, 'status' | 'error' | 'settlements'>,
) => {
  const reach = useAtomValue(link.atom)
  const reading = readingOf({
    status: agent.status,
    broken: agent.error !== undefined,
    settledBadly: agent.settlements.slice(-1).some((settled) => settled.outcome === 'failed'),
  })
  const held = useMemo(() => lasting(reading === 'CatchingUp', QUIET_MS), [reading])
  const late = useSyncExternalStore(held.subscribe, held.read, held.read)
  return streamSaid(reading, { socketLost: reach === 'lost', late })
}

const whyNot = (refusal: Parameters<typeof readBusy>[0]) =>
  Option.map(readBusy(refusal), (busy) => busy.body.error.message)
const readBusy = Schema.decodeUnknownOption(Busy)

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
  pictures: ReadonlyArray<Picture>
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
              name: picture.filename,
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
  waiting,
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
  waiting: boolean
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
        // The top edge fades, so a message scrolling out of view leaves instead of being sliced.
        className="flex flex-1 flex-col-reverse overflow-y-auto scroll-fade-top px-4 sm:px-6"
        // Reversed column: the browser keeps the view pinned to the newest message by itself, with
        // no scroll effect to run on every streamed token. In a reversed column the newest message
        // is at scroll position zero and reading back goes negative.
        onScroll={(event) => setAway(Math.abs(event.currentTarget.scrollTop) > AWAY_PX)}
      >
        {/* The gutter is on the scroller, not the column, so the messages and the composer below
          them are exactly the same width at every window size. */}
        <ol
          ref={arriving}
          className="mx-auto flex min-h-full w-full max-w-(--thread-max-w) shrink-0 flex-col gap-5 py-5 sm:py-6"
        >
          {/* Vivid at the top, part of the conversation: it scrolls away with it. */}
          {hero}
          {/* Not while Vivid is working: the waiting row below is the truer thing to show. */}
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
          {waiting && (
            // It arrives late on purpose: an answer that starts within a second never shows it,
            // and one that takes longer has something alive to look at. It stands where the
            // reply will be, with Vivid's face, so the answer takes its place instead of
            // appearing somewhere else.
            <li
              className="flex items-center gap-3 transition-opacity delay-700 duration-(--dur-slow) starting:opacity-0"
              aria-live="polite"
            >
              <Alive size={28} state="thinking" />
              <span className="flex items-center gap-2">
                <ThinkingOrb state="breathing" size={20} aria-hidden />
                <span className="text-label text-ink-3">Thinking…</span>
              </span>
            </li>
          )}
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
