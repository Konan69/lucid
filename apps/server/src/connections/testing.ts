import * as NodeHttp from 'node:http'
import { expect } from '@effect/vitest'
import { NodeHttpClient, NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as NetAddress from 'effect/net/NetAddress'
import { eq, inArray } from 'drizzle-orm'
import { Clock, ConfigProvider, Context, Effect, Layer, Option, Ref, Schema } from 'effect'
import {
  Approval,
  ApprovalId,
  ApprovalState,
  AuditEvent,
  Company,
  CompanyId,
  ConnectionId,
  Person,
  PersonId,
  ProposedAction,
  ServiceAuthorization,
  ServiceId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { type Actor, summaryOf } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseLayer } from '../database/testdb.ts'
import { Audit } from '../audit/record.ts'
import { Gate, GateDecision, type GateExposure } from '../approvals/gate.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'
import {
  ExecutorAppOwnership,
  executorLayer,
  type AccountIdentity,
  type ExecutorService,
  type ExecutorActiveReferences,
  Executor,
  ExecutorAppId,
  ExecutorAuthorizationId,
  ExecutorAccountId,
  ExecutorBinding,
  ExecutorReferences,
  ExecutorServiceEntry,
  ExecutorStatus,
  ExecutorStep,
  ExecutorTool,
  ExecutorCallOutcome,
} from './executor.ts'
import { unconfiguredDecisionLayer } from '../decisions/model.ts'
import { googleService } from './google.ts'
import { keyedService } from './curation.ts'
import { toolEffectsLayer } from './effects.ts'
import { connectionStoreLayer } from './store.ts'

export const serviceId = ServiceId.make('test-service')
export const readTool = ExecutorTool.make({
  name: 'read',
  description: 'Read records',
  effect: 'read',
  input: {},
})
export const writeTool = ExecutorTool.make({
  name: 'write',
  description: 'Write records',
  effect: 'write',
  input: {},
})
const fixtureRouteMissing = Schema.TaggedStruct('FixtureRouteMissing', {})

/** Recording authority keeps external behavior deliberate while exercising the production store and SQL. */
interface ConnectionProbeService {
  readonly tools: Ref.Ref<readonly (typeof ExecutorTool.Type)[]>
  readonly calls: Ref.Ref<number>
  readonly inputs: Ref.Ref<ReadonlyArray<Parameters<ExecutorService['call']>[0]>>
  readonly signIns: Ref.Ref<number>
  readonly step: Ref.Ref<'Done' | 'OpenSignIn' | 'EnterKey'>
  readonly begins: Ref.Ref<number>
  readonly removals: Ref.Ref<number>
  readonly catalogs: Ref.Ref<number>
  readonly discoveries: Ref.Ref<number>
  readonly events: Ref.Ref<readonly AuditEvent[]>
  readonly checked: Ref.Ref<readonly { action: ProposedAction; exposure: GateExposure }[]>
  readonly decision: Ref.Ref<'Allowed' | 'Blocked' | 'ApprovalRequired'>
  readonly outcome: Ref.Ref<typeof ExecutorCallOutcome.Type>
  /** Who the service says the next account asked about is; none is a service that does not say. */
  readonly identity: Ref.Ref<Option.Option<AccountIdentity>>
}

export class ConnectionProbe extends Context.Service<ConnectionProbe, ConnectionProbeService>()(
  'vivid/ConnectionProbe',
) {}

/** Fixtures requiring a live app refuse migration-only states before building protocol values. */
export function activeReferences(references: ExecutorReferences): ExecutorActiveReferences {
  if (
    ExecutorReferences.guards.ReconnectRequired(references) ||
    ExecutorReferences.guards.MigrationPending(references)
  )
    expect.fail('An active app reference is required by this fixture')
  return references
}

/** Completion retains provider identity and supplies only an opaque account reference. */
const authorized = (input: ExecutorReferences) => {
  const references = activeReferences(input)
  return ExecutorReferences.cases.Authorized.make({
    appOwnership: references.appOwnership,
    service: references.service,
    app: references.app,
    binding: references.binding,
    owner: references.owner,

    account: ExecutorAccountId.make(crypto.randomUUID()),
  })
}

/** Source effects and recorded calls belong to the external adapter test boundary. */
const makeExecutor = (probe: ConnectionProbeService): ExecutorService => {
  return Executor.of({
    inventory: Effect.succeed({ apps: [], accounts: [], links: [] }),
    reconcile: () => Effect.die('Legacy rows require the real reconciliation adapter'),
    prepareRetirement: Effect.fn('Executor.Test.prepareRetirement')((resources) =>
      Effect.succeed(resources),
    ),
    retire: Effect.fn('Executor.Test.retire')(() => Effect.void),
    authorization: Effect.fn('Executor.Test.authorization')(() =>
      Effect.succeed(ServiceAuthorization.cases.None.make({})),
    ),
    catalog: Effect.gen(function* () {
      yield* Ref.update(probe.catalogs, (count) => count + 1)
      return [
        ExecutorServiceEntry.make({
          id: serviceId,
          name: 'Records',
          description: 'Read and write records',
          domain: null,
          authorization: ServiceAuthorization.cases.None.make({}),
        }),
      ]
    }).pipe(Effect.withSpan('Executor.Test.catalog')),
    add: Effect.fn('Executor.Test.add')((input) => makeExecutor(probe).begin(input)),
    make: Effect.fn('Executor.Test.make')((input) => makeExecutor(probe).begin(input)),
    begin: Effect.fn('Executor.Test.begin')(function* (input) {
      yield* Ref.update(probe.begins, (count) => count + 1)
      const identity = {
        appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
        service: input.service,
        owner: input.owner,

        app: ExecutorAppId.make(crypto.randomUUID()),
        binding: ExecutorBinding.cases.Public.make({}),
      }
      const step = yield* Ref.get(probe.step)
      if (step === 'OpenSignIn')
        return ExecutorStep.cases.OpenSignIn.make({
          references: ExecutorReferences.cases.SigningIn.make({
            ...identity,
            authorization: ExecutorAuthorizationId.make(crypto.randomUUID()),
          }),
          address: `https://example.test/sign-in?state=${input.connectionId}`,
        })
      if (step === 'EnterKey')
        return ExecutorStep.cases.EnterKey.make({
          references: ExecutorReferences.cases.EnteringKey.make({
            ...identity,
            authorization: ExecutorAuthorizationId.make(crypto.randomUUID()),
            method: 'key',
            label: input.label,
          }),
          fields: [{ name: 'key', label: 'Key' }],
        })
      return ExecutorStep.cases.Done.make({
        references: ExecutorReferences.cases.Public.make(identity),
      })
    }),
    /** Renewal deliberately retains the provider target while returning a fresh next step. */
    reauthorize: Effect.fn('Executor.Test.reauthorize')(function* (input) {
      const identity = {
        appOwnership: activeReferences(input.references).appOwnership,
        service: input.references.service,
        owner: input.references.owner,

        app: activeReferences(input.references).app,
        binding: activeReferences(input.references).binding,
      }
      const step = yield* Ref.get(probe.step)
      if (step === 'OpenSignIn')
        return ExecutorStep.cases.OpenSignIn.make({
          references: ExecutorReferences.cases.SigningIn.make({
            ...identity,
            authorization: ExecutorAuthorizationId.make(crypto.randomUUID()),
          }),
          address: `https://example.test/sign-in/${crypto.randomUUID()}?state=${input.connectionId}`,
        })
      if (step === 'EnterKey')
        return ExecutorStep.cases.EnterKey.make({
          references: ExecutorReferences.cases.EnteringKey.make({
            ...identity,
            authorization: ExecutorAuthorizationId.make(crypto.randomUUID()),
            method: 'key',
            label: input.label,
          }),
          fields: [{ name: 'key', label: 'Key' }],
        })
      return ExecutorStep.cases.Done.make({
        references: ExecutorReferences.cases.Public.make(identity),
      })
    }),
    complete: Effect.fn('Executor.Test.complete')(({ references }) =>
      Effect.succeed(authorized(references)),
    ),
    completeSignIn: Effect.fn('Executor.Test.signIn')(function* ({ references }) {
      yield* Ref.update(probe.signIns, (count) => count + 1)
      return authorized(references)
    }),
    status: Effect.fn('Executor.Test.status')((references) =>
      Effect.succeed(ExecutorStatus.cases.Ready.make({ references })),
    ),
    /** As the adapter does: only a Connection that holds an account has anyone to be. */
    identity: Effect.fn('Executor.Test.identity')(function* (references) {
      if (!ExecutorReferences.guards.Authorized(references)) return Option.none()
      return yield* Ref.get(probe.identity)
    }),
    remove: Effect.fn('Executor.Test.remove')(() =>
      Ref.update(probe.removals, (count) => count + 1),
    ),
    tools: Effect.fn('Executor.Test.tools')(function* () {
      yield* Ref.update(probe.discoveries, (count) => count + 1)
      return yield* Ref.get(probe.tools)
    }),
    call: Effect.fn('Executor.Test.call')(function* (input) {
      yield* Ref.update(probe.inputs, (inputs) => [...inputs, input])
      yield* Ref.update(probe.calls, (count) => count + 1)
      return yield* Ref.get(probe.outcome)
    }),
  })
}

/** A bounded Executor test Layer records dispatch and returns source-owned effects. */
const probeLayer = Layer.effectContext(
  Effect.gen(function* () {
    const probe = ConnectionProbe.of({
      tools: yield* Ref.make<readonly (typeof ExecutorTool.Type)[]>([readTool, writeTool]),
      calls: yield* Ref.make(0),
      inputs: yield* Ref.make<ReadonlyArray<Parameters<ExecutorService['call']>[0]>>([]),
      signIns: yield* Ref.make(0),
      step: yield* Ref.make<'Done' | 'OpenSignIn' | 'EnterKey'>('Done'),
      begins: yield* Ref.make(0),
      removals: yield* Ref.make(0),
      catalogs: yield* Ref.make(0),
      discoveries: yield* Ref.make(0),
      events: yield* Ref.make<readonly AuditEvent[]>([]),
      checked: yield* Ref.make<readonly { action: ProposedAction; exposure: GateExposure }[]>([]),
      decision: yield* Ref.make<'Allowed' | 'Blocked' | 'ApprovalRequired'>('Allowed'),
      outcome: yield* Ref.make<typeof ExecutorCallOutcome.Type>(
        ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }),
      ),
      identity: yield* Ref.make(Option.none<AccountIdentity>()),
    })
    const executor = makeExecutor(probe)
    const audit = Audit.of({
      record: Effect.fn('Audit.Test.record')((_actor, event) =>
        Ref.update(probe.events, (events) => [...events, event]),
      ),
    })
    const gate = Gate.of({
      check: Effect.fn('Gate.Test.check')(function* (actor, action, exposure) {
        yield* Ref.update(probe.checked, (checked) => [...checked, { action, exposure }])
        const decision = yield* Ref.get(probe.decision)
        if (decision === 'Allowed') return GateDecision.cases.Allowed.make({})
        if (decision === 'Blocked')
          return GateDecision.cases.Blocked.make({ rule: 'Never change records.' })
        const threadId = Option.getOrElse(actor.threadId, () => ThreadId.make('approval-test'))
        const now = yield* Clock.currentTimeMillis
        return GateDecision.cases.ApprovalRequired.make({
          approval: Approval.make({
            id: ApprovalId.make(crypto.randomUUID()),
            threadId,
            runId: null,
            action,
            digest: 'test-digest',
            askedOf: summaryOf(actor.person),
            state: ApprovalState.cases.Pending.make({ expiresAt: now + 60_000 }),
            createdAt: now,
          }),
        })
      }),
    })
    return Context.make(ConnectionProbe, probe).pipe(
      Context.add(Executor, executor),
      Context.add(Audit, audit),
      Context.add(Gate, gate),
    )
  }),
)

const dependencies = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  silentChangesLayer,
  probeLayer,
  toolEffectsLayer.pipe(Layer.provideMerge(unconfiguredDecisionLayer)),
)
export const connectionTestLayer = connectionStoreLayer.pipe(Layer.provideMerge(dependencies))

/** Cleanup is installed before the first write and only touches unique disposable test identities. */
export const fixture = Effect.fn('Connections.Test.fixture')(function* () {
  const database = yield* Database
  const probe = yield* ConnectionProbe
  const prior = {
    step: yield* Ref.get(probe.step),
    outcome: yield* Ref.get(probe.outcome),
    tools: yield* Ref.get(probe.tools),
    decision: yield* Ref.get(probe.decision),
    identity: yield* Ref.get(probe.identity),
  }
  // Controls are restored even when an assertion fails before a test's happy-path reset.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Ref.set(probe.step, prior.step)
      yield* Ref.set(probe.outcome, prior.outcome)
      yield* Ref.set(probe.tools, prior.tools)
      yield* Ref.set(probe.decision, prior.decision)
      yield* Ref.set(probe.identity, prior.identity)
    }),
  )
  const suffix = crypto.randomUUID()
  const owner = Person.make({
    id: PersonId.make(`connection-owner-${suffix}`),
    name: 'Owner',
    email: `owner-${suffix}@example.test`,
  })
  const member = Person.make({
    id: PersonId.make(`connection-member-${suffix}`),
    name: 'Member',
    email: `member-${suffix}@example.test`,
  })
  const company = Company.make({
    id: CompanyId.make(`connection-company-${suffix}`),
    name: 'Test Company',
    slug: `connection-company-${suffix}`,
  })
  const threadId = ThreadId.make(`connection-thread-${suffix}`)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
      yield* database.run(
        database.delete(personTable).where(inArray(personTable.id, [owner.id, member.id])),
      )
    }).pipe(Effect.catch(() => Effect.logError('Connection fixture cleanup failed'))),
  )
  yield* database.run(database.insert(personTable).values([owner, member]))
  yield* database.run(
    database.insert(companyTable).values({ id: company.id, name: company.name, slug: company.id }),
  )
  yield* database.run(
    database.insert(membershipTable).values([
      { id: `owner-${suffix}`, companyId: company.id, userId: owner.id, role: 'owner' },
      { id: `member-${suffix}`, companyId: company.id, userId: member.id, role: 'member' },
    ]),
  )
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      title: 'Connection test',
      titleSource: 'Person',
      updatedAt: yield* Clock.currentTimeMillis,
      personId: owner.id,
      companyId: company.id,
      audience: 'company',
    }),
  )
  const ownerActor: Actor = {
    person: owner,
    workspace: Workspace.cases.Company.make({ company, role: 'owner' }),
    by: 'person',
    threadId: Option.none(),
  }
  const memberActor: Actor = {
    person: member,
    workspace: Workspace.cases.Company.make({ company, role: 'member' }),
    by: 'vivid',
    threadId: Option.some(threadId),
  }
  const personalActor: Actor = {
    person: owner,
    workspace: Workspace.cases.Personal.make({}),
    by: 'vivid',
    threadId: Option.some(threadId),
  }
  return { ownerActor, memberActor, personalActor, threadId }
})

/** Requests carry no effect claim: the provider's classification is the only source. */
export const toolRequest = (connectionId: ConnectionId, tool: string) => ({
  connectionId,
  tool,
  input: {},
  summary: 'Read the records',
  rationale: 'Answer the question',
})

const HostedInstall = Schema.Struct({ name: Schema.NonEmptyString })
const HostedImport = Schema.Struct({ source: HostedInstall })
const HostedRequirements = Schema.Record(
  Schema.String,
  Schema.Struct({ provider: Schema.String, definition: Schema.Json }),
)
const decodeHostedRequirements = Schema.decodeUnknownEffect(HostedRequirements)
const decodeHostedTarget = Schema.decodeUnknownEffect(
  Schema.Struct({ app: Schema.String, requirement: Schema.String }),
)
const decodeHostedSelections = Schema.decodeUnknownEffect(
  Schema.Record(Schema.String, Schema.Array(Schema.String)),
)
const decodeHostedInstall = Schema.decodeUnknownEffect(HostedInstall)
const decodeHostedImport = Schema.decodeUnknownEffect(HostedImport)
const decodeHostedJson = Schema.decodeUnknownEffect(Schema.Json)

/**
 * What Executor's own catalogue contributed to a list. Vivid's Google services lead every list
 * and come from the server itself, so a test about the remote catalogue reads past them.
 */
export function remoteEntries<Entry extends { readonly id: ServiceId }>(entries: readonly Entry[]) {
  return entries.filter(
    (entry) => Option.isNone(googleService(entry.id)) && keyedService(entry.id) === undefined,
  )
}

export const hostedOrganization = 'test-organization'
export const hostedPrefix = `/api/organizations/${hostedOrganization}`
export const hostedService = ServiceId.make('test/service')
export const hostedReturnAddress = 'https://vivid.example.test/api/connections/return'
const hostedRemoved = { removed: true }
export const hostedTools = [
  { name: 'read', description: 'Read records', inputSchema: {}, readOnly: true },
]

interface HostedRequest {
  readonly peer: {
    readonly address: Option.Option<string>
    readonly port: Option.Option<number>
  }
  readonly path: string
  readonly search: string
  readonly body: Schema.Json
  readonly headers: Readonly<Record<string, string>>
}
interface HostedReply {
  readonly status: number
  readonly body: Schema.Json
}
interface HostedState {
  readonly target: Ref.Ref<Schema.Json>
  readonly intercept: Ref.Ref<(request: HostedRequest) => Effect.Effect<void>>
  /** Drop or hold an answer after the fixture has committed the write. */
  readonly afterWrite: Ref.Ref<
    (request: HostedRequest) => Effect.Effect<void, never, HttpServerRequest.HttpServerRequest>
  >
  readonly requests: Ref.Ref<readonly HostedRequest[]>
  readonly replies: Ref.Ref<ReadonlyMap<string, HostedReply>>
  readonly apps: Ref.Ref<readonly { readonly id: string; readonly name: string }[]>
  readonly selections: Ref.Ref<ReadonlyMap<string, Schema.Json>>
  readonly accounts: Ref.Ref<Schema.Json>
  readonly catalog: Ref.Ref<readonly Schema.Json[]>
  readonly paginated: Ref.Ref<boolean>
  readonly redirectUri: Ref.Ref<string>
  readonly result: Ref.Ref<Schema.Json>
  /** What the app's own check says the account is (`AccountHealth.info`); null is an app with
   * no check, which is what most of the catalogue is. */
  readonly identity: Ref.Ref<Schema.Json>
}

/** Each installation has its own foreign identity; the remote app's provider declaration drives Vivid's form and OAuth method selection. */
const hostedApp = Effect.fn('Executor.HostedTest.app')(function* (
  state: HostedState,
  app: { readonly id: string; readonly name: string },
) {
  const requirements = yield* decodeHostedRequirements(yield* Ref.get(state.accounts))
  const accounts = Object.fromEntries(
    Object.entries(requirements).map(([name, value]) => [
      name,
      { ...value, scope: 'user', cardinality: 'one' },
    ]),
  )
  return {
    id: app.id,
    name: app.name,
    activeVersion: 'version',
    copiedFrom: null,
    requirements: { accounts },
  }
})

/** The name a request creates an app under: install and deploy name it at the top of the body,
 * an import names it in `source`. None for every other request. */
const hostedAppName = Effect.fn('Executor.HostedTest.appName')(function* (request: HostedRequest) {
  if (request.path === 'POST /apps/import')
    return Option.some((yield* decodeHostedImport(request.body)).source.name)
  if (request.path === 'POST /apps/install' || request.path === 'POST /apps/deploy')
    return Option.some((yield* decodeHostedInstall(request.body)).name)
  return Option.none<string>()
})

/** A removed app takes its account selections with it; an unlinked account leaves its app's
 * selection without it. Anything else is not a removal. */
const hostedRemoval = Effect.fn('Executor.HostedTest.removal')(function* (
  state: HostedState,
  request: HostedRequest,
) {
  const removedApp = request.path.match(/^DELETE \/apps\/([^/]+)$/u)
  if (removedApp !== null) {
    const id = removedApp[1]
    yield* Ref.update(state.apps, (apps) => apps.filter((app) => app.id !== id))
    yield* Ref.update(state.selections, (selections) => {
      const retained = new Map(selections)
      if (id !== undefined) retained.delete(id)
      return retained
    })
    return Option.some(hostedRemoved)
  }
  const unlinked = request.path.match(
    /^DELETE \/apps\/([^/]+)\/accounts\/(?:app|user)\/([^/]+)\/([^/]+)$/u,
  )
  if (unlinked !== null) {
    const [, app, requirement, account] = unlinked
    if (app === undefined || requirement === undefined || account === undefined)
      return yield* Effect.die('Malformed fixture unlink target')
    const selection = (yield* Ref.get(state.selections)).get(app)
    if (selection === undefined) return Option.some(hostedRemoved)
    const decoded = yield* decodeHostedSelections(selection)
    const accounts = decoded[requirement]
    if (accounts === undefined) return Option.some(hostedRemoved)
    yield* Ref.update(state.selections, (selections) =>
      new Map(selections).set(app, {
        ...decoded,
        [requirement]: accounts.filter((selected) => selected !== account),
      }),
    )
    return Option.some(hostedRemoved)
  }
  return Option.none<typeof hostedRemoved>()
})

/** Simulate create-only app installation plus ConnectionId app deduplication on the remote
 * side. Tests observe the real Executor Layer's requests rather than a fake Executor service.
 */
const hostedWrite = Effect.fn('Executor.HostedTest.write')(function* (
  state: HostedState,
  request: HostedRequest,
) {
  const named = yield* hostedAppName(request)
  if (Option.isSome(named)) {
    const app = yield* Ref.modify(state.apps, (apps) => {
      const created = {
        id: apps.length === 0 ? 'app' : `app-${apps.length + 1}`,
        name: named.value,
      }
      return [created, [...apps, created]]
    })
    return yield* hostedApp(state, app)
  }
  const removal = yield* hostedRemoval(state, request)
  if (Option.isSome(removal)) return removal.value
  const connectionPath = request.path.match(
    /^POST \/apps\/([^/]+)\/accounts\/(?:app|user)\/([^/]+)\/connections$/u,
  )
  if (connectionPath !== null) {
    const app = connectionPath[1]
    const requirement = connectionPath[2]
    if (app === undefined || requirement === undefined)
      return yield* Effect.die('Malformed test account target')
    const target = { app, requirement }
    yield* Ref.set(state.target, target)
    return {
      id: 'authorization',
      reconnectAccount: null,
      target,
      state: { status: 'pending' },
      url: 'https://executor.example.test/form',
    }
  }
  if (
    request.path === 'POST /connections/authorization/submit' ||
    request.path === 'POST /connections/authorization/oauth/complete'
  ) {
    const target = yield* Ref.get(state.target).pipe(Effect.flatMap(decodeHostedTarget))
    yield* Ref.update(state.selections, (all) =>
      new Map(all).set(target.app, { [target.requirement]: ['account'] }),
    )
    return { id: 'account' }
  }
  if (request.path === 'POST /connections/authorization/oauth/start')
    return {
      status: 'redirect',
      authorizationUrl:
        'https://provider.example.test/sign-in?state=hosted-fixture-oauth-state-00000000',
      redirectUri: yield* Ref.get(state.redirectUri),
      expiresAt: '2026-10-04T00:00:00Z',
    }
  if (/^POST \/apps\/[^/]+\/tools\/call$/u.test(request.path)) return yield* Ref.get(state.result)
  // HostedAccounts.check: runs the app's check and answers with the account's health.
  if (request.path === 'POST /accounts/account/health')
    return {
      account: 'account',
      info: yield* Ref.get(state.identity),
      infoCheckedAt: null,
      apps: [],
    }
  return hostedRemoved
})

/** Tool pages retain a version and exact selections while the fixture router stays independent. */
const hostedPage = Effect.fn('Executor.HostedTest.page')(function* (
  state: HostedState,
  request: HostedRequest,
) {
  const search = new URLSearchParams(request.search)
  const appId = request.path.split('/')[2]
  if (appId === undefined) return yield* Effect.die('Missing fixture app')
  const selection = (yield* Ref.get(state.selections)).get(appId)
  const page = {
    accounts: { app: {}, user: selection === undefined ? {} : selection },
    version: 'version',
    items: hostedTools,
    routers: [],
  }
  if (!(yield* Ref.get(state.paginated))) return page
  if (search.has('cursor'))
    return {
      ...page,
      items: [{ name: 'write', description: 'Write records', inputSchema: {}, readOnly: false }],
    }
  return { ...page, next: 'next/with+&symbols' }
})

/** Both pages carry the same account/version snapshot; the cursor intentionally needs URL
 * encoding so a broken query builder cannot accidentally turn it into another search parameter.
 */
const hostedRead = Effect.fn('Executor.HostedTest.read')(function* (
  state: HostedState,
  request: HostedRequest,
) {
  if (request.path === 'GET /catalog') return yield* Ref.get(state.catalog)
  if (request.path === 'GET /inventory') {
    const apps = yield* Effect.forEach(yield* Ref.get(state.apps), (app) => hostedApp(state, app))
    return { apps, links: [], accounts: [{ id: 'unrelated-account', label: 'Same label' }] }
  }
  const appPath = request.path.match(/^GET \/apps\/([^/]+)$/u)
  if (appPath !== null) {
    const app = (yield* Ref.get(state.apps)).find((candidate) => candidate.id === appPath[1])
    if (app === undefined) return yield* Effect.die('Hosted fixture app was not installed')
    return yield* hostedApp(state, app)
  }
  if (/^GET \/apps\/[^/]+\/tools$/u.test(request.path)) return yield* hostedPage(state, request)
  const links = request.path.match(/^GET \/apps\/([^/]+)\/accounts\/(?:app|user)$/u)
  if (links !== null) {
    const app = links[1]
    if (app === undefined) return yield* Effect.die('Missing link app')
    const selection = (yield* Ref.get(state.selections)).get(app)
    if (selection === undefined) return []
    const decoded = yield* decodeHostedSelections(selection)
    return Object.entries(decoded).flatMap(([requirement, accounts]) =>
      accounts.map((id) => ({ requirement, account: { id } })),
    )
  }
  if (request.path.startsWith('GET /providers/'))
    return { mode: 'automatic', clients: [], grant: 'authorization_code', scopes: [] }
  if (request.path === 'GET /connections/authorization')
    return {
      id: 'authorization',
      reconnectAccount: null,
      target: yield* Ref.get(state.target),
      state: { status: 'pending' },
    }
  return hostedRemoved
})

/** This scoped HTTP fixture reuses the old transport suite's loopback-server mechanism. No
 * production process, Executor instance, credentials, or database is involved. Unknown routes
 * fail explicitly, so forgotten local endpoints cannot pass using a permissive response.
 */
export const hostedExecutorFixture = Effect.fn('Executor.HostedTest.fixture')(function* () {
  const state: HostedState = {
    target: yield* Ref.make<Schema.Json>({ app: 'app', requirement: 'slot' }),
    intercept: yield* Ref.make<(request: HostedRequest) => Effect.Effect<void>>(() => Effect.void),
    afterWrite: yield* Ref.make<
      (request: HostedRequest) => Effect.Effect<void, never, HttpServerRequest.HttpServerRequest>
    >(() => Effect.void),
    requests: yield* Ref.make<readonly HostedRequest[]>([]),
    replies: yield* Ref.make<ReadonlyMap<string, HostedReply>>(new Map()),
    apps: yield* Ref.make<readonly { readonly id: string; readonly name: string }[]>([]),
    selections: yield* Ref.make<ReadonlyMap<string, Schema.Json>>(new Map()),
    accounts: yield* Ref.make<Schema.Json>({}),
    catalog: yield* Ref.make<readonly Schema.Json[]>([
      {
        id: hostedService,
        package: '@test/service',
        auth: [],
        icons: [],
        name: 'Test Integration',
        description: 'Test service',
        connectUrl: 'https://example.test',
      },
    ]),
    paginated: yield* Ref.make(false),
    redirectUri: yield* Ref.make(hostedReturnAddress),
    result: yield* Ref.make<Schema.Json>({
      content: [{ type: 'text', text: 'Done' }],
      structuredContent: { ok: true },
      isError: false,
    }),
    identity: yield* Ref.make<Schema.Json>(null),
  }
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  const handler = Effect.fn('Executor.HostedTest.request')(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, 'http://fixture.test')
    // Capture the active peer before reading a body can close its socket. Absent peer metadata
    // stays explicit so a disconnected peer never acquires invented diagnostic metadata.
    const socket = NodeHttpServerRequest.toIncomingMessage(request).socket
    const peer = {
      address: Option.fromUndefinedOr(socket.remoteAddress),
      port: Option.fromUndefinedOr(socket.remotePort),
    }
    const body =
      request.headers['content-type'] === 'application/json'
        ? yield* request.json.pipe(Effect.flatMap(decodeHostedJson))
        : null
    const received = {
      peer,
      path: `${request.method} ${url.pathname}`,
      search: url.search,
      body,
      headers: request.headers,
    }
    yield* Ref.update(state.requests, (items) => [...items, received])
    yield* (yield* Ref.get(state.intercept))(received)
    const reply = (yield* Ref.get(state.replies)).get(received.path)
    if (reply !== undefined)
      return HttpServerResponse.jsonUnsafe(reply.body, { status: reply.status })
    if (!url.pathname.startsWith(`${hostedPrefix}/`))
      return HttpServerResponse.jsonUnsafe(fixtureRouteMissing.make({}), { status: 404 })
    const local = {
      ...received,
      path: `${request.method} ${url.pathname.slice(hostedPrefix.length)}`,
    }
    if (!hostedRoute(local.path))
      return HttpServerResponse.jsonUnsafe(fixtureRouteMissing.make({}), { status: 404 })
    const result =
      request.method === 'GET' ? yield* hostedRead(state, local) : yield* hostedWrite(state, local)
    if (request.method !== 'GET') yield* (yield* Ref.get(state.afterWrite))(received)
    return HttpServerResponse.jsonUnsafe(result)
  })
  yield* server.serve(handler())
  if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die('Expected TCP fixture')
  const url = yield* Effect.fromResult(NetAddress.toUrl(server.address))
  // Match production's scoped dispatcher: destroy this fixture's keep-alive connections before
  // its listener closes, rather than waiting for a global fetch pool's real-time idle expiry.
  // A fresh layer keeps a suite memo map from lending another fixture a closed dispatcher.
  const configured = executorLayer.pipe(
    Layer.provide(Layer.fresh(NodeHttpClient.layerUndici)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          GOOGLE_CLIENT_ID: 'isolated-test-client',
          GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
          VIVID_EXECUTOR_URL: url.href.replace(/\/$/u, ''),
          VIVID_EXECUTOR_KEY: 'isolated-test-key',
          VIVID_EXECUTOR_ORGANIZATION: hostedOrganization,
          VIVID_EXECUTOR_PUBLIC_ONLY: true,
        }),
      ),
    ),
  )
  return { ...state, configured }
})

/** Requirement-scoped account connections and app removal are the beta.23 public routes. */
function hostedRoute(path: string) {
  return (
    [
      'GET /catalog',
      'GET /inventory',
      'GET /providers/provider/oauth/oauth/setup',
      'GET /connections/authorization',
      'POST /apps/install',
      'POST /apps/deploy',
      'POST /apps/import',
      'POST /accounts/account/health',
      'POST /connections/authorization/submit',
      'POST /connections/authorization/oauth/start',
      'POST /connections/authorization/oauth/complete',
      'DELETE /accounts/account',
    ].includes(path) ||
    /^GET \/apps\/[^/]+(?:\/tools|\/accounts\/(?:app|user))?$/u.test(path) ||
    /^POST \/apps\/[^/]+\/tools\/call$/u.test(path) ||
    /^POST \/apps\/[^/]+\/accounts\/(?:app|user)\/[^/]+\/connections$/u.test(path) ||
    /^DELETE \/apps\/[^/]+(?:\/accounts\/(?:app|user)\/[^/]+\/[^/]+)?$/u.test(path)
  )
}
