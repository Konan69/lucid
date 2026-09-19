import { Effect, Schema } from 'effect'
import { authorizationAddress, type ConnectorId } from './connectorRequests'
import { ClientRequestFailed, emptyResponse, request } from './request'

export type ConnectorState = 'disconnected' | 'connecting' | 'connected' | 'error'

export type Connector = {
  id: string
  status: ConnectorState
  metadata: { id: string; name: string; description: string; icon: string }
}

const ConnectorSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(['disconnected', 'connecting', 'connected', 'error']),
  metadata: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    icon: Schema.String,
  }),
})
const ConnectorResponseSchema = Schema.fromJsonString(
  Schema.Struct({
    connectors: Schema.mutable(Schema.Array(ConnectorSchema)),
  }),
)
const AuthResponseSchema = Schema.fromJsonString(Schema.Struct({ authUrl: Schema.String }))
const decodeConnectorResponse = Schema.decodeUnknownSync(ConnectorResponseSchema)
const decodeAuthResponse = Schema.decodeUnknownSync(AuthResponseSchema)

/** Reads the current external Connection state from the application server. */
export const list = Effect.fn('Connectors.list')(function* () {
  const response = yield* request('/api/connectors', decodeConnectorResponse)
  return response.connectors
})

/** Requests the provider-owned authorization address for one Connection. */
export const authorize = Effect.fn('Connectors.authorize')(function* (id: string) {
  const response = yield* request(`/api/connectors/${id}/auth`, decodeAuthResponse)
  return response.authUrl
})

/** Deletes one Connection and returns the refreshed Connection list. */
export const disconnect = Effect.fn('Connectors.disconnect')(function* (id: string) {
  yield* request(`/api/connectors/${id}`, emptyResponse, { method: 'DELETE' })
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
      Effect.mapError(
        (cause) =>
          new ClientRequestFailed({
            path: '/api/vivid',
            status: null,
            message: 'Could not complete the connection. Try again.',
            cause,
          }),
      ),
    )
    return null
  }
  const path = `/api/connectors/${connector}/auth`
  const authUrl = yield* authorize(connector)
  return yield* Effect.try(() => authorizationAddress(authUrl)).pipe(
    Effect.mapError(
      (cause) =>
        new ClientRequestFailed({
          path,
          status: null,
          message: 'The connection returned an invalid sign-in address.',
          cause,
        }),
    ),
  )
})
