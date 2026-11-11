import { index, pgTable, text } from 'drizzle-orm/pg-core'
import { sessionTable } from '../auth/tables.ts'
import { personColumn } from '../database/owner.ts'

/**
 * One Live Activity per installation, addressed by the update token of the card the app started.
 * There is no push-to-start address: the server only updates or ends a card the app already shows
 * (`@vivid/contracts` `ActivityRegistration`). Session deletion removes its sending authority.
 */
export const activityTargets = pgTable(
  'vivid_activity_targets',
  {
    installation: text('installation').primaryKey(),
    personId: personColumn().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessionTable.id, { onDelete: 'cascade' }),
    updateToken: text('update_token'),
  },
  (table) => [index('vivid_activity_targets_person').on(table.personId)],
)
