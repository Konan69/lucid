import { useEffect, useState } from 'react'
import * as Result from 'effect/Result'
import { Check, ExternalLink } from 'lucide-react'
import * as connectorRequestsData from '../../data/requests'
import * as connectorsData from '../../data/connectors'
import { run } from '../../data/runtime'
import { ToolMarks } from '../Marks'

export function ConnectorRequestCard({
  request,
  onContinue,
  disabled,
}: {
  request: connectorRequestsData.ConnectorRequest
  onContinue: () => Promise<void>
  disabled: boolean
}) {
  const [status, setStatus] = useState<connectorRequestsData.ConnectorStatus['status'] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [authUrl, setAuthUrl] = useState('')
  const name = connectorRequestsData.connectorNames[request.connector]
  useEffect(() => {
    let active = true
    async function refresh() {
      const result = await run(connectorsData.readRequestStatus(request.connector))
      if (!active) return
      if (Result.isFailure(result)) {
        setError(result.failure.message)
        return
      }
      setStatus(result.success)
    }
    void refresh()
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    const timer = setInterval(
      () => {
        if (!document.hidden) void refresh()
      },
      authUrl ? 3000 : 15000,
    )
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [request.connector, authUrl])

  async function act() {
    setBusy(true)
    setError('')
    // Open synchronously from the click so browser popup blockers don't eat the handoff.
    const popup = status === 'connected' ? null : window.open('about:blank', '_blank')
    if (popup) popup.opener = null
    const result = await run(
      connectorsData.actOnRequest(request.connector, status === 'connected', onContinue),
    )
    if (Result.isFailure(result)) {
      if (popup) popup.close()
      setError(result.failure.message)
      setBusy(false)
      return
    }
    const url = result.success
    if (url !== null) {
      setAuthUrl(url)
      if (popup) popup.location.href = url
    }
    setBusy(false)
  }

  const connected = status === 'connected'
  return (
    <div className="my-3 rounded-panel bg-surface-2 px-3.5 py-3 smooth-shadow-ring-xs">
      <div className="flex items-center gap-3">
        <ToolMarks tools={[request.connector]} size={28} />
        <span className="min-w-0 flex-1 text-label font-title text-ink">{name}</span>
        {connected && (
          <span className="inline-flex items-center gap-1 text-meta text-success">
            <Check className="size-3.5" />
            Connected
          </span>
        )}
      </div>
      <p className="mt-2 text-label text-ink-3">{request.reason}</p>
      {error && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      )}
      {authUrl && !connected && (
        <p role="status" className="mt-2 text-meta text-ink-3">
          Finish signing in, then return here.{' '}
          <a href={authUrl} target="_blank" rel="noreferrer" className="text-accent-ink underline">
            Open sign-in again
          </a>
        </p>
      )}
      <button
        disabled={busy || disabled}
        onClick={() => void act()}
        className="mt-3 inline-flex h-8 items-center gap-2 rounded-control bg-surface-3 px-3 text-label font-title text-ink smooth-shadow-ring-xs hover:bg-wash-hover disabled:opacity-50"
      >
        {busy
          ? 'Working…'
          : connected
            ? 'Continue'
            : authUrl
              ? 'Retry connection'
              : `Connect ${name}`}
        {!connected && <ExternalLink className="size-3.5" />}
      </button>
    </div>
  )
}
