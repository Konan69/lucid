import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { TodoId } from '@vivid/contracts'
import { companyColumn, epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/** One thing on one Person's to-do list. JSON state owns when it was done or why it was dropped. */
export const todos = pgTable(
  'vivid_todos',
  {
    id: text('id').$type<TodoId>().primaryKey(),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    what: text('what').notNull(),
    due: epoch('due'),
    state: jsonb('state').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [index('vivid_todos_owner').on(table.personId, table.companyId)],
)
