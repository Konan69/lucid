import { boolean, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { epoch, personColumn } from '../database/owner.ts'

/**
 * One row per Person's Computer. A Person has at most one, and it is theirs in every workspace:
 * its files and its signed-in browser are personal, so it is never a Company's.
 *
 * `machine` is the provider's reference for the machine behind it. `status` is `starting`,
 * `running`, `stopped` or `failed`, changed at `since`; `reason` explains `failed`. `held` is true
 * while the Person has the keyboard and pointer, during which Vivid may not act on it.
 * `lastActivityAt` is epoch milliseconds for action/watch activity. Zero marks pre-policy rows
 * with no observation, so their first restored deadline is overdue rather than invented.
 */
export const computers = pgTable(
  'vivid_computers',
  {
    id: text('id').primaryKey(),
    personId: personColumn().notNull(),
    machine: text('machine').notNull(),
    status: text('status').notNull(),
    since: epoch('since').notNull(),
    lastActivityAt: epoch('last_activity_at').notNull().default(0),
    reason: text('reason'),
    held: boolean('held').notNull().default(false),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [uniqueIndex('vivid_computers_person').on(table.personId)],
)

/** A durable create intent precedes HTTP; its body and key survive crashes and config changes.
 * Provider identity is private server data. A lost binding never authorizes a replacement machine. */
export const machineBindings = pgTable('vivid_machine_bindings', {
  key: text('key').primaryKey(),
  intent: text('intent').notNull().unique(),
  requestedAt: epoch('requested_at').notNull(),
  request: jsonb('request').notNull(),
  providerId: text('provider_id').unique(),
  observedState: text('observed_state').notNull(),
  since: epoch('since').notNull(),
})
