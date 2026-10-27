import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  pgSchema,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The conversation runtime's tables: every Person's Pi Durable store, side by side in one table
 * set, told apart by `store_id`. `drizzle.config.ts` in this package generates `./drizzle` from
 * this file, and root `pnpm db:migrate` applies it after the server's product tables; the runtime
 * never migrates when it starts.
 *
 * The record tables are a port of Pi Durable 1.2.0's SQLite schema
 * (its reference schema, `INITIAL_SCHEMA`) by way of the earlier one-schema-per-store
 * PostgreSQL port, with `store_id` leading every primary key and index, so one store's rows never
 * meet another's and a scan of one store reads only its own index range. Record bodies stay the
 * JSON text Pi wrote (`IS JSON` checks them; nothing rewrites them as `jsonb`), and identities
 * are 64-bit. Every table lives in the `runtime` schema, apart from the server's.
 *
 * The SQLite schema compares indexed text bytewise. PostgreSQL's deterministic default collation
 * gives the same answer for the only comparisons these columns serve (equality), so the columns
 * keep the database's collation.
 */
export const runtime = pgSchema('runtime')

/**
 * One row per store: an opaque identity and the Person whose conversations it holds. The store
 * id, not the Person id, keys every record, so a store can later move (to the Person's Computer)
 * or change owner without its rows being rewritten.
 */
export const stores = runtime.table('stores', {
  id: uuid('id').primaryKey(),
  personId: text('person_id').notNull().unique(),
})

/**
 * The runtime's authority: one row, advanced each time a process takes over. Every write reads
 * it `FOR SHARE` in its own transaction and refuses when the generation is not its own; a
 * takeover updates it, which waits for those transactions and then outdates them.
 */
export const owner = runtime.table(
  'owner',
  {
    id: smallint('id').primaryKey(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    /** Which process took this generation: its host, process id and a random part. */
    process: text('process').notNull(),
  },
  (table) => [check('owner_singleton', sql`${table.id} = 1`)],
)

/**
 * Per store, Pi's allocator: the next record id to hand out (ids up to it are reserved) and the
 * next commit sequence. Pi's SQLite storage keeps one such row per database.
 */
export const metadata = runtime.table('metadata', {
  storeId: uuid('store_id')
    .primaryKey()
    .references(() => stores.id),
  nextId: bigint('next_id', { mode: 'number' }).notNull(),
  nextSeq: bigint('next_seq', { mode: 'number' }).notNull(),
})

/** Which record kind owns each id of a store: Pi's ids are one namespace across kinds. */
export const recordIds = runtime.table(
  'record_ids',
  {
    storeId: uuid('store_id').notNull(),
    id: bigint('id', { mode: 'number' }).notNull(),
    recordType: text('record_type').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.id] }),
    check(
      'record_ids_type',
      sql`${table.recordType} IN ('conversation', 'entry', 'task', 'submission', 'document')`,
    ),
  ],
)

export const conversations = runtime.table(
  'conversations',
  {
    storeId: uuid('store_id').notNull(),
    id: bigint('id', { mode: 'number' }).notNull(),
    ownerConversationId: bigint('owner_conversation_id', { mode: 'number' }),
    ownerTaskId: bigint('owner_task_id', { mode: 'number' }),
    record: text('record').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.id] }),
    check('conversations_record', sql`${table.record} IS JSON`),
    index('conversations_by_owner_conversation').on(
      table.storeId,
      table.ownerConversationId,
      table.id,
    ),
    index('conversations_by_owner_task').on(table.storeId, table.ownerTaskId, table.id),
  ],
)

export const entries = runtime.table(
  'entries',
  {
    storeId: uuid('store_id').notNull(),
    id: bigint('id', { mode: 'number' }).notNull(),
    conversationId: bigint('conversation_id', { mode: 'number' }).notNull(),
    head: bigint('head', { mode: 'number' }),
    commitSeq: bigint('commit_seq', { mode: 'number' }).notNull(),
    record: text('record').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.id] }),
    check('entries_record', sql`${table.record} IS JSON`),
    index('entries_by_conversation').on(
      table.storeId,
      table.conversationId,
      table.id.desc().nullsFirst(),
    ),
    index('entry_heads_by_conversation')
      .on(table.storeId, table.conversationId, table.id.desc().nullsFirst())
      .where(sql`${table.head} IS NOT NULL`),
  ],
)

export const tasks = runtime.table(
  'tasks',
  {
    storeId: uuid('store_id').notNull(),
    id: bigint('id', { mode: 'number' }).notNull(),
    conversationId: bigint('conversation_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    abortRequested: integer('abort_requested').notNull(),
    background: integer('background').notNull(),
    record: text('record').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.id] }),
    check(
      'tasks_status',
      sql`${table.status} IN ('pending', 'running', 'waiting', 'completing', 'terminal')`,
    ),
    check('tasks_abort_requested', sql`${table.abortRequested} IN (0, 1)`),
    check('tasks_background', sql`${table.background} IN (0, 1)`),
    check('tasks_record', sql`${table.record} IS JSON`),
    index('tasks_by_status').on(table.storeId, table.status, table.id),
    index('tasks_by_conversation').on(table.storeId, table.conversationId, table.id),
    index('tasks_by_kind').on(table.storeId, table.kind, table.id),
    index('tasks_by_abort_requested').on(table.storeId, table.abortRequested, table.id),
    index('tasks_by_background').on(table.storeId, table.background, table.id),
    // Startup asks which stores have unfinished work, across every store (`stores.ts`).
    index('tasks_live')
      .on(table.storeId)
      .where(sql`${table.status} <> 'terminal'`),
  ],
)

export const submissions = runtime.table(
  'submissions',
  {
    storeId: uuid('store_id').notNull(),
    id: bigint('id', { mode: 'number' }).notNull(),
    conversationId: bigint('conversation_id', { mode: 'number' }).notNull(),
    requestId: text('request_id'),
    status: text('status').notNull(),
    record: text('record').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.id] }),
    check('submissions_status', sql`${table.status} IN ('queued', 'placed', 'done', 'unanswered')`),
    check('submissions_record', sql`${table.record} IS JSON`),
    index('submissions_by_request').on(table.storeId, table.conversationId, table.requestId),
    index('submissions_by_conversation').on(table.storeId, table.conversationId, table.id),
    index('submissions_by_status').on(table.storeId, table.status, table.id),
    // Startup asks which stores have deliveries waiting, across every store (`stores.ts`).
    index('submissions_queued')
      .on(table.storeId)
      .where(sql`${table.status} = 'queued'`),
  ],
)

export const documents = runtime.table(
  'documents',
  {
    storeId: uuid('store_id').notNull(),
    id: bigint('id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    family: integer('family').notNull(),
    keyValue: text('key_value').notNull(),
    scopeKind: text('scope_kind').notNull(),
    ownerId: bigint('owner_id', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    retiredAt: bigint('retired_at', { mode: 'number' }),
    record: text('record').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.id] }),
    check('documents_family', sql`${table.family} IN (0, 1)`),
    check('documents_scope_kind', sql`${table.scopeKind} IN ('session', 'conversation', 'task')`),
    check('documents_record', sql`${table.record} IS JSON`),
    index('documents_by_address').on(
      table.storeId,
      table.kind,
      table.scopeKind,
      table.ownerId,
      table.family,
      table.keyValue,
      table.createdAt.desc().nullsFirst(),
      table.retiredAt,
    ),
    index('documents_by_scope').on(table.storeId, table.scopeKind, table.ownerId, table.id),
    index('documents_by_scope_kind').on(
      table.storeId,
      table.scopeKind,
      table.ownerId,
      table.kind,
      table.id,
    ),
  ],
)

export const documentRevisions = runtime.table(
  'document_revisions',
  {
    storeId: uuid('store_id').notNull(),
    documentId: bigint('document_id', { mode: 'number' }).notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    content: text('content').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.documentId, table.seq] }),
    check('document_revisions_kind', sql`${table.kind} IN ('base', 'delta')`),
    check('document_revisions_content', sql`${table.content} IS JSON`),
    index('document_revisions_by_kind').on(
      table.storeId,
      table.documentId,
      table.kind,
      table.seq.desc().nullsFirst(),
    ),
  ],
)
