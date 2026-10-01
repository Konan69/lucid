import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'

/**
 * The audit record: one row per consequential thing that happened, never updated or deleted.
 *
 * `person_id` is the Person responsible: who did it, or on whose behalf Vivid did (`by` says
 * which). A row with a `company_id` belongs to that Company's record, which its admins read; a row
 * without one is in the Person's own. `event` is the encoded `AuditEvent`, which by design carries
 * what happened and never the content it happened to.
 */
export const auditEntries = pgTable(
  'vivid_audit_entries',
  {
    id: text('id').primaryKey(),
    at: epoch('at').notNull(),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    by: text('by').notNull(),
    threadId: text('thread_id'),
    event: jsonb('event').notNull(),
  },
  (table) => [
    index('vivid_audit_entries_person').on(table.personId, table.at),
    index('vivid_audit_entries_company').on(table.companyId, table.at),
  ],
)
