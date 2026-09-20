import { desc, eq } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Connection as ConnectionSchema, ConnectionId, type Connection } from '@vivid/contracts'
import { ConnectionStatus } from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { GoogleOAuthConfiguration, ServerConfig } from '../config.ts'
import { credentials } from './tables.ts'
import {
  ConnectionFailure,
  type ConnectionCredential,
  type ConnectionMetadata,
  type ConnectionTool,
  ConnectionToolFailure,
} from './types.ts'
import * as Calendar from './google/calendar.ts'
import * as Drive from './google/drive.ts'
import { exchangeGoogleCode, getGoogleAuthUrl, refreshGoogleToken } from './google/oauth.ts'
import * as Gmail from './google/gmail.ts'

type StoreError = DatabaseInfrastructureError | ConnectionFailure | ConnectionToolFailure
type DatabaseService = Database['Service']
type Provider = {
  readonly metadata: ConnectionMetadata
  readonly tools: ReadonlyArray<ConnectionTool>
}

const providers: ReadonlyArray<Provider> = [
  { metadata: Gmail.metadata, tools: Gmail.tools },
  { metadata: Calendar.metadata, tools: Calendar.tools },
  { metadata: Drive.metadata, tools: Drive.tools },
]
const providerFor = (id: typeof ConnectionId.Type) =>
  Option.fromNullishOr(providers.find((provider) => provider.metadata.id === id))
const credentialRow = createSelectSchema(credentials)
const credentialSchema = Schema.Struct({
  id: Schema.String,
  connectorId: ConnectionId,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  scope: Schema.String,
  createdAt: Schema.Number,
})
const decodeRow = Schema.decodeUnknownEffect(credentialRow)
const decodeCredential = Schema.decodeUnknownEffect(credentialSchema)
const decodeConnection = Schema.decodeUnknownEffect(ConnectionSchema)

const invalidStoredCredential = () =>
  new ConnectionFailure({ message: 'Stored Connection credential is invalid' })
const unknownConnection = () => new ConnectionFailure({ message: 'Unknown Connection' })
const unavailableConnection = () =>
  new ConnectionFailure({ message: 'This Connection is not configured' })

/** Reads one persisted row and decodes its provider id before any credential use. */
const decodeStoredCredential = Effect.fn('ConnectionStore.decodeCredential')(function* (
  row: typeof credentials.$inferSelect,
) {
  const decodedRow = yield* decodeRow(row).pipe(Effect.mapError(invalidStoredCredential))
  return yield* decodeCredential(decodedRow).pipe(Effect.mapError(invalidStoredCredential))
})

/** Converts a provider's credential rows into the public status without exposing their values. */
const statusFor = (rows: ReadonlyArray<ConnectionCredential>): typeof ConnectionStatus.Type => {
  if (rows.length === 0) return 'disconnected'
  return rows.some((credential) => credential.expiresAt > Date.now() + 60_000)
    ? 'connected'
    : 'error'
}

/** The server-owned authority for OAuth, credentials, provider calls, and public Connection state. */
export interface ConnectionStoreService {
  readonly list: () => Effect.Effect<ReadonlyArray<Connection>, StoreError>
  readonly authorizationUrl: (
    id: typeof ConnectionId.Type,
    state: string,
  ) => Effect.Effect<string, StoreError>
  readonly exchangeCode: (
    id: typeof ConnectionId.Type,
    code: string,
  ) => Effect.Effect<{ readonly connectorId: typeof ConnectionId.Type }, StoreError>
  readonly remove: (id: typeof ConnectionId.Type) => Effect.Effect<number, StoreError>
  readonly execute: (
    id: typeof ConnectionId.Type,
    tool: string,
    input: Schema.Json,
  ) => Effect.Effect<Schema.Json, StoreError>
}

export class ConnectionStore extends Context.Service<ConnectionStore, ConnectionStoreService>()(
  'vivid/ConnectionStore',
) {}

/** Retrieves rows for one provider; this private operation is the only credential read path. */
const makeCredentialReads = (database: DatabaseService) => {
  const forConnector = Effect.fn('ConnectionStore.credentialsForConnector')(function* (
    id: typeof ConnectionId.Type,
  ) {
    const rows = yield* database.run(
      database
        .select()
        .from(credentials)
        .where(eq(credentials.connectorId, id))
        .orderBy(desc(credentials.createdAt)),
    )
    return yield* Effect.forEach(rows, decodeStoredCredential)
  })

  return { forConnector }
}

/** Reads one provider's public state while keeping its persisted credential values private. */
const makePublicConnectionReader = (reads: ReturnType<typeof makeCredentialReads>) =>
  Effect.fn('ConnectionStore.readPublicConnection')(function* (provider: Provider) {
    const rows = yield* reads.forConnector(provider.metadata.id)
    return yield* decodeConnection({
      id: provider.metadata.id,
      status: statusFor(rows),
      metadata: provider.metadata,
    }).pipe(
      Effect.mapError(() => new ConnectionFailure({ message: 'Connection metadata is invalid' })),
    )
  })

/** Adds a refreshed access token without ever returning the credential to an RPC caller. */
const makeAccessToken = (
  database: DatabaseService,
  config: typeof ServerConfig.Service,
  reads: ReturnType<typeof makeCredentialReads>,
) =>
  Effect.fn('ConnectionStore.accessToken')(function* (id: typeof ConnectionId.Type, _tool: string) {
    const credentialsForConnector = yield* reads.forConnector(id)
    const credential = credentialsForConnector[0]
    if (credential === undefined)
      return yield* Effect.fail(new ConnectionFailure({ message: `${id} is not connected` }))
    if (credential.expiresAt > Date.now() + 60_000) return credential.accessToken
    const google = GoogleOAuthConfiguration.$match(config.GOOGLE_OAUTH, {
      Disabled: () => Option.none<ReturnType<typeof GoogleOAuthConfiguration.Enabled>>(),
      Enabled: (value) => Option.some(value),
    })
    if (Option.isNone(google)) return yield* Effect.fail(unavailableConnection())
    const refreshed = yield* refreshGoogleToken(google.value, credential.refreshToken)
    yield* database.run(
      database
        .update(credentials)
        .set({ accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt })
        .where(eq(credentials.id, credential.id)),
    )
    return refreshed.accessToken
  })

/** Builds all Connection operations over the server's Effect Drizzle database. */
export const connectionStoreLayer = Layer.effect(
  ConnectionStore,
  Effect.gen(function* () {
    const database = yield* Database
    const config = yield* ServerConfig
    const reads = makeCredentialReads(database)
    const readPublicConnection = makePublicConnectionReader(reads)
    const accessToken = makeAccessToken(database, config, reads)

    return ConnectionStore.of({
      list: Effect.fn('ConnectionStore.list')(function* () {
        return yield* Effect.forEach(providers, readPublicConnection)
      }),
      authorizationUrl: Effect.fn('ConnectionStore.authorizationUrl')(function* (id, state) {
        const provider = providerFor(id)
        if (Option.isNone(provider)) return yield* Effect.fail(unknownConnection())
        const google = GoogleOAuthConfiguration.$match(config.GOOGLE_OAUTH, {
          Disabled: () => Option.none<ReturnType<typeof GoogleOAuthConfiguration.Enabled>>(),
          Enabled: (value) => Option.some(value),
        })
        if (Option.isNone(google)) return yield* Effect.fail(unavailableConnection())
        return getGoogleAuthUrl(google.value, provider.value.metadata.scopes, state)
      }),
      exchangeCode: Effect.fn('ConnectionStore.exchangeCode')(function* (id, code) {
        if (Option.isNone(providerFor(id))) return yield* Effect.fail(unknownConnection())
        const google = GoogleOAuthConfiguration.$match(config.GOOGLE_OAUTH, {
          Disabled: () => Option.none<ReturnType<typeof GoogleOAuthConfiguration.Enabled>>(),
          Enabled: (value) => Option.some(value),
        })
        if (Option.isNone(google)) return yield* Effect.fail(unavailableConnection())
        const token = yield* exchangeGoogleCode(google.value, code)
        yield* database.run(
          database.insert(credentials).values({
            id: crypto.randomUUID(),
            connectorId: id,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
            scope: token.scope,
            createdAt: yield* Clock.currentTimeMillis,
          }),
        )
        return { connectorId: id }
      }),
      remove: Effect.fn('ConnectionStore.remove')(function* (id) {
        if (Option.isNone(providerFor(id))) return yield* Effect.fail(unknownConnection())
        const deleted = yield* database.run(
          database
            .delete(credentials)
            .where(eq(credentials.connectorId, id))
            .returning({ id: credentials.id }),
        )
        return deleted.length
      }),
      execute: Effect.fn('ConnectionStore.execute')(function* (id, toolName, input) {
        const provider = providerFor(id)
        if (Option.isNone(provider)) return yield* Effect.fail(unknownConnection())
        const tool = provider.value.tools.find((candidate) => candidate.name === toolName)
        if (tool === undefined)
          return yield* Effect.fail(new ConnectionFailure({ message: 'Unknown Connection tool' }))
        const token = yield* accessToken(id, toolName)
        return yield* tool.execute(input, token)
      }),
    })
  }),
)
