import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";

export type ConversationSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
};

const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS konan_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    preview TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS konan_conversations_updated_at
    ON konan_conversations(updated_at DESC);
`);

const listStatement = database.prepare(`
  SELECT id, title, preview, updated_at AS updatedAt
  FROM konan_conversations
  ORDER BY updated_at DESC, id ASC
`);

const upsertStatement = database.prepare(`
  INSERT INTO konan_conversations (id, title, preview, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    preview = excluded.preview,
    updated_at = excluded.updated_at
`);

export function listConversations(): ConversationSummary[] {
  return listStatement.all() as unknown as ConversationSummary[];
}

export function upsertConversation(conversation: ConversationSummary): ConversationSummary {
  upsertStatement.run(
    conversation.id,
    conversation.title,
    conversation.preview,
    conversation.updatedAt,
  );
  return conversation;
}
