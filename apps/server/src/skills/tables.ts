import { index, pgTable, text } from 'drizzle-orm/pg-core'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'

/**
 * One row per skill: a procedure Vivid learned and can follow again.
 *
 * A row with no `company_id` is its `person_id`'s own; a row with one is shared with that Company
 * and `person_id` records who saved it.
 */
export const skills = pgTable(
  'vivid_skills',
  {
    id: text('id').primaryKey(),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    name: text('name').notNull(),
    about: text('about').notNull(),
    useWhen: text('use_when').notNull(),
    instructions: text('instructions').notNull(),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [
    index('vivid_skills_person').on(table.personId),
    index('vivid_skills_company').on(table.companyId),
  ],
)
