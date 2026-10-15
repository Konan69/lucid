import { and, eq, ne, sql } from 'drizzle-orm'
import {
  Clock,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Result,
  Schema,
  Semaphore,
} from 'effect'
import { Conflict } from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { executorFailure } from './errors.ts'
import {
  Executor,
  ExecutorAppId,
  ExecutorAccountId,
  ExecutorReferences,
  LegacyExecutorReferences,
  migrationPending,
  reconnectRequired,
  executorReconnectMessage,
  type ExecutorFailure,
} from './executor.ts'
import {
  claimedApp,
  decodeRow,
  decodeStoredRow,
  encodeReferences,
  type ConnectionRecord,
} from './records.ts'
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

/** SQL selects only pending legacy states; a concurrent completed row is skipped safely. */
function legacySelection(
  references: typeof import('./records.ts').storedRowSchema.Type.references,
) {
  if (isLegacy(references)) return Option.some(references)
  return Option.map(
    Option.liftPredicate(references, ExecutorReferences.guards.MigrationPending),
    (value) => value.legacy,
  )
}

/** Each row gets its own durable result. Permanent refusals cannot fail the inventory list;
 * transient rows retain their original JSON and retry on the next explicit pass. The lock
 * serializes claims across processes and CAS also refuses stale row revisions.
 */
export const migrateConnections = Effect.fn('Connections.migrate')(function* () {
  const database = yield* Database
  const executor = yield* Executor
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(connectionLock)
      const rows = yield* tx
        .select()
        .from(connections)
        .where(
          sql`${connections.references} ? 'profile' OR ${connections.references}->>'_tag' = 'MigrationPending'`,
        )
        .orderBy(connections.createdAt, connections.id)
      for (const raw of rows) {
        const decoded = yield* decodeStoredRow(raw).pipe(Effect.result)
        if (Result.isFailure(decoded)) {
          yield* Effect.logError('Invalid legacy Connection row', raw.id)
          continue
        }
        const row = decoded.success
        const selection = legacySelection(row.references)
        if (Option.isNone(selection)) continue
        const legacy = selection.value
        const result = yield* executor.reconcile(legacy).pipe(Effect.result)
        let references = Result.isSuccess(result) ? result.success : refused(legacy, result.failure)
        const app = claimedApp(references)
        if (app !== null) {
          const claims = yield* tx
            .select({ id: connections.id })
            .from(connections)
            .where(and(eq(connections.executorApp, app), ne(connections.id, row.id)))
            .limit(1)
          if (claims.length > 0) references = shared(legacy, references)
        }
        const reconnect = ExecutorReferences.guards.ReconnectRequired(references)
        const saved = yield* tx
          .update(connections)
          .set({
            references: yield* encodeReferences(references),
            executorApp: claimedApp(references),
            status: reconnect ? 'failed' : row.status,
            reason: reconnect ? executorReconnectMessage : row.reason,
            updatedAt: Math.max(yield* Clock.currentTimeMillis, row.updatedAt + 1),
          })
          .where(
            and(
              eq(connections.id, row.id),
              eq(connections.updatedAt, row.updatedAt),
              sql`(${connections.references} ? 'profile' OR ${connections.references}->>'_tag' = 'MigrationPending')`,
            ),
          )
          .returning({ id: connections.id })
        if (saved.length > 0)
          yield* Effect.logInfo('Integration app reconciliation').pipe(
            Effect.annotateLogs({ connectionId: row.id, result: references._tag }),
          )
      }
      const remaining = yield* tx
        .select({ id: connections.id })
        .from(connections)
        .where(
          sql`${connections.references} ? 'profile' OR ${connections.references}->>'_tag' = 'MigrationPending'`,
        )
        .limit(1)
      return remaining.length > 0
    }),
  )
})

/** A store runs the pass once after a successful cutover. Only persisted retry outcomes make
 * later reads run it again; healthy inventories do not take a migration lock on every lookup.
 */
const makeMigration = Effect.fn('Connections.makeMigration')(function* () {
  const database = yield* Database
  const executor = yield* Executor
  const done = yield* Ref.make(false)
  const lock = yield* Semaphore.make(1)
  const run = Effect.fn('Connections.migrationPass')(function* () {
    yield* lock.withPermit(
      Effect.gen(function* () {
        if (yield* Ref.get(done)) return
        const remaining = yield* migrateConnections().pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Executor, executor),
        )
        if (!remaining) yield* Ref.set(done, true)
      }),
    )
  })
  return { run }
})

/** Shared startup/read migration lifecycle; database and Executor authority come from its Layer. */
export class ConnectionMigration extends Context.Service<
  ConnectionMigration,
  Effect.Success<ReturnType<typeof makeMigration>>
>()('vivid/ConnectionMigration') {}
export const migrationLayer = Layer.effect(ConnectionMigration, makeMigration())

interface ConnectionResources {
  readonly apps: ReadonlyArray<typeof ExecutorAppId.Type>
  readonly account: Option.Option<typeof ExecutorAccountId.Type>
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
    Authorized: ({ app, account }) => ({ apps: [app], account: Option.some(account) }),
    Public: ({ app }) => ({ apps: [app], account: Option.none() }),
    EnteringKey: ({ app }) => ({ apps: [app], account: Option.none() }),
    SigningIn: ({ app }) => ({ apps: [app], account: Option.none() }),
    OAuthSigningIn: ({ app }) => ({ apps: [app], account: Option.none() }),
    GoogleSigningIn: ({ app }) => ({ apps: [app], account: Option.none() }),
  })
}

/** Decode each holder once and aggregate the identities whose authority must remain intact. */
const heldResources = Effect.fn('Connections.heldResources')(function* (
  rows: ReadonlyArray<typeof connections.$inferSelect>,
) {
  const held = yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (row) {
      return storedResources((yield* decodeStoredRow(row)).references)
    }),
  )
  return {
    retainedApps: held.flatMap((value) => value.apps),
    retainedAccounts: held.flatMap((value) => Option.toArray(value.account)),
  }
})

/** Retired copy discovery is committed before revocation, so a crash after credential deletion
 * cannot lose the copy IDs needed by a retry. Reclamation and row deletion then share the same
 * lock as migration; concurrent removals cannot both defer cleanup to a row being removed.
 */
export const removeConnection = Effect.fn('Connections.removeResources')(function* (
  row: ConnectionRecord,
) {
  const database = yield* Database
  const executor = yield* Executor
  let references = row.references
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
  yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(connectionLock)
      const current = (yield* tx
        .select()
        .from(connections)
        .where(eq(connections.id, row.id))
        .for('update'))[0]
      if (current === undefined) return
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
        yield* executor.remove(target.references).pipe(Effect.mapError(executorFailure))
      }
      yield* tx.delete(connections).where(eq(connections.id, row.id))
    }),
  )
})
