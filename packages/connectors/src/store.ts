import * as NodeCrypto from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { desc, eq } from 'drizzle-orm'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { Pool, types } from 'pg'
import type { ConnectorCredential, ConnectorId, ConnectorStatus } from './types.ts'
import { bootstrapConnectorSchema } from './migration.ts'
import { credentials } from './schema.ts'

types.setTypeParser(20, (value) => Number(value))

interface ConnectorDatabase {
  readonly db: ReturnType<typeof drizzle>
  /** Resolves once the credential table exists; every operation awaits it first. */
  readonly ready: Promise<void>
}

let configured = Option.none<ConnectorDatabase>()

/**
 * Opens the credential database. Nothing happens at import: a module that reads the environment
 * and opens a pool while it loads cannot be imported by a test, or by a server that gets its
 * configuration from a Layer. The application server calls this once with the URL from its own
 * `ServerConfig`; a caller that never configures it gets `DATABASE_URL` on first use.
 *
 * This Promise store is owed work (docs/00-structure.md): it moves into the server's
 * `connections/` domain on Effect Drizzle, and Vivid's tools reach it over RPC.
 */
export function configureConnectorStore(databaseUrl: string): void {
  const pool = new Pool({ connectionString: databaseUrl })
  configured = Option.some({
    db: drizzle({ client: pool }),
    // oxlint-disable-next-line vivid/no-runpromise-in-library
    ready: Effect.runPromise(bootstrapConnectorSchema(pool)),
  })
}

const connectorDatabase = (): ConnectorDatabase => {
  if (Option.isSome(configured)) return configured.value
  // oxlint-disable-next-line vivid/no-runpromise-in-library
  configureConnectorStore(Redacted.value(Effect.runSync(Config.Redacted('DATABASE_URL'))))
  return Option.getOrThrow(configured)
}

const CredentialSchema = Schema.Struct({
  id: Schema.String,
  connectorId: Schema.Union([
    Schema.Literal('gmail'),
    Schema.Literal('calendar'),
    Schema.Literal('drive'),
  ]),
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  scope: Schema.String,
  createdAt: Schema.Number,
})
const decodeCredential = Schema.decodeUnknownSync(CredentialSchema)

const credentialSelection = {
  id: credentials.id,
  connectorId: credentials.connectorId,
  accessToken: credentials.accessToken,
  refreshToken: credentials.refreshToken,
  expiresAt: credentials.expiresAt,
  scope: credentials.scope,
  createdAt: credentials.createdAt,
}

export async function listCredentials(): Promise<ConnectorCredential[]> {
  const { db, ready } = connectorDatabase()
  await ready
  return (
    await db.select(credentialSelection).from(credentials).orderBy(desc(credentials.createdAt))
  ).map((row) => decodeCredential(row))
}

export async function getCredentialsForConnector(
  connectorId: ConnectorId,
): Promise<ConnectorCredential[]> {
  const { db, ready } = connectorDatabase()
  await ready
  return (
    await db
      .select(credentialSelection)
      .from(credentials)
      .where(eq(credentials.connectorId, connectorId))
      .orderBy(desc(credentials.createdAt))
  ).map((row) => decodeCredential(row))
}

export async function getCredential(id: string): Promise<ConnectorCredential | null> {
  const { db, ready } = connectorDatabase()
  await ready
  const rows = await db.select(credentialSelection).from(credentials).where(eq(credentials.id, id))
  return rows[0] ? decodeCredential(rows[0]) : null
}

export async function saveCredential(
  credential: Omit<ConnectorCredential, 'id' | 'createdAt'>,
): Promise<ConnectorCredential> {
  const { db, ready } = connectorDatabase()
  await ready
  const id = NodeCrypto.randomUUID()
  const createdAt = Date.now()
  await db.insert(credentials).values({ ...credential, id, createdAt })
  return decodeCredential({ ...credential, id, createdAt })
}

export async function updateCredential(
  id: string,
  patch: Partial<Pick<ConnectorCredential, 'accessToken' | 'refreshToken' | 'expiresAt'>>,
): Promise<ConnectorCredential | null> {
  const { db } = connectorDatabase()
  const current = await getCredential(id)
  if (!current) return null
  const next = { ...current, ...patch }
  await db
    .update(credentials)
    .set({
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
    })
    .where(eq(credentials.id, id))
  return decodeCredential(next)
}

export async function deleteCredential(id: string): Promise<boolean> {
  const { db, ready } = connectorDatabase()
  await ready
  return (
    (await db.delete(credentials).where(eq(credentials.id, id)).returning({ id: credentials.id }))
      .length > 0
  )
}

export async function deleteCredentialsForConnector(connectorId: ConnectorId): Promise<number> {
  const { db, ready } = connectorDatabase()
  await ready
  return (
    await db
      .delete(credentials)
      .where(eq(credentials.connectorId, connectorId))
      .returning({ id: credentials.id })
  ).length
}

export async function getConnectorStatus(connectorId: ConnectorId): Promise<ConnectorStatus> {
  const creds = await getCredentialsForConnector(connectorId)
  if (creds.length === 0) return 'disconnected'
  return creds.some((credential) => credential.expiresAt > Date.now() + 60_000)
    ? 'connected'
    : 'error'
}
