import { boolean, index, pgTable, text } from 'drizzle-orm/pg-core'
import { sessionTable } from '../auth/tables.ts'
import { personColumn } from '../database/owner.ts'

/** One aggregate activity per installation. Session deletion removes its sending authority. */
export const activityTargets = pgTable(
  'vivid_activity_targets',
  {
    installation: text('installation').primaryKey(),
    personId: personColumn().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessionTable.id, { onDelete: 'cascade' }),
    startToken: text('start_token'),
    updateToken: text('update_token'),
    started: boolean('started').notNull().default(false),
  },
  (table) => [index('vivid_activity_targets_person').on(table.personId)],
)
