import { bigint, text } from 'drizzle-orm/pg-core'
import { personTable } from '../auth/tables.ts'
import { companyTable } from '../companies/tables.ts'

/**
 * The two columns that say whose a product record is.
 *
 * `person_id` is the Person who made it, and the only owner when `company_id` is null: that is a
 * record in the Person's personal space. A `company_id` places the record in that Company, where
 * each domain decides who else may see it. Deleting a Person or a Company removes what they own.
 *
 * These live beside the product tables rather than in a base table because Drizzle generates each
 * owner's SQL from the columns its tables declare.
 */
export const personColumn = (name = 'person_id') =>
  text(name).references(() => personTable.id, { onDelete: 'cascade' })

export const companyColumn = () =>
  text('company_id').references(() => companyTable.id, { onDelete: 'cascade' })

/** Milliseconds since the Unix epoch, the unit every product timestamp crosses the wire in. */
export const epoch = (name: string) => bigint(name, { mode: 'number' })
