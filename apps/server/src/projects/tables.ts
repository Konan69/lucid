import { integer, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { personTable } from '../auth/tables.ts'
import { companyTable } from '../companies/tables.ts'

export const projectTable = pgTable(
  'project',
  {
    id: text().primaryKey(),
    /** Null for a Project in its creator's personal space. */
    companyId: text().references(() => companyTable.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    parentProjectId: text().references((): AnyPgColumn => projectTable.id, { onDelete: 'cascade' }),
    createdBy: text()
      .notNull()
      .references(() => personTable.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /**
     * The encoded `ProjectWork`. Every Project made before work existed only grouped Threads, so
     * it is `Unspecified`: no objective is invented for it.
     */
    work: jsonb().notNull().default({ _tag: 'Unspecified' }),
    /** `ProjectRevision`: how many changes the work has had. */
    revision: integer().notNull().default(0),
    /** When the work last changed; absent until it first does. */
    workedAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('project_company_idx').on(table.companyId),
    index('project_parent_idx').on(table.parentProjectId),
    index('project_company_parent_idx').on(table.companyId, table.parentProjectId),
    index('project_creator_idx').on(table.createdBy),
  ],
)
