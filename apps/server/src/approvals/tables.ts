import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { threads } from '../threads/tables.ts'
import { personTable } from '../auth/tables.ts'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'
import { Signal, encodeSignal } from './signal.ts'

/**
 * One row per Approval: the exact action Vivid proposed, and what became of it.
 *
 * `action` is the encoded `ProposedAction` and `digest` its SHA-256; a decision must quote the
 * digest, so a card drawn from an older proposal cannot authorize a newer one. `person_id` is the
 * Person whose Run continues; any Person deciding must be able to see the Thread.
 *
 * `status` moves `pending` → `executing` → `succeeded` | `failed` | `unknown`, or `pending` →
 * `denied` | `expired` | `withdrawn`. The move out of `pending` is one conditional `UPDATE`, which
 * is what makes a second click, a second tab and a retried request harmless. `decided_by` and
 * `decided_at` are set once it leaves `pending` by a Person's decision; `finished_at` and `outcome`
 * (the result, the failure reason or the withdrawal reason) once it settles.
 */
export const approvals = pgTable(
  'vivid_approvals',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    action: jsonb('action').notNull(),
    digest: text('digest').notNull(),
    status: text('status').notNull(),
    expiresAt: epoch('expires_at').notNull(),
    decidedBy: text('decided_by').references(() => personTable.id, { onDelete: 'set null' }),
    decidedAt: epoch('decided_at'),
    finishedAt: epoch('finished_at'),
    outcome: text('outcome'),
    signal: jsonb('signal')
      .notNull()
      .default(encodeSignal(Signal.cases.None.make({}))),
    signalDueAt: epoch('signal_due_at').notNull().default(0),
    signalClaim: text('signal_claim'),
    createdAt: epoch('created_at').notNull(),
  },
  (table) => [
    index('vivid_approvals_signal').on(table.signalDueAt),
    index('vivid_approvals_thread').on(table.threadId, table.createdAt),
    index('vivid_approvals_person').on(table.personId, table.status),
    index('vivid_approvals_pending').on(table.status, table.expiresAt),
  ],
)
