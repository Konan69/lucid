import { Check, LoaderCircle } from 'lucide-react'
import * as Result from 'effect/Result'
import { useEffect, useState } from 'react'
import * as connectorsData from '../data/connectors'
import { run } from '../data/runtime'
import { ServiceMarks } from '../ui/Marks'

/* What each connector lets Vivid do, in Vivid's words rather than the API's. */
const PURPOSE = new Map([
  ['gmail', 'Read your mail, and send the nudges you ask it to send.'],
  ['calendar', 'See what is on and put follow-ups on the calendar.'],
  ['drive', 'Find and read the files you mention.'],
])

type Notice = { tone: 'success' | 'danger'; text: string }

function resultFromLocation() {
  const params = new URLSearchParams(location.search)
  return {
    connected: params.get('connected') ?? undefined,
    error: params.get('error') ?? undefined,
  }
}

export function Connectors({ embedded = false }: { embedded?: boolean }) {
  const [connectors, setConnectors] = useState<connectorsData.Connector[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(() => {
    const result = resultFromLocation()
    if (result.connected) return { tone: 'success', text: `${result.connected} is connected.` }
    if (result.error) return { tone: 'danger', text: `Could not connect: ${result.error}` }
    return null
  })

  useEffect(() => {
    let cancelled = false

    // The initial request synchronizes the screen with the connector runtime. Applying the
    // response asynchronously avoids a redundant synchronous state transition on mount.
    void run(connectorsData.list()).then((result) => {
      if (cancelled) return
      if (Result.isFailure(result)) {
        setConnectors([])
        setNotice({ tone: 'danger', text: result.failure.message })
        return
      }
      setConnectors(result.success)
    })

    if (location.search.includes('connected=') || location.search.includes('error=')) {
      history.replaceState(null, '', '/?settings=connectors')
    }

    return () => {
      cancelled = true
    }
  }, [])

  async function connect(id: string) {
    setBusy(id)
    const result = await run(connectorsData.authorize(id))
    if (Result.isFailure(result)) {
      setNotice({ tone: 'danger', text: result.failure.message })
      setBusy(null)
      return
    }
    location.assign(result.success)
  }

  async function disconnect(id: string) {
    setBusy(id)
    const result = await run(connectorsData.disconnect(id))
    if (Result.isFailure(result)) {
      setNotice({ tone: 'danger', text: result.failure.message })
      setBusy(null)
      return
    }
    setNotice(null)
    setConnectors(result.success)
    setBusy(null)
  }

  const connected = (connectors ?? []).filter((connector) => connector.status === 'connected')
  const named = connected.length > 0 ? connected.map((connector) => connector.metadata.name) : null

  return (
    <section className={embedded ? 'pt-3' : 'flex h-full min-w-0 flex-1 flex-col bg-surface-0'}>
      {!embedded && (
        <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
          <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">Connectors</h1>
          <ServiceMarks services={connected.map((connector) => connector.id)} size={18} />
        </header>
      )}

      <div className={embedded ? '' : 'min-h-0 flex-1 overflow-y-auto scroll-fade-y'}>
        <div
          className={
            embedded
              ? 'mx-auto w-full max-w-3xl pb-8'
              : 'mx-auto w-full max-w-230 px-5 pt-1 pb-10 sm:px-8'
          }
        >
          <p className="px-0.5 text-meta font-meta text-ink-4">
            {named
              ? `Vivid can use ${named.join(', ')}.`
              : 'Vivid works without these. Connect one when you want it to act on your mail, calendar, or files.'}
          </p>

          <ConnectorNotice notice={notice} />

          <ul className="mt-4 flex flex-col gap-1.5">
            {connectors === null && (
              <li className="flex items-center gap-2 px-3 py-4 text-label text-ink-4">
                <LoaderCircle className="size-3.5 animate-spin" />
                Checking what is connected
              </li>
            )}
            {connectors !== null &&
              connectors.map((connector) => (
                <ConnectorRow
                  key={connector.id}
                  connector={connector}
                  busy={busy === connector.id}
                  onConnect={connect}
                  onDisconnect={disconnect}
                />
              ))}
          </ul>

          <p className="mt-6 px-0.5 text-meta text-ink-4">
            Google signs you in and Vivid keeps the token on this machine. Disconnect removes it.
          </p>
        </div>
      </div>
    </section>
  )
}

/** Renders connector feedback only when an authorization or runtime result exists. */
function ConnectorNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null
  return (
    <div
      role={notice.tone === 'danger' ? 'alert' : 'status'}
      className={`mt-3 flex items-center gap-2 rounded-control px-3 py-2 text-label ${notice.tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`}
    >
      {notice.tone === 'success' && <Check className="size-3.5" />}
      {notice.text}
    </div>
  )
}

/** Renders one connector's status and action without making the screen own row-level decisions. */
function ConnectorRow({
  connector,
  busy,
  onConnect,
  onDisconnect,
}: {
  connector: connectorsData.Connector
  busy: boolean
  onConnect: (id: string) => Promise<void>
  onDisconnect: (id: string) => Promise<void>
}) {
  const isConnected = connector.status === 'connected'
  return (
    <li className="flex items-center gap-3 rounded-row bg-surface-2 p-3 smooth-shadow-ring-xs">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-1 smooth-shadow-ring-xs">
        <ServiceMarks services={[connector.id]} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-body text-ink">{connector.metadata.name}</span>
          {isConnected && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-meta font-title text-success">
              <Check className="size-3" />
              Connected
            </span>
          )}
          {connector.status === 'error' && (
            <span className="rounded-full bg-danger-soft px-2 py-0.5 text-meta font-title text-danger">
              Needs attention
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-meta text-ink-3">
          {PURPOSE.get(connector.id) ?? connector.metadata.description}
        </span>
      </span>
      {isConnected ? (
        <button
          disabled={busy}
          onClick={() => void onDisconnect(connector.id)}
          className="inline-flex h-8 shrink-0 items-center rounded-control px-3 text-label text-ink-3 hover:bg-wash-hover hover:text-ink disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : 'Disconnect'}
        </button>
      ) : (
        <button
          disabled={busy}
          onClick={() => void onConnect(connector.id)}
          className="inline-flex h-8 shrink-0 items-center rounded-control bg-surface-3 px-3 text-label font-title text-ink smooth-shadow-ring-xs hover:bg-wash-hover disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : 'Connect'}
        </button>
      )}
    </li>
  )
}
