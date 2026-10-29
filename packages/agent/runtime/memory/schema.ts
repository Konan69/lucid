import { integer, unique, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** One current revision per address. A retraction removes the body and retains its revision. */
export const entries = sqliteTable(
  'memory_entries',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    layer: text().notNull(),
    file: text().notNull(),
    kind: text().notNull(),
    description: text().notNull(),
    body: text(),
    basis: text().notNull(),
    revision: integer().notNull(),
    updatedAt: integer('updated_at').notNull(),
    authority: text().notNull(),
  },
  (table) => [unique('memory_entries_address').on(table.layer, table.file)],
)
