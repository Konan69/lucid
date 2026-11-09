import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { DEFAULT_APPEARANCE, LocationSharing } from '@vivid/contracts'
import { personTable } from '../auth/tables.ts'

export const settingsTable = pgTable('settings', {
  personId: text()
    .primaryKey()
    .references(() => personTable.id, { onDelete: 'cascade' }),
  theme: text().notNull().default('system'),
  /** An IANA zone name. Local dates and times are resolved in it. */
  timezone: text().notNull().default('UTC'),
  /** Whether this Person wants to be told when something needs them or finishes. */
  notify: boolean().notNull().default(true),
  /**
   * Whether the Computer's browser sends its traffic out through this Person's own computer
   * (`computers/egress/`). Off until the Person turns it on. Issue 61 removes the choice.
   */
  egress: boolean().notNull().default(false),
  /**
   * Whether this Person shares where they are, and their latest reading: an encoded
   * `LocationSharing` (`packages/contracts/src/location.ts`). One column holds both, so turning
   * sharing off and forgetting the reading are one write, and a reading can never outlive it.
   */
  location: jsonb().notNull().default(LocationSharing.cases.Off.make({})),
  /**
   * What this Person calls Vivid in their personal space, and how its face is drawn there: an
   * `Appearance` (`packages/contracts/src/appearance.ts`). The defaults are Vivid as it ships, so
   * a row written before these columns existed reads as nobody having changed anything.
   */
  vividName: text().notNull().default(DEFAULT_APPEARANCE.name),
  vividLook: jsonb().notNull().default(DEFAULT_APPEARANCE.look),
  vividOutline: text().notNull().default(DEFAULT_APPEARANCE.outline),
  updatedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})
