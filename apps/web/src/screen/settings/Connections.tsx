import {
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  ServiceAuthorization,
  Workspace,
  type Connection,
  type ConnectionId,
  type MeResponse,
  type Service,
} from '@vivid/contracts'
import { Redacted, Result } from 'effect'
import { Link2, Search } from 'lucide-react'
import { useState } from 'react'
import { change, live, LiveState, useLive } from '../../data/live'
import { Button } from '../../ui/Button'
import { Dialog, DialogActions } from '../../ui/Dialog'
import { Empty, Refusal, Row, Section } from './Parts'

const HOW = (service: Service) =>
  ServiceAuthorization.match(service.authorization, {
    SignIn: () => 'Sign in',
    Key: () => 'Key',
    None: () => 'No sign-in needed',
  })

const STANDING = (connection: Connection) =>
  ConnectionState.match(connection.state, {
    Ready: () => 'Connected',
    NeedsAuthorization: () => 'Needs you to sign in again',
    Failed: ({ reason }) => `Not working: ${reason}`,
  })

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
  const [query, setQuery] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const [keying, setKeying] = useState<Keying | null>(null)
  if (!LiveState.$is('Ready')(state)) return null
  const { connections, services } = state.value
  const admin = Workspace.guards.Company(me.workspace) && me.workspace.role !== 'member'
  const mine = connections.filter((item) => ConnectionOwnership.guards.Personal(item.ownership))
  const shared = connections.filter((item) => ConnectionOwnership.guards.Shared(item.ownership))
  const wanted = query.trim().toLowerCase()
  const found =
    wanted.length === 0
      ? []
      : services.filter((service) => service.name.toLowerCase().includes(wanted)).slice(0, 12)

  async function connect(service: Service, asShared: boolean) {
    const result = await change((client) =>
      client.BeginConnection({
        service: service.id,
        label: service.name.slice(0, 40),
        shared: asShared,
      }),
    )
    if (Result.isFailure(result)) {
      setRefusal(`${service.name} could not be connected just now.`)
      return
    }
    setRefusal(null)
    ConnectionStep.match(result.success, {
      // A provider's sign-in page opens in its own tab; this page hears that it finished through
      // the live list and needs nothing from that tab.
      OpenSignIn: ({ address }) => void window.open(address, '_blank', 'noopener,noreferrer'),
      EnterKey: ({ connection, fields }) =>
        setKeying({ id: connection.id, name: connection.serviceName, fields }),
      Done: () => undefined,
    })
  }

  const remove = (connection: Connection) =>
    void change((client) => client.RemoveConnection({ id: connection.id }))

  return (
    <>
      <Refusal message={refusal} />
      <Section title="Yours" detail="Vivid uses these only when it is acting for you.">
        {mine.length === 0 && <Empty>Nothing connected yet. Find a service below.</Empty>}
        {mine.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
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
              onRemove={admin ? () => remove(connection) : undefined}
            />
          ))}
        </Section>
      )}
      <Section title="Connect something" detail={`${services.length} services available.`}>
        <label className="flex h-11 items-center gap-2.5 px-4">
          <Search className="size-4 text-ink-3" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search for a service"
            className="min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-ink-4"
          />
        </label>
        {wanted.length > 0 && found.length === 0 && <Empty>No service by that name.</Empty>}
        {found.map((service) => (
          <Row key={service.id} label={service.name} detail={service.description.slice(0, 120)}>
            <span className="text-meta font-meta text-ink-4">{HOW(service)}</span>
            <Button size="sm" onClick={() => void connect(service, false)}>
              Connect
            </Button>
            {admin && (
              <Button size="sm" variant="ghost" onClick={() => void connect(service, true)}>
                For the company
              </Button>
            )}
          </Row>
        ))}
      </Section>
      {keying !== null && <EnterKey keying={keying} onClose={() => setKeying(null)} />}
    </>
  )
}

function ConnectionRow({
  connection,
  onRemove,
}: {
  connection: Connection
  onRemove?: () => void
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-3 ring-line">
        <Link2 className="size-4" strokeWidth={1.6} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-label text-ink">{connection.serviceName}</div>
        <div className="truncate text-label text-ink-3">{STANDING(connection)}</div>
      </div>
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
    const data = new FormData(form)
    // A text input's form value is a string; a file entry is not something this form has.
    const typed = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value : ''
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
