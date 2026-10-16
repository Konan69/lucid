import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  pgEnum,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type { LibraryFolderId, RunFailure, RunId } from '@vivid/contracts'
import { companyColumn, epoch, personColumn, threadColumn } from '../database/owner.ts'
import type { ThreadPlace } from './place.ts'
import { TitleSource } from './title.ts'
import { projectTable } from '../projects/tables.ts'

/** The existing migration backfilled legacy titles as Person; every new writer must state provenance explicitly. */
export const titleSource = pgEnum('vivid_thread_title_source', TitleSource.literals)

/**
 * One row per Thread. The table keeps its first name because Flue's history is keyed by the same
 * id and renaming a table is not worth a rewrite of every installation's data.
 *
 * `person_id` is the creator, on whose behalf Vivid acts in a private Thread. `audience` widens who
 * may read and send: `private` (the creator), `people` (the creator and the rows in
 * `vivid_thread_participants`), `company` (every Member of `company_id`). A personal-space Thread
 * has no Company and is always `private`.
 */
export const threads = pgTable(
  'vivid_conversations',
  {
    id: threadColumn('id').primaryKey(),
    title: text('title').notNull(),
    titleSource: titleSource('title_source').notNull(),
    preview: text('preview').notNull().default(''),
    updatedAt: epoch('updated_at').notNull(),
    archived: boolean('archived').notNull().default(false),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    audience: text('audience').notNull().default('private'),
    projectId: text('project_id').references(() => projectTable.id, { onDelete: 'set null' }),
    // Where the Thread lives for its Person (`place.ts`): every Thread before Watches is a Conversation.
    place: text('place').$type<ThreadPlace>().notNull().default('Conversation'),
  },
  (table) => [
    index('vivid_conversations_updated_at').on(table.updatedAt),
    index('vivid_conversations_person').on(table.personId, table.updatedAt),
    index('vivid_conversations_company').on(table.companyId, table.updatedAt),
  ],
)

/**
 * First arrival belongs to a Person across all workspaces. Keep the original Thread id even
 * after its deletion: deleting a conversation must never restart the introduction. The id is
 * deliberately not a cascading Thread foreign key; Person deletion removes the receipt.
 */
export const firstThreads = pgTable('vivid_first_threads', {
  personId: personColumn().primaryKey(),
  threadId: threadColumn('thread_id').notNull(),
})

/** The Members a `people` Thread is shared with, beside its creator. */
export const threadParticipants = pgTable(
  'vivid_thread_participants',
  {
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    personId: personColumn().notNull(),
    addedAt: epoch('added_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.personId] }),
    index('vivid_thread_participants_person').on(table.personId),
  ],
)

/** When each Person last saw each Thread. Anything that happened later is unread for them. */
export const threadReads = pgTable(
  'vivid_thread_reads',
  {
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    personId: personColumn().notNull(),
    readAt: epoch('read_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.personId] })],
)

/**
 * One row per Run. The id is Flue's submission id, so a Message in Flue's history joins to the
 * Run that carried it and through it to the Person Vivid acted for.
 *
 * `origin` is the encoded `RunOrigin` without its Person, who is `person_id`; `state` is one of
 * `working`, `completed`, `failed`, `stopped`, `unknown`, and `finished_at` is set for every state
 * but `working`.
 */
export const runs = pgTable(
  'vivid_runs',
  {
    id: text('id').$type<RunId>().primaryKey(),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    personId: personColumn().notNull(),
    turn: integer('turn').notNull(),
    libraryFolder: text('library_folder').$type<LibraryFolderId>(),
    origin: jsonb('origin').notNull(),
    state: text('state').notNull(),
    startedAt: epoch('started_at').notNull(),
    /** Flue's receipt has arrived; reservations alone never count as answering a Person. */
    admittedAt: epoch('admitted_at'),
    /** The original receipt survives keyed retries without depending on runtime availability. */
    receipt: jsonb('receipt'),
    finishedAt: epoch('finished_at'),
    /** Only failed Runs have a reason; pre-classification failures remain null in storage. */
    failureReason: text('failure_reason').$type<RunFailure>(),
  },
  (table) => [
    index('vivid_runs_thread').on(table.threadId, table.startedAt),
    index('vivid_runs_state').on(table.state),
    uniqueIndex('vivid_runs_thread_turn').on(table.threadId, table.turn),
  ],
)
