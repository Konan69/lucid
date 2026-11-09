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
    /**
     * The Approval this notice asks the Person to decide, so its push can carry Allow and Decline
     * (`push/delivery.ts`). Null for every notice that asks nothing of its own.
     */
    approvalId: text('approval_id'),
    createdAt: epoch('created_at').notNull(),
    readAt: epoch('read_at'),
    /** The Person this notification is for, and the workspace it happened in. */
    personId: personColumn().notNull(),
    companyId: companyColumn(),
  },
  (table) => [
    index('vivid_notifications_created').on(table.createdAt),
    index('vivid_notifications_person').on(table.personId, table.createdAt),
  ],
)
