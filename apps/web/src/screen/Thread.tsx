import { useFlueAgent } from '@flue/react'
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
import { useMemo, useState } from 'react'
import { change, LiveState, seenThread, useLive } from '../data/live'
import { Route, router } from '../data/route'
import { Faces } from '../ui/Avatar'
import { Button, IconButton } from '../ui/Button'
import { Face } from '../ui/Face'
import { Composer } from './thread/Composer'
import { Message, type ThreadContext } from './thread/Message'
import { Share } from './thread/Share'

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
  if (LiveState.$is('Failed')(detail)) return <Gone />
  return (
    <Conversation
      key={id}
      id={id}
      me={me}
      detail={LiveState.$is('Ready')(detail) ? Option.some(detail.value) : Option.none()}
      panelOpen={panelOpen}
      onTogglePanel={onTogglePanel}
    />
  )
}

/** A Thread that is not there, or not this Person's to see. The two look the same on purpose. */
function Gone() {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-surface-0 px-6 text-center content-edge">
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
  detail,
  panelOpen,
  onTogglePanel,
}: {
  id: ThreadId
  me: MeResponse
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
  const thread = Option.map(detail, (value) => value.thread)
  const shared = Option.exists(thread, (value) => !ThreadAudience.guards.Private(value.audience))
  const working =
    agent.status === 'submitted' ||
    agent.status === 'streaming' ||
    Option.exists(thread, (value) => value.attention === 'Working')
  const visible = agent.messages.filter(
    (message) => message.display !== 'hidden' || message.signal !== undefined,
  )
  const context: ThreadContext = {
    me: me.person.id,
    shared,
    runs: Option.match(detail, { onNone: () => [], onSome: (value) => value.runs }),
    approvals: Option.match(detail, { onNone: () => [], onSome: (value) => value.approvals }),
    requests: Option.match(detail, { onNone: () => [], onSome: (value) => value.requests }),
  }

  function send(text: string) {
    // A Thread started without a name takes its first message as one.
    if (Option.exists(thread, (value) => value.title === 'New thread')) {
      void change((sdk) => sdk.PatchThread({ id, patch: { title: titleFromMessage(text) } }))
    }
    // In a shared Thread the server turns the message into an attributed one, so it is sent
    // plainly and drawn when it comes back; in a private one the hook shows it at once.
    if (shared) void client.send({ message: { kind: 'user', body: text } })
    else void agent.sendMessage(text).catch(() => undefined)
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0 content-edge">
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
        working={working}
        streaming={agent.messages.some(
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
    <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-title font-title text-ink">
          {Option.match(thread, { onNone: () => '', onSome: (value) => value.title })}
        </h1>
      </div>
      {typing.length > 0 && (
        <span className="hidden text-meta font-meta text-ink-4 sm:inline" aria-live="polite">
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

/** The scrolling column. It follows the newest message unless the Person has scrolled away. */
function Messages({
  ready,
  working,
  streaming,
  failure,
  onRetry,
  children,
}: {
  ready: boolean
  working: boolean
  streaming: boolean
  failure: string | null
  onRetry: () => void
  children: React.ReactNode
}) {
  const empty = Array.isArray(children) && children.length === 0
  return (
    <div
      className="flex flex-1 flex-col-reverse overflow-y-auto"
      // Reversed column: the browser keeps the view pinned to the newest message by itself, with
      // no scroll effect to run on every streamed token.
    >
      <ol className="mx-auto flex w-full max-w-(--thread-max-w) flex-col gap-5 px-4 py-5 sm:p-6">
        {!ready && empty && (
          <li className="py-12 text-center text-label text-ink-4" aria-busy>
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
            <p className="pt-1 text-body text-ink-4">Thinking…</p>
          </li>
        )}
        {failure !== null && (
          <li className="flex items-center gap-3 rounded-panel bg-danger-soft px-4 py-3 text-label text-danger ring-line">
            <span className="min-w-0 flex-1">{failure}</span>
            <button className="cursor-pointer font-title underline" onClick={onRetry}>
              Try again
            </button>
          </li>
        )}
      </ol>
    </div>
  )
}
