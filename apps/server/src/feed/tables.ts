import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { FeedProvenance, type FeedCardState, type PostUrgency } from '@vivid/contracts'
import { epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/**
 * `Legacy` as the provenance column holds it: what every card posted before the column existed
 * reads as, and so its default. A column default is fixed when the table is declared, outside any
 * Effect, so this is encoded once at load; `Legacy` has no fields and so no way to fail, and were
 * the schema changed until it did, the schema's own error ends the load.
 */
const storedLegacy = Result.getOrThrow(
  Schema.encodeResult(FeedProvenance)(FeedProvenance.cases.Legacy.make({})),
)

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
    words: text('words'),
    display: text('display'),
    actions: jsonb('actions').notNull(),
    /**
     * Which Run posted the current content, what started the work and what it rests on
     * (`FeedProvenance`), replaced with the content on every post. Run and Watch ids are copied
     * in, not referenced, so the cause stays readable after the Watch is removed.
     */
    provenance: jsonb('provenance').notNull().default(storedLegacy),
    /** Where the current content came from, in Vivid's words (`FeedFrom`); null before 8 November 2026. */
    cameFrom: text('came_from'),
    /** How soon the current content may interrupt the Person (`PostUrgency`). */
    urgency: text('urgency').$type<PostUrgency>().notNull().default('ordinary'),
    /**
     * When the Person was told of the current content by a notice, or null while they have not
     * been: an ordinary card waits for the pacing pass (`pace.ts`), an urgent one is told at once.
     * A new post replaces the content, so it is news again and is cleared.
     */
    toldAt: epoch('told_at'),
    state: text('state').$type<FeedCardState>().notNull(),
    postedAt: epoch('posted_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('vivid_feed_cards_thread').on(table.threadId),
    index('vivid_feed_cards_person').on(table.personId, table.updatedAt),
    // The pacing pass reads only ordinary cards nobody was told of yet.
    index('vivid_feed_cards_untold')
      .on(table.personId, table.postedAt)
      .where(sql`${table.urgency} = 'ordinary' and ${table.toldAt} is null`),
  ],
)
