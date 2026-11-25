import { and, eq, ne, sql } from 'drizzle-orm'
import {
  Cause,
  Clock,
  Effect,
  Layer,
  Duration,
  Schedule,
  Match,
  Option,
  Result,
  Schema,
} from 'effect'
import { Conflict } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { executorFailure, ConnectionReclamationBlocked } from './errors.ts'
import {
  Executor,
  ExecutorAppId,
  ExecutorAccountId,
  ExecutorReferences,
  ExecutorAppOwnership,
  LegacyExecutorReferences,
  migrationPending,
  reconnectRequired,
  retirementOf,
  executorReconnectMessage,
  type ExecutorFailure,
  type ExecutorActiveReferences,
} from './executor.ts'
import {
  claimedApp,
  decodeRow,
  decodeStoredRow,
  encodeReferences,
  type ConnectionRecord,
  storedRowSchema,
} from './records.ts'
import { disconnectWatches, unsubscribeWatches } from '../watches/apps.ts'
import { connections } from './tables.ts'

const isLegacy = Schema.is(LegacyExecutorReferences)

/** Reconciliation and resource reclamation share one cross-process transaction lock. Normal
 * new Connections allocate fresh account/app identities and cannot claim legacy resources.
 */
const connectionLock = sql`SELECT pg_advisory_xact_lock(hashtextextended('vivid-executor-migration', 0))`

/** Expected upstream availability failures preserve the original selection for another pass. */
function refused(legacy: typeof LegacyExecutorReferences.Type, failure: ExecutorFailure) {
  return Match.value(failure).pipe(
    Match.tag(
      'ExecutorTransportFailure',
      'ExecutorExecutionUncertain',
      'ExecutorConflict',
      'ServiceUnavailable',
      () => migrationPending(legacy, 'Unavailable'),
    ),
    Match.tag('ExecutorNotReady', () => migrationPending(legacy, 'NotReady')),
    Match.tag('ExecutorResourceMissing', ({ resource }) =>
      resource === 'Account'
        ? reconnectRequired(legacy, 'UnresolvedMigration', [])
        : migrationPending(legacy, 'CopyPending'),
    ),
    Match.tag(
      'ExecutorRequirementChanged',
      'ExecutorConnectionRefused',
      'ExecutorAccountChoiceUnsupported',
      'ExecutorOAuthClientUnavailable',
      'ExecutorOAuthClientAmbiguous',
      'ExecutorSourceUnsupported',
      'ExecutorImportQueryUnsupported',
      'ExecutorPublicAddressRequired',
      'ExecutorResponseInvalid',
      'ExecutorAccessDenied',
      'ExecutorRejected',
      'ExecutorInputInvalid',
      'ExecutorSetupRequired',
      'ExecutorOAuthSetupFailed',
      'ExecutorAppNameTaken',
      'ExecutorSignInRequired',
      'ExecutorAuthorizationUnavailable',
      'ExecutorApprovalUnsupported',
      () => reconnectRequired(legacy, 'UnresolvedMigration', []),
    ),
    Match.exhaustive,
  )
}

/** A successful API selection still cannot claim another Connection's app. Preserve the exact
 * account and selected copy for safe later removal when upstream merged equal selections.
 */
function shared(legacy: typeof LegacyExecutorReferences.Type, references: ExecutorReferences) {
  const app = claimedApp(references)
  return reconnectRequired(
    legacy,
    'SharedSelection',
    app !== null && app !== legacy.app ? [app] : [],
  )
}

/** Only legacy selections and retryable wrappers enter a pass. Completed rows supply app
 * claims, and the SQL revision/pending predicate refuses a concurrent completion.
 */
function legacySelection(
  references: typeof import('./records.ts').storedRowSchema.Type.references,
) {
  if (isLegacy(references)) return Option.some(references)
  return Option.map(
    Option.liftPredicate(references, ExecutorReferences.guards.MigrationPending),
    (value) => value.legacy,
  )
}

/** Only legacy or retryable selections belong to this worker; invalid rows are reported
 * by identity and cannot keep the retry schedule alive on their own.
 */
const retryable = sql`(${connections.references} ? 'profile' OR ${connections.references}->>'_tag' = 'MigrationPending')`
const legacyRows = Effect.fn('Connections.legacyRows')(function* () {
  const database = yield* Database
  const rows = yield* database.run(
    database.select().from(connections).orderBy(connections.createdAt, connections.id),
  )
  const valid: Array<typeof storedRowSchema.Type> = []
  for (const raw of rows) {
    const decoded = yield* decodeStoredRow(raw).pipe(Effect.result)
    if (Result.isFailure(decoded)) {
      yield* Effect.logError('Invalid Connection migration row', { connectionId: raw.id })
      continue
    }
    if (Option.isSome(legacySelection(decoded.success.references))) valid.push(decoded.success)
  }
  return {
    pending: valid,
    claims: rows.flatMap((row) =>
      row.executorApp === null ? [] : [{ id: row.id, app: row.executorApp }],
    ),
  }
})

/** Only compatible unsuccessful attempts consume the budget. At the worker's one-minute
 * cap, 1,440 attempts represent roughly 24 hours. Failed global probes and downtime consume
 * no attempts, including an outage that starts after a row already made compatible progress.
 */
function timedOutcome(row: typeof storedRowSchema.Type, references: ExecutorReferences) {
  if (!ExecutorReferences.guards.MigrationPending(references)) return references
  const prior = ExecutorReferences.guards.MigrationPending(row.references)
    ? row.references.compatibleAttempts
    : 0
  const compatibleAttempts = prior + 1
  if (compatibleAttempts >= 24 * 60) {
    const reason = Match.value(references.reason).pipe(
      Match.when('CopyPending', () => 'MigrationTargetMissing' as const),
      Match.when('NotReady', () => 'MigrationTargetNotReady' as const),
      Match.whenOr('Unavailable', 'Unattempted', () => 'MigrationTargetUnavailable' as const),
      Match.exhaustive,
    )
    return reconnectRequired(references.legacy, reason, [])
  }
  return ExecutorReferences.cases.MigrationPending.make({ ...references, compatibleAttempts })
}

/** All HTTP work finishes before this short transaction. A shared lock serializes app claims
 * with reclamation, while revision/predicate CAS refuses stale selections. Counter-only writes
 * preserve the Connection revision, and the observed counter prevents stale passes from replacing
 * newer bookkeeping. Equal JSON is not rewritten. Removal can finish across a healthy retry.
 */
const saveOutcome = Effect.fn('Connections.saveMigrationOutcome')(function* (
  row: typeof storedRowSchema.Type,
  outcome: ExecutorReferences,
  claims: ReadonlyArray<{ readonly id: string; readonly app: string }>,
) {
  const database = yield* Database
  const selection = legacySelection(row.references)
  if (Option.isNone(selection)) return yield* Effect.void
  // Keep pre-inventory claims even if their rows disappear while HTTP work is in flight.
  const selected = claimedApp(outcome)
  const held =
    selected !== null && claims.some((claim) => claim.app === selected && claim.id !== row.id)
  const initial = held ? shared(selection.value, outcome) : outcome
  // Pending JSON written before this counter existed decodes with the schema's zero default.
  const counterRevision = ExecutorReferences.guards.MigrationPending(row.references)
    ? sql`COALESCE(${connections.references}->'compatibleAttempts', '0'::jsonb) = ${JSON.stringify(row.references.compatibleAttempts)}::jsonb`
    : sql`TRUE`
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(connectionLock)
      let references = initial
      const app = claimedApp(references)
      if (app !== null) {
        const current = yield* tx
          .select({ id: connections.id })
          .from(connections)
          .where(and(eq(connections.executorApp, app), ne(connections.id, row.id)))
          .limit(1)
        if (current.length > 0) references = shared(selection.value, references)
      }
      const encoded = yield* encodeReferences(references)
      const reconnect = ExecutorReferences.guards.ReconnectRequired(references)
      const payload = JSON.stringify(encoded)
      const revision = Math.max(yield* Clock.currentTimeMillis, row.updatedAt + 1)
      const saved = yield* tx
        .update(connections)
        .set({
          references: encoded,
          executorApp: claimedApp(references),
          status: reconnect ? 'failed' : row.status,
          reason: reconnect ? executorReconnectMessage : row.reason,
          updatedAt: sql`CASE
            WHEN ${connections.references} - 'compatibleAttempts' = ${payload}::jsonb - 'compatibleAttempts'
            THEN ${connections.updatedAt} ELSE ${revision} END`,
        })
        .where(
          and(
            eq(connections.id, row.id),
            eq(connections.updatedAt, row.updatedAt),
            retryable,
            counterRevision,
            sql`${connections.references} IS DISTINCT FROM ${payload}::jsonb`,
          ),
        )
        .returning({ updatedAt: connections.updatedAt })
      const changed = saved[0]
      if (changed !== undefined && changed.updatedAt !== row.updatedAt)
        yield* Effect.logInfo('Integration app reconciliation').pipe(
          Effect.annotateLogs({ connectionId: row.id, result: references._tag }),
        )
    }),
  )
})

/** The organization-wide protocol probe happens once before any row write. An old-shape,
 * malformed, missing or unreachable inventory leaves all selections untouched and retryable.
 * Per-row failures are isolated only after the shared beta.23 contract has been established.
 */
export const migrateConnections = Effect.fn('Connections.migrate')(function* () {
  const executor = yield* Executor
  const snapshot = yield* legacyRows()
  if (snapshot.pending.length === 0) return false
  const inventory = yield* executor.inventory.pipe(Effect.result)
  if (Result.isFailure(inventory)) {
    yield* Effect.logWarning('Integration migration waiting for compatible inventory', {
      reason: inventory.failure._tag,
    })
    return true
  }
  for (const row of snapshot.pending) {
    const selection = legacySelection(row.references)
    if (Option.isNone(selection)) continue
    const result = yield* executor.reconcile(selection.value, inventory.success).pipe(Effect.result)
    const outcome = Result.isSuccess(result)
      ? result.success
      : refused(selection.value, result.failure)
    yield* saveOutcome(row, timedOutcome(row, outcome), snapshot.claims)
  }
  return (yield* legacyRows()).pending.length > 0
})

/** The pass is forked into the server Layer's scope. Boot/health and
 * reads never await reconciliation. Failed or unfinished passes back off from five seconds to a minute;
 * no retryable rows ends this upgrade worker. Cancellation interrupts both HTTP and scheduled waits.
 */
export const migrationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const database = yield* Database
    const executor = yield* Executor
    const pass = migrateConnections().pipe(
      Effect.provideService(Database, database),
      Effect.provideService(Executor, executor),
      Effect.catch((error) =>
        Effect.logError('Integration migration pass failed', { reason: error._tag }).pipe(
          Effect.as(true),
        ),
      ),
    )
    const backoff = Schedule.exponential('5 seconds').pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.min(duration, Duration.minutes(1))),
      ),
    )
    yield* pass.pipe(
      Effect.repeat({ schedule: backoff, while: (remaining) => remaining }),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError('Integration migration worker stopped', cause),
      ),
      Effect.forkScoped,
    )
  }),
)

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
export function storedResources(
  references: typeof import('./records.ts').storedRowSchema.Type.references,
): ConnectionResources {
  if (isLegacy(references))
    return {
      apps: [references.app],
      account: LegacyExecutorReferences.guards.Authorized(references)
        ? Option.some(references.account)
        : Option.none(),
    }
  return ExecutorReferences.match(references, {
    ReconnectRequired: ({ retired }) => ({
      apps: [retired.original, ...retired.copies],
      account: retired.account,
    }),
    MigrationPending: ({ legacy }) => storedResources(legacy),
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
      const decoded = yield* decodeStoredRow(row).pipe(Effect.result)
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
  return subscriptions
})

/** Pending Dedicated requests resolve and save their account before any revocation. The fast
 * path is limited to references that already carry the account or cannot have one.
 * Retired copy discovery is committed before revocation, so a crash after credential deletion
 * cannot lose the copy IDs needed by a retry. Reclamation and row deletion then share the same
 * lock as migration; concurrent removals cannot both defer cleanup to a row being removed.
 */
export const removeConnection = Effect.fn('Connections.removeResources')(function* (
  row: ConnectionRecord,
) {
  const database = yield* Database
  const executor = yield* Executor
  if (
    ExecutorReferences.isAnyOf(['Public', 'Authorized'])(row.references) &&
    ExecutorAppOwnership.guards.Dedicated(row.references.appOwnership)
  ) {
    yield* executor.remove(row.references).pipe(Effect.mapError(executorFailure))
    const stopped = yield* database.transaction((tx) => removeRow(tx, row))
    yield* unsubscribeWatches(stopped)
    return yield* Effect.void
  }
  let references = row.references
  if (!ExecutorReferences.isAnyOf(['MigrationPending', 'ReconnectRequired'])(references))
    references = ExecutorReferences.cases.ReconnectRequired.make({
      service: references.service,
      owner: references.owner,
      retired: retirementOf(references),
      reason: 'RemovalPending',
    })
  let revision = row.updatedAt
  if (ExecutorReferences.guards.MigrationPending(references))
    references = reconnectRequired(references.legacy, 'UnresolvedMigration', [])
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
          updatedAt: revision,
        })
        .where(and(eq(connections.id, row.id), eq(connections.updatedAt, row.updatedAt)))
        .returning({ id: connections.id }),
    )
    if (saved.length === 0)
      return yield* new Conflict({ message: 'This integration changed before removal; reload it.' })
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
  yield* unsubscribeWatches(stopped)
})
