import * as NodeHttp from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as NetAddress from 'effect/unstable/net/NetAddress'
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
  executorLayer,
  type ExecutorService,
  Executor,
  ExecutorAppId,
  ExecutorAuthorizationId,
  ExecutorAccountId,
  ExecutorProfileId,
  ExecutorReferences,
  ExecutorServiceEntry,
  ExecutorStatus,
  ExecutorStep,
  ExecutorTool,
  ExecutorCallOutcome,
} from './executor.ts'
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
}

export class ConnectionProbe extends Context.Service<ConnectionProbe, ConnectionProbeService>()(
  'vivid/ConnectionProbe',
) {}

/** Completion retains provider identity and supplies only an opaque account reference. */
const authorized = (references: ExecutorReferences) =>
  ExecutorReferences.cases.Authorized.make({
    service: references.service,
    app: references.app,
    profile: references.profile,
    owner: references.owner,
    account: ExecutorAccountId.make(crypto.randomUUID()),
  })

/** Source effects and recorded calls belong to the external adapter test boundary. */
const makeExecutor = (probe: ConnectionProbeService): ExecutorService => {
  return Executor.of({
    configured: true,
    authorization: Effect.fn('Executor.Test.authorization')(() =>
      Effect.succeed(ServiceAuthorization.cases.None.make({})),
    ),
    catalog: Effect.fn('Executor.Test.catalog')(function* () {
      yield* Ref.update(probe.catalogs, (count) => count + 1)
      return [
        ExecutorServiceEntry.make({
          id: serviceId,
          name: 'Records',
          description: 'Read and write records',
          authorization: ServiceAuthorization.cases.None.make({}),
        }),
      ]
    }),
    add: Effect.fn('Executor.Test.add')((input) => makeExecutor(probe).begin(input)),
    begin: Effect.fn('Executor.Test.begin')(function* (input) {
      yield* Ref.update(probe.begins, (count) => count + 1)
      const identity = {
        service: input.service,
        owner: input.owner,
        app: ExecutorAppId.make(crypto.randomUUID()),
        profile: ExecutorProfileId.make(crypto.randomUUID()),
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
        service: input.references.service,
        owner: input.references.owner,
        app: input.references.app,
        profile: input.references.profile,
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
    remove: Effect.fn('Executor.Test.remove')(() =>
      Ref.update(probe.removals, (count) => count + 1),
    ),
    tools: Effect.fn('Executor.Test.tools')(function* () {
      yield* Ref.update(probe.discoveries, (count) => count + 1)
      return yield* Ref.get(probe.tools)
    }),
    call: Effect.fn('Executor.Test.call')(function* () {
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
)
export const connectionTestLayer = connectionStoreLayer.pipe(Layer.provideMerge(dependencies))

/** Cleanup is installed before the first write and only touches unique disposable test identities. */
export const fixture = Effect.fn('Connections.Test.fixture')(function* () {
  const database = yield* Database
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
const HostedTargetInput = Schema.Struct({ profile: Schema.NonEmptyString })
const decodeHostedTarget = Schema.decodeUnknownEffect(HostedTargetInput)
const HostedProfileInput = Schema.Struct({ idempotencyKey: Schema.NonEmptyString })
const decodeHostedInstall = Schema.decodeUnknownEffect(HostedInstall)
const decodeHostedImport = Schema.decodeUnknownEffect(HostedImport)
const decodeHostedProfileInput = Schema.decodeUnknownEffect(HostedProfileInput)
const decodeHostedJson = Schema.decodeUnknownEffect(Schema.Json)

export const hostedOrganization = 'test-organization'
export const hostedPrefix = `/api/organizations/${hostedOrganization}`
export const hostedService = ServiceId.make('test/service')
export const hostedReturnAddress = 'https://vivid.example.test/api/connections/return'
const hostedProfile = { id: 'profile', status: 'ready', failure: null }
export const hostedTools = [
  { name: 'read', description: 'Read records', inputSchema: {}, readOnly: true },
]

interface HostedRequest {
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
  readonly requests: Ref.Ref<readonly HostedRequest[]>
  readonly replies: Ref.Ref<ReadonlyMap<string, HostedReply>>
  readonly apps: Ref.Ref<readonly { readonly id: string; readonly name: string }[]>
  readonly profiles: Ref.Ref<ReadonlyMap<string, string>>
  readonly accounts: Ref.Ref<Schema.Json>
  readonly catalog: Ref.Ref<readonly Schema.Json[]>
  readonly paginated: Ref.Ref<boolean>
  readonly redirectUri: Ref.Ref<string>
  readonly result: Ref.Ref<Schema.Json>
}

/** Each installation has its own foreign identity; the remote app's provider declaration drives Vivid's form and OAuth method selection. */
const hostedApp = Effect.fn('Executor.HostedTest.app')(function* (
  state: HostedState,
  app: { readonly id: string; readonly name: string },
) {
  return { id: app.id, name: app.name, requirements: { accounts: yield* Ref.get(state.accounts) } }
})

/** Simulate create-only app installation plus ConnectionId profile deduplication on the remote
 * side. Tests observe the real Executor Layer's requests rather than a fake Executor service.
 */
const hostedWrite = Effect.fn('Executor.HostedTest.write')(function* (
  state: HostedState,
  request: HostedRequest,
) {
  if (request.path === 'POST /apps/install' || request.path === 'POST /apps/import') {
    const { name } =
      request.path === 'POST /apps/install'
        ? yield* decodeHostedInstall(request.body)
        : (yield* decodeHostedImport(request.body)).source
    const app = yield* Ref.modify(state.apps, (apps) => {
      const created = { id: apps.length === 0 ? 'app' : `app-${apps.length + 1}`, name }
      return [created, [...apps, created]]
    })
    return yield* hostedApp(state, app)
  }
  if (/^POST \/apps\/[^/]+\/profiles$/u.test(request.path)) {
    const { idempotencyKey } = yield* decodeHostedProfileInput(request.body)
    const id = yield* Ref.modify(state.profiles, (profiles) => {
      const existing = profiles.get(idempotencyKey)
      if (existing !== undefined) return [existing, profiles]
      const created = `profile-${idempotencyKey}`
      return [created, new Map([...profiles, [idempotencyKey, created]])]
    })
    return { ...hostedProfile, id }
  }
  const connectionPath = request.path.match(/^POST \/apps\/([^/]+)\/connections$/u)
  if (connectionPath !== null) {
    const app = connectionPath[1]
    if (app === undefined) return yield* Effect.die('Hosted fixture connection app is absent')
    const { profile } = yield* decodeHostedTarget(request.body)
    const target = { app, profile }
    yield* Ref.set(state.target, target)
    return {
      id: 'authorization',
      reconnectAccount: null,
      target,
      state: { status: 'pending' },
      url: 'https://executor.example.test/form',
    }
  }
  if (request.path === 'POST /accounts/account/connections')
    return {
      id: 'authorization',
      reconnectAccount: { id: 'account' },
      target: null,
      state: { status: 'pending' },
    }
  if (
    request.path === 'POST /connections/authorization/submit' ||
    request.path === 'POST /connections/authorization/oauth/complete'
  )
    return { id: 'account' }
  if (request.path === 'POST /connections/authorization/oauth/start')
    return {
      status: 'redirect',
      authorizationUrl:
        'https://provider.example.test/sign-in?state=hosted-fixture-oauth-state-00000000',
      redirectUri: yield* Ref.get(state.redirectUri),
      expiresAt: '2026-10-04T00:00:00Z',
    }
  if (/^POST \/apps\/[^/]+\/tools\/call$/u.test(request.path)) return yield* Ref.get(state.result)
  return hostedProfile
})

/** Both pages carry the same profile/deployment snapshot; the cursor intentionally needs URL
 * encoding so a broken query builder cannot accidentally turn it into another search parameter.
 */
const hostedRead = Effect.fn('Executor.HostedTest.read')(function* (
  state: HostedState,
  request: HostedRequest,
) {
  if (request.path === 'GET /catalog') return yield* Ref.get(state.catalog)
  if (request.path === 'GET /inventory') {
    const apps = yield* Effect.forEach(yield* Ref.get(state.apps), (app) => hostedApp(state, app))
    return { apps, accounts: [{ id: 'unrelated-account', label: 'Same label' }] }
  }
  const appPath = request.path.match(/^GET \/apps\/([^/]+)$/u)
  if (appPath !== null) {
    const app = (yield* Ref.get(state.apps)).find((candidate) => candidate.id === appPath[1])
    if (app === undefined) return yield* Effect.die('Hosted fixture app was not installed')
    return yield* hostedApp(state, app)
  }
  if (/^GET \/apps\/[^/]+\/tools$/u.test(request.path)) {
    const search = new URLSearchParams(request.search)
    const profile = search.get('profile')
    const page = {
      profile,
      profileRevision: 1,
      deployment: 'deployment',
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
  }
  if (request.path.startsWith('GET /providers/'))
    return { mode: 'automatic', grant: 'authorization_code', scopes: [] }
  if (request.path === 'GET /connections/authorization')
    return {
      id: 'authorization',
      reconnectAccount: null,
      target: yield* Ref.get(state.target),
      state: { status: 'pending' },
    }
  return hostedProfile
})

/** This scoped HTTP fixture reuses the old transport suite's loopback-server mechanism. No
 * production process, Executor instance, credentials, or database is involved. Unknown routes
 * fail explicitly, so forgotten local endpoints cannot pass using a permissive response.
 */
export const hostedExecutorFixture = Effect.fn('Executor.HostedTest.fixture')(function* () {
  const state: HostedState = {
    target: yield* Ref.make<Schema.Json>({ app: 'app', profile: 'profile' }),
    intercept: yield* Ref.make<(request: HostedRequest) => Effect.Effect<void>>(() => Effect.void),
    requests: yield* Ref.make<readonly HostedRequest[]>([]),
    replies: yield* Ref.make<ReadonlyMap<string, HostedReply>>(new Map()),
    apps: yield* Ref.make<readonly { readonly id: string; readonly name: string }[]>([]),
    profiles: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
    accounts: yield* Ref.make<Schema.Json>({}),
    catalog: yield* Ref.make<readonly Schema.Json[]>([
      {
        id: hostedService,
        kind: 'mcp',
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
  }
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  const handler = Effect.fn('Executor.HostedTest.request')(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, 'http://fixture.test')
    const body =
      request.headers['content-type'] === 'application/json'
        ? yield* request.json.pipe(Effect.flatMap(decodeHostedJson))
        : null
    const received = {
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
    return HttpServerResponse.jsonUnsafe(result)
  })
  yield* server.serve(handler())
  if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die('Expected TCP fixture')
  const url = yield* Effect.fromResult(NetAddress.toUrl(server.address))
  const configured = executorLayer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
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

/** Profile IDs are dynamic because the remote host, rather than Vivid, allocates them. */
function hostedRoute(path: string) {
  return (
    [
      'GET /catalog',
      'GET /inventory',
      'GET /providers/provider/oauth/oauth/setup',
      'GET /connections/authorization',
      'POST /apps/install',
      'POST /apps/import',
      'POST /accounts/account/connections',
      'POST /connections/authorization/submit',
      'POST /connections/authorization/oauth/start',
      'POST /connections/authorization/oauth/complete',
      'DELETE /accounts/account',
    ].includes(path) ||
    /^GET \/apps\/[^/]+(?:\/tools)?$/u.test(path) ||
    /^POST \/apps\/[^/]+\/(?:profiles|connections|tools\/call)$/u.test(path) ||
    /^(?:GET|DELETE) \/apps\/[^/]+\/profiles\/[^/]+$/u.test(path) ||
    /^POST \/apps\/[^/]+\/profiles\/[^/]+\/reconcile$/u.test(path)
  )
}
