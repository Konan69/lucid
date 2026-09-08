import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { desc, eq, sql } from "drizzle-orm";
import { Pool, types } from "pg";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ConnectorCredential, ConnectorId, ConnectorStatus } from "./types.ts";
import { credentials } from "./schema.ts";

types.setTypeParser(20, (value) => Number(value));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool });
const ready = (async () => {
  const existing = await db.execute(sql`SELECT to_regclass('public.vivid_credentials') AS name`);
  if (!existing.rows[0]?.name) {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  }
})();

const CredentialSchema = Schema.Struct({
  id: Schema.String,
  connectorId: Schema.Union([Schema.Literal("gmail"), Schema.Literal("calendar"), Schema.Literal("drive")]),
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  scope: Schema.String,
  createdAt: Schema.Number
});
const decodeCredential = (value: unknown): ConnectorCredential =>
  Effect.runSync(Schema.decodeUnknownEffect(CredentialSchema)(value) as Effect.Effect<ConnectorCredential, unknown, never>);

const credentialSelection = {
  id: credentials.id,
  connectorId: credentials.connectorId,
  accessToken: credentials.accessToken,
  refreshToken: credentials.refreshToken,
  expiresAt: credentials.expiresAt,
  scope: credentials.scope,
  createdAt: credentials.createdAt
};

export async function listCredentials(): Promise<ConnectorCredential[]> {
  await ready;
  return (await db.select(credentialSelection).from(credentials).orderBy(desc(credentials.createdAt))).map(decodeCredential);
}

export async function getCredentialsForConnector(connectorId: ConnectorId): Promise<ConnectorCredential[]> {
  await ready;
  return (await db.select(credentialSelection).from(credentials).where(eq(credentials.connectorId, connectorId)).orderBy(desc(credentials.createdAt))).map(decodeCredential);
}

export async function getCredential(id: string): Promise<ConnectorCredential | null> {
  await ready;
  const rows = await db.select(credentialSelection).from(credentials).where(eq(credentials.id, id));
  return rows[0] ? decodeCredential(rows[0]) : null;
}

export async function saveCredential(credential: Omit<ConnectorCredential, "id" | "createdAt">): Promise<ConnectorCredential> {
  await ready; const id = randomUUID(); const createdAt = Date.now();
  await db.insert(credentials).values({ ...credential, id, createdAt });
  return decodeCredential({ ...credential, id, createdAt });
}

export async function updateCredential(id: string, patch: Partial<Pick<ConnectorCredential, "accessToken" | "refreshToken" | "expiresAt">>): Promise<ConnectorCredential | null> {
  const current = await getCredential(id); if (!current) return null;
  const next = { ...current, ...patch };
  await db.update(credentials).set({ accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt }).where(eq(credentials.id, id));
  return decodeCredential(next);
}

export async function deleteCredential(id: string): Promise<boolean> {
  await ready;
  return (await db.delete(credentials).where(eq(credentials.id, id)).returning({ id: credentials.id })).length > 0;
}

export async function deleteCredentialsForConnector(connectorId: ConnectorId): Promise<number> {
  await ready;
  return (await db.delete(credentials).where(eq(credentials.connectorId, connectorId)).returning({ id: credentials.id })).length;
}

export async function getConnectorStatus(connectorId: ConnectorId): Promise<ConnectorStatus> {
  const creds = await getCredentialsForConnector(connectorId); if (creds.length === 0) return "disconnected";
  return creds.some((credential) => credential.expiresAt > Date.now() + 60_000) ? "connected" : "error";
}
