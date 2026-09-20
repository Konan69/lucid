import { useState } from 'react'
import { Linking, View } from 'react-native'
import { Check, ExternalLink } from 'lucide-react-native'
import { ConnectionListResponse } from '@vivid/contracts'
import { useWorkspace } from '../../workspace'
import { useResource } from '../../data/resource/hook'
import { Card, ControlPill, Label } from '../ui'
import { ServiceMark } from '../Mark'
import { authorizationAddress, connectorNames, type ConnectorRequest } from '@vivid/state'

/** Keeps connector action copy aligned with the current request state. */
function connectorActionLabel(input: {
  readonly busy: boolean
  readonly connected: boolean
  readonly authUrl: string
  readonly name: string
}) {
  if (input.busy) return 'Working…'
  if (input.connected) return 'Continue'
  return input.authUrl ? 'Retry connection' : `Connect ${input.name}`
}

export function ConnectorRequestCard({
  request,
  onContinue,
  disabled,
}: {
  request: ConnectorRequest
  onContinue: () => Promise<void>
  disabled: boolean
}) {
  const { api } = useWorkspace()
  const resource = useResource(
    api,
    'connections',
    api.rpc((client) => client.ListConnections()),
    ConnectionListResponse,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const connected =
    resource.data === undefined
      ? false
      : resource.data.connectors.some(
          (item) => item.id === request.connector && item.status === 'connected',
        )
  const name = connectorNames[request.connector]
  async function act() {
    setBusy(true)
    setError('')
    try {
      if (connected) await onContinue()
      else {
        const data = await api.fetchConnectionAuthorization(
          `/api/connectors/${request.connector}/auth`,
        )
        const url = authorizationAddress(data.authUrl)
        await Linking.openURL(url)
        setAuthUrl(url)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card style={{ marginVertical: 8, gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <ServiceMark service={request.connector} size={28} />
        <Label size="label" style={{ flex: 1, fontWeight: '500' }}>
          {name}
        </Label>
        {connected && (
          <Label size="micro" tone="status-success">
            Connected
          </Label>
        )}
      </View>
      <Label size="label" tone="ink-3">
        {request.reason}
      </Label>
      {!!(error || resource.error) && (
        <Label size="micro" tone="status-danger">
          {error || resource.error}
        </Label>
      )}
      {!!authUrl && !connected && (
        <>
          <Label size="micro" tone="ink-3">
            Finish signing in, then return here.
          </Label>
          <ControlPill
            label="Open sign-in again"
            onPress={() => {
              void Linking.openURL(authUrl).catch(() =>
                setError('Could not open sign-in. Try again.'),
              )
            }}
          />
        </>
      )}
      <ControlPill
        icon={connected ? Check : ExternalLink}
        label={connectorActionLabel({ busy, connected, authUrl, name })}
        disabled={busy || disabled}
        onPress={() => void act()}
      />
    </Card>
  )
}
