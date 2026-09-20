import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import {
  CalendarConnector,
  DriveConnector,
  GmailConnector,
  configureConnectorStore,
  deleteCredentialsForConnector,
  getConnectorStatus,
} from '@vivid/connectors'
import { ServerConfig } from '../config.ts'
import {
  Connection as ConnectionSchema,
  type Connection,
  type ConnectionId,
} from '@vivid/contracts'

export class ConnectionFailure extends Schema.TaggedError<ConnectionFailure>()(
  'ConnectionFailure',
  { message: Schema.String },
) {}

const factories = new Map<ConnectionId, () => GmailConnector | CalendarConnector | DriveConnector>([
  ['gmail', () => new GmailConnector()],
  ['calendar', () => new CalendarConnector()],
  ['drive', () => new DriveConnector()],
])

export interface ConnectionStoreService {
  readonly list: () => Effect.Effect<ReadonlyArray<Connection>, ConnectionFailure>
  readonly authorizationUrl: (
    id: ConnectionId,
    state: string,
  ) => Effect.Effect<string, ConnectionFailure>
  readonly exchangeCode: (
    id: ConnectionId,
    code: string,
  ) => Effect.Effect<{ readonly connectorId: string }, ConnectionFailure>
  readonly remove: (id: ConnectionId) => Effect.Effect<number, ConnectionFailure>
}

export class ConnectionStore extends Context.Service<ConnectionStore, ConnectionStoreService>()(
  'vivid/ConnectionStore',
) {}

const connector = (id: ConnectionId) => factories.get(id)?.()

const connectionSchemaDecoder = Schema.decodeUnknownEffect(ConnectionSchema)

/**
 * The Connection store opens the credential database from this server's own configuration when
 * the Layer is built, so the connectors package never reads the environment by itself.
 */
export const connectionStoreLayer = Layer.effect(
  ConnectionStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig
    configureConnectorStore(Redacted.value(config.DATABASE_URL))
    return ConnectionStore.of({
      list: Effect.fn('ConnectionStore.list')(function* () {
        return yield* Effect.forEach(Array.from(factories), ([id, make]) =>
          Effect.tryPromise({
            try: () => getConnectorStatus(id),
            catch: () => new ConnectionFailure({ message: 'Connection status could not be read' }),
          }).pipe(
            Effect.flatMap((status) =>
              connectionSchemaDecoder({
                id,
                status,
                metadata: make().metadata(),
              }),
            ),
            Effect.mapError(
              () => new ConnectionFailure({ message: 'Connection status was invalid' }),
            ),
          ),
        )
      }),
      authorizationUrl: Effect.fn('ConnectionStore.authorizationUrl')(function* (id, state) {
        const current = connector(id)
        if (current === undefined)
          return yield* Effect.fail(new ConnectionFailure({ message: 'Unknown Connection' }))
        return yield* Effect.try({
          try: () => current.getAuthUrl(state),
          catch: () => new ConnectionFailure({ message: 'Google sign-in is not configured' }),
        })
      }),
      exchangeCode: Effect.fn('ConnectionStore.exchangeCode')(function* (id, code) {
        const current = connector(id)
        if (current === undefined)
          return yield* Effect.fail(new ConnectionFailure({ message: 'Unknown Connection' }))
        return yield* Effect.tryPromise({
          try: () => current.exchangeCode(code),
          catch: () => new ConnectionFailure({ message: 'Connection authorization failed' }),
        })
      }),
      remove: Effect.fn('ConnectionStore.remove')(function* (id) {
        return yield* Effect.tryPromise({
          try: () => deleteCredentialsForConnector(id),
          catch: () => new ConnectionFailure({ message: 'Connection could not be removed' }),
        })
      }),
    })
  }),
)
