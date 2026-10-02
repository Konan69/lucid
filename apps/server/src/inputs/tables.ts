import { boolean, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { personTable } from '../auth/tables.ts'
import { epoch, personColumn } from '../database/owner.ts'
import { Signal, encodeSignal } from '../approvals/signal.ts'

/**
 * One row per Input request: a question a Run could not safely answer alone.
 *
 * `person_id` is the Person asked. `status` is `waiting`, `answered` or `withdrawn`; `answered_by`
 * and `answer` are set by the answer, and `settled_at` by either ending. `options` is the encoded
 * list of `InputOption`.
 */
export const inputRequests = pgTable(
  'vivid_input_requests',
  {
    id: text('id').primaryKey(),
    // Keep the decision after Thread deletion so replay can record its terminal reason.
    threadId: text('thread_id').notNull(),
    runId: text('run_id'),
    personId: personColumn().notNull(),
    question: text('question').notNull(),
    options: jsonb('options').notNull(),
    allowsOwnAnswer: boolean('allows_own_answer').notNull(),
    status: text('status').notNull(),
    answeredBy: text('answered_by').references(() => personTable.id, { onDelete: 'set null' }),
    answer: text('answer'),
    settledAt: epoch('settled_at'),
    signal: jsonb('signal')
      .notNull()
      .default(encodeSignal(Signal.cases.None.make({}))),
    signalDueAt: epoch('signal_due_at').notNull().default(0),
    signalClaim: text('signal_claim'),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [
    index('vivid_input_requests_signal').on(table.signalDueAt),
    index('vivid_input_requests_thread').on(table.threadId, table.createdAt),
    index('vivid_input_requests_person').on(table.personId, table.status),
  ],
)
