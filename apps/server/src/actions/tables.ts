import type { ActionOperationId, ApprovalId, RunId } from '@vivid/contracts'
import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { epoch, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/**
 * One row per outward operation Vivid sent: the external-effect receipt, not a copy of the
 * conversation. The id is the trusted operation key (`journal.ts`), so a retried call finds its row.
 *
 * `target` is the encoded `ActionTarget` sent and `fingerprint` the SHA-256 of what makes two sends
 * the same act, so an exact repeat in the Thread is found while an earlier one is unresolved.
 * `receipt` is null while the operation is being sent (`ActionPhase.Dispatching`) and is written
 * once. `reconciliation` is the encoded `ActionReconciliation`, `Unchecked` until someone checks.
 * `run_id` and `approval_id` are null when there was none: an Approval raised outside a Run, or an
 * action Vivid was allowed to do without asking. `retry_of` names the operation proven not applied
 * that this one sends again.
 */
export const actions = pgTable(
  'vivid_actions',
  {
    id: text('id').$type<ActionOperationId>().primaryKey(),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    runId: text('run_id').$type<RunId>(),
    approvalId: text('approval_id').$type<ApprovalId>(),
    target: jsonb('target').notNull(),
    fingerprint: text('fingerprint').notNull(),
    retryOf: text('retry_of').$type<ActionOperationId>(),
    claimedAt: epoch('claimed_at').notNull(),
    receipt: jsonb('receipt'),
    reconciliation: jsonb('reconciliation').notNull(),
  },
  (table) => [
    index('vivid_actions_fingerprint').on(table.threadId, table.fingerprint),
    index('vivid_actions_run').on(table.runId),
  ],
)
