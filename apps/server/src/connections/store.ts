import { and, eq, isNull } from 'drizzle-orm'
import { Cache, Clock, Context, Effect, Exit, Layer, Redacted } from 'effect'
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
} from '@vivid/contracts'
import { requireAdmin, type Actor } from '../auth/access.ts'
import { Audit } from '../audit/record.ts'
import { ServerConfig } from '../config.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import {
  Executor,
  ExecutorOwnerId,
  ExecutorReferences,
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

/** Shared management is an admin capability; owning the row does not bypass it. */
const mayManage = Effect.fn('Connections.mayManage')(function* (
  actor: Actor,
  row: ConnectionRecord,
) {
  if (row.companyId !== null) yield* requireAdmin(actor.workspace)
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
    yield* (yield* Audit).record(
      actor,
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
  // Preserve pending references when the host cannot start sign-in; the account remains removable.
  const step = yield* executor
    .begin({
      service: request.service,
      label: request.label,
      owner,
      subject: actor.person.id,
      returnAddress: new URL(`/api/connections/return/${encodeURIComponent(id)}`, config.PUBLIC_URL)
        .href,
    })
    .pipe(
      Effect.catchTag('ExecutorSignInRequired', ({ references, message }) =>
        Effect.succeed({ references, message }),
      ),
      Effect.mapError(executorFailure),
    )
  const now = yield* Clock.currentTimeMillis
  const status = '_tag' in step && ExecutorStep.guards.Done(step) ? 'ready' : 'needs-authorization'
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
      actor,
      AuditEvent.cases.ConnectionAdded.make({ service: service.name, shared: request.shared }),
    )
  if (!('_tag' in step)) return yield* Effect.fail(new InvalidRequest({ message: step.message }))
  const connection = yield* publicConnection(actor, row)
  return ExecutorStep.match<ConnectionStep>(step, {
    Done: () => ConnectionStep.cases.Done.make({ connection }),
    EnterKey: () => ConnectionStep.cases.EnterKey.make({ connection }),
    OpenSignIn: ({ address }) => ConnectionStep.cases.OpenSignIn.make({ connection, address }),
  })
})

/** Caches are acquired once per application Layer; transient failures have zero TTL. */
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
  const catalog = yield* Effect.cachedWithTTL(
    executor.catalog().pipe(Effect.mapError(executorFailure)),
    (exit) => (Exit.isSuccess(exit) ? '10 minutes' : 0),
  )
  const decodeReferences = decodeStored(ExecutorReferences, 'Executor references')
  const toolCache = yield* Cache.makeWith(
    Effect.fn('Connections.loadTools')(function* (id: ConnectionId) {
      const rows = yield* database.run(
        database
          .select({ references: connections.references })
          .from(connections)
          .where(eq(connections.id, id))
          .limit(1),
      )
      const row = yield* returned(rows, 'Connection')
      const references = yield* decodeReferences(row.references)
      return yield* executor.tools(references).pipe(Effect.mapError(executorFailure))
    }),
    { capacity: 1000, timeToLive: (exit) => (Exit.isSuccess(exit) ? '5 minutes' : 0) },
  )
  const catalogServices = Effect.fn('Connections.catalog')(function* () {
    return (yield* catalog).map((entry) => Service.make({ ...entry, mark: null }))
  })
  const get = (actor: Actor, id: ConnectionId) => provide(getRecord(actor, id, false))
  const management = makeManagement({ executor, database, provide, get, toolCache })
  return {
    get,
    catalog: catalogServices,
    list: Effect.fn('Connections.list')(function* (actor: Actor) {
      const rows = yield* provide(listRecords(actor))
      const services = yield* catalogServices().pipe(
        Effect.catchTag('ServiceUnavailable', () => Effect.succeed([])),
      )
      const items = yield* Effect.forEach(rows, (row) => provide(publicConnection(actor, row)))
      return { services, connections: items }
    }),
    records: (actor: Actor) => provide(listRecords(actor)),
    tools: (row: ConnectionRecord) => Cache.get(toolCache, row.id),
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

/** Management shares the Layer's authority and invalidates cached tools after every state change. */
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
  readonly toolCache: Cache.Cache<
    ConnectionId,
    readonly (typeof import('./executor.ts').ExecutorTool.Type)[],
    import('../database/client.ts').DatabaseInfrastructureError | ReturnType<typeof executorFailure>
  >
}) => {
  const { executor, database, provide, get, toolCache } = input
  return {
    complete: Effect.fn('Connections.complete')(function* (
      actor: Actor,
      request: CompleteConnectionRequest,
    ) {
      const row = yield* get(actor, request.id)
      yield* mayManage(actor, row)
      const references = yield* executor
        .complete({ references: row.references, fields: request.fields })
        .pipe(Effect.mapError(executorFailure))
      yield* Cache.invalidate(toolCache, row.id)
      return yield* provide(finish(actor, row, references))
    }),
    callback: Effect.fn('Connections.callback')(function* (
      actor: Actor,
      id: ConnectionId,
      callbackAddress: Redacted.Redacted,
    ) {
      const row = yield* provide(getRecord(actor, id, true))
      const references = yield* executor
        .completeSignIn({ references: row.references, callbackAddress })
        .pipe(Effect.mapError(executorFailure))
      const connection = yield* provide(finish(actor, row, references))
      return ConnectionState.guards.Ready(connection.state)
    }),
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
      yield* Cache.invalidate(toolCache, row.id)
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
    notReady: Effect.fn('Connections.notReady')(function* (actor: Actor, row: ConnectionRecord) {
      const saved = yield* provide(
        saveState(row, ConnectionState.cases.NeedsAuthorization.make({}), row.references),
      )
      yield* Cache.invalidate(toolCache, row.id)
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
