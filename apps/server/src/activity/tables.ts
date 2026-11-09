import type { ApprovalId, RunId } from '@vivid/contracts'
import { index, pgTable, text } from 'drizzle-orm/pg-core'
import { sessionTable } from '../auth/tables.ts'
import { personColumn } from '../database/owner.ts'

/** Claims belong to one work unit; an ambiguous send cannot disable future Runs. */
export type ActivityStartKey = `run:${RunId}` | `approval:${ApprovalId}`

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
    startKey: text('start_key').$type<ActivityStartKey>(),
  },
  (table) => [index('vivid_activity_targets_person').on(table.personId)],
)
