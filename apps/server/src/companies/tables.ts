import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { DEFAULT_APPEARANCE } from '@vivid/contracts'
import { personTable } from '../auth/tables.ts'

const id = () => text().primaryKey()
const createdAt = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow()

export const companyTable = pgTable(
  'company',
  {
    id: id(),
    name: text().notNull(),
    slug: text().notNull(),
    logo: text(),
    metadata: jsonb(),
    /**
     * What this Company calls Vivid and how its face is drawn for everyone in it: an `Appearance`
     * (`packages/contracts/src/appearance.ts`). Better Auth creates Company rows and does not know
     * these columns, so the database defaults are what a new Company starts with.
     */
    vividName: text().notNull().default(DEFAULT_APPEARANCE.name),
    vividLook: jsonb().notNull().default(DEFAULT_APPEARANCE.look),
    vividOutline: text().notNull().default(DEFAULT_APPEARANCE.outline),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('company_slug_idx').on(table.slug)],
)

export const membershipTable = pgTable(
  'membership',
  {
    id: id(),
    companyId: text()
      .notNull()
      .references(() => companyTable.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => personTable.id, { onDelete: 'cascade' }),
    role: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('membership_company_user_idx').on(table.companyId, table.userId),
    index('membership_user_idx').on(table.userId),
    index('membership_company_idx').on(table.companyId),
  ],
)

export const invitationTable = pgTable(
  'invitation',
  {
    id: id(),
    companyId: text()
      .notNull()
      .references(() => companyTable.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text().notNull(),
    status: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    inviterId: text()
      .notNull()
      .references(() => personTable.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('invitation_company_idx').on(table.companyId),
    index('invitation_email_idx').on(table.email),
    // One open offer per address in a Company. Inviting again replaces the earlier offer; this is
    // what makes that true when two admins invite the same address at the same moment.
    uniqueIndex('invitation_pending_idx')
      .on(table.companyId, table.email)
      .where(sql`${table.status} = 'pending'`),
  ],
)
