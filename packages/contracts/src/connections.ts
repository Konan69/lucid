import { Schema } from 'effect'

/** Supported external Connection identifier. */
export const ConnectionId = Schema.Literals(['gmail', 'calendar', 'drive'] as const)
/** Decoded Connection identifier. */
export type ConnectionId = typeof ConnectionId.Type
/** Closed Connection lifecycle values encoded by the current HTTP protocol. */
export const ConnectionStatus = Schema.Literals([
  'disconnected',
  'connecting',
  'connected',
  'error',
] as const)

/** External Connection metadata shown by clients. */
export const Connection = Schema.Struct({
  id: ConnectionId,
  status: ConnectionStatus,
  metadata: Schema.Struct({
    id: ConnectionId,
    name: Schema.String,
    description: Schema.String,
    icon: Schema.String,
    scopes: Schema.Array(Schema.String),
  }),
}).annotate({ identifier: 'Connection', title: 'Connection' })
/** Decoded external Connection metadata. */
export interface Connection extends Schema.Schema.Type<typeof Connection> {}
/** Connection path parameters. */
export const ConnectionParams = Schema.Struct({ id: ConnectionId })
/** OAuth callback query returned by Google. */
export const ConnectionCallbackQuery = Schema.Struct({
  code: Schema.String,
  state: Schema.optionalKey(Schema.String),
})
/** Signed state payload carried through the OAuth redirect. */
export const ConnectionCallbackState = Schema.Struct({
  connector: ConnectionId,
  nonce: Schema.String,
})
/** Connection list response. */
export const ConnectionListResponse = Schema.Struct({ connectors: Schema.Array(Connection) })
/** Connection authorization response. */
export const ConnectionAuthorizationResponse = Schema.Struct({ authUrl: Schema.String })
/** Connection deletion response. */
export const ConnectionDeletionResponse = Schema.Struct({
  success: Schema.Boolean,
  deleted: Schema.Number,
})

/** Runtime message requesting authorization for one external Connection. */
export const ConnectionRequestMessage = Schema.Struct({
  kind: Schema.Literal('connector-request'),
  connector: ConnectionId,
  reason: Schema.String,
}).annotate({ identifier: 'ConnectionRequestMessage', title: 'Connection request message' })
/** Decoded Connection request message. */
export interface ConnectionRequestMessage extends Schema.Schema.Type<
  typeof ConnectionRequestMessage
> {}
