import { CATALOG_RETRY_DELAY } from './catalog.ts'
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
  Option,
  Semaphore,
  Match,
} from 'effect'
import {
  AddIntegrationRequest,
  MakeIntegrationRequest,
  ServiceId,
  SignInSurface,
  AuditEvent,
  BeginConnectionRequest,
  CompanyId,
  CompleteConnectionRequest,
  Conflict,
  Connection,
  ConnectionId,
  ConnectionState,
  ConnectionStep,
  InvalidRequest,
  NotFound,
  RenameConnectionRequest,
  Service,
  ServiceCatalog,
  ServiceAuthorization,
  ServiceUnavailable,
  Workspace,
} from '@vivid/contracts'
import { findPerson, requireAdmin, type Actor } from '../auth/access.ts'
import { workspaceIn } from '../auth/session.ts'
import { Audit } from '../audit/record.ts'
import { ServerConfig } from '../config.ts'
import { Database, returned } from '../database/client.ts'
import { Changes } from '../live/changes.ts'
import {
  Executor,
  ExecutorTool,
  ExecutorOwnerId,
  ExecutorReferences,
  ExecutorResourceMissing,
  ExecutorNotReady,
  ExecutorPublicAddressRequired,
  connectionSetupMessage,
  executorMigrationMessage,
  resourceReason,
  ExecutorStatus,
  ExecutorStep,
  type ExecutorService,
  ExecutorSignInRequired,
  ExecutorAuthorizationUnavailable,
  ExecutorBuildFailed,
} from './executor.ts'
import { madeFiles, madeService } from './made.ts'
import { executorFailure } from './errors.ts'
import {
  connectionOf,
  encodeReferences,
  getRecord,
  callbackTrip,
  listRecords,
  publicConnection,
  recordChanged,
  retainTrip,
  saveIdentity,
  saveName,
  saveState,
  type ConnectionRecord,
} from './records.ts'
import { namedAccounts } from './names.ts'
import { removeConnection } from './migration.ts'
import { connections } from './tables.ts'
import { callbackHash, correlateSignIn } from './correlation.ts'
import { catalogService, IMPORTED, serviceLogo } from './logo.ts'
import { loadCuration } from './curation.ts'
import { connectionAddressLayer, type ConnectionSource } from './address.ts'

const isResourceMissing = Schema.is(ExecutorResourceMissing)
const isPublicAddressRequired = Schema.is(ExecutorPublicAddressRequired)
const isBuildFailed = Schema.is(ExecutorBuildFailed)
const isSignInRequired = Schema.is(ExecutorSignInRequired)
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

/**
 * What Executor files a Connection's account under in its own records: the service's
 * name, in the 40 characters its label takes. Vivid never reads it back.
 */
const executorLabel = (serviceName: string) => serviceName.slice(0, 40)

/**
 * Asks the service who a ready Connection's account is, and keeps the answer on the row.
 *
 * It runs once a Connection is ready, which is the first moment the service will say: Executor
 * asks only when told to (`Executor.identity`). Knowing the address is not what makes an account
 * usable, so nothing here can fail the Connection it is asked about. Executor being out of reach,
 * refusing, or timing out leaves the account without an identity, logged by tag; so does a row
 * that changed while the service was being asked. The Person can still name the account.
 */
const identify = Effect.fn('Connections.identify')(function* (row: ConnectionRecord) {
  if (row.status !== 'ready') return row
  const executor = yield* Executor
  const identity = yield* executor
    .identity(row.references)
    .pipe(
      Effect.catch((failure) =>
        Effect.logWarning('Integration identity unavailable', failure._tag).pipe(
          Effect.as(Option.none<typeof row.identity & string>()),
        ),
      ),
    )
  if (Option.isNone(identity) || identity.value === row.identity) return row
  // Not being able to keep the answer is the same as not having one: the Connection is ready
  // either way, and what follows (publishing it, the audit entry) must still happen.
  return yield* saveIdentity(row, identity.value).pipe(
    Effect.catch((failure) =>
      Effect.logWarning('Integration identity not saved', failure._tag).pipe(Effect.as(row)),
    ),
  )
})

/**
 * A name is given once among the accounts it could be confused with: a Person's own accounts on
 * a service, or the accounts a Company shares on it. Two of those that were both called "Work"
 * would have to be told apart by a number on the later one, and a number moves when the earlier
 * account is renamed or removed: Vivid, still holding the old name, would then act through the
 * other account. So a name another account of the same owner already has on the service is
 * refused. Case and the spaces around it do not make a name different.
 *
 * A Person's own account and their Company's may still share a name: whoever names the Company's
 * cannot see what each member called their own. Those two are told apart by the number.
 *
 * This reads and then writes; nothing in the database enforces it. Two requests that give the
 * same name at the same instant (one Person on two devices) can both pass, and the two accounts
 * are then told apart by the number as well. Making that impossible takes a unique index on the
 * owner, the service and the folded name, which this change does not add.
 */
const requireFreeName = Effect.fn('Connections.requireFreeName')(function* (
  actor: Actor,
  target: Pick<ConnectionRecord, 'service' | 'name' | 'companyId'> & {
    /** The account being renamed, which does not clash with itself; null for a new account. */
    readonly except: ConnectionId | null
  },
) {
  // Taking a name away clashes with nothing.
  const wanted = Option.map(Option.fromNullOr(target.name), (name) => name.trim().toLowerCase())
  const taken =
    Option.isSome(wanted) &&
    (yield* listRecords(actor)).some(
      (row) =>
        row.service === target.service &&
        row.companyId === target.companyId &&
        row.id !== target.except &&
        row.name !== null &&
        row.name.trim().toLowerCase() === wanted.value,
    )
  if (taken)
    return yield* new Conflict({
      message: 'Another account on this integration already has that name.',
    })
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
  const saved = yield* identify(yield* saveState(row, next.state, next.references))
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

/** A failed Begin owns no product row. Release its exact provider resources while retaining the
 * original failure; only a cleanup tag can enter diagnostics, never provider or callback data.
 */
const discardBegin = Effect.fn('Connections.discardBegin')(
  (executor: ExecutorService, references: ExecutorReferences) =>
    executor.remove(references).pipe(
      Effect.tapError((failure) =>
        Effect.logError('Integration Begin compensation failed', failure._tag),
      ),
      Effect.ignore,
    ),
)

/** Allocate the storage owner separately from the connecting Person's execution attribution. */
const begin = Effect.fn('Connections.begin')(function* <E>(
  actor: Actor,
  request: BeginConnectionRequest,
  service: Service,
  start: (
    input: Parameters<ExecutorService['begin']>[0],
  ) => Effect.Effect<typeof ExecutorStep.Type, E>,
) {
  let companyId: CompanyId | null = null
  if (request.shared) companyId = (yield* requireAdmin(actor.workspace)).company.id
  if (ServiceAuthorization.guards.SetupRequired(service.authorization))
    return yield* new InvalidRequest({ message: connectionSetupMessage })
  // Refused before anything is allocated at the service: a name is Vivid's own.
  yield* requireFreeName(actor, {
    service: service.id,
    name: request.name,
    companyId,
    except: null,
  })
  const id = ConnectionId.make(crypto.randomUUID())
  const config = yield* ServerConfig
  const owner = ExecutorOwnerId.make(companyId === null ? `p-${actor.person.id}` : `c-${companyId}`)
  const executor = yield* Executor
  // Revoke an unusable pending grant before reporting failure; never insert a dead product row.
  const step = yield* start({
    connectionId: id,
    service: request.service,
    label: executorLabel(service.name),
    owner,
    subject: actor.person.id,
    returnAddress: new URL('/api/connections/return', config.PUBLIC_URL).href,
  }).pipe(
    Effect.flatMap((next) =>
      correlateSignIn(next).pipe(Effect.tapError(() => discardBegin(executor, next.references))),
    ),
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
          // What the Person called it, if they said. Who the service says it is comes after the
          // account is ready (`identify`), so it is never known at insert.
          name: request.name,
          identity: null,
          // Retired, and written only so a server on the previous release can read this row
          // (`tables.ts`): the service's name is what every client sent as the label.
          label: service.name,
          personId: actor.person.id,
          companyId,
          references: yield* encodeReferences(step.references),
          executorApp: step.references.app,
          status,
          returnsTo: request.from,
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
          return yield* error
        }),
      ),
    )
  const row = yield* identify(
    yield* getRecord(actor, ConnectionId.make((yield* returned(rows, 'Connection')).id), false),
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

/** Imports retain their public-egress refusal for the add outcome mapping. */
const publicBeginFailure = (error: import('./executor.ts').ExecutorFailure) =>
  isPublicAddressRequired(error) ? error : executorFailure(error)

/** A failed authored build remains repairable; other provider errors keep the shared translation. */
const madeBeginFailure = (error: import('./executor.ts').ExecutorFailure | ExecutorBuildFailed) =>
  isBuildFailed(error) ? error : executorFailure(error)

/** Cancel an unusable grant before its failure is translated. Preserve authored build errors
 * for the author without adding them to the catalogue/import adapter's failure channel. */
function prepareBegin<A, E>(executor: ExecutorService, operation: Effect.Effect<A, E>) {
  return operation.pipe(
    Effect.tapError((error) =>
      isSignInRequired(error) ? discardBegin(executor, error.references) : Effect.void,
    ),
  )
}

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
  return yield* executorFailure(error)
})

/** Resume keeps the same Company owner and provider target while attributing the grant to its admin. */
const resume = Effect.fn('Connections.resume')(function* (actor: Actor, row: ConnectionRecord) {
  const config = yield* ServerConfig
  const executor = yield* Executor
  const step = yield* executor
    .reauthorize({
      connectionId: row.id,
      service: row.service,
      label: executorLabel(row.serviceName),
      owner: row.references.owner,
      subject: actor.person.id,
      references: row.references,
      returnAddress: new URL('/api/connections/return', config.PUBLIC_URL).href,
    })
    .pipe(
      Effect.mapError((error) => (isRetainedAuthorization(error) ? error : executorFailure(error))),
      Effect.catchTags({
        ExecutorSignInRequired: (error) => retainAuthorization(actor, row, error),
        ExecutorAuthorizationUnavailable: (error) => retainAuthorization(actor, row, error),
      }),
      Effect.flatMap(correlateSignIn),
    )
  const saved = yield* identify(
    yield* saveState(
      row,
      ExecutorStep.guards.Done(step)
        ? ConnectionState.cases.Ready.make({})
        : ConnectionState.cases.NeedsAuthorization.make({}),
      step.references,
    ),
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

/** Empty ready catalogs, Integrations that must be signed in again and newly failed Integrations
 * have different admission meanings. Discovery returns the transition it persisted; callers never
 * guess it from a second read. */
export const ToolDiscovery = Schema.TaggedUnion({
  Ready: { tools: Schema.Array(ExecutorTool) },
  NeedsAuthorization: {},
  Failed: { reason: Schema.String },
})

const isNotReady = Schema.is(ExecutorNotReady)

/**
 * Lists one Integration's tools, and keeps its stored state true to what Executor answered.
 *
 * Executor owns the account and its sign-in; the row's state is Vivid's copy of it. A missing
 * resource fails the row. An account Executor says must be signed in again (its saved sign-in
 * can no longer be used, no account is linked, the selection changed) moves the row to
 * NeedsAuthorization here, at discovery. Until 26 October 2026 that answer became InvalidRequest
 * and left the row Ready: only a tool call that reached Executor could demote it, and discovery
 * failed before any call did. A Person's Gmail whose Google sign-in had lapsed stayed Ready for
 * days and failed every find_tools for all of their Integrations.
 */
const loadTools = Effect.fn('Connections.tools')(function* (actor: Actor, row: ConnectionRecord) {
  const executor = yield* Executor
  return yield* executor.tools(row.references).pipe(
    Effect.map((tools) => ToolDiscovery.cases.Ready.make({ tools })),
    Effect.mapError((error) =>
      isResourceMissing(error) || isNotReady(error) ? error : executorFailure(error),
    ),
    Effect.catchTags({
      ExecutorResourceMissing: Effect.fn('Connections.failDiscovery')(function* ({ resource }) {
        const reason = resourceReason(resource)
        const saved = yield* saveState(
          row,
          ConnectionState.cases.Failed.make({ reason }),
          row.references,
        )
        yield* recordChanged(actor, saved)
        return ToolDiscovery.cases.Failed.make({ reason })
      }),
      ExecutorNotReady: Effect.fn('Connections.lapsedDiscovery')(function* () {
        const saved = yield* saveState(
          row,
          ConnectionState.cases.NeedsAuthorization.make({}),
          row.references,
        )
        yield* recordChanged(actor, saved)
        return ToolDiscovery.cases.NeedsAuthorization.make({})
      }),
    }),
  )
})

/**
 * Gives each catalog Connection the catalog's icon for its service. A Connection that already
 * names an icon (an added server) keeps it; one whose service the catalog does not list keeps
 * none.
 */
const withCatalogMarks = (
  items: ReadonlyArray<Connection>,
  catalog: ReadonlyArray<Service>,
): ReadonlyArray<Connection> => {
  const marks = new Map(catalog.map((entry) => [entry.id, entry.mark]))
  return items.map((item) =>
    item.mark === null
      ? Connection.make({
          id: item.id,
          service: item.service,
          serviceName: item.serviceName,
          mark: Option.getOrNull(Option.fromNullishOr(marks.get(item.service))),
          site: item.site,
          name: item.name,
          identity: item.identity,
          account: item.account,
          origin: item.origin,
          ownership: item.ownership,
          state: item.state,
          createdAt: item.createdAt,
        })
      : item,
  )
}

/** Pace unavailable icon lookups at the adapter's thirty-second retry interval. Successful
 * lists see its current snapshot; other failures and interruptions are never retained.
 */
function listCatalogLifetime(
  exit: Exit.Exit<ReadonlyArray<Service>, ReturnType<typeof executorFailure>>,
) {
  if (Exit.isSuccess(exit)) return 0
  return Option.exists(
    Cause.findErrorOption(exit.cause),
    (error) => error instanceof ServiceUnavailable,
  )
    ? CATALOG_RETRY_DELAY
    : 0
}

/** Explicit search/management never inherit list failures. Effect rc.116's installed
 * src/internal/effect.ts:4454 delegates cachedWithTTL to cachedInvalidateWithTTL;
 * lines 4400–4422 share the owner's exit, including interruption, with waiting readers.
 * Fork each cached read into the Layer scope (forkIn, lines 5553–5568), then join it:
 * disconnecting a caller removes only its join observer (fiberJoin, lines 860–867).
 * The probe keeps the caller's Clock and pending-reader deduplication; Layer shutdown
 * still interrupts it. Starting immediately keeps overlapping zero-TTL readers together.
 * Success refresh and unavailability backoff retain their TTL policy.
 */
const rememberListCatalog = Effect.fn('Connections.rememberListCatalog')(
  (catalog: Effect.Effect<ReadonlyArray<Service>, ReturnType<typeof executorFailure>>) =>
    Effect.scope.pipe(
      Effect.flatMap((scope) =>
        Effect.cachedWithTTL(catalog, listCatalogLifetime).pipe(
          // Produce the reusable read program without starting a lookup during acquisition.
          Effect.map((cached) =>
            cached.pipe(
              Effect.forkIn(scope, { startImmediately: true }),
              Effect.flatMap(Fiber.join),
            ),
          ),
        ),
      ),
    ),
)

type ConnectionAuthority = Executor | Database | Audit | ServerConfig | Changes
type ProvideAuthority = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, ConnectionAuthority>>

/** Capture authority once; the adapter owns discovery and catalog cache lifetimes. */
const makeStore = Effect.fn('Connections.makeStore')(function* () {
  const executor: ExecutorService = yield* Executor
  const database = yield* Database
  const returnAddress = (yield* ServerConfig).PUBLIC_URL.href
  // Retain only authorities; the caller owns its span, Scope and Clock after construction ends.
  const dependencies = Context.pick(
    Executor,
    Database,
    Audit,
    ServerConfig,
    Changes,
  )(yield* Effect.context<Executor | Database | Audit | ServerConfig | Changes>())
  const provide: ProvideAuthority = (effect) => effect.pipe(Effect.provide(dependencies))
  const catalogServices = Effect.fn('Connections.catalog')(function* () {
    return (yield* executor.catalog.pipe(Effect.mapError(executorFailure))).map(catalogService)
  })
  const listCatalog = yield* rememberListCatalog(catalogServices())
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
    if (entry === undefined) return yield* new InvalidRequest({ message: 'Unknown integration.' })
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
    /**
     * Read persistence even when the catalog host is offline. An added server names its own icon
     * (`connectionLogo`); a catalog service's icon is the catalog's, so it is filled in here when
     * the catalog can be read and left absent when it cannot, in which case each client draws its
     * bundled logo or the service's initial.
     */
    list: Effect.fn('Connections.list')(function* (actor: Actor) {
      // Named oldest first, which is what fixes each account's name; shown newest first.
      const named = namedAccounts(yield* provide(listRecords(actor))).toReversed()
      const items = yield* Effect.forEach(named, ({ row, account }) =>
        connectionOf(actor, row, account),
      )
      const catalog = yield* listCatalog.pipe(
        Effect.catchTag('ServiceUnavailable', () => Effect.succeed<ReadonlyArray<Service>>([])),
      )
      return { connections: withCatalogMarks(items, catalog) }
    }),
    records: (actor: Actor) => provide(listRecords(actor)),
    tools: (actor: Actor, row: ConnectionRecord) => provide(loadTools(actor, row)),
    ...makeRegistration({ executor, provide, catalogServices }),
    ...management,
  }
})

/** Registration owns allocation and its failure translation; management owns existing accounts. */
function makeRegistration(input: {
  readonly executor: ExecutorService
  readonly provide: ProvideAuthority
  readonly catalogServices: () => Effect.Effect<
    ReadonlyArray<Service>,
    ReturnType<typeof executorFailure>
  >
}) {
  const { executor } = input
  return {
    /** Validate shared management before the first external operation. */
    begin: Effect.fn('Connections.begin')(function* (
      actor: Actor,
      request: BeginConnectionRequest,
    ) {
      // Refuse non-admin sharing before catalog lookup or provider mutation.
      if (request.shared) yield* requireAdmin(actor.workspace)
      const entry = (yield* input.catalogServices()).find((item) => item.id === request.service)
      if (entry === undefined)
        return yield* new InvalidRequest({
          message: 'Choose an integration from the current catalogue.',
        })
      const start = Effect.fn('Connections.beginCatalog')(
        (input: Parameters<ExecutorService['begin']>[0]) =>
          prepareBegin(executor, executor.begin(input)).pipe(Effect.mapError(publicBeginFailure)),
      )
      return yield* input
        .provide(begin(actor, request, entry, start))
        .pipe(
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
        id: ServiceId.make(`${IMPORTED}${source.address}`),
        name: request.name,
        description: '',
        mark: serviceLogo(source.address),
        authorization: ServiceAuthorization.cases.None.make({}),
      })
      const start: ExecutorService['begin'] = Effect.fn('Connections.import')((input) =>
        executor.add({ ...input, source }),
      )
      return yield* input.provide(
        begin(
          actor,
          // The name Vivid gave is the server's own, kept as the service's name. Nobody has
          // called the account anything yet. A Run importing an address has no client trip;
          // its initial browser return keeps the existing web destination.
          { service: importedService.id, name: null, shared: request.shared, from: 'Web' },
          importedService,
          (input) => prepareBegin(executor, start(input)).pipe(Effect.mapError(publicBeginFailure)),
        ),
      )
    }),
    /** Authored apps are personal and use the ordinary insertion/compensation boundary. */
    make: Effect.fn('Connections.make')(function* (actor: Actor, request: MakeIntegrationRequest) {
      const service = Service.make({
        id: madeService(request.name),
        name: request.name,
        description: '',
        mark: null,
        authorization: ServiceAuthorization.cases.None.make({}),
      })
      return yield* input.provide(
        begin(
          actor,
          { service: service.id, name: null, shared: false, from: 'Web' },
          service,
          (input) =>
            prepareBegin(executor, executor.make({ ...input, files: madeFiles(request) })).pipe(
              Effect.mapError(madeBeginFailure),
            ),
        ),
      )
    }),
  }
}

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

/** Fixed callbacks verify pending correlation again under a Connection lock, preventing replay
 * from dispatching another completion in this process. Executor also claims each OAuth attempt.
 */
const makeCallbacks = (
  input: Pick<Parameters<typeof makeManagement>[0], 'executor' | 'provide'>,
  withCallback: ReturnType<typeof serializeResumes>,
) => {
  const { executor, provide } = input
  /** Ownership, pending state, correlation, and fresh Company permission precede provider access. */
  const callback = Effect.fn('Connections.callback')(
    function* (actor: Actor, id: ConnectionId, callbackAddress: Redacted.Redacted) {
      const row = yield* provide(getRecord(actor, id, true))
      const hash = yield* callbackHash(callbackAddress)
      if (
        row.status !== 'needs-authorization' ||
        !ExecutorReferences.guards.OAuthSigningIn(row.references) ||
        row.references.stateHash !== hash
      )
        return yield* new NotFound({ message: 'Integration sign-in not found' })
      const managing = yield* provide(rowActor(actor, row))
      const references = yield* executor
        .completeSignIn({ references: row.references, callbackAddress })
        .pipe(Effect.mapError(executorFailure))
      const connection = yield* provide(finish(managing, row, references))
      return connection.state
    },
    (effect, _actor, id) => withCallback(effect, id),
  )
  return {
    /**
     * A browser coming back from a service's sign-in page: finishes the Integration its state
     * names, for the Person who began it, and says which surface that Person began it on.
     *
     * No session is asked for (`callbackTrip`). The actor is the row's own Person, by their own
     * hand; `callback` then takes the workspace from the row's Company and a fresh Membership, so
     * the personal space given here is only where that reading starts.
     */
    returning: Effect.fn('Connections.returning')(function* (address: Redacted.Redacted) {
      const trip = yield* provide(callbackTrip(yield* callbackHash(address)))
      const person = yield* provide(findPerson(trip.person))
      if (Option.isNone(person))
        return yield* new NotFound({ message: 'Integration sign-in not found' })
      const actor: Actor = {
        person: person.value,
        workspace: Workspace.cases.Personal.make({}),
        by: 'person',
        threadId: Option.none(),
      }
      const state = yield* callback(actor, trip.id, address)
      // Read after completion so the latest persisted trip decides where the browser hands back.
      const row = yield* provide(getRecord(actor, trip.id, true))
      return { id: trip.id, state, surface: row.returnsTo }
    }),
    callback,
  }
}

/** Resume evaluates the saved status before provider access, preserving operator setup refusals. */
const resumeExisting = Effect.fn('Connections.resumeExistingState')(function* (
  input: Parameters<typeof makeManagement>[0],
  actor: Actor,
  id: ConnectionId,
  from: SignInSurface,
) {
  const { executor, provide, get } = input
  const row = yield* get(actor, id)
  yield* mayManage(actor, row)
  if (ExecutorReferences.guards.MigrationPending(row.references))
    return yield* new ServiceUnavailable({
      service: 'connections',
      message: executorMigrationMessage,
    })
  return yield* Match.value(row.status).pipe(
    Match.when('ready', () =>
      // No trip is opened for an account that is already ready, so nothing is written: this is
      // also how a client asks whether a sign-in went through, and a question must not change
      // the row or be refused because the row has just changed.
      provide(publicConnection(actor, row)).pipe(
        Effect.map((connection) => ConnectionStep.cases.Done.make({ connection })),
      ),
    ),
    Match.when('failed', () =>
      Effect.fail(
        new InvalidRequest({ message: 'Remove this failed integration and connect again.' }),
      ),
    ),
    Match.when(
      'needs-authorization',
      Effect.fn('Connections.resumePending')(function* () {
        const service = (yield* executor.catalog.pipe(Effect.mapError(executorFailure))).find(
          (entry) => entry.id === row.service,
        )
        if (
          service !== undefined &&
          ServiceAuthorization.guards.SetupRequired(service.authorization)
        )
          return yield* new InvalidRequest({ message: connectionSetupMessage })
        const managing = yield* provide(rowActor(actor, row))
        const retained = yield* provide(retainTrip(managing, row, from))
        return yield* provide(resume(managing, retained))
      }),
    ),
    Match.exhaustive,
  )
})

/** Management shares the Layer's authority and publishes every persisted state change. */
const makeManagement = (input: {
  readonly executor: ExecutorService
  readonly database: typeof Database.Service
  readonly provide: ProvideAuthority
  readonly get: (
    actor: Actor,
    id: ConnectionId,
  ) => Effect.Effect<
    ConnectionRecord,
    | import('@vivid/contracts').NotFound
    | Conflict
    | InvalidRequest
    | ServiceUnavailable
    | import('../database/client.ts').DatabaseInfrastructureError
  >
}) => {
  const { executor, provide, get } = input
  const withResume = serializeResumes()
  return {
    /** Resume has exactly removal's scoped lookup and admin check, before provider access. */
    resume: Effect.fn('Connections.resumeExisting')(
      (actor: Actor, id: ConnectionId, from: SignInSurface) =>
        resumeExisting(input, actor, id, from),
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
    ...makeCallbacks(input, withResume),
    /**
     * What a Person calls an account is theirs to give, change and take away. Whoever may remove
     * the Connection may name it, so a member cannot rename the account their Company shares.
     * Nothing is asked of the service: the name is Vivid's own.
     */
    rename: Effect.fn('Connections.rename')(function* (
      actor: Actor,
      request: RenameConnectionRequest,
    ) {
      const row = yield* get(actor, request.id)
      yield* mayManage(actor, row)
      yield* provide(
        requireFreeName(actor, {
          service: row.service,
          name: request.name,
          companyId: row.companyId,
          except: row.id,
        }),
      )
      const saved = yield* provide(saveName(row, request.name))
      yield* provide(recordChanged(actor, saved))
      return yield* provide(publicConnection(actor, saved))
    }),
    /** Remove provider authority before deleting the scoped product record. */
    remove: Effect.fn('Connections.remove')(function* (actor: Actor, id: ConnectionId) {
      const row = yield* get(actor, id)
      yield* mayManage(actor, row)
      yield* provide(
        removeConnection(row).pipe(
          Effect.catchTag(
            'ConnectionReclamationBlocked',
            () =>
              new ServiceUnavailable({
                service: 'connections',
                message: 'Vivid cannot remove this integration right now. Try again later.',
              }),
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
