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
import { titleFromMessage } from '@vivid/state'
import { Option } from 'effect'
import { Lock, MonitorSmartphone, Share2, Users } from 'lucide-react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { change, LiveState, seenThread, useLive } from '../data/live'
import { Route, router } from '../data/route'
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
  if (LiveState.$is('Failed')(detail)) return <Gone />
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
  const [unsent, setUnsent] = useState<Option.Option<string>>(Option.none())
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
    void sending.catch(() => setUnsent(Option.some(text)))
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
          <NotSent words={unsent.value} onAgain={() => send(unsent.value)} />
        )}
        {Option.isSome(ended) && (
          <Outcome
            run={ended.value}
            onAgain={Option.map(lastSaid, (words) => () => send(words))}
          />
        )}
      </Messages>

      <Composer
        working={working}
        onSend={send}
        onStop={() => void change((sdk) => sdk.StopThread({ id }))}
        onTyping={(typing) => void change((sdk) => sdk.ReportPresence({ threadId: id, typing }))}
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
    Unsent: ({ words }) => <NotSent words={words} onAgain={onAgain} />,
  })
}

/**
 * Words that left this page and did not arrive. They stay where they were written, marked, with
 * the one thing to do about it; a message a Person typed is never silently lost.
 */
function NotSent({ words, onAgain }: { words: string; onAgain: () => void }) {
  return (
    <li className="flex flex-col items-end gap-1.5">
      <div className="w-full opacity-60">
        <Said text={words} mine />
      </div>
      <p role="alert" className="text-meta font-meta text-danger">
        Not sent.{' '}
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

/** The scrolling column. It follows the newest message unless the Person has scrolled away. */
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
  return (
    <div
      className="flex flex-1 flex-col-reverse overflow-y-auto px-4 sm:px-6"
      // Reversed column: the browser keeps the view pinned to the newest message by itself, with
      // no scroll effect to run on every streamed token.
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
  )
}
