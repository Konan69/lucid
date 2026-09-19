import { asc, desc, eq } from 'drizzle-orm'
import { db, schemaReady } from './runtime-db.ts'
import { conversations } from './runtime-schema.ts'
import { decodeConversation } from './runtime-codecs.ts'

export type ConversationSummary = {
  id: string
  title: string
  preview: string
  updatedAt: number
  archived: boolean
}

function plainPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const conversationSelection = {
  id: conversations.id,
  title: conversations.title,
  preview: conversations.preview,
  updatedAt: conversations.updatedAt,
  archived: conversations.archived,
}

function mapConversation(row: Parameters<typeof decodeConversation>[0]): ConversationSummary {
  const value = decodeConversation(row)
  return { ...value, preview: plainPreview(value.preview) }
}

export async function listConversations(): Promise<ConversationSummary[]> {
  await schemaReady
  const rows = await db
    .select(conversationSelection)
    .from(conversations)
    .orderBy(desc(conversations.updatedAt), asc(conversations.id))
  return rows.map(mapConversation)
}

export async function upsertConversation(
  conversation: ConversationSummary,
): Promise<ConversationSummary> {
  await schemaReady
  const normalized = { ...conversation, preview: plainPreview(conversation.preview) }
  await db
    .insert(conversations)
    .values(normalized)
    .onConflictDoUpdate({
      target: conversations.id,
      set: {
        title: normalized.title,
        preview: normalized.preview,
        updatedAt: normalized.updatedAt,
        archived: normalized.archived,
      },
    })
  return normalized
}

export async function deleteConversation(id: string): Promise<boolean> {
  await schemaReady
  const rows = await db
    .delete(conversations)
    .where(eq(conversations.id, id))
    .returning({ id: conversations.id })
  return rows.length > 0
}
