import { and, eq, isNull } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Redacted, Schema, Option, Semaphore } from 'effect'
import {
  AddIntegrationRequest,
  ServiceId,
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
  ServiceAuthorization,
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
  ExecutorPublicAddressRequired,
  connectionSetupMessage,
  resourceReason,
  ExecutorStatus,
  ExecutorStep,
  type ExecutorService,
  ExecutorSignInRequired,
  ExecutorAuthorizationUnavailable,
} from './executor.ts'
import { executorFailure } from './errors.ts'
import {
  encodeReferences,
  getRecord,
  googleCallbackId,
  listRecords,
  publicConnection,
  recordChanged,
  retainResumer,
  saveState,
  type ConnectionRecord,
} from './records.ts'
import { connections } from './tables.ts'
import { catalogService, serviceLogo } from './logo.ts'
import { loadCuration } from './curation.ts'
import { connectionAddressLayer, type ConnectionSource } from './address.ts'

const isResourceMissing = Schema.is(ExecutorResourceMissing)
const isPublicAddressRequired = Schema.is(ExecutorPublicAddressRequired)
const isRetainedAuthorization = Schema.is(
  Schema.Union([ExecutorSignInRequired, ExecutorAuthorizationUnavailable]),
)

/** Availability changes metadata only; explicit construction preserves the wire Service model. */
function authorizedService(service: Service, authorization: ServiceAuthorization) {
  return Service.make({
    id: service.id,
    name: service.name,
    description: service.description,
    mark: service.mark,
    authorization,
  })
}

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
  service: Service,
  start: ExecutorService['begin'],
) {
  let companyId: CompanyId | null = null
  if (request.shared) companyId = (yield* requireAdmin(actor.workspace)).company.id
  if (ServiceAuthorization.guards.SetupRequired(service.authorization))
    return yield* Effect.fail(new InvalidRequest({ message: connectionSetupMessage }))
  if (request.label.trim().length === 0)
    return yield* Effect.fail(new InvalidRequest({ message: 'Give this account a label.' }))
  const id = ConnectionId.make(crypto.randomUUID())
  const config = yield* ServerConfig
  const owner = ExecutorOwnerId.make(companyId === null ? `p-${actor.person.id}` : `c-${companyId}`)
  const executor = yield* Executor
  // Revoke an unusable pending grant before reporting failure; never insert a dead product row.
  const step = yield* start({
    connectionId: id,
    service: request.service,
    label: request.label,
    owner,
    subject: actor.person.id,
    returnAddress: new URL(`/api/connections/return/${encodeURIComponent(id)}`, config.PUBLIC_URL)
      .href,
  }).pipe(
    Effect.catchTag(
      'ExecutorSignInRequired',
      Effect.fn('Connections.cancelSignIn')(function* (error) {
        yield* executor.remove(error.references)
        return yield* Effect.fail(error)
      }),
    ),
    Effect.mapError((error) => (isPublicAddressRequired(error) ? error : executorFailure(error))),
  )
  const now = yield* Clock.currentTimeMillis
  const status = ExecutorStep.guards.Done(step) ? 'ready' : 'needs-authorization'
  const database = yield* Database
  const rows = yield* database
    .run(
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
    .pipe(
      Effect.catch(
        Effect.fn('Connections.compensateInsert')(function* (error) {
          // Cleanup is attempted and logged; the rejected insert remains the operation's original failure.
          yield* executor.remove(step.references).pipe(
            Effect.tapError((failure) =>
              Effect.logError('Connection insert compensation failed', failure._tag),
            ),
            Effect.ignore,
          )
          return yield* Effect.fail(error)
        }),
      ),
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

/** Retain a replacement request before reporting failure so the next Resume resolves that exact grant. */
const retainAuthorization = Effect.fn('Connections.retainAuthorization')(function* (
  actor: Actor,
  row: ConnectionRecord,
  error: ExecutorSignInRequired | ExecutorAuthorizationUnavailable,
) {
  const saved = yield* saveState(
    row,
    ConnectionState.cases.NeedsAuthorization.make({}),
    error.references,
  )
  yield* recordChanged(actor, saved)
  return yield* Effect.fail(executorFailure(error))
})

/** Resume keeps the same Company owner and provider target while attributing the grant to its admin. */
const resume = Effect.fn('Connections.resume')(function* (actor: Actor, row: ConnectionRecord) {
  const config = yield* ServerConfig
  const executor = yield* Executor
  const step = yield* executor
    .reauthorize({
      connectionId: row.id,
      service: row.service,
      label: row.label,
      owner: row.references.owner,
      subject: actor.person.id,
      references: row.references,
      returnAddress: new URL(
        `/api/connections/return/${encodeURIComponent(row.id)}`,
        config.PUBLIC_URL,
      ).href,
    })
    .pipe(
      Effect.mapError((error) => (isRetainedAuthorization(error) ? error : executorFailure(error))),
      Effect.catchTags({
        ExecutorSignInRequired: (error) => retainAuthorization(actor, row, error),
        ExecutorAuthorizationUnavailable: (error) => retainAuthorization(actor, row, error),
      }),
    )
  const saved = yield* saveState(
    row,
    ExecutorStep.guards.Done(step)
      ? ConnectionState.cases.Ready.make({})
      : ConnectionState.cases.NeedsAuthorization.make({}),
    step.references,
  )
  yield* recordChanged(actor, saved)
  if (ExecutorStep.guards.Done(step))
    yield* (yield* Audit).record(
      actor,
      AuditEvent.cases.ConnectionAdded.make({
        service: row.serviceName,
        shared: row.companyId !== null,
      }),
    )
  const connection = yield* publicConnection(actor, saved)
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
  const returnAddress = (yield* ServerConfig).PUBLIC_URL.href
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
    return (yield* executor.catalog().pipe(Effect.mapError(executorFailure))).map(catalogService)
  })
  /** Inspect the selected candidate without retaining any account or credential. */
  const inspectService = Effect.fn('Connections.inspectService')(function* (service: Service) {
    const authorization = yield* executor
      .authorization({ service: service.id, returnAddress })
      .pipe(
        // The downloaded catalog is an explicit optimistic hint until read-only inspection succeeds.
        // Never cache a transient answer or hide a virgin service because no app definition exists yet.
        Effect.catchTags({
          ExecutorNotReady: () => Effect.succeed(service.authorization),
          ExecutorTransportFailure: () => Effect.succeed(service.authorization),
          ExecutorExecutionUncertain: () => Effect.succeed(service.authorization),
          ExecutorResponseInvalid: () => Effect.succeed(service.authorization),
        }),
        Effect.mapError(executorFailure),
      )
    return authorizedService(service, authorization)
  })
  /** Search uses only completed availability facts in the adapter's snapshot. A cold sign-in
   * hint remains optimistic until Begin or Resume supplies a real app definition. The decoded
   * curation is kept for the life of the store: the file cannot change while the server runs.
   */
  const curated = yield* Effect.cached(loadCuration())
  /** Which services are shown, in what order and how many, is the checked-in curation's decision. */
  const find = Effect.fn('Connections.findServices')(function* (query: string) {
    const search = yield* curated
    return search(yield* catalogServices(), query)
  })
  /** Offers inspect exactly the chosen service, using the same cached availability as search. */
  const service = Effect.fn('Connections.service')(function* (
    id: import('@vivid/contracts').ServiceId,
  ) {
    const entry = (yield* catalogServices()).find((candidate) => candidate.id === id)
    if (entry === undefined)
      return yield* Effect.fail(new InvalidRequest({ message: 'Unknown integration.' }))
    if (ServiceAuthorization.guards.SetupRequired(entry.authorization)) return entry
    return yield* inspectService(entry)
  })
  const get = (actor: Actor, id: ConnectionId) => provide(getRecord(actor, id, false))
  const management = makeManagement({ executor, database, provide, get })

  return {
    get,
    catalog: catalogServices,
    service,
    /** Catalog search is independent of ownership and preserves the adapter's retained order. */
    find: Effect.fn('Connections.search')((query: string) =>
      find(query).pipe(
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
      const entry = (yield* catalogServices()).find((item) => item.id === request.service)
      if (entry === undefined)
        return yield* Effect.fail(
          new InvalidRequest({ message: 'Choose an integration from the current catalogue.' }),
        )
      const start = Effect.fn('Connections.beginCatalog')(
        (input: Parameters<ExecutorService['begin']>[0]) => executor.begin(input),
      )
      return yield* provide(begin(actor, request, entry, start)).pipe(
        Effect.catchTag('ExecutorPublicAddressRequired', (error) =>
          Effect.fail(executorFailure(error)),
        ),
      )
    }),
    /** URL imports persist through the same compensation, ownership and authorization steps. */
    add: Effect.fn('Connections.add')(function* (
      actor: Actor,
      request: AddIntegrationRequest,
      source: ConnectionSource,
    ) {
      if (request.shared) yield* requireAdmin(actor.workspace)
      const importedService = Service.make({
        id: ServiceId.make(`url:${source.address}`),
        name: request.name,
        description: '',
        mark: serviceLogo(source.address),
        authorization: ServiceAuthorization.cases.None.make({}),
      })
      const start: ExecutorService['begin'] = Effect.fn('Connections.import')((input) =>
        executor.add({ ...input, source }),
      )
      return yield* provide(
        begin(
          actor,
          {
            service: importedService.id,
            label: request.name,
            shared: request.shared,
          },
          importedService,
          start,
        ),
      )
    }),
    ...management,
  }
})

/** Each Connection has its own lock through the last holder/waiter; idle locks are removed.
 * A slow external call cannot block unrelated Connections, and eviction cannot split a busy lock.
 */
const serializeResumes = () => {
  const resuming = new Map<ConnectionId, { permit: Semaphore.Semaphore; users: number }>()
  const withResume = <A, E, R>(effect: Effect.Effect<A, E, R>, id: ConnectionId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lock = yield* Effect.acquireRelease(
          Effect.sync(() => {
            let current = resuming.get(id)
            if (current === undefined) {
              current = { permit: Semaphore.makeUnsafe(1), users: 0 }
              resuming.set(id, current)
            }
            current.users += 1
            return current
          }),
          (current) =>
            Effect.sync(() => {
              current.users -= 1
              if (current.users === 0) resuming.delete(id)
            }),
        )
        return yield* lock.permit.withPermit(effect)
      }),
    )
  return withResume
}

/** Fixed callbacks and id-addressed callbacks share the same account completion authority. */
const makeCallbacks = (
  input: Pick<Parameters<typeof makeManagement>[0], 'executor' | 'provide'>,
) => {
  const { executor, provide } = input
  /** Bind sign-in completion to its initiating Person across workspace switches. */
  const callback = Effect.fn('Connections.callback')(function* (
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
  })

  return {
    googleCallbackId: Effect.fn('Connections.resolveGoogleReturn')(
      (actor: Actor, state: Parameters<typeof googleCallbackId>[1]) =>
        provide(googleCallbackId(actor, state)),
    ),
    callback,
  }
}

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
  const withResume = serializeResumes()
  return {
    /** Resume has exactly removal's scoped lookup and admin check, before provider access. */
    resume: Effect.fn('Connections.resumeExisting')(
      function* (actor: Actor, id: ConnectionId) {
        const row = yield* get(actor, id)
        yield* mayManage(actor, row)
        if (row.status === 'ready')
          return ConnectionStep.cases.Done.make({
            connection: yield* provide(publicConnection(actor, row)),
          })
        if (row.status === 'failed')
          return yield* Effect.fail(
            new InvalidRequest({ message: 'Remove this failed integration and connect again.' }),
          )
        const service = (yield* executor.catalog().pipe(Effect.mapError(executorFailure))).find(
          (entry) => entry.id === row.service,
        )
        if (
          service !== undefined &&
          ServiceAuthorization.guards.SetupRequired(service.authorization)
        )
          return yield* Effect.fail(new InvalidRequest({ message: connectionSetupMessage }))
        const managing = yield* provide(rowActor(actor, row))
        const retained = yield* provide(retainResumer(managing, row))
        return yield* provide(resume(managing, retained))
      },
      (effect, _actor, id) => withResume(effect, id),
    ),
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
    ...makeCallbacks(input),
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

/** Product account authority over the external adapter; no credential values enter this integration. */
export class ConnectionStore extends Context.Service<
  ConnectionStore,
  Effect.Success<ReturnType<typeof makeStore>>
>()('vivid/ConnectionStore') {}
export const connectionStoreLayer = Layer.effect(ConnectionStore, makeStore()).pipe(
  Layer.provideMerge(connectionAddressLayer),
)
