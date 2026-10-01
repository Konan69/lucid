import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { epoch, personColumn } from '../database/owner.ts'

/**
 * One row per Person's Computer. A Person has at most one, and it is theirs in every workspace:
 * its files and its signed-in browser are personal, so it is never a Company's.
 *
 * `machine` is the provider's reference for the machine behind it. `status` is `starting`,
 * `running`, `stopped` or `failed`, changed at `since`; `reason` explains `failed`. `held` is true
 * while the Person has the keyboard and pointer, during which Vivid may not act on it.
 */
export const computers = pgTable(
  'vivid_computers',
  {
    id: text('id').primaryKey(),
    personId: personColumn().notNull(),
    machine: text('machine').notNull(),
    status: text('status').notNull(),
    since: epoch('since').notNull(),
    reason: text('reason'),
    held: boolean('held').notNull().default(false),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [uniqueIndex('vivid_computers_person').on(table.personId)],
)
