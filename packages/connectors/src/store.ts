import * as NodeCrypto from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { desc, eq } from 'drizzle-orm'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { Pool, types } from 'pg'
import type { ConnectorCredential, ConnectorId, ConnectorStatus } from './types.ts'
import { bootstrapConnectorSchema } from './migration.ts'
import { credentials } from './schema.ts'

types.setTypeParser(20, (value) => Number(value))
// This module composes Connector persistence before its legacy Promise API is imported.
// oxlint-disable-next-line vivid/no-runpromise-in-library
const databaseUrl = Redacted.value(Effect.runSync(Config.Redacted('DATABASE_URL')))
const pool = new Pool({ connectionString: databaseUrl })
const db = drizzle({ client: pool })
// The Promise adapter is owned here because every legacy store operation awaits the same bootstrap.
// oxlint-disable-next-line vivid/no-runpromise-in-library
const ready = Effect.runPromise(bootstrapConnectorSchema(pool))

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
  await ready
  return (
    await db.select(credentialSelection).from(credentials).orderBy(desc(credentials.createdAt))
  ).map((row) => decodeCredential(row))
}

export async function getCredentialsForConnector(
  connectorId: ConnectorId,
): Promise<ConnectorCredential[]> {
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
  await ready
  const rows = await db.select(credentialSelection).from(credentials).where(eq(credentials.id, id))
  return rows[0] ? decodeCredential(rows[0]) : null
}

export async function saveCredential(
  credential: Omit<ConnectorCredential, 'id' | 'createdAt'>,
): Promise<ConnectorCredential> {
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
  await ready
  return (
    (await db.delete(credentials).where(eq(credentials.id, id)).returning({ id: credentials.id }))
      .length > 0
  )
}

export async function deleteCredentialsForConnector(connectorId: ConnectorId): Promise<number> {
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
