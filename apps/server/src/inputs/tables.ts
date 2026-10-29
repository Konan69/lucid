import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { threads } from '../threads/tables.ts'
import { personTable } from '../auth/tables.ts'
import { epoch, personColumn } from '../database/owner.ts'
import { storedNone } from '../approvals/signal.ts'

/**
 * One row per Input request: questions a Run could not safely answer alone.
 *
 * `person_id` is the Person asked. `status` is `waiting`, `answered` or `withdrawn`; `answered_by`
 * and `answers` are set by the answer, and `settled_at` by either ending. `questions` and
 * `answers` are encoded non-empty lists in the same order; unanswered rows have null answers.
 */
export const inputRequests = pgTable(
  'vivid_input_requests',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    personId: personColumn().notNull(),
    questions: jsonb('questions').notNull(),
    status: text('status').notNull(),
    answeredBy: text('answered_by').references(() => personTable.id, { onDelete: 'set null' }),
    answers: jsonb('answers'),
    settledAt: epoch('settled_at'),
    signal: jsonb('signal').notNull().default(storedNone),
    signalDueAt: epoch('signal_due_at').notNull().default(0),
    signalClaim: text('signal_claim'),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [
    index('vivid_input_requests_signal')
      .on(table.signalDueAt)
      .where(sql`${table.signal}->>'_tag' = 'Owed'`),
    index('vivid_input_requests_thread').on(table.threadId, table.createdAt),
    index('vivid_input_requests_person').on(table.personId, table.status),
  ],
)

/**
 * One row per handoff: a step on the Computer only the Person asked can do.
 *
 * It holds no value the Person typed, in any form: not encrypted, not hashed, not its length.
 * `request` is the public definition (form fields or the live-screen kind) and `page` its public
 * address; `binding` is the browser's own window, tab and address the fields were found on, which
 * stays on the server. `status` is `waiting`, `applying`, `ready`, `completed` or `withdrawn`;
 * `receipts` holds one result per form field once a fill was typed. An open handoff (waiting,
 * applying, ready) keeps Vivid off the Person's Computer, so one Person has at most one.
 */
export const handoffs = pgTable(
  'vivid_handoffs',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    personId: personColumn().notNull(),
    summary: text('summary').notNull(),
    request: jsonb('request').notNull(),
    page: jsonb('page').notNull(),
    binding: jsonb('binding').notNull(),
    status: text('status').notNull(),
    receipts: jsonb('receipts'),
    completedBy: text('completed_by').references(() => personTable.id, { onDelete: 'set null' }),
    settledAt: epoch('settled_at'),
    signal: jsonb('signal').notNull().default(storedNone),
    signalDueAt: epoch('signal_due_at').notNull().default(0),
    signalClaim: text('signal_claim'),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [
    index('vivid_handoffs_signal')
      .on(table.signalDueAt)
      .where(sql`${table.signal}->>'_tag' = 'Owed'`),
    index('vivid_handoffs_thread').on(table.threadId, table.createdAt),
    uniqueIndex('vivid_handoffs_open')
      .on(table.personId)
      .where(sql`${table.status} in ('waiting', 'applying', 'ready')`),
  ],
)
