import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import type { MemoryForgetId } from '@vivid/contracts'
import { epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/**
 * One forget of one Person's memory, from the request or plan to its receipt. `thread_id` is the
 * Thread Vivid plans and carries it out in: the conversation it was asked in, or the background
 * Thread a Settings press opened. `origin` says which, because only a Settings forget is owed a
 * receipt when its Run ends without one. `state` is the encoded `ForgetState` (`store.ts`).
 * Personal memory follows the Person across workspaces, so the row has no Company.
 */
export const memoryForgets = pgTable(
  'vivid_memory_forgets',
  {
    id: text('id').$type<MemoryForgetId>().primaryKey(),
    personId: personColumn().notNull(),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    origin: text('origin').$type<'Settings' | 'Conversation'>().notNull(),
    state: jsonb('state').notNull(),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [
    index('vivid_memory_forgets_thread').on(table.personId, table.threadId, table.createdAt),
  ],
)
