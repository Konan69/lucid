import { VividRpcClient } from '@vivid/client-runtime'
import type { Connection } from '@vivid/contracts'
import { ConnectionAuthorizationResponse, ConnectionId } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { authorizationAddress, type ConnectorId } from '@vivid/state'
import { clientFailure } from './runtime'

export type Connector = Connection
export type ConnectorState = Connector['status']
export type ConnectorStatus = Connector

const decodeAuthorizationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConnectionAuthorizationResponse),
)
const decodeConnectionId = Schema.decodeUnknownEffect(ConnectionId)

/** Reads the current external Connection state from the application server. */
export const list = Effect.fn('Connectors.list')(function* () {
  const client = yield* VividRpcClient
  const response = yield* client.ListConnections()
  return [...response.connectors]
})

/** Requests the provider-owned authorization address for one Connection. */
export const authorize = Effect.fn('Connectors.authorize')(function* (id: string) {
  const path = `/api/connectors/${id}/auth`
  const response = yield* Effect.tryPromise({
    try: () => fetch(path),
    catch: (cause) => clientFailure('Could not reach Vivid.', cause),
  })
  if (!response.ok)
    return yield* Effect.fail(clientFailure(`Request failed (${response.status})`, response.status))
  const payload = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => clientFailure('Vivid returned an unreadable response.', cause),
  })
  const authorization = yield* decodeAuthorizationJson(payload).pipe(
    Effect.mapError((cause) => clientFailure('Vivid returned invalid data.', cause)),
  )
  return authorization.authUrl
})

/** Deletes one Connection and returns the refreshed Connection list. */
export const disconnect = Effect.fn('Connectors.disconnect')(function* (id: string) {
  const client = yield* VividRpcClient
  const connectionId = yield* decodeConnectionId(id).pipe(
    Effect.mapError((cause) => clientFailure('The connection id is invalid.', cause)),
  )
  yield* client.DeleteConnection({ id: connectionId })
  return yield* list()
})

/** Reads the state of the Connection requested by one persisted tool result. */
export const readRequestStatus = Effect.fn('Connectors.readRequestStatus')(function* (
  connector: ConnectorId,
) {
  const connectors = yield* list()
  const current = connectors.find((item) => item.id === connector)
  return current === undefined ? ('disconnected' as const) : current.status
})

/** Runs either the conversation continuation or the provider authorization handoff. */
export const actOnRequest = Effect.fn('Connectors.actOnRequest')(function* (
  connector: ConnectorId,
  connected: boolean,
  onContinue: () => Promise<void>,
) {
  if (connected) {
    yield* Effect.tryPromise(() => onContinue()).pipe(
      Effect.mapError((cause) =>
        clientFailure('Could not complete the connection. Try again.', cause),
      ),
    )
    return null
  }
  const authUrl = yield* authorize(connector)
  return yield* Effect.try(() => authorizationAddress(authUrl)).pipe(
    Effect.mapError((cause) =>
      clientFailure('The connection returned an invalid sign-in address.', cause),
    ),
  )
})
