import { and, eq, sql, type SQL } from 'drizzle-orm'
import * as Array from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  ApprovalId,
  ApprovalInvalidation,
  CompanyId,
  PersonId,
  ProposedAction,
  ThreadId,
  type ArtifactId,
  type ConnectionId,
  type RunId,
} from '@vivid/contracts'
import { decodeStored, encodeStored, type Database } from '../database/client.ts'
import { announceFeed } from '../feed/changes.ts'
import { announce, Topic } from '../live/changes.ts'
import { approvals } from './tables.ts'
import { Conclusion, encodeSignal, owed, wakesVivid } from './signal.ts'

type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0]

const Locked = Schema.Struct({
  id: ApprovalId,
  threadId: ThreadId,
  personId: PersonId,
  companyId: Schema.NullOr(CompanyId),
  action: ProposedAction,
})
const decodeLocked = decodeStored(Locked, 'Approval')
const encodeInvalidation = encodeStored(ApprovalInvalidation, 'Approval invalidation')

/**
 * Closes every Pending Approval that `bound` selects, because what it approved just changed.
 *
 * It runs inside the transaction of the write that made the change (a document revised, an
 * Integration signed in again, a Run stopped, a Membership removed), so the change and the closing
 * commit together: no moment exists where the change is visible and the old ask can still be
 * allowed. The rows are locked before they are written, and the claim in `store.ts` locks the same
 * row, so a click and a change racing on one Approval leave exactly one of them.
 *
 * Open screens learn of it through the asked-of Person's, the Thread's and the Company's topics,
 * announced on the same transaction. When the change leaves the work still wanted (`wakesVivid`),
 * the row also owes Vivid a signal, which the sweeper delivers like any other outcome.
 */
export const invalidatePending = Effect.fn('Approvals.invalidatePending')(function* (
  tx: Transaction,
  bound: SQL,
  reason: ApprovalInvalidation,
) {
  const values = yield* tx
    .select({
      id: approvals.id,
      threadId: approvals.threadId,
      personId: approvals.personId,
      companyId: approvals.companyId,
      action: approvals.action,
    })
    .from(approvals)
    .where(and(eq(approvals.status, 'pending'), bound))
    .for('update')
  if (values.length === 0) return []
  const rows = yield* Effect.forEach(values, decodeLocked)
  const now = yield* Clock.currentTimeMillis
  const invalidation = yield* encodeInvalidation(reason)
  yield* Effect.forEach(
    rows,
    Effect.fn('Approvals.invalidateOne')(function* (row) {
      const signal = wakesVivid(reason)
        ? {
            signal: yield* encodeSignal(
              owed(row.id, row.action.summary, Conclusion.cases.Invalidated.make({ reason }), null),
            ),
            signalDueAt: now,
          }
        : {}
      yield* tx
        .update(approvals)
        .set({ status: 'invalidated', finishedAt: now, invalidation, ...signal })
        .where(eq(approvals.id, row.id))
    }),
    { discard: true },
  )
  const threadIds = Array.dedupe(rows.map((row) => row.threadId))
  yield* announce(
    tx,
    rows.flatMap((row) => [
      Topic.person(row.personId),
      Topic.thread(row.threadId),
      ...Option.toArray(Option.map(Option.fromNullOr(row.companyId), Topic.company)),
    ]),
  )
  yield* announceFeed(tx, threadIds)
  return rows.map((row) => row.id)
})

/** Approvals whose action runs through this Integration. */
export const usingConnection = (id: ConnectionId) =>
  sql`${approvals.action}->'target'->>'connectionId' = ${id}`

/** Approvals whose action carries the text of this Thread document. */
export const sendingDocument = (id: ArtifactId) =>
  sql`${approvals.binding}->'preconditions' @> ${JSON.stringify([{ _tag: 'ArtifactVersion', artifactId: id }])}::jsonb`

/** Approvals raised by this Run. */
export const askedBy = (id: RunId) => eq(approvals.runId, id)

/** Approvals asked of this Person in this Company. */
export const askedOfMember = (personId: PersonId, companyId: CompanyId) =>
  sql`${approvals.personId} = ${personId} and ${approvals.companyId} = ${companyId}`
