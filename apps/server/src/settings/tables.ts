import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { DEFAULT_APPEARANCE } from '@vivid/contracts'
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
  /**
   * What this Person calls Vivid in their personal space, and how its face is drawn there: an
   * `Appearance` (`packages/contracts/src/appearance.ts`). The defaults are Vivid as it ships, so
   * a row written before these columns existed reads as nobody having changed anything.
   */
  vividName: text().notNull().default(DEFAULT_APPEARANCE.name),
  vividLook: jsonb().notNull().default(DEFAULT_APPEARANCE.look),
  updatedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})
