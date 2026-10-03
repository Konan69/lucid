import { index, pgTable, text } from 'drizzle-orm/pg-core'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'

/**
 * One row per rule: a standing instruction about what Vivid may do without asking.
 *
 * A row with no `company_id` is its `person_id`'s own rule and follows them everywhere. A row with
 * a `company_id` is that Company's rule, binding on every Member; `person_id` records the admin
 * who wrote it. `decision` is `Allow`, `Ask` or `Never`.
 */
export const rules = pgTable(
  'vivid_rules',
  {
    id: text('id').primaryKey(),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    action: text('action').notNull(),
    decision: text('decision').notNull(),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [
    index('vivid_rules_person').on(table.personId),
    index('vivid_rules_company').on(table.companyId),
  ],
)
