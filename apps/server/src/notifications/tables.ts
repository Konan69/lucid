import { index, pgTable, text } from 'drizzle-orm/pg-core'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'

/** Recipient-owned notices link to a Thread when the event has one. */
export const notifications = pgTable(
  'vivid_notifications',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    conversationId: text('conversation_id'),
    createdAt: epoch('created_at').notNull(),
    readAt: epoch('read_at'),
    /** Commit the publication receipt with NOTIFY so queue acknowledgement loss cannot repeat it. */
    publishedAt: epoch('published_at'),
    /** The Person this notification is for, and the workspace it happened in. */
    personId: personColumn().notNull(),
    companyId: companyColumn(),
  },
  (table) => [
    index('vivid_notifications_created').on(table.createdAt),
    index('vivid_notifications_person').on(table.personId, table.createdAt),
  ],
)
