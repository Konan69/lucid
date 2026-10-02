import { useAtomMount, useAtomSet } from '@effect/atom-react'
import { useFlueAgent, type FlueConversationMessage } from '@flue/react'
import { createFlueClient } from '@flue/sdk'
import {
  ThreadAudience,
  Workspace,
  type MeResponse,
  type Thread as ThreadRecord,
  type ThreadDetail,
  type ThreadId,
} from '@vivid/contracts'
import { draftPlace, titleFromMessage } from '@vivid/state'
import { Option, Schema } from 'effect'
import { ArrowDown, Lock, MonitorSmartphone, Share2, Users } from 'lucide-react'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { change, LiveState, presentIn, seenThread, typingIn, useLive } from '../data/live'
import { Route, router } from '../data/route'
import { orSay } from '../data/said'
import { FirstWords, firstWords } from '../data/threads'
import { Faces } from '../ui/Avatar'
import { Button, IconButton } from '../ui/Button'
import { Face } from '../ui/Face'
import { Composer } from './thread/Composer'
import { isBlank, Message, Said, textOf, type ThreadContext } from './thread/Message'
import { newestRun, Outcome } from './thread/Outcome'
import { Share } from './thread/Share'
import { BAR } from './bar'

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
      <Button onClick={() => router.go(Route.New())}>Start a new thread</Button>
    </section>
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
  const [sharing, setSharing] = useState(false)
  // Words that were sent from here and refused. They are kept, never dropped, until sent again.
  const [unsent, setUnsent] = useState<Option.Option<Unsent>>(Option.none())
  // Being on this screen is what makes the Person present in the Thread; see `presentIn`.
  useAtomMount(presentIn(id))
  const setTyping = useAtomSet(typingIn(id))
  const thread = Option.map(detail, (value) => value.thread)
  const shared = Option.exists(thread, (value) => !ThreadAudience.guards.Private(value.audience))
  const runs = Option.match(detail, { onNone: () => [], onSome: (value) => value.runs })
  const working =
    agent.status === 'submitted' ||
    agent.status === 'streaming' ||
    FirstWords.$is('Sending')(first) ||
    Option.exists(thread, (value) => value.attention === 'Working')
  const visible = agent.messages.filter(
    (message) =>
      (message.display !== 'hidden' || message.signal !== undefined) && !isBlank(message),
  )
  const context: ThreadContext = {
    me: me.person.id,
    shared,
    runs,
    approvals: Option.match(detail, { onNone: () => [], onSome: (value) => value.approvals }),
    requests: Option.match(detail, { onNone: () => [], onSome: (value) => value.requests }),
  }

  function send(text: string) {
    setUnsent(Option.none())
    // A Thread started without a name takes its first message as one.
    if (Option.exists(thread, (value) => value.title === 'New thread')) {
      void change((sdk) => sdk.PatchThread({ id, patch: { title: titleFromMessage(text) } }))
    }
    // In a shared Thread the server turns the message into an attributed one, so it is sent
    // plainly and drawn when it comes back; in a private one the hook shows it at once.
    const sending = shared
      ? client.send({ message: { kind: 'user', body: text } })
      : agent.sendMessage(text)
    void sending.catch((refusal) => setUnsent(Option.some({ words: text, why: whyNot(refusal) })))
  }

  const lastSaid = lastWords(visible, me)
  const ended = working ? Option.none() : newestRun(runs)

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <Header
        thread={thread}
        present={Option.match(detail, { onNone: () => [], onSome: (value) => value.present })}
        me={me}
        panelOpen={panelOpen}
        onShare={() => setSharing(true)}
        onTogglePanel={onTogglePanel}
      />

      <Messages
        ready={agent.historyReady}
        empty={visible.length === 0 && FirstWords.$is('Settled')(first)}
        working={working}
        streaming={visible.some(
          (message) =>
            message.role === 'assistant' &&
            message.parts.some((part) => 'state' in part && part.state === 'streaming'),
        )}
        failure={agent.error === undefined ? null : agent.error.message}
        onRetry={() => agent.refresh()}
      >
        {visible.map((message) => (
          <li key={message.id} className="animate-rise-in">
            <Message message={message} context={context} working={working} onContinue={send} />
          </li>
        ))}
        <OnTheirWay first={first} onAgain={() => firstWords.again(id)} />
        {Option.isSome(unsent) && (
          <NotSent
            words={unsent.value.words}
            why={unsent.value.why}
            onAgain={() => send(unsent.value.words)}
          />
        )}
        {Option.isSome(ended) && (
          <Outcome run={ended.value} onAgain={Option.map(lastSaid, (words) => () => send(words))} />
        )}
      </Messages>

      <Composer
        place={draftPlace(me.person.id, Option.some(id))}
        working={working}
        onSend={send}
        onStop={() =>
          void orSay(
            change((sdk) => sdk.StopThread({ id })),
            'Vivid could not be stopped just now. Try again.',
          )
        }
        onTyping={setTyping}
      />

      {sharing && Option.isSome(thread) && Workspace.guards.Company(me.workspace) && (
        <Share
          thread={thread.value}
          company={me.workspace.company.name}
          me={me.person.id}
          onClose={() => setSharing(false)}
        />
      )}
    </section>
  )
}

function Header({
  thread,
  present,
  me,
  panelOpen,
  onShare,
  onTogglePanel,
}: {
  thread: Option.Option<ThreadRecord>
  present: ThreadDetail['present']
  me: MeResponse
  panelOpen: boolean
  onShare: () => void
  onTogglePanel: () => void
}) {
  const others = present.filter((seen) => seen.person.id !== me.person.id)
  const typing = others.filter((seen) => seen.typing)
  const inCompany = Workspace.guards.Company(me.workspace)
  const mine = Option.exists(thread, (value) => value.createdBy.id === me.person.id)
  return (
    <header className={BAR}>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-title font-title text-ink">
          {Option.match(thread, { onNone: () => '', onSome: (value) => value.title })}
        </h1>
      </div>
      {typing.length > 0 && (
        <span className="hidden text-meta font-meta text-ink-3 sm:inline" aria-live="polite">
          {typing.map((seen) => seen.person.name).join(', ')} typing…
        </span>
      )}
      {others.length > 0 && <Faces people={others.map((seen) => seen.person)} size={20} />}
      {Option.isSome(thread) && inCompany && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!mine}
          title={mine ? 'Choose who can see this thread' : 'Only its creator can change this'}
          icon={<AudienceIcon audience={thread.value.audience} />}
          onClick={onShare}
        >
          {ThreadAudience.match(thread.value.audience, {
            Private: () => 'Share',
            People: ({ participants }) => `${participants.length + 1} people`,
            Company: () => 'Everyone',
          })}
        </Button>
      )}
      <IconButton label="Vivid’s computer" active={panelOpen} onClick={onTogglePanel}>
        <MonitorSmartphone className="size-4" />
      </IconButton>
    </header>
  )
}

function AudienceIcon({ audience }: { audience: ThreadAudience }) {
  if (ThreadAudience.guards.Private(audience)) return <Share2 className="size-3.5" />
  return ThreadAudience.guards.People(audience) ? (
    <Users className="size-3.5" />
  ) : (
    <Lock className="hidden" />
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
        <Said text={words} mine />
      </li>
    ),
    Unsent: ({ words }) => <NotSent words={words} why={Option.none()} onAgain={onAgain} />,
  })
}

/** Words that were sent from here and refused, and the reason when the server gave one. */
interface Unsent {
  readonly words: string
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
  why,
  onAgain,
}: {
  words: string
  /** The server's own sentence for why, when it gave one meant for the Person. */
  why: Option.Option<string>
  onAgain: () => void
}) {
  return (
    <li className="flex flex-col items-end gap-1.5">
      <div className="w-full opacity-60">
        <Said text={words} mine />
      </div>
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

/**
 * The scrolling column. It follows the newest message unless the Person has scrolled away, and
 * once they have, one press brings them back to it without touching what they were typing.
 */
function Messages({
  ready,
  empty,
  working,
  streaming,
  failure,
  onRetry,
  children,
}: {
  ready: boolean
  /** Nothing has been said here yet, by anyone. */
  empty: boolean
  working: boolean
  streaming: boolean
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
        className="flex flex-1 flex-col-reverse overflow-y-auto px-4 sm:px-6"
        // Reversed column: the browser keeps the view pinned to the newest message by itself, with
        // no scroll effect to run on every streamed token. In a reversed column the newest message
        // is at scroll position zero and reading back goes negative.
        onScroll={(event) => setAway(Math.abs(event.currentTarget.scrollTop) > AWAY_PX)}
      >
        {/* The gutter is on the scroller, not the column, so the messages and the composer below
          them are exactly the same width at every window size. */}
        <ol className="mx-auto flex w-full max-w-(--thread-max-w) flex-col gap-5 py-5 sm:py-6">
          {!ready && empty && (
            <li className="py-12 text-center text-label text-ink-3" aria-busy>
              Opening…
            </li>
          )}
          {ready && empty && !working && (
            <li className="py-12 text-center">
              <Face size={36} mood="happy" className="mx-auto" />
              <p className="mt-3 text-title font-title text-ink">Vivid is ready</p>
              <p className="mt-1 text-label text-ink-3">What should I take off your plate?</p>
            </li>
          )}
          {children}
          {working && !streaming && (
            <li className="flex animate-rise-in gap-3" aria-live="polite">
              <Face size={24} mood="thinking" className="mt-1" />
              <p className="pt-1 text-body text-ink-3">Thinking…</p>
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
        <button
          aria-label="Jump to the latest message"
          title="Jump to latest"
          // Pressing it must not take the keyboard out of the composer mid-sentence.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (scroller.current !== null) scroller.current.scrollTo({ top: 0, behavior: 'smooth' })
          }}
          className="absolute bottom-3 left-1/2 z-10 inline-flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full text-ink-2 smooth-shadow-ring-sm glass transition-pop duration-(--dur-base) ease-out hover:text-ink active:scale-96 starting:translate-y-1 starting:opacity-0"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
}
