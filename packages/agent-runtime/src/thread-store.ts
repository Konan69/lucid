import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";

export type ConversationSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  archived: boolean;
};

const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS konan_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    preview TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS konan_conversations_updated_at
    ON konan_conversations(updated_at DESC);
`);

const conversationColumns = database.prepare("PRAGMA table_info(konan_conversations)").all() as unknown as Array<{ name: string }>;
if (!conversationColumns.some((column) => column.name === "archived")) {
  database.exec("ALTER TABLE konan_conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
}

const listStatement = database.prepare(`
  SELECT id, title, preview, updated_at AS updatedAt, archived
  FROM konan_conversations
  ORDER BY updated_at DESC, id ASC
`);

const upsertStatement = database.prepare(`
  INSERT INTO konan_conversations (id, title, preview, updated_at, archived)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    preview = excluded.preview,
    updated_at = excluded.updated_at,
    archived = excluded.archived
`);

const deleteStatement = database.prepare("DELETE FROM konan_conversations WHERE id = ?");

function mapConversation(row: unknown): ConversationSummary {
  const value = row as Omit<ConversationSummary, "archived"> & { archived: number };
  return { ...value, archived: value.archived === 1, preview: plainPreview(value.preview) };
}

function plainPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function listConversations(): ConversationSummary[] {
  return (listStatement.all() as unknown[]).map(mapConversation);
}

export function upsertConversation(conversation: ConversationSummary): ConversationSummary {
  const normalized = { ...conversation, preview: plainPreview(conversation.preview) };
  upsertStatement.run(
    normalized.id,
    normalized.title,
    normalized.preview,
    normalized.updatedAt,
    normalized.archived ? 1 : 0,
  );
  return normalized;
}

export function deleteConversation(id: string): boolean {
  return deleteStatement.run(id).changes > 0;
}
