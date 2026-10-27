import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** One current revision per address. A retraction removes the body and retains its revision. */
export const notes = sqliteTable(
  'memory_notes',
  {
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
  (table) => [primaryKey({ columns: [table.layer, table.file] })],
)
