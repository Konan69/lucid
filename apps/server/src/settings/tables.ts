import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { personTable } from '../auth/tables.ts'

export const settingsTable = pgTable('settings', {
  personId: text()
    .primaryKey()
    .references(() => personTable.id, { onDelete: 'cascade' }),
  theme: text().notNull().default('system'),
  /** An IANA zone name. Routines and "tomorrow at 9" are resolved in it. */
  timezone: text().notNull().default('UTC'),
  /** Whether this Person wants to be told when something needs them or finishes. */
  notify: boolean().notNull().default(true),
  updatedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})
