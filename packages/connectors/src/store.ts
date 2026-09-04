import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConnectorCredential, ConnectorId, ConnectorStatus } from "./types.ts";

const databasePath = process.env.KONAN_CONNECTOR_DB ?? ".state/connectors.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS konan_credentials (
    id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS konan_credentials_connector
    ON konan_credentials(connector_id);
`);

export function listCredentials(): ConnectorCredential[] {
  return database.prepare(
    `SELECT id, connector_id AS connectorId, access_token AS accessToken,
            refresh_token AS refreshToken, expires_at AS expiresAt,
            scope, created_at AS createdAt
     FROM konan_credentials ORDER BY created_at DESC`
  ).all() as unknown as ConnectorCredential[];
}

export function getCredentialsForConnector(connectorId: ConnectorId): ConnectorCredential[] {
  return database.prepare(
    `SELECT id, connector_id AS connectorId, access_token AS accessToken,
            refresh_token AS refreshToken, expires_at AS expiresAt,
            scope, created_at AS createdAt
     FROM konan_credentials WHERE connector_id = ? ORDER BY created_at DESC`
  ).all(connectorId) as unknown as ConnectorCredential[];
}

export function getCredential(id: string): ConnectorCredential | null {
  const row = database.prepare(
    `SELECT id, connector_id AS connectorId, access_token AS accessToken,
            refresh_token AS refreshToken, expires_at AS expiresAt,
            scope, created_at AS createdAt
     FROM konan_credentials WHERE id = ?`
  ).get(id);
  return (row as unknown as ConnectorCredential) ?? null;
}

export function saveCredential(credential: Omit<ConnectorCredential, "id" | "createdAt">): ConnectorCredential {
  const id = randomUUID();
  const createdAt = Date.now();
  database.prepare(
    `INSERT INTO konan_credentials (id, connector_id, access_token, refresh_token, expires_at, scope, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, credential.connectorId, credential.accessToken, credential.refreshToken, credential.expiresAt, credential.scope, createdAt);
  return { ...credential, id, createdAt };
}

export function updateCredential(id: string, patch: Partial<Pick<ConnectorCredential, "accessToken" | "refreshToken" | "expiresAt">>): ConnectorCredential | null {
  const current = getCredential(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  database.prepare(
    `UPDATE konan_credentials SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?`
  ).run(next.accessToken, next.refreshToken, next.expiresAt, id);
  return next;
}

export function deleteCredential(id: string): boolean {
  return Number(database.prepare("DELETE FROM konan_credentials WHERE id = ?").run(id).changes) > 0;
}

export function deleteCredentialsForConnector(connectorId: ConnectorId): number {
  return Number(database.prepare("DELETE FROM konan_credentials WHERE connector_id = ?").run(connectorId).changes);
}

export function getConnectorStatus(connectorId: ConnectorId): ConnectorStatus {
  const creds = getCredentialsForConnector(connectorId);
  if (creds.length === 0) return "disconnected";
  const now = Date.now();
  const hasValid = creds.some((c) => c.expiresAt > now + 60_000);
  return hasValid ? "connected" : "error";
}
