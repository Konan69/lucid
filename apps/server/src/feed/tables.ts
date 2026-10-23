import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { FeedCardState } from '@vivid/contracts'
import { epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/**
 * The cards on a Person's Feed. One per background Thread (the unique index): Vivid posting again
 * from the same Thread replaces the words in place, so the card is the Thread's face, not a log.
 * The Feed belongs to the Person alone, whichever workspace they are in.
 */
export const feedCards = pgTable(
  'vivid_feed_cards',
  {
    id: text('id').primaryKey(),
    personId: personColumn().notNull(),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    words: text('words').notNull(),
    display: text('display'),
    actions: jsonb('actions').notNull(),
    state: text('state').$type<FeedCardState>().notNull(),
    postedAt: epoch('posted_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('vivid_feed_cards_thread').on(table.threadId),
    index('vivid_feed_cards_person').on(table.personId, table.updatedAt),
  ],
)
