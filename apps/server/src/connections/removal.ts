import { observeFailures } from '../observability/failure.ts'
import { Message } from '../observability/messages.ts'
import { and, eq, ne, sql } from 'drizzle-orm'
import { Clock, Effect, Option, Result } from 'effect'
import { ApprovalInvalidation, Conflict } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { executorFailure, ConnectionReclamationBlocked } from './errors.ts'
import { callerOf, operationsOf, watchPrincipal } from './members.ts'
import { ExecutorAdoption } from './adopter.ts'
import {
  ExecutorAppId,
  ExecutorAccountId,
  ExecutorReferences,
  ExecutorAppOwnership,
  retirementOf,
  executorReconnectMessage,
  type ExecutorActiveReferences,
} from './executor.ts'
import { decodeRow, decodeStoredRow, encodeReferences, type ConnectionRecord } from './records.ts'
import { disconnectWatches, unsubscribeWatches } from '../watches/apps.ts'
import { connections } from './tables.ts'
import { invalidatePending, usingConnection } from '../approvals/stale.ts'

/** Concurrent removals cannot both defer reclamation to a row being removed. */
const connectionLock = sql`SELECT pg_advisory_xact_lock(hashtextextended('vivid-executor-migration', 0))`

interface ConnectionResources {
  readonly apps: ReadonlyArray<typeof ExecutorAppId.Type>
  readonly account: Option.Option<typeof ExecutorAccountId.Type>
}

/** Proven copies retain their source identity too: another row's unresolved selection may
 * still refer to that original app or account while this row uses the deployed copy.
 */
function activeResources(references: ExecutorActiveReferences): ConnectionResources {
  const retired = retirementOf(references)
  return { apps: [retired.original, ...retired.copies], account: retired.account }
}

/** Resource identities are compared across every Person and Company, including unresolved rows. */
function storedResources(
  references: typeof import('./records.ts').storedRowSchema.Type.references,
): ConnectionResources {
  return ExecutorReferences.match(references, {
    ReconnectRequired: ({ retired }) => ({
      apps: [retired.original, ...retired.copies],
      account: retired.account,
    }),
    Authorized: activeResources,
    Public: activeResources,
    EnteringKey: activeResources,
    SigningIn: activeResources,
    OAuthSigningIn: activeResources,
    GoogleSigningIn: activeResources,
  })
}

/** Decode each holder once and aggregate the identities whose authority must remain intact. */
const heldResources = Effect.fn('Connections.heldResources')(function* (
  rows: ReadonlyArray<typeof connections.$inferSelect>,
) {
  const held = yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (row) {
      const decoded = yield* decodeStoredRow(row).pipe(observeFailures('rpc'), Effect.result)
      if (Result.isFailure(decoded)) {
        yield* Effect.logError('Integration reclamation blocked by invalid row', {
          connectionId: row.id,
        })
        return yield* new ConnectionReclamationBlocked({ recordId: row.id })
      }
      return storedResources(decoded.success.references)
    }),
  )
  return {
    retainedApps: held.flatMap((value) => value.apps),
    retainedAccounts: held.flatMap((value) => Option.toArray(value.account)),
  }
})

/** The row lock excludes late Watch creation; subscription keys must survive the cascade. */
const removeRow = Effect.fn('Connections.removeRow')(function* (
  tx: Parameters<typeof disconnectWatches>[0],
  row: ConnectionRecord,
) {
  const current = (yield* tx
    .select()
    .from(connections)
    .where(eq(connections.id, row.id))
    .for('update'))[0]
  if (current === undefined || current.updatedAt !== row.updatedAt)
    return yield* new Conflict({ message: 'This integration changed before removal; reload it.' })
  const subscriptions = yield* disconnectWatches(tx, row.id)
  yield* tx.delete(connections).where(eq(connections.id, row.id))
  yield* invalidatePending(
    tx,
    usingConnection(row.id),
    ApprovalInvalidation.cases.ConnectionChanged.make({ connectionId: row.id, generation: null }),
  )
  return subscriptions
})

/** Pending Dedicated requests resolve and save their account before any revocation. The fast
 * path is limited to references that already carry the account or cannot have one.
 * Retired copy discovery is committed before revocation, so a crash after credential deletion
 * cannot lose the copy IDs needed by a retry. Reclamation and row deletion then share the same
 * reclamation lock; concurrent removals cannot both defer cleanup to a row being removed.
 */
const removeResources = Effect.fn('Connections.removeResources')(function* (row: ConnectionRecord) {
  const database = yield* Database
  // A member's app and personal account are removed with that member's own key: the owner may
  // delete a member's app but not the account the member connected (`members.ts`). Its Watches
  // were subscribed as that member, so they are unsubscribed as it too.
  const caller = yield* callerOf({
    executorPrincipal: watchPrincipal(row.executorPrincipal),
    personId: row.personId,
  })
  const executor = yield* operationsOf(row)
  if (
    !ExecutorReferences.guards.ReconnectRequired(row.references) &&
    (ExecutorAppOwnership.guards.Adopted(row.references.appOwnership) ||
      (ExecutorReferences.isAnyOf(['Public', 'Authorized'])(row.references) &&
        ExecutorAppOwnership.guards.Dedicated(row.references.appOwnership)))
  ) {
    const ownership = row.references.appOwnership
    if (ExecutorAppOwnership.guards.Adopted(ownership))
      yield* (yield* ExecutorAdoption).remove(row.references).pipe(Effect.mapError(executorFailure))
    else yield* executor.remove(row.references).pipe(Effect.mapError(executorFailure))
    if (ExecutorAppOwnership.guards.Adopted(ownership))
      yield* (yield* ExecutorAdoption)
        .removeGroup(ownership.group)
        .pipe(Effect.mapError(executorFailure))
    const stopped = yield* database.transaction((tx) => removeRow(tx, row))
    yield* unsubscribeWatches(caller, stopped)
    return yield* Effect.void
  }
  let references = row.references
  if (!ExecutorReferences.guards.ReconnectRequired(references))
    references = ExecutorReferences.cases.ReconnectRequired.make({
      service: references.service,
      owner: references.owner,
      retired: retirementOf(references),
      reason: 'RemovalPending',
    })
  let revision = row.updatedAt
  if (ExecutorReferences.guards.ReconnectRequired(references)) {
    const retired = yield* executor
      .prepareRetirement(references.retired)
      .pipe(Effect.mapError(executorFailure))
    references = ExecutorReferences.cases.ReconnectRequired.make({ ...references, retired })
    revision = Math.max(yield* Clock.currentTimeMillis, row.updatedAt + 1)
    const saved = yield* database.run(
      database
        .update(connections)
        .set({
          references: yield* encodeReferences(references),
          executorApp: null,
          status: 'failed',
          reason: executorReconnectMessage,
          // Its pending Approvals close when the row is deleted below; should deletion not follow,
          // the moved generation still refuses them at the claim.
          authorizationGeneration: sql`${connections.authorizationGeneration} + 1`,
          updatedAt: revision,
        })
        .where(and(eq(connections.id, row.id), eq(connections.updatedAt, row.updatedAt)))
        .returning({ id: connections.id }),
    )
    if (saved.length === 0)
      return yield* new Conflict({
        message: 'This integration changed before removal; reload it.',
      })
  }
  const stopped = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(connectionLock)
      const current = (yield* tx
        .select()
        .from(connections)
        .where(eq(connections.id, row.id))
        .for('update'))[0]
      if (current === undefined) return []
      if (
        current.updatedAt !== revision ||
        current.personId !== row.personId ||
        current.companyId !== row.companyId
      )
        return yield* new Conflict({
          message: 'This integration changed before removal; reload it.',
        })
      const target = yield* decodeRow(current)
      if (ExecutorReferences.guards.ReconnectRequired(target.references)) {
        const others = yield* tx.select().from(connections).where(ne(connections.id, row.id))
        const claims = yield* heldResources(others)
        yield* executor
          .retire({ resources: target.references.retired, ...claims })
          .pipe(Effect.mapError(executorFailure))
      } else {
        return yield* new Conflict({
          message: 'This integration changed before removal; reload it.',
        })
      }
      return yield* removeRow(tx, { ...target, updatedAt: revision })
    }),
  )
  yield* unsubscribeWatches(caller, stopped)
})

/** Serialize removals of the same Connection before deleting foreign resources. A stale
 * removal must reload rather than delete resources whose references changed meanwhile. */
export const removeConnection = Effect.fn('Connections.remove')(function* (row: ConnectionRecord) {
  yield* Effect.annotateCurrentSpan({
    'vivid.connection.id': row.id,
    'vivid.executor.principal': row.executorPrincipal,
  })
  const database = yield* Database
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof removeResources>>>()
  const removed = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`vivid-adopt:${row.id}`}, 0))`,
      )
      const [current] = yield* tx
        .select({ updatedAt: connections.updatedAt })
        .from(connections)
        .where(eq(connections.id, row.id))
      if (current === undefined || current.updatedAt !== row.updatedAt)
        return yield* new Conflict({
          message: 'This integration changed before removal; reload it.',
        })
      // The lock transaction must not absorb retirement's independently committed recovery writes.
      // Effect.setContext replaces the transaction context with the caller's captured context.
      return yield* removeResources(row).pipe(Effect.setContext(context))
    }),
  )
  yield* Effect.logInfo(Message.connectionRemoved).pipe(
    Effect.annotateLogs({
      'vivid.connection.id': row.id,
      'vivid.executor.principal': row.executorPrincipal,
    }),
  )
  return removed
})
