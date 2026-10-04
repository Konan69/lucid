import { useAtomMount, useAtomSet } from '@effect/atom-react'
import { useFlueAgent, type FlueConversationMessage } from '@flue/react'
import { createFlueClient } from '@flue/sdk'
import { ThreadAudience, type MeResponse, type ThreadDetail, type ThreadId } from '@vivid/contracts'
import { draftPlace, titleFromMessage, workspaceKey } from '@vivid/state'
import { Option, Schema } from 'effect'
import { ArrowDown } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { arrival } from '../data/arrival'
import { change, LiveState, presentIn, seenThread, typingIn, useLive } from '../data/live'
import { Route, router } from '../data/route'
import { orSay } from '../data/said'
import { FirstWords, firstWords } from '../data/threads'
import { Button } from '../ui/button'
import { Alive, ranBadly } from '../ui/Alive'
import { Face } from '../ui/Face'
import { arriving } from '../ui/settle'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import type { Picture } from './thread/Attach'
import { Composer } from './thread/Composer'
import { isBlank, Message, Said, textOf, type ThreadContext } from './thread/Message'
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
  const first = useSyncExternalStore(firstWords.subscribe, () => firstWords.of(id))
  const landed = useSyncExternalStore(firstWords.subscribe, () => firstWords.landed(id))
  // A Thread whose first words are still on their way may not exist on the server yet. It is not
  // gone, it is arriving, and what the Person just wrote is already on screen.
  if (LiveState.$is('Failed')(detail) && FirstWords.$is('Settled')(first)) return <Gone />
  return (
    <Conversation
      // The conversation is observed afresh once a new Thread's first words have landed: the
      // observer that opened with the screen was told there was no conversation yet.
      key={landed ? `${id}:landed` : id}
      id={id}
      me={me}
      first={first}
      detail={LiveState.$is('Ready')(detail) ? Option.some(detail.value) : Option.none()}
      panelOpen={panelOpen}
      onTogglePanel={onTogglePanel}
    />
  )
}

/** A Thread that is not there, or not this Person's to see. The two look the same on purpose. */
function Gone() {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-surface-0 px-6 text-center">
      <Face size={40} mood="neutral" />
      <h1 className="text-title font-title text-ink">This thread is not here</h1>
      <p className="max-w-sm text-label text-ink-3">
        It may have been deleted, or it is in a space you are not working in right now.
      </p>
      <Button variant="outline" onClick={() => router.go(Route.New())}>
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
  void orSay(
    change((sdk) => sdk.StopThread({ id })),
    'Vivid could not be stopped just now. Try again.',
  )

/** The title shown while a new Thread's first words are still in flight. */
const arrivingTitle = (first: FirstWords): Option.Option<string> =>
  FirstWords.$match(first, {
    Settled: () => Option.none(),
    Sending: ({ words }) => Option.some(titleFromMessage(words)),
    Unsent: ({ words }) => Option.some(titleFromMessage(words)),
  })

/** Keeps card attribution and pending questions tied to the same live Thread snapshot. */
function contextFor(
  detail: Option.Option<ThreadDetail>,
  me: MeResponse['person']['id'],
  shared: boolean,
  runs: ThreadContext['runs'],
): ThreadContext {
  return {
    me,
    shared,
    runs,
    approvals: Option.match(detail, { onNone: () => [], onSome: (value) => value.approvals }),
    requests: Option.match(detail, { onNone: () => [], onSome: (value) => value.requests }),
  }
}

/** Keeps the conversation's message rows together, including deliveries still on their way. */
function ConversationMessages({
  ready,
  empty,
  working,
  waiting,
  failure,
  onRetry,
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
      {visible.map((message, position) => (
        // `data-arrives`: a Message that lands while the Thread is open rises into place; the
        // ones already here when it opens do not move (`arriving`, on the list below).
        <li key={message.id} data-arrives>
          <Message
            message={message}
            context={context}
            working={working}
            latest={position === visible.length - 1}
            onContinue={onContinue}
          />
        </li>
      ))}
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
  const client = useMemo(
    () => createFlueClient({ url: `/api/vivid/${encodeURIComponent(id)}` }),
    [id],
  )
  const agent = useFlueAgent({ client })
  // Words that were sent from here and refused. They are kept, never dropped, until sent again.
  const [unsent, setUnsent] = useState<Option.Option<Unsent>>(Option.none())
  // Being on this screen is what makes the Person present in the Thread; see `presentIn`.
  useAtomMount(presentIn(id))
  const setTyping = useAtomSet(typingIn(id))
  const thread = Option.map(detail, (value) => value.thread)
  const shared = Option.exists(thread, (value) => !ThreadAudience.guards.Private(value.audience))
  const runs = Option.match(detail, { onNone: () => [], onSome: (value) => value.runs })
  // The Thread the server just opened for Vivid to speak first in already has a Run going. Until
  // the Thread's own record arrives to say so, that is known from having opened it, so the page
  // shows Vivid thinking from its first frame and never an empty Thread.
  const opening =
    useSyncExternalStore(arrival.subscribe, () => arrival.isOpened(id)) && Option.isNone(thread)
  const working =
    opening ||
    agent.status === 'submitted' ||
    agent.status === 'streaming' ||
    FirstWords.$is('Sending')(first) ||
    Option.exists(thread, (value) => value.attention === 'Working')
  const visible = agent.messages.filter(
    (message) =>
      (message.display !== 'hidden' || message.signal !== undefined) && !isBlank(message),
  )
  const context = contextFor(detail, me.person.id, shared, runs)

  /**
   * Sends words under a key that names this one delivery. A send whose answer was lost on the way
   * back is "not sent" as far as this page can tell; sending it again under the same key is the
   * same delivery to the server, not a second message and a second Run.
   */
  function send(text: string, key: string, pictures: ReadonlyArray<Picture>) {
    setUnsent(Option.none())
    // A Thread started without a name takes its first message as one.
    if (Option.exists(thread, (value) => value.title === 'New thread')) {
      void change((sdk) => sdk.PatchThread({ id, patch: { title: titleFromMessage(text) } }))
    }
    // In a shared Thread the server turns the message into an attributed one, so it is sent
    // plainly and drawn when it comes back; in a private one the hook shows it at once.
    const sending = shared
      ? client.send({ message: { kind: 'user', body: text }, idempotencyKey: key })
      : agent.sendMessage(text, { idempotencyKey: key, images: [...pictures] })
    void sending.catch((refusal) =>
      setUnsent(Option.some({ words: text, key, pictures, why: whyNot(refusal) })),
    )
  }

  /** Says something new: a delivery of its own. */
  const say = (text: string, pictures: ReadonlyArray<Picture> = []) =>
    send(text, crypto.randomUUID(), pictures)

  const lastSaid = lastWords(visible, me)
  const ended = working ? Option.none() : newestRun(runs)
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
      failed={agent.error !== undefined || Option.isSome(unsent) || Option.exists(ended, ranBadly)}
      panelOpen={panelOpen}
      onTogglePanel={onTogglePanel}
    >
      {(hero) => (
        <>
          <ConversationMessages
            hero={hero}
            ready={agent.historyReady}
            empty={visible.length === 0 && FirstWords.$is('Settled')(first)}
            working={working}
            waiting={isWaiting(working, visible)}
            failure={agent.error === undefined ? null : 'Vivid can’t be reached right now.'}
            onRetry={() => agent.refresh()}
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

          <Composer
            place={draftPlace(me.person.id, {
              workspace: workspaceKey(me.workspace),
              thread: Option.some(id),
            })}
            working={working}
            // A picture goes with a message straight to Vivid; a shared Thread's messages take
            // another path that cannot carry one yet.
            pictures={!shared}
            onSend={say}
            onStop={() => stop(id)}
            onTyping={setTyping}
          />
        </>
      )}
    </Layout>
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

/** A new Thread's first words, drawn from the hand-off until the conversation has them. */
function OnTheirWay({ first, onAgain }: { first: FirstWords; onAgain: () => void }) {
  return FirstWords.$match(first, {
    Settled: () => null,
    Sending: ({ words }) => (
      <li>
        <Said text={words} mine pictures={[]} />
      </li>
    ),
    Unsent: ({ words }) => (
      <NotSent words={words} pictures={[]} shown={false} why={Option.none()} onAgain={onAgain} />
    ),
  })
}

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
