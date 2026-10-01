import { and, eq, isNull } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Redacted, Schema, Option } from 'effect'
import {
  AuditEvent,
  BeginConnectionRequest,
  CompanyId,
  CompleteConnectionRequest,
  ConnectionId,
  ConnectionState,
  ConnectionStep,
  InvalidRequest,
  Service,
  ServiceCatalog,
  Workspace,
} from '@vivid/contracts'
import { requireAdmin, type Actor } from '../auth/access.ts'
import { workspaceIn } from '../auth/session.ts'
import { Audit } from '../audit/record.ts'
import { ServerConfig } from '../config.ts'
import { Database, returned } from '../database/client.ts'
import {
  Executor,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorResourceMissing,
  resourceReason,
  ExecutorStatus,
  ExecutorStep,
  type ExecutorService,
} from './executor.ts'
import { executorFailure } from './errors.ts'
import {
  encodeReferences,
  getRecord,
  listRecords,
  publicConnection,
  recordChanged,
  saveState,
  type ConnectionRecord,
} from './records.ts'
import { connections } from './tables.ts'
import { rankServices } from './ranking.ts'

const isResourceMissing = Schema.is(ExecutorResourceMissing)

/** Shared management is an admin capability; owning the row does not bypass it. */
const mayManage = Effect.fn('Connections.mayManage')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  if (row.companyId !== null) yield* requireAdmin(actor.workspace)
})

/** Session workspace is a preference. Callback management and audit attribution use the row's
 * actual Company and fresh Membership; personal Connections always attribute to personal space.
 */
const rowActor = Effect.fn('Connections.rowActor')(function* (actor: Actor, row: ConnectionRecord) {
  const workspace = yield* workspaceIn(actor.person.id, Option.fromNullOr(row.companyId))
  if (row.companyId !== null) yield* requireAdmin(workspace)
  return { ...actor, workspace }
})

/** Persist authorization state before auditing readiness; provider calls remain outside transactions. */
const finish = Effect.fn('Connections.finish')(function* (
  actor: Actor,
  row: ConnectionRecord,
  references: ExecutorReferences,
) {
  const executor = yield* Executor
  const status = yield* executor.status(references).pipe(Effect.mapError(executorFailure))
  const next = ExecutorStatus.match<{ state: ConnectionState; references: ExecutorReferences }>(
    status,
    {
      Ready: (value) => ({
        state: ConnectionState.cases.Ready.make({}),
        references: value.references,
      }),
      NeedsAuthorization: (value) => ({
        state: ConnectionState.cases.NeedsAuthorization.make({}),
        references: value.references,
      }),
      Failed: ({ reason }) => ({
        state: ConnectionState.cases.Failed.make({ reason }),
        references,
      }),
    },
  )
  const saved = yield* saveState(row, next.state, next.references)
  yield* recordChanged(actor, saved)
  if (row.status !== 'ready' && saved.status === 'ready') {
    const attribution =
      row.companyId === null ? { ...actor, workspace: Workspace.cases.Personal.make({}) } : actor
    yield* (yield* Audit).record(
      attribution,
      AuditEvent.cases.ConnectionAdded.make({
        service: row.serviceName,
        shared: row.companyId !== null,
      }),
    )
  }
  return yield* publicConnection(actor, saved)
})

/** Allocate the storage owner separately from the connecting Person's execution attribution. */
const begin = Effect.fn('Connections.begin')(function* (
  actor: Actor,
  request: BeginConnectionRequest,
  catalog: readonly Service[],
) {
  let companyId: CompanyId | null = null
  if (request.shared) companyId = (yield* requireAdmin(actor.workspace)).company.id
  const service = catalog.find((entry) => entry.id === request.service)
  if (service === undefined)
    return yield* Effect.fail(
      new InvalidRequest({ message: 'Choose a service from the current catalog.' }),
    )
  if (request.label.trim().length === 0)
    return yield* Effect.fail(new InvalidRequest({ message: 'Give this account a label.' }))
  const id = ConnectionId.make(crypto.randomUUID())
  const config = yield* ServerConfig
  const owner = ExecutorOwnerId.make(companyId === null ? `p-${actor.person.id}` : `c-${companyId}`)
  const executor = yield* Executor
  // Revoke an unusable pending grant before reporting failure; never insert a dead product row.
  const step = yield* executor
    .begin({
      connectionId: id,
      service: request.service,
      label: request.label,
      owner,
      subject: actor.person.id,
      returnAddress: new URL(`/api/connections/return/${encodeURIComponent(id)}`, config.PUBLIC_URL)
        .href,
    })
    .pipe(
      Effect.catchTag(
        'ExecutorSignInRequired',
        Effect.fn('Connections.cancelSignIn')(function* (error) {
          yield* executor.remove(error.references)
          return yield* Effect.fail(error)
        }),
      ),
      Effect.mapError(executorFailure),
    )
  const now = yield* Clock.currentTimeMillis
  const status = ExecutorStep.guards.Done(step) ? 'ready' : 'needs-authorization'
  const database = yield* Database
  const rows = yield* database.run(
    database
      .insert(connections)
      .values({
        id,
        service: service.id,
        serviceName: service.name,
        label: request.label,
        personId: actor.person.id,
        companyId,
        references: encodeReferences(step.references),
        status,
        reason: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  )
  const row = yield* getRecord(
    actor,
    ConnectionId.make((yield* returned(rows, 'Connection')).id),
    false,
  )
  yield* recordChanged(actor, row)
  if (status === 'ready')
    yield* (yield* Audit).record(
      {
        ...actor,
        workspace: companyId === null ? Workspace.cases.Personal.make({}) : actor.workspace,
      },
      AuditEvent.cases.ConnectionAdded.make({ service: service.name, shared: request.shared }),
    )
  const connection = yield* publicConnection(actor, row)
  return ExecutorStep.match<ConnectionStep>(step, {
    Done: () => ConnectionStep.cases.Done.make({ connection }),
    EnterKey: ({ fields }) => ConnectionStep.cases.EnterKey.make({ connection, fields }),
    OpenSignIn: ({ address }) => ConnectionStep.cases.OpenSignIn.make({ connection, address }),
  })
})

/** Permanently missing resources fail the persisted Connection and disappear from discovery. */
const loadTools = Effect.fn('Connections.tools')(function* (actor: Actor, row: ConnectionRecord) {
  const executor = yield* Executor
  return yield* executor.tools(row.references).pipe(
    Effect.mapError((error) => (isResourceMissing(error) ? error : executorFailure(error))),
    Effect.catchTag(
      'ExecutorResourceMissing',
      Effect.fn('Connections.failDiscovery')(function* ({ resource }) {
        const saved = yield* saveState(
          row,
          ConnectionState.cases.Failed.make({
            reason: resourceReason(resource),
          }),
          row.references,
        )
        yield* recordChanged(actor, saved)
        return []
      }),
    ),
  )
})

/** Capture authority once; the adapter owns discovery and catalog cache lifetimes. */
const makeStore = Effect.fn('Connections.makeStore')(function* () {
  const executor: ExecutorService = yield* Executor
  const database = yield* Database
  const dependencies = yield* Effect.context<
    Executor | Database | Audit | ServerConfig | import('../live/changes.ts').Changes
  >()
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Executor | Database | Audit | ServerConfig | import('../live/changes.ts').Changes
    >,
  ) => effect.pipe(Effect.provide(dependencies))
  const catalogServices = Effect.fn('Connections.catalog')(function* () {
    return (yield* executor.catalog().pipe(Effect.mapError(executorFailure))).map((entry) =>
      Service.make({ ...entry, mark: null }),
    )
  })
  const get = (actor: Actor, id: ConnectionId) => provide(getRecord(actor, id, false))
  const management = makeManagement({ executor, database, provide, get })
  return {
    get,
    catalog: catalogServices,
    /** Catalog search is independent of ownership and preserves the adapter's retained order. */
    find: Effect.fn('Connections.findServices')((query: string) =>
      catalogServices().pipe(
        Effect.map((services) =>
          ServiceCatalog.cases.Ready.make({
            services: rankServices(services, query),
            total: services.length,
          }),
        ),
        Effect.catchTag('ServiceUnavailable', () =>
          Effect.succeed(ServiceCatalog.cases.Unavailable.make({})),
        ),
      ),
    ),
    /** Read persistence even when the catalog host is offline. */
    list: Effect.fn('Connections.list')(function* (actor: Actor) {
      const rows = yield* provide(listRecords(actor))
      const items = yield* Effect.forEach(rows, (row) => provide(publicConnection(actor, row)))
      return { connections: items }
    }),
    records: (actor: Actor) => provide(listRecords(actor)),
    tools: (actor: Actor, row: ConnectionRecord) => provide(loadTools(actor, row)),
    /** Validate shared management before the first external operation. */
    begin: Effect.fn('Connections.begin')(function* (
      actor: Actor,
      request: BeginConnectionRequest,
    ) {
      // Refuse non-admin sharing before catalog lookup or provider mutation.
      if (request.shared) yield* requireAdmin(actor.workspace)
      return yield* provide(begin(actor, request, yield* catalogServices()))
    }),
    ...management,
  }
})

/** Management shares the Layer's authority and publishes every persisted state change. */
const makeManagement = (input: {
  readonly executor: ExecutorService
  readonly database: typeof Database.Service
  readonly provide: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Executor | Database | Audit | ServerConfig | import('../live/changes.ts').Changes
    >,
  ) => Effect.Effect<A, E>
  readonly get: (
    actor: Actor,
    id: ConnectionId,
  ) => Effect.Effect<
    ConnectionRecord,
    | import('@vivid/contracts').NotFound
    | import('../database/client.ts').DatabaseInfrastructureError
  >
}) => {
  const { executor, database, provide, get } = input
  return {
    /** Only a managing Person submits keys; the store retains identifiers alone. */
    complete: Effect.fn('Connections.complete')(function* (
      actor: Actor,
      request: CompleteConnectionRequest,
    ) {
      const row = yield* get(actor, request.id)
      yield* mayManage(actor, row)
      const references = yield* executor
        .complete({ references: row.references, fields: request.fields })
        .pipe(Effect.mapError(executorFailure))
      return yield* provide(finish(actor, row, references))
    }),
    /** Bind sign-in completion to its initiating Person across workspace switches. */
    callback: Effect.fn('Connections.callback')(function* (
      actor: Actor,
      id: ConnectionId,
      callbackAddress: Redacted.Redacted,
    ) {
      const row = yield* provide(getRecord(actor, id, true))
      const managing = yield* provide(rowActor(actor, row))
      const references = yield* executor
        .completeSignIn({ references: row.references, callbackAddress })
        .pipe(Effect.mapError(executorFailure))
      const connection = yield* provide(finish(managing, row, references))
      return connection.state
    }),
    /** Remove provider authority before deleting the scoped product record. */
    remove: Effect.fn('Connections.remove')(function* (actor: Actor, id: ConnectionId) {
      const row = yield* get(actor, id)
      yield* mayManage(actor, row)
      yield* executor.remove(row.references).pipe(Effect.mapError(executorFailure))
      yield* database.run(
        database
          .delete(connections)
          .where(
            and(
              eq(connections.id, row.id),
              eq(connections.personId, row.personId),
              row.companyId === null
                ? isNull(connections.companyId)
                : eq(connections.companyId, row.companyId),
            ),
          ),
      )
      yield* provide(recordChanged(actor, row))
      yield* provide(
        Effect.flatMap(Audit, (audit) =>
          audit.record(
            actor,
            AuditEvent.cases.ConnectionRemoved.make({
              service: row.serviceName,
              shared: row.companyId !== null,
            }),
          ),
        ),
      )
    }),
    /** A deleted provider resource fails permanently instead of asking for credentials again. */
    failed: Effect.fn('Connections.failed')(function* (
      actor: Actor,
      row: ConnectionRecord,
      reason: string,
    ) {
      const saved = yield* provide(
        saveState(row, ConnectionState.cases.Failed.make({ reason }), row.references),
      )
      yield* provide(recordChanged(actor, saved))
    }),
    /** Persist authorization loss before publishing the change. */
    notReady: Effect.fn('Connections.notReady')(function* (actor: Actor, row: ConnectionRecord) {
      const saved = yield* provide(
        saveState(row, ConnectionState.cases.NeedsAuthorization.make({}), row.references),
      )
      yield* provide(recordChanged(actor, saved))
    }),
  }
}

/** Product account authority over the external adapter; no credential values enter this service. */
export class ConnectionStore extends Context.Service<
  ConnectionStore,
  Effect.Success<ReturnType<typeof makeStore>>
>()('vivid/ConnectionStore') {}
export const connectionStoreLayer = Layer.effect(ConnectionStore, makeStore())
