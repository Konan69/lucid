import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { personTable } from '../auth/tables.ts'

export const settingsTable = pgTable('settings', {
  personId: text()
    .primaryKey()
    .references(() => personTable.id, { onDelete: 'cascade' }),
  theme: text().notNull().default('system'),
  updatedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})
