import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { RunId, WorkerKind } from '@vivid/contracts'
import { epoch, threadColumn } from '../database/owner.ts'
import { runs, threads } from '../threads/tables.ts'

/**
 * One row per helper Run (`ChildRun` in `@vivid/contracts`). The helper's Person is its parent
 * Run's `person_id`; `thread_id` is the parent's Thread, copied at reservation so a Thread's
 * helpers are numbered and listed without a join.
 *
 * `state` is the encoded `ChildRunState`; `turn` the encoded `ChildTurn`, what its current or last
 * round of work is (its brief, or the latest follow-up). `receipt` is the runtime's native address once its work
 * was admitted (`ChildReceipt`). The helper's answer and transcript stay in Pi, never here.
 *
 * `wake` is whether the Thread still has to hear how the helper's round ended: `held` while it works,
 * `due` once it ended and the parent has not heard, `sent` once the result delivery was admitted,
 * `none` when nobody needs to hear it (the parent read it by waiting or stopped it itself, or the
 * Thread was stopped).
 */
export const childRuns = pgTable(
  'vivid_child_runs',
  {
    id: text('id').$type<RunId>().primaryKey(),
    parentRunId: text('parent_run_id')
      .$type<RunId>()
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    parentToolCallId: text('parent_tool_call_id').notNull(),
    number: integer('number').notNull(),
    kind: text('kind').$type<WorkerKind>().notNull(),
    brief: text('brief').notNull(),
    budget: jsonb('budget').notNull(),
    requestedAt: epoch('requested_at').notNull(),
    state: jsonb('state').notNull(),
    turn: jsonb('turn').notNull().default({ _tag: 'Brief' }),
    receipt: jsonb('receipt'),
    wake: text('wake').$type<'held' | 'due' | 'sent' | 'none'>().notNull(),
  },
  (table) => [
    uniqueIndex('vivid_child_runs_call').on(table.parentRunId, table.parentToolCallId),
    uniqueIndex('vivid_child_runs_number').on(table.threadId, table.number),
    index('vivid_child_runs_wake').on(table.wake),
  ],
)
