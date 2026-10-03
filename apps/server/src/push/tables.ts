import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { NotificationId, PushDestination, PushTargetId } from '@vivid/contracts'
import { sessionTable } from '../auth/tables.ts'
import { epoch, personColumn } from '../database/owner.ts'
import { notifications } from '../notifications/tables.ts'
import type { PushReceipt } from './receipts.ts'

/** Session deletion cascades before auth publishes its existing session-ended Person signal. */
export const pushTargets = pgTable(
  'vivid_push_targets',
  {
    id: text('id').$type<PushTargetId>().primaryKey(),
    personId: personColumn().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessionTable.id, { onDelete: 'cascade' }),
    addressHash: text('address_hash').notNull(),
    destination: jsonb('destination').$type<PushDestination>().notNull(),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('vivid_push_targets_address').on(table.addressHash),
    index('vivid_push_targets_person').on(table.personId),
  ],
)

/**
 * One irreversible send claim per Notification and target. Claims commit before external I/O;
 * an uncertain attempt is never resent. Only the Notification owns the text, not this ledger.
 * Target ids intentionally have no FK: removing a gone target must retain its delivery evidence.
 */
export const pushDeliveries = pgTable(
  'vivid_push_deliveries',
  {
    notificationId: text('notification_id')
      .$type<NotificationId>()
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    targetId: text('target_id').$type<PushTargetId>().notNull(),
    bodyHash: text('body_hash').notNull(),
    bodyLength: integer('body_length').notNull(),
    receipt: jsonb('receipt').$type<PushReceipt>().notNull(),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.notificationId, table.targetId] })],
)
