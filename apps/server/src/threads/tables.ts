import { bigint, boolean, index, pgTable, text } from 'drizzle-orm/pg-core'

const epoch = (name: string) => bigint(name, { mode: 'number' })

export const threads = pgTable(
  'vivid_conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    preview: text('preview').notNull().default(''),
    updatedAt: epoch('updated_at').notNull(),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [index('vivid_conversations_updated_at').on(table.updatedAt)],
)
