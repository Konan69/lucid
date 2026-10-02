import { useAtom, useAtomRefresh, useAtomValue } from '@effect/atom-react'
import {
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  ServiceAuthorization,
  ServiceCatalog,
  Workspace,
  type Connection,
  type ConnectionId,
  type MeResponse,
  type Service,
} from '@vivid/contracts'
import { liveStateOf } from '@vivid/state'
import { Option, Redacted, Result } from 'effect'
import { Link2, Search } from 'lucide-react'
import { useState } from 'react'
import { change, live, LiveState, services, serviceSearch, useLive } from '../../data/live'
import { orSay } from '../../data/said'
import { Button } from '../../ui/Button'
import { Dialog, DialogActions } from '../../ui/Dialog'
import { Awaiting, Empty, Refusal, Row, Section } from './Parts'

const HOW = (service: Service) =>
  ServiceAuthorization.match(service.authorization, {
    SignIn: () => 'Sign in',
    Key: () => 'Key',
    None: () => 'No sign-in needed',
    SetupRequired: () => 'Not set up on this Vivid',
  })

/**
 * A provider's sign-in address, when it is one a browser should be sent to. The address comes
 * from the Connection layer and ends up in a tab, so anything that is not a web page (a script
 * address, another app's scheme, something that does not parse) is treated as no address at all.
 */
const signInPage = (address: string) =>
  Option.filter(
    Option.liftThrowable((value: string) => new URL(value))(address),
    (page) => page.protocol === 'https:' || page.protocol === 'http:',
  )

/**
 * Sends the tab that was opened for a sign-in to the provider's page. The tab was opened by the
 * click itself, before the server was asked anything, because a browser only lets a page open a
 * tab while it is still handling the click. Without a tab or a real address there is nothing to
 * show, and the caller says so.
 */
function showSignIn(tab: Window | null, address: string) {
  const page = signInPage(address)
  if (tab === null || Option.isNone(page)) {
    if (tab !== null) tab.close()
    return false
  }
  // The provider's page must not be able to reach back into this one.
  tab.opener = null
  tab.location.replace(page.value.href)
  return true
}

const STANDING = (connection: Connection) =>
  ConnectionState.match(connection.state, {
    Ready: () => 'Connected',
    NeedsAuthorization: () => 'Not connected yet',
    Failed: ({ reason }) => `Not working: ${reason}`,
  })

const added = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/**
 * Which account a row is, when the service's name alone does not say: what the Person called it,
 * when they called it anything, and always the day it was added, so two accounts on one service
 * can be told apart before one of them is removed.
 */
const WHICH = (connection: Connection) => {
  const day = `added ${added.format(connection.createdAt)}`
  return connection.label === connection.serviceName ? day : `${connection.label} · ${day}`
}

/** A key being collected for a Connection that began: which one, and what it asks for. */
interface Keying {
  readonly id: ConnectionId
  readonly name: string
  readonly fields: ReadonlyArray<{ readonly name: string; readonly label: string }>
}

/**
 * The outside services Vivid can use. A Person's own Connections act only for them, in every
 * workspace. A Company's are added by an admin and can be read through by every member's Vivid.
 * What is typed here goes straight to the Connection layer and is never shown to Vivid, written
 * into a Thread, or kept in this app.
 */
export function Connections({ me }: { me: MeResponse }) {
  const state = useLive(live.connections)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [keying, setKeying] = useState<Keying | null>(null)
  if (!LiveState.$is('Ready')(state)) return <Awaiting state={state} />
  const { connections } = state.value
  const admin = Workspace.guards.Company(me.workspace) && me.workspace.role !== 'member'
  const mine = connections.filter((item) => ConnectionOwnership.guards.Personal(item.ownership))
  const shared = connections.filter((item) => ConnectionOwnership.guards.Shared(item.ownership))

  /**
   * Does what a Connection says comes next: shows the provider's sign-in page in the tab that was
   * opened for it, asks for the key, or nothing when it is already done.
   */
  function follow(step: ConnectionStep, tab: Window | null, name: string) {
    ConnectionStep.match(step, {
      // A provider's sign-in page is shown in its own tab; this page hears that it finished
      // through the live list and needs nothing from that tab.
      OpenSignIn: ({ address }) => {
        if (showSignIn(tab, address)) return
        setRefusal(
          `${name}’s sign-in page could not be opened. Allow pop-ups for this page, then connect again.`,
        )
      },
      EnterKey: ({ connection, fields }) => {
        if (tab !== null) tab.close()
        setKeying({ id: connection.id, name: connection.serviceName, fields })
      },
      Done: () => {
        if (tab !== null) tab.close()
      },
    })
  }

  async function connect(service: Service, asShared: boolean) {
    const signingIn = ServiceAuthorization.guards.SignIn(service.authorization)
    const tab = signingIn ? window.open('about:blank', '_blank') : null
    const result = await change((client) =>
      client.BeginConnection({
        service: service.id,
        label: service.name.slice(0, 40),
        shared: asShared,
      }),
    )
    if (Result.isFailure(result)) {
      if (tab !== null) tab.close()
      setRefusal(`${service.name} could not be connected just now.`)
      return
    }
    setRefusal(null)
    follow(result.success, tab, service.name)
  }

  /**
   * Picks a Connection up where it stopped: the sign-in tab was closed, the key was never
   * entered, or the sign-in lapsed. It is the same Connection afterwards, not a second one.
   *
   * A Connection does not say whether it wants a sign-in page or a key until it is asked, so the
   * tab is opened once the answer is a sign-in page. A browser allows that for a few seconds
   * after the click; when it has stopped allowing it, the sentence that says so is the fallback.
   */
  async function resume(connection: Connection) {
    const result = await change((client) => client.ResumeConnection({ id: connection.id }))
    if (Result.isFailure(result)) {
      setRefusal(`${connection.serviceName} could not be reconnected just now.`)
      return
    }
    setRefusal(null)
    const tab = ConnectionStep.guards.OpenSignIn(result.success)
      ? window.open('about:blank', '_blank')
      : null
    follow(result.success, tab, connection.serviceName)
  }

  const remove = (connection: Connection) =>
    void orSay(
      change((client) => client.RemoveConnection({ id: connection.id })),
      `${connection.serviceName} could not be removed. Try again.`,
    )

  return (
    <>
      <Refusal message={refusal} />
      <Section title="Yours" detail="Vivid uses these only when it is acting for you.">
        {mine.length === 0 && <Empty>Nothing connected yet. Pick a service below.</Empty>}
        {mine.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            onResume={() => void resume(connection)}
            onRemove={() => remove(connection)}
          />
        ))}
      </Section>
      {Workspace.guards.Company(me.workspace) && (
        <Section
          title={`${me.workspace.company.name}’s`}
          detail="Every member’s Vivid can read through these. Only admins add or remove them."
        >
          {shared.length === 0 && <Empty>No shared connections.</Empty>}
          {shared.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              onResume={admin ? () => void resume(connection) : undefined}
              onRemove={admin ? () => remove(connection) : undefined}
            />
          ))}
        </Section>
      )}
      <Catalog
        onConnect={(service) => void connect(service, false)}
        onShare={admin ? (service) => void connect(service, true) : undefined}
      />
      {keying !== null && <EnterKey keying={keying} onClose={() => setKeying(null)} />}
    </>
  )
}

/**
 * The services Vivid can be connected to. Before anything is typed it lists the ones most people
 * want, so the common case is one click; typing searches the whole catalog by name. The last
 * answer stays up while the next is on its way, so the list does not blink between keystrokes.
 */
function Catalog({
  onConnect,
  onShare,
}: {
  onConnect: (service: Service) => void
  onShare?: (service: Service) => void
}) {
  const [query, setQuery] = useAtom(serviceSearch)
  const found = liveStateOf(useAtomValue(services))
  const again = useAtomRefresh(services)
  const searching = query.trim().length > 0
  const detail = LiveState.$match(found, {
    Loading: () => 'Looking through the catalog.',
    Failed: () => 'The catalog could not be read.',
    Ready: ({ value }) =>
      ServiceCatalog.match(value, {
        Ready: ({ total }) =>
          searching
            ? `Searching ${total.toLocaleString()} services.`
            : `The most used of ${total.toLocaleString()} services. Search for any other.`,
        Unavailable: () => 'The catalog is out of reach right now.',
      }),
  })
  return (
    <Section title="Connect something" detail={detail}>
      <label className="flex h-11 items-center gap-2.5 px-4">
        <Search className="size-4 text-ink-3" />
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          // The catalog search takes at most this many characters; the field stops there too, so
          // a longer name is never a request the server refuses.
          maxLength={80}
          aria-label="Search for a service"
          placeholder="Search for a service"
          className="min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-ink-3"
        />
      </label>
      <Found found={found} onAgain={again} onConnect={onConnect} onShare={onShare} />
    </Section>
  )
}

/** What the search has to show: the matches, that there are none, or why there is no answer. */
function Found({
  found,
  onAgain,
  onConnect,
  onShare,
}: {
  found: LiveState<ServiceCatalog>
  onAgain: () => void
  onConnect: (service: Service) => void
  onShare?: (service: Service) => void
}) {
  if (LiveState.$is('Loading')(found)) return <Empty>…</Empty>
  if (LiveState.$is('Failed')(found)) return <Empty>{found.failure.message}</Empty>
  if (ServiceCatalog.guards.Unavailable(found.value)) {
    return (
      <Empty>
        Vivid cannot reach its catalog of services at the moment. What you have already connected
        still works.{' '}
        <button
          onClick={onAgain}
          className="cursor-pointer rounded-xs text-ink-2 underline underline-offset-4 hover:text-ink"
        >
          Look again
        </button>
      </Empty>
    )
  }
  const { services: list } = found.value
  if (list.length === 0) return <Empty>No service by that name.</Empty>
  return list.map((service) => (
    <ServiceRow key={service.id} service={service} onConnect={onConnect} onShare={onShare} />
  ))
}

function ServiceRow({
  service,
  onConnect,
  onShare,
}: {
  service: Service
  onConnect: (service: Service) => void
  onShare?: (service: Service) => void
}) {
  // A catalog entry's description is written by whoever published it, often for another product
  // by name, so the row says only what Vivid knows to be true: the service and how it is entered.
  const offered = !ServiceAuthorization.guards.SetupRequired(service.authorization)
  return (
    <Row label={service.name} detail={HOW(service)}>
      {offered && (
        <Button size="sm" onClick={() => onConnect(service)}>
          Connect
        </Button>
      )}
      {offered && onShare !== undefined && (
        <Button size="sm" variant="ghost" onClick={() => onShare(service)}>
          For the company
        </Button>
      )}
    </Row>
  )
}

function ConnectionRow({
  connection,
  onResume,
  onRemove,
}: {
  connection: Connection
  /** Present for whoever may finish this Connection; it is offered only while it is unfinished. */
  onResume?: () => void
  onRemove?: () => void
}) {
  const unfinished =
    ConnectionState.guards.NeedsAuthorization(connection.state) ||
    ConnectionState.guards.Failed(connection.state)
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-3 ring-line">
        <Link2 className="size-4" strokeWidth={1.6} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-label text-ink">{connection.serviceName}</div>
        <div className="truncate text-label text-ink-3">
          {STANDING(connection)} · {WHICH(connection)}
        </div>
      </div>
      {unfinished && onResume !== undefined && (
        <Button size="sm" onClick={onResume}>
          Reconnect
        </Button>
      )}
      {onRemove !== undefined && (
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  )
}

/**
 * Collects the key a service asks for. The values are wrapped the moment they leave the form and
 * sent once; they are not kept in state after the dialog closes and never appear anywhere else.
 */
function EnterKey({ keying, onClose }: { keying: Keying; onClose: () => void }) {
  const [refusal, setRefusal] = useState<string | null>(null)

  async function submit(form: HTMLFormElement) {
    // Each field is read from its own input, by the name the service gave it: an input's value is
    // always text, where a form's entries could also be files.
    const typed = (name: string) => {
      const input = form.elements.namedItem(name)
      return input instanceof HTMLInputElement ? input.value : ''
    }
    const fields = Object.fromEntries(
      keying.fields.map((field) => [field.name, Redacted.make(typed(field.name))]),
    )
    const result = await change((client) => client.CompleteConnection({ id: keying.id, fields }))
    if (Result.isFailure(result)) {
      setRefusal('That was not accepted. Check it and try again.')
      return
    }
    onClose()
  }

  return (
    <Dialog
      title={`Connect ${keying.name}`}
      description="This goes straight to the connection and is never shown to Vivid or kept in a thread."
      width="md"
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit(event.currentTarget)
        }}
        className="flex flex-col gap-3"
      >
        {keying.fields.map((field) => (
          <label key={field.name} className="flex flex-col gap-1.5">
            <span className="text-label text-ink-2">{field.label}</span>
            <input
              required
              name={field.name}
              type="password"
              autoComplete="off"
              className="h-9 rounded-control bg-well px-3 font-mono text-label text-ink ring-line outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        ))}
        {refusal !== null && (
          <p role="alert" className="text-label text-danger">
            {refusal}
          </p>
        )}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Connect
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
