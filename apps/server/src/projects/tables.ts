import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { personTable } from '../auth/tables.ts'
import { companyTable } from '../companies/tables.ts'

export const projectTable = pgTable(
  'project',
  {
    id: text().primaryKey(),
    companyId: text().notNull().references(() => companyTable.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    parentProjectId: text().references((): AnyPgColumn => projectTable.id, { onDelete: 'cascade' }),
    createdBy: text().notNull().references(() => personTable.id, { onDelete: 'restrict' }),
    createdAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('project_company_idx').on(table.companyId),
    index('project_parent_idx').on(table.parentProjectId),
    index('project_company_parent_idx').on(table.companyId, table.parentProjectId),
  ],
)
