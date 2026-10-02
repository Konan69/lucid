import * as NodeHttp from 'node:http'
import { NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  ConnectionId,
  InvalidRequest,
  ServiceAuthorization,
  ServiceId,
  ServiceUnavailable,
} from '@vivid/contracts'
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Result,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as NetAddress from 'effect/unstable/net/NetAddress'
import {
  Executor,
  ExecutorAppId,
  ExecutorAccountId,
  ExecutorAuthorizationId,
  ExecutorCallOutcome,
  ExecutorResumeOutcome,
  ExecutorOwnerId,
  ExecutorProfileId,
  ExecutorReferences,
  ExecutorRequestId,
  ExecutorCopyRetained,
  ExecutorStep,
  ExecutorPublicAddressRequired,
  executorLayer,
  connectionSetupMessage,
} from './executor.ts'
import { executorFailure } from './errors.ts'
import { ConnectionSource } from './address.ts'
import { connectionStoreLayer, ConnectionStore } from './store.ts'
import { connectionTestLayer } from './testing.ts'
import { testConfigLayer, testDatabaseConfigured } from '../database/testdb.ts'
import { ServiceCatalog } from '@vivid/contracts'

const service = ServiceId.make('test/service')
const references = ExecutorReferences.cases.Public.make({
  service,
  app: ExecutorAppId.make('app'),
  profile: ExecutorProfileId.make('profile'),
  owner: ExecutorOwnerId.make('p-owner'),
})
const Fault = Schema.TaggedUnion({
  Reset: {},
  Reply: { status: Schema.Int, body: Schema.Json },
})
type Fault = typeof Fault.Type
const reply = (status: number, body: typeof Schema.Json.Type) =>
  Fault.cases.Reply.make({ status, body })
const defaultCatalog = [
  {
    id: service,
    kind: 'mcp',
    name: 'Test',
    description: 'Test service',
    connectUrl: 'https://example.test',
    auth: { kind: 'none' },
  },
  { kind: 'future-kind' },
]
/** Minimal remote entries leave popularity absent unless that particular wire entry supplies it. */
function catalogService(name: string) {
  return {
    id: name,
    kind: 'mcp',
    name,
    description: name,
    connectUrl: 'https://example.test',
    auth: { kind: 'none' },
  }
}
const page = {
  items: [{ name: 'read', description: 'Read records', inputSchema: {}, readOnly: true }],
  deployment: 'deployment',
  profileRevision: 1,
}
const profile = { id: 'profile', status: 'ready', failure: null }
const app = { id: 'copy', requirements: { accounts: {} } }
const template = { id: 'template', requirements: { accounts: {} } }
const Json = Schema.decodeUnknownEffect(Schema.Json)
const WireError = Schema.TaggedUnion({
  FixtureRouteMissing: {},
  ToolBlocked: {},
  ToolApprovalNotFound: {},
  InputInvalid: {},
  AppNotFound: {},
  ProfileNotFound: {},
  DeploymentNotFound: {},
  AccountNotFound: {},
  NewInputRefusal: { message: Schema.String },
  OAuthSetupFailed: { reason: Schema.String },
  OAuthClientUnavailable: {},
  OAuthReconnectRequired: {},
})
const Begin = Schema.Struct({ owner: Schema.String, name: Schema.String })
const Resume = Schema.Struct({ owner: Schema.String, requestId: Schema.String })
const decodeBegin = Schema.decodeUnknownEffect(Begin)
const decodeResume = Schema.decodeUnknownEffect(Resume)

/** Scoped loopback HTTP exercises the actual client, decoders and lost-response behavior. The
 * route table controls only the remote protocol; Executor is always its production Layer.
 */
const fixture = Effect.fn('ExecutorHttpTest.fixture')(function* () {
  const responses = yield* Ref.make(new Map<string, Fault>())
  const catalogRequests = yield* Queue.unbounded<void>()
  const setupRequests = yield* Queue.unbounded<void>()
  const setupGate = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none())
  const requests = yield* Ref.make<
    readonly { path: string; search: string; body: typeof Schema.Json.Type }[]
  >([])
  const copies = yield* Ref.make<readonly (typeof Begin.Type)[]>([])
  const copied = yield* Ref.make(false)
  const imported = yield* Ref.make(false)
  const paginated = yield* Ref.make(false)
  const catalogDefinitions = yield* Ref.make<readonly (typeof Schema.Json.Type)[]>([])
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  const handler = Effect.fn('ExecutorHttpTest.handler')(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, 'http://fixture.test')
    const body =
      request.method === 'GET' || request.method === 'DELETE' || url.pathname.endsWith('/cancel')
        ? null
        : yield* request.json.pipe(Effect.flatMap(Json))
    const path = `${request.method} ${url.pathname}`
    yield* Ref.update(requests, (items) => [...items, { path, search: url.search, body }])
    if (path === 'GET /dashboard/api/catalog') yield* Queue.offer(catalogRequests, undefined)
    if (path === 'POST /v1/account-connections/oauth/setup') {
      yield* Queue.offer(setupRequests, undefined)
      const gate = yield* Ref.get(setupGate)
      if (Option.isSome(gate)) yield* Deferred.await(gate.value)
    }
    if (path === 'POST /v1/apps/copies') {
      const input = yield* decodeBegin(body)
      yield* Ref.update(copies, (items) => [...items, input])
      yield* Ref.set(copied, true)
    }
    if (path === 'POST /dashboard/api/catalog/import') yield* Ref.set(imported, true)
    if (path === 'POST /v1/tools/resume') {
      const resume = yield* decodeResume(body)
      if (resume.owner !== references.owner)
        return HttpServerResponse.jsonUnsafe(WireError.cases.ToolApprovalNotFound.make({}), {
          status: 404,
        })
    }
    const fault = (yield* Ref.get(responses)).get(path)
    if (fault !== undefined) return yield* serveFault(request, fault)
    const response = yield* defaultResponse({
      path,
      url,
      copied,
      imported,
      paginated,
      catalogDefinitions,
    })
    return HttpServerResponse.jsonUnsafe(response)
  })
  yield* server.serve(handler())
  if (!NetAddress.isInetAddress(server.address))
    return yield* Effect.die('Expected a loopback address')
  const url = yield* Effect.fromResult(NetAddress.toUrl(server.address))
  const layer = executorLayer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          VIVID_EXECUTOR_URL: url.href.replace(/\/$/, ''),
          VIVID_EXECUTOR_KEY: 'isolated-test-key',
          VIVID_EXECUTOR_PUBLIC_ONLY: true,
        }),
      ),
    ),
  )
  return {
    address: url.href.replace(/\/$/u, ''),
    responses,
    catalogDefinitions,
    requests,
    catalogRequests,
    setupRequests,
    setupGate,
    copies,
    copied,
    imported,
    paginated,
    layer,
  }
})

/** Destroying the real socket after reading the request models acceptance with a lost response. */
const serveFault = Effect.fn('ExecutorHttpTest.fault')(function* (
  request: typeof HttpServerRequest.HttpServerRequest.Service,
  fault: Fault,
) {
  return yield* Fault.match(fault, {
    Reply: ({ status, body }) => Effect.succeed(HttpServerResponse.jsonUnsafe(body, { status })),
    Reset: () =>
      Effect.sync(() => NodeHttpServerRequest.toIncomingMessage(request).socket.destroy()).pipe(
        Effect.andThen(Effect.interruptible(Effect.never)),
      ),
  })
})

/** Minimal protocol resources are stateful so begin retry and compensation have observable effects. */
const defaultResponse = Effect.fn('ExecutorHttpTest.response')(function* (input: {
  path: string
  url: URL
  copied: Ref.Ref<boolean>
  imported: Ref.Ref<boolean>
  paginated: Ref.Ref<boolean>
  catalogDefinitions: Ref.Ref<readonly (typeof Schema.Json.Type)[]>
}) {
  switch (input.path) {
    case 'GET /dashboard/api/catalog':
      return defaultCatalog
    case 'GET /v1/tools':
      if (!(yield* Ref.get(input.paginated))) return page
      return input.url.searchParams.has('cursor')
        ? {
            ...page,
            items: [
              { name: 'write', description: 'Write records', inputSchema: {}, readOnly: false },
            ],
          }
        : { ...page, next: 'second' }
    case 'POST /v1/tools/call':
    case 'POST /v1/tools/resume':
      return { status: 'completed', value: { ok: true } }
    case 'GET /v1/apps':
      if (input.url.searchParams.get('name') === `Vivid catalog ${service}`)
        return yield* Ref.get(input.catalogDefinitions)
      if (input.url.searchParams.get('owner') === 'local')
        return (yield* Ref.get(input.imported)) ? [template] : []
      return (yield* Ref.get(input.copied)) ? [app] : []
    case 'POST /dashboard/api/catalog/import':
      return template
    case 'POST /v1/apps/copies':
      return app
    case 'DELETE /v1/apps/template':
      yield* Ref.set(input.imported, false)
      return {}
    case 'DELETE /v1/apps/copy':
      yield* Ref.set(input.copied, false)
      return {}
    case 'POST /v1/apps/copy/profiles':
    case 'POST /v1/apps/copy/profiles/profile/reconcile':
    case 'POST /v1/apps/app/profiles/profile/reconcile':
      return profile
    default:
      return WireError.cases.FixtureRouteMissing.make({})
  }
})

/** A local transport Layer is acquired per claim; no retries, sleeps or installation dependency. */
describe('Executor HTTP failures', () => {
  for (const [name, path, fault] of [
    ['call 5xx', 'POST /v1/tools/call', reply(503, WireError.cases.ToolBlocked.make({}))],
    ['call connection reset', 'POST /v1/tools/call', Fault.cases.Reset.make({})],
    ['resume 5xx', 'POST /v1/tools/resume', reply(500, null)],
    ['resume connection reset', 'POST /v1/tools/resume', Fault.cases.Reset.make({})],
  ] as const) {
    it.effect(`${name} preserves OutcomeUnknown`, () =>
      Effect.gen(function* () {
        const remote = yield* fixture()
        yield* Ref.update(remote.responses, (values) => new Map(values).set(path, fault))
        const outcome = yield* Effect.gen(function* () {
          const executor = yield* Executor
          return path === 'POST /v1/tools/call'
            ? yield* executor.call({ references, tool: 'read', input: {} })
            : yield* executor.resume({
                references,
                requestId: ExecutorRequestId.make('approval'),
                accept: true,
              })
        }).pipe(Effect.provide(remote.layer))
        expect(outcome._tag).toBe('OutcomeUnknown')
        expect(
          (yield* Ref.get(remote.requests)).filter((request) => request.path === path),
        ).toHaveLength(1)
      }).pipe(Effect.scoped),
    )
  }
  it.effect('401 propagates unavailable while decoded 403 ToolBlocked refuses the tool', () =>
    Effect.gen(function* () {
      const remote = yield* fixture()
      yield* Effect.gen(function* () {
        const executor = yield* Executor
        for (const path of ['POST /v1/tools/call', 'POST /v1/tools/resume']) {
          yield* Ref.update(remote.responses, (values) =>
            new Map(values).set(path, reply(401, WireError.cases.ToolBlocked.make({}))),
          )
          const failed =
            path === 'POST /v1/tools/call'
              ? executor
                  .call({ references, tool: 'read', input: {} })
                  .pipe(Effect.mapError(executorFailure), Effect.flip)
              : executor
                  .resume({
                    references,
                    requestId: ExecutorRequestId.make('approval'),
                    accept: true,
                  })
                  .pipe(Effect.mapError(executorFailure), Effect.flip)
          expect(yield* failed).toBeInstanceOf(ServiceUnavailable)
        }
        yield* Ref.update(remote.responses, (values) =>
          new Map(values).set(
            'POST /v1/tools/call',
            reply(403, WireError.cases.ToolBlocked.make({})),
          ),
        )
        expect((yield* executor.call({ references, tool: 'read', input: {} }))._tag).toBe(
          'Rejected',
        )
      }).pipe(Effect.provide(remote.layer))
    }).pipe(Effect.scoped),
  )
  it.effect('unknown tagged 4xx is a refusal, and resume includes its exact owner', () =>
    Effect.gen(function* () {
      const remote = yield* fixture()
      yield* Ref.update(remote.responses, (values) =>
        new Map(values).set(
          'POST /v1/tools/call',
          reply(422, WireError.cases.NewInputRefusal.make({ message: 'Bearer private-value' })),
        ),
      )
      yield* Effect.gen(function* () {
        const executor = yield* Executor
        const outcome = yield* executor.call({ references, tool: 'read', input: {} })
        expect(outcome._tag).toBe('Rejected')
        expect(JSON.stringify(outcome)).not.toContain('private-value')
        yield* executor.resume({
          references,
          requestId: ExecutorRequestId.make('approval'),
          accept: true,
        })
      }).pipe(Effect.provide(remote.layer))
      const request = (yield* Ref.get(remote.requests)).find(
        (item) => item.path === 'POST /v1/tools/resume',
      )
      expect(request).toBeDefined()
      if (request === undefined) expect.fail('Missing resume request')
      expect(yield* decodeResume(request.body)).toEqual({
        owner: references.owner,
        requestId: 'approval',
      })
    }).pipe(Effect.scoped),
  )
  for (const [missing, error] of [
    ['App', WireError.cases.AppNotFound.make({})],
    ['Profile', WireError.cases.ProfileNotFound.make({})],
    ['Deployment', WireError.cases.DeploymentNotFound.make({})],
    ['Account', WireError.cases.AccountNotFound.make({})],
  ] as const) {
    it.effect(`${missing} absence permanently fails status and propagates from call`, () =>
      Effect.gen(function* () {
        const remote = yield* fixture()
        yield* Ref.update(remote.responses, (values) =>
          new Map(values).set('GET /v1/tools', reply(404, error)),
        )
        yield* Effect.gen(function* () {
          const executor = yield* Executor
          expect((yield* executor.status(references))._tag).toBe('Failed')
          const failure = yield* executor
            .call({ references, tool: 'read', input: {} })
            .pipe(Effect.flip)
          expect(failure._tag).toBe('ExecutorResourceMissing')
          expect(failure).toMatchObject({ resource: missing })
        }).pipe(Effect.provide(remote.layer))
      }).pipe(Effect.scoped),
    )
  }
})

/** Layer acquisition starts catalog I/O without a reader. The real decoder accepts the observed
 * numeric/null/omitted shape, skips unknown kinds and preserves stable popularity ties.
 */
it.effect('loads the catalog eagerly and preserves popularity and wire order', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    yield* Ref.update(remote.responses, (values) =>
      new Map(values).set(
        'GET /dashboard/api/catalog',
        reply(200, [
          catalogService('Wire first'),
          { ...catalogService('Low'), popularity: 3 },
          { kind: 'future-kind', popularity: 100 },
          { ...catalogService('High'), popularity: 20 },
          { ...catalogService('High tie'), popularity: 20 },
          { ...catalogService('Null'), popularity: null },
          catalogService('Wire last'),
        ]),
      ),
    )
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      yield* Queue.take(remote.catalogRequests)
      const entries = yield* executor.catalog()
      expect(entries.map((entry) => entry.name)).toEqual([
        'High',
        'High tie',
        'Low',
        'Wire first',
        'Null',
        'Wire last',
      ])
      expect(
        (yield* Ref.get(remote.requests)).filter(
          (request) => request.path === 'GET /dashboard/api/catalog',
        ),
      ).toEqual([expect.objectContaining({ search: '?limit=2000' })])
    }).pipe(Effect.provide(remote.layer))
  }).pipe(Effect.scoped),
)

/** The same production cache serves tools/call and catalog/begin, including structurally equal
 * references decoded anew from persistence; a controllable clock proves both expiration budgets.
 */
it.effect('shares discovery and catalog snapshots and expires them without caching failures', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const entries = yield* executor.catalog()
      yield* Queue.take(remote.catalogRequests)
      expect(entries.map((entry) => entry.id)).toEqual([service])
      yield* executor.catalog()
      yield* executor.tools(references)
      yield* executor.call({
        references: ExecutorReferences.cases.Public.make({ ...references }),
        tool: 'read',
        input: {},
      })
      let requests = yield* Ref.get(remote.requests)
      expect(requests.filter((request) => request.path === 'GET /v1/tools')).toHaveLength(1)
      expect(requests.find((request) => request.path === 'GET /v1/tools')).toMatchObject({
        search: expect.stringContaining('limit=2000'),
      })
      expect(
        requests.filter((request) => request.path === 'GET /dashboard/api/catalog'),
      ).toHaveLength(1)
      yield* TestClock.adjust('5 minutes')
      yield* executor.tools(references)
      yield* executor.catalog()
      requests = yield* Ref.get(remote.requests)
      expect(requests.filter((request) => request.path === 'GET /v1/tools')).toHaveLength(2)
      expect(
        requests.filter((request) => request.path === 'GET /dashboard/api/catalog'),
      ).toHaveLength(1)
      yield* TestClock.adjust('5 minutes')
      yield* Queue.take(remote.catalogRequests)
      yield* executor.catalog()
      expect(
        (yield* Ref.get(remote.requests)).filter(
          (request) => request.path === 'GET /dashboard/api/catalog',
        ),
      ).toHaveLength(2)
    }).pipe(Effect.provide(remote.layer))
  }).pipe(Effect.scoped),
)

/** The stable Connection id drives both copy naming and the profile's idempotency key. */
const beginInput = {
  connectionId: ConnectionId.make('connection'),
  service,
  owner: references.owner,
  subject: 'person',
  label: 'Account',
  returnAddress: 'https://vivid.example.test/return/connection',
}
for (const failurePath of [
  'POST /v1/apps/copy/profiles',
  'POST /v1/apps/copy/profiles/profile/reconcile',
]) {
  it.effect(`compensates a copied app when ${failurePath} fails`, () =>
    Effect.gen(function* () {
      const remote = yield* fixture()
      yield* Ref.update(remote.responses, (values) =>
        new Map(values).set(failurePath, reply(422, WireError.cases.InputInvalid.make({}))),
      )
      yield* Effect.gen(function* () {
        expect((yield* (yield* Executor).begin(beginInput).pipe(Effect.flip))._tag).toBe(
          'ExecutorRejected',
        )
      }).pipe(Effect.provide(remote.layer))
      expect(yield* Ref.get(remote.copied)).toBe(false)
    }).pipe(Effect.scoped),
  )
}
it.effect('recovers a lost copy response and uses the integration id for profile idempotency', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    yield* Ref.update(remote.responses, (values) =>
      new Map(values).set('POST /v1/apps/copies', Fault.cases.Reset.make({})),
    )
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      expect(ExecutorStep.guards.Done(yield* executor.begin(beginInput))).toBe(true)
      expect(ExecutorStep.guards.Done(yield* executor.begin(beginInput))).toBe(true)
    }).pipe(Effect.provide(remote.layer))
    expect(yield* Ref.get(remote.copies)).toEqual([
      { owner: references.owner, name: 'Vivid Connection connection' },
    ])
    const profiles = (yield* Ref.get(remote.requests)).filter(
      (request) => request.path === 'POST /v1/apps/copy/profiles',
    )
    expect(profiles).toHaveLength(2)
    for (const request of profiles)
      expect(request.body).toMatchObject({ idempotencyKey: beginInput.connectionId })
    expect(
      (yield* Ref.get(remote.requests)).filter(
        (request) => request.path === 'GET /dashboard/api/catalog',
      ),
    ).toHaveLength(1)
  }).pipe(Effect.scoped),
)
it.effect('retains copied identity if cleanup fails, then converges on the same copy', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    yield* Ref.update(remote.responses, (values) =>
      new Map(values).set('DELETE /v1/apps/template', reply(503, null)),
    )
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const failure = yield* executor.begin(beginInput).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(ExecutorCopyRetained)
      yield* Ref.update(remote.responses, () => new Map())
      expect(ExecutorStep.guards.Done(yield* executor.begin(beginInput))).toBe(true)
    }).pipe(Effect.provide(remote.layer))
    expect(yield* Ref.get(remote.copies)).toHaveLength(1)
    expect(yield* Ref.get(remote.imported)).toBe(false)
  }).pipe(Effect.scoped),
)

/** Semantic errors can carry nested third-party headers; both dispatch paths sanitize at ingress. */
for (const value of [
  { content: [{ text: '401 Authorization: Bearer private-value' }] },
  'Harmless rejected input. '.repeat(100),
]) {
  it.effect(
    `bounds and sanitizes semantic tool errors: ${JSON.stringify(value).slice(0, 20)}`,
    () =>
      Effect.gen(function* () {
        const remote = yield* fixture()
        yield* Ref.update(remote.responses, (values) =>
          new Map(values)
            .set('POST /v1/tools/call', reply(200, { status: 'completed', value, toolError: true }))
            .set(
              'POST /v1/tools/resume',
              reply(200, { status: 'completed', value, toolError: true }),
            ),
        )
        yield* Effect.gen(function* () {
          const executor = yield* Executor
          const called = yield* executor.call({ references, tool: 'read', input: {} })
          const resumed = yield* executor.resume({
            references,
            requestId: ExecutorRequestId.make('approval'),
            accept: true,
          })
          expect(called._tag).toBe('Rejected')
          expect(resumed._tag).toBe('Failed')
          expect(JSON.stringify(called)).not.toContain('private-value')
          expect(JSON.stringify(resumed)).not.toContain('private-value')
          if (ExecutorCallOutcome.guards.Rejected(called))
            expect(called.message.length).toBeLessThanOrEqual(400)
          if (ExecutorResumeOutcome.guards.Failed(resumed))
            expect(resumed.reason.length).toBeLessThanOrEqual(400)
        }).pipe(Effect.provide(remote.layer))
      }).pipe(Effect.scoped),
  )
}

/** Catalog auth cannot invent key fields: the imported declaration supplies names and labels. */
it.effect('passes declared key fields through and compensates a failed authorization start', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    const keyApp = {
      id: 'copy',
      requirements: {
        accounts: {
          primary: {
            provider: 'provider',
            definition: {
              auth: {
                key: {
                  type: 'secrets',
                  fields: { properties: { apiKey: { title: 'Service key' }, tenant: {} } },
                },
              },
            },
          },
        },
      },
    }
    yield* Ref.update(remote.responses, (values) =>
      new Map(values)
        .set(
          'GET /dashboard/api/catalog',
          reply(200, [
            {
              id: service,
              kind: 'mcp',
              name: 'Test',
              description: 'Test service',
              connectUrl: 'https://example.test',
              auth: { kind: 'api_key' },
            },
          ]),
        )
        .set('POST /v1/apps/copies', reply(200, keyApp))
        .set('POST /dashboard/api/catalog/import', reply(200, { ...keyApp, id: 'template' }))
        .set(
          'POST /v1/account-connections',
          reply(200, { id: 'authorization', reconnectAccount: null, state: { status: 'pending' } }),
        ),
    )
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const step = yield* executor.begin(beginInput)
      expect(ExecutorStep.guards.EnterKey(step)).toBe(true)
      if (ExecutorStep.guards.EnterKey(step))
        expect(step.fields).toEqual([
          { name: 'apiKey', label: 'Service key' },
          { name: 'tenant', label: 'tenant' },
        ])
      yield* Ref.update(remote.responses, (values) =>
        new Map(values).set('POST /v1/account-connections', reply(503, null)),
      )
      yield* Ref.set(remote.copied, false)
      expect((yield* executor.begin(beginInput).pipe(Effect.flip))._tag).toBe(
        'ExecutorExecutionUncertain',
      )
    }).pipe(Effect.provide(remote.layer))
    expect(yield* Ref.get(remote.copied)).toBe(false)
  }).pipe(Effect.scoped),
)

/** The foreign owner check must see the integration's owner, even when the request id is valid. */
it.effect('cannot resume an approval belonging to a different owner', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    const outcome = yield* Effect.gen(function* () {
      return yield* (yield* Executor).resume({
        references: ExecutorReferences.cases.Public.make({
          ...references,
          owner: ExecutorOwnerId.make('p-other'),
        }),
        requestId: ExecutorRequestId.make('approval'),
        accept: true,
      })
    }).pipe(Effect.provide(remote.layer))
    expect(outcome._tag).toBe('Failed')
  }).pipe(Effect.scoped),
)

/** Pagination pins deployment and revision, then reuses the entire snapshot for dispatch. */
it.effect('requests maximum pages and caches every discovered page for subsequent calls', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    yield* Ref.set(remote.paginated, true)
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      expect((yield* executor.tools(references)).map((tool) => tool.name)).toEqual([
        'read',
        'write',
      ])
      yield* executor.call({ references, tool: 'write', input: {} })
    }).pipe(Effect.provide(remote.layer))
    const requests = yield* Ref.get(remote.requests)
    const pages = requests.filter((request) => request.path === 'GET /v1/tools')
    expect(pages).toHaveLength(2)
    for (const request of pages) expect(request.search).toContain('limit=2000')
    expect(pages[1]).toMatchObject({
      search: expect.stringContaining('deployment=deployment&expectedProfileRevision=1'),
    })
    expect(requests.find((request) => request.path === 'POST /v1/tools/call')).toMatchObject({
      body: { deployment: 'deployment', expectedProfileRevision: 1 },
    })
  }).pipe(Effect.scoped),
)

/** Catalog reads share cold failure until the scheduled retry; keyed discovery retries immediately. */
it.effect(
  'retries cold catalog failures in the background without caching discovery failures',
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture()
      yield* Ref.update(remote.responses, (values) =>
        new Map(values)
          .set('GET /dashboard/api/catalog', reply(503, null))
          .set('GET /v1/tools', reply(503, null)),
      )
      yield* Effect.gen(function* () {
        const executor = yield* Executor
        expect((yield* executor.catalog().pipe(Effect.flip))._tag).toBe('ServiceUnavailable')
        yield* Queue.take(remote.catalogRequests)
        expect((yield* executor.tools(references).pipe(Effect.flip))._tag).toBe(
          'ExecutorExecutionUncertain',
        )
        yield* Ref.update(remote.responses, () => new Map())
        expect((yield* executor.catalog().pipe(Effect.flip))._tag).toBe('ServiceUnavailable')
        yield* TestClock.adjust('30 seconds')
        yield* Queue.take(remote.catalogRequests)
        // A cold reader waits for this retry's real HTTP response to finish decoding.
        expect(yield* executor.catalog()).toHaveLength(1)
        expect(yield* executor.tools(references)).toHaveLength(1)
      }).pipe(Effect.provide(remote.layer))
    }).pipe(Effect.scoped),
)

/** Compensation failure keeps a located reference rather than abandoning the copied app. */
it.effect('preserves references when compensation fails and reuses them on retry', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    yield* Ref.update(remote.responses, (values) =>
      new Map(values)
        .set('POST /v1/apps/copy/profiles', reply(503, null))
        .set('DELETE /v1/apps/copy', reply(503, null)),
    )
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const failure = yield* executor.begin(beginInput).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(ExecutorCopyRetained)
      expect(failure).toMatchObject({ references: { app: 'copy', owner: references.owner } })
      expect(yield* Ref.get(remote.copied)).toBe(true)
      yield* Ref.update(remote.responses, () => new Map())
      expect(ExecutorStep.guards.Done(yield* executor.begin(beginInput))).toBe(true)
    }).pipe(Effect.provide(remote.layer))
    expect(yield* Ref.get(remote.copies)).toHaveLength(1)
  }).pipe(Effect.scoped),
)

/** The catalog says which paths exist; setup decides which sign-in path this installation can start. */
function setupDefinition(mixed: boolean) {
  const auth = { signIn: { type: 'oauth2' } }
  if (!mixed) return { provider: 'provider', definition: { auth } }
  return {
    provider: 'provider',
    definition: {
      auth: {
        ...auth,
        key: {
          type: 'secrets',
          fields: { properties: { pat: { title: 'Personal access token' } } },
        },
      },
    },
  }
}

/** Public registration and account initiation are distinct observable protocol operations. */
const setupFixture = Effect.fn('ExecutorHttpTest.setupFixture')(function* (
  mixed: boolean,
  mode: string,
) {
  const remote = yield* fixture()
  const requirement = setupDefinition(mixed)
  const accounts = { primary: requirement }
  yield* Ref.set(remote.catalogDefinitions, [{ id: 'template', requirements: { accounts } }])
  yield* Ref.update(remote.responses, (values) =>
    new Map(values)
      .set(
        'GET /dashboard/api/catalog',
        reply(200, [{ ...catalogService(service), auth: { kind: mixed ? 'mixed' : 'oauth' } }]),
      )
      .set(
        'POST /dashboard/api/catalog/import',
        reply(200, { id: 'template', requirements: { accounts } }),
      )
      .set('POST /v1/apps/copies', reply(200, { id: 'copy', requirements: { accounts } }))
      .set('POST /v1/account-connections/oauth/setup', reply(200, { mode }))
      .set(
        'POST /v1/account-connections/oauth/start',
        reply(200, { status: 'redirect', authorizationUrl: 'https://service.test/sign-in' }),
      )
      .set(
        'POST /v1/account-connections',
        reply(200, { id: 'authorization', reconnectAccount: null, state: { status: 'pending' } }),
      ),
  )
  return remote
})

for (const mode of ['automatic', 'saved', 'client-required']) {
  for (const mixed of [false, true]) {
    it.effect(`resolves ${mixed ? 'mixed' : 'sign-in only'} setup ${mode} and caches it`, () =>
      Effect.gen(function* () {
        const remote = yield* setupFixture(mixed, mode)
        yield* Effect.gen(function* () {
          const executor = yield* Executor
          const input = { service, returnAddress: beginInput.returnAddress }
          const expected = mode !== 'client-required' ? 'SignIn' : mixed ? 'Key' : 'SetupRequired'
          const outcome = yield* executor.begin(beginInput).pipe(Effect.result)
          const authorization = yield* executor.authorization(input)
          expect(authorization._tag).toBe(expected)
          expect(yield* executor.authorization({ ...input })).toEqual(authorization)
          if (ServiceAuthorization.guards.Key(authorization))
            expect(authorization.fields).toEqual([{ name: 'pat', label: 'Personal access token' }])
          if (Result.isFailure(outcome)) {
            expect(expected).toBe('SetupRequired')
            expect(outcome.failure._tag).toBe('ExecutorSetupRequired')
            expect(executorFailure(outcome.failure)).toEqual(
              new InvalidRequest({ message: connectionSetupMessage }),
            )
            expect(
              (yield* Ref.get(remote.requests)).some(
                (request) => request.path === 'POST /v1/account-connections',
              ),
            ).toBe(false)
          } else if (ServiceAuthorization.guards.Key(authorization)) {
            expect(ExecutorStep.guards.EnterKey(outcome.success)).toBe(true)
            expect(outcome.success).toHaveProperty('fields', authorization.fields)
            expect(
              (yield* Ref.get(remote.requests)).some(
                (request) => request.path === 'POST /v1/account-connections/oauth/start',
              ),
            ).toBe(false)
          } else {
            expect(ExecutorStep.guards.OpenSignIn(outcome.success)).toBe(true)
            expect(outcome.success).toHaveProperty('address', 'https://service.test/sign-in')
          }
          expect(
            (yield* Ref.get(remote.requests)).filter(
              (request) => request.path === 'POST /v1/account-connections/oauth/setup',
            ),
          ).toHaveLength(1)
        }).pipe(Effect.provide(remote.layer))
      }).pipe(Effect.scoped),
    )
  }
}

/** A transient response neither overwrites the retained fact nor survives as a cached answer. */
it.effect(
  'keeps known sign-in availability across transient inspection failure and retries immediately',
  () =>
    Effect.gen(function* () {
      const remote = yield* setupFixture(false, 'automatic')
      yield* Effect.gen(function* () {
        const executor = yield* Executor
        yield* executor.begin(beginInput)
        const before = (yield* Ref.get(remote.requests)).length
        const input = { service, returnAddress: beginInput.returnAddress }
        expect((yield* executor.authorization(input))._tag).toBe('SignIn')
        yield* Ref.update(remote.responses, (values) =>
          new Map(values).set('POST /v1/account-connections/oauth/setup', reply(503, null)),
        )
        const retry = { service, returnAddress: 'https://vivid.test/retry' }
        expect((yield* executor.authorization(retry).pipe(Effect.flip))._tag).toBe(
          'ExecutorExecutionUncertain',
        )
        expect((yield* executor.catalog())[0]).toHaveProperty('authorization._tag', 'SignIn')
        yield* Ref.update(remote.responses, (values) =>
          new Map(values).set(
            'POST /v1/account-connections/oauth/setup',
            reply(200, { mode: 'automatic' }),
          ),
        )
        expect((yield* executor.authorization(retry))._tag).toBe('SignIn')
        yield* TestClock.adjust('10 minutes')
        expect((yield* executor.authorization(input))._tag).toBe('SignIn')
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.filter((request) => request.path === 'POST /v1/account-connections/oauth/setup'),
        ).toHaveLength(4)
        expect(requests.filter((request) => request.path === 'GET /v1/apps')).toHaveLength(2)
        expect(
          requests
            .slice(before)
            .some(
              (request) =>
                request.path === 'POST /dashboard/api/catalog/import' ||
                request.path.startsWith('DELETE '),
            ),
        ).toBe(false)
      }).pipe(Effect.provide(remote.layer))
    }).pipe(Effect.scoped),
)

/** Sign-in can discover missing client setup after an optimistic inspection. That authority failure
 * must retain the pending references for cleanup and correct later catalog reads immediately.
 */
it.effect('records client-required from sign-in start and preserves the product failure', () =>
  Effect.gen(function* () {
    const remote = yield* setupFixture(false, 'automatic')
    yield* Ref.update(remote.responses, (values) =>
      new Map(values).set(
        'POST /v1/account-connections/oauth/start',
        reply(422, WireError.cases.OAuthClientUnavailable.make({})),
      ),
    )
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const failure = yield* executor.begin(beginInput).pipe(Effect.flip)
      expect(failure._tag).toBe('ExecutorSignInRequired')
      expect(executorFailure(failure)).toEqual(
        new InvalidRequest({ message: connectionSetupMessage }),
      )
      expect((yield* executor.catalog())[0]).toHaveProperty('authorization._tag', 'SetupRequired')
    }).pipe(Effect.provide(remote.layer))
  }).pipe(Effect.scoped),
)

/** A real HTTP response gate remains closed while virtual time expires the whole service lookup. */
it.effect('times out inspection at five seconds and leaves the catalog readable', () =>
  Effect.gen(function* () {
    const remote = yield* setupFixture(false, 'automatic')
    const gate = yield* Deferred.make<void>()
    yield* Ref.set(remote.setupGate, Option.some(gate))
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const completed = yield* Deferred.make<void>()
      const inspection = yield* executor.begin(beginInput).pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkChild,
      )
      yield* Queue.take(remote.setupRequests)
      yield* TestClock.adjust('4 seconds')
      expect(yield* Deferred.isDone(completed)).toBe(false)
      expect((yield* executor.catalog())[0]).toHaveProperty('authorization._tag', 'SignIn')
      yield* TestClock.adjust('1 second')
      expect((yield* Fiber.join(inspection).pipe(Effect.flip))._tag).toBe(
        'ExecutorTransportFailure',
      )
      expect((yield* executor.catalog())[0]).toHaveProperty('authorization._tag', 'SignIn')
      yield* Deferred.succeed(gate, undefined)
    }).pipe(Effect.provide(remote.layer), Effect.ensuring(Deferred.succeed(gate, undefined)))
  }).pipe(Effect.scoped),
)

/** Search crosses the production store and HTTP adapter; only the remote protocol is controlled.
 * The database is the isolated test Layer, and searching needs no fixture writes.
 */
describe.skipIf(!testDatabaseConfigured)('Catalog search during setup inspection', () => {
  it.effect('offers the catalog hint before an explicit connection supplies its definition', () =>
    Effect.gen(function* () {
      const remote = yield* setupFixture(false, 'automatic')
      yield* Ref.set(remote.catalogDefinitions, [])
      const storeLayer = Layer.fresh(connectionStoreLayer).pipe(
        Layer.provideMerge(remote.layer),
        Layer.provide(connectionTestLayer),
      )
      yield* Effect.gen(function* () {
        const store = yield* ConnectionStore
        expect((yield* store.service(service)).authorization).toEqual(
          ServiceAuthorization.cases.SignIn.make({}),
        )
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.some(
            (request) =>
              request.path === 'POST /dashboard/api/catalog/import' ||
              request.path.startsWith('DELETE '),
          ),
        ).toBe(false)
      }).pipe(Effect.provide(storeLayer))
    }).pipe(Effect.scoped),
  )
  it.effect('starts no setup I/O during cold search or subsequent refreshes', () =>
    Effect.gen(function* () {
      const remote = yield* setupFixture(false, 'automatic')
      const gate = yield* Deferred.make<void>()
      yield* Ref.set(remote.setupGate, Option.some(gate))
      const storeLayer = Layer.fresh(connectionStoreLayer).pipe(
        Layer.provideMerge(remote.layer),
        Layer.provide(connectionTestLayer),
      )
      yield* Effect.gen(function* () {
        const store = yield* ConnectionStore
        const result = yield* store.find('test/service')
        expect(ServiceCatalog.guards.Ready(result)).toBe(true)
        if (ServiceCatalog.guards.Ready(result)) {
          expect(result.total).toBe(1)
          expect(result.services.map((entry) => entry.authorization)).toEqual([
            ServiceAuthorization.cases.SignIn.make({}),
          ])
        }
        yield* TestClock.adjust('10 minutes')
        expect(
          (yield* Ref.get(remote.requests)).some(
            (request) => request.path === 'POST /v1/account-connections/oauth/setup',
          ),
        ).toBe(false)
        expect((yield* store.find(''))._tag).toBe('Ready')
        expect(yield* Deferred.isDone(gate)).toBe(false)
      }).pipe(Effect.provide(storeLayer), Effect.ensuring(Deferred.succeed(gate, undefined)))
    }).pipe(Effect.scoped),
  )
  for (const status of [422, 401, 503]) {
    it.effect(`keeps search succeeding when one service's inspection returns HTTP ${status}`, () =>
      Effect.gen(function* () {
        const remote = yield* setupFixture(false, 'automatic')
        yield* Ref.update(remote.responses, (values) =>
          new Map(values)
            .set(
              'POST /v1/account-connections/oauth/setup',
              reply(status, WireError.cases.OAuthSetupFailed.make({ reason: 'discovery_invalid' })),
            )
            .set(
              'GET /dashboard/api/catalog',
              reply(200, [
                { ...catalogService(service), auth: { kind: 'oauth' } },
                catalogService('test/public'),
              ]),
            ),
        )
        const storeLayer = Layer.fresh(connectionStoreLayer).pipe(
          Layer.provideMerge(remote.layer),
          Layer.provide(connectionTestLayer),
        )
        yield* Effect.gen(function* () {
          const store = yield* ConnectionStore
          const executor = yield* Executor
          // Setup is learned by this explicit Begin; discovery keeps the last optimistic hint.
          yield* executor.begin(beginInput).pipe(Effect.flip)
          const result = yield* store.find('test')
          expect(ServiceCatalog.guards.Ready(result)).toBe(true)
          if (ServiceCatalog.guards.Ready(result)) {
            expect(result.total).toBe(2)
            expect(result.services.map((entry) => [entry.id, entry.authorization])).toEqual([
              [service, ServiceAuthorization.cases.SignIn.make({})],
              ['test/public', ServiceAuthorization.cases.None.make({})],
            ])
          }
        }).pipe(Effect.provide(storeLayer), Effect.provide(testConfigLayer))
      }).pipe(Effect.scoped),
    )
  }
})

/** A gate on actual HTTP setup responses proves four in-flight lookups reusing an explicitly begun app definition. */
it.effect('bounds simultaneous setup lookups without looking up catalog apps', () =>
  Effect.gen(function* () {
    const remote = yield* setupFixture(true, 'client-required')
    const gate = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      yield* executor.begin(beginInput)
      yield* Queue.take(remote.setupRequests)
      yield* Ref.set(remote.setupGate, Option.some(gate))
      const fibers = yield* Effect.forEach(
        Array.from({ length: 5 }, (_, index) => index),
        (index) =>
          executor
            .authorization({ service, returnAddress: `https://vivid.test/return/${index}` })
            .pipe(Effect.forkChild),
      )
      yield* Effect.forEach([1, 2, 3, 4], () => Queue.take(remote.setupRequests))
      expect(
        (yield* Ref.get(remote.requests)).filter(
          (request) => request.path === 'POST /v1/account-connections/oauth/setup',
        ),
      ).toHaveLength(5)
      yield* Deferred.succeed(gate, undefined)
      yield* Queue.take(remote.setupRequests)
      const resolved = yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber))
      expect(resolved.every(ServiceAuthorization.guards.Key)).toBe(true)
      expect(
        (yield* Ref.get(remote.requests)).filter((request) => request.path === 'GET /v1/apps'),
      ).toHaveLength(2)
    }).pipe(Effect.provide(remote.layer))
  }).pipe(Effect.scoped),
)

/** One bad registry row cannot hide unrelated services on a cold download. */
it.effect('isolates malformed catalog entries and retains healthy services', () =>
  Effect.gen(function* () {
    const remote = yield* fixture()
    const broken = [
      null,
      { id: 'invalid-kind', kind: 42 },
      { ...catalogService('invalid-name'), name: 42 },
      { ...catalogService('invalid-popularity'), popularity: 'popular' },
    ]
    yield* Ref.update(remote.responses, (values) =>
      new Map(values).set(
        'GET /dashboard/api/catalog',
        reply(200, [...broken, catalogService('healthy')]),
      ),
    )
    yield* Effect.gen(function* () {
      expect((yield* (yield* Executor).catalog()).map((entry) => entry.id)).toEqual(['healthy'])
    }).pipe(Effect.provide(remote.layer))
  }).pipe(Effect.scoped),
)

/** A failure before the dispatch boundary proves nothing ran; real sockets exercise that classification. */
for (const fault of [
  reply(503, null),
  Fault.cases.Reset.make({}),
  reply(200, { malformed: true }),
]) {
  it.effect('reports failed discovery as a refusal without dispatching the action', () =>
    Effect.gen(function* () {
      const remote = yield* fixture()
      yield* Ref.update(remote.responses, (values) => new Map(values).set('GET /v1/tools', fault))
      yield* Effect.gen(function* () {
        const outcome = yield* (yield* Executor).call({ references, tool: 'read', input: {} })
        expect(outcome._tag).toBe('Rejected')
        expect(JSON.stringify(outcome)).toContain('before the action was sent')
      }).pipe(Effect.provide(remote.layer))
      expect(
        (yield* Ref.get(remote.requests)).some((request) => request.path === 'POST /v1/tools/call'),
      ).toBe(false)
    }).pipe(Effect.scoped),
  )
}

/** Resuming a pending request keeps its account connection, app and profile; only OAuth's address changes. */
for (const kind of ['SignIn', 'Key'] as const) {
  it.effect(`reopens pending ${kind} without importing or issuing another grant`, () =>
    Effect.gen(function* () {
      const remote = yield* setupFixture(
        kind === 'Key',
        kind === 'Key' ? 'client-required' : 'automatic',
      )
      const pending =
        kind === 'SignIn'
          ? ExecutorReferences.cases.SigningIn.make({
              service: references.service,
              app: references.app,
              profile: references.profile,
              owner: references.owner,
              authorization: ExecutorAuthorizationId.make('saved'),
            })
          : ExecutorReferences.cases.EnteringKey.make({
              service: references.service,
              app: references.app,
              profile: references.profile,
              owner: references.owner,
              authorization: ExecutorAuthorizationId.make('saved'),
              label: 'Saved',
              method: 'key',
            })
      yield* Ref.update(remote.responses, (values) =>
        new Map(values)
          .set(
            'GET /v1/account-connections/saved',
            reply(200, { id: 'saved', reconnectAccount: null, state: { status: 'pending' } }),
          )
          .set(
            'GET /v1/apps/app',
            reply(200, {
              id: references.app,
              requirements: { accounts: { primary: setupDefinition(kind === 'Key') } },
            }),
          )
          .set(
            'POST /v1/account-connections/oauth/start',
            reply(200, {
              status: 'redirect',
              authorizationUrl: 'https://service.test/new-sign-in',
            }),
          ),
      )
      yield* Effect.gen(function* () {
        const step = yield* (yield* Executor).reauthorize({ ...beginInput, references: pending })
        expect(step._tag).toBe(kind === 'SignIn' ? 'OpenSignIn' : 'EnterKey')
        expect(step.references).toMatchObject({
          app: references.app,
          profile: references.profile,
          authorization: 'saved',
        })
        if (ExecutorStep.guards.OpenSignIn(step))
          expect(step.address).toBe('https://service.test/new-sign-in')
      }).pipe(Effect.provide(remote.layer))
      const requests = yield* Ref.get(remote.requests)
      expect(
        requests.some(
          (request) =>
            request.path === 'POST /dashboard/api/catalog/import' ||
            request.path === 'POST /v1/apps/copies' ||
            request.path === 'POST /v1/account-connections',
        ),
      ).toBe(false)
    }).pipe(Effect.scoped),
  )
}

/** A lapsed account reconnects in place: the provider API receives that exact existing account. */
it.effect('binds renewed authorization to the saved account', () =>
  Effect.gen(function* () {
    const remote = yield* setupFixture(false, 'automatic')
    const saved = ExecutorReferences.cases.Authorized.make({
      service: references.service,
      app: references.app,
      profile: references.profile,
      owner: references.owner,
      account: ExecutorAccountId.make('saved-account'),
    })
    yield* Ref.update(remote.responses, (values) =>
      new Map(values)
        .set('GET /v1/tools', reply(422, WireError.cases.OAuthReconnectRequired.make({})))
        .set(
          'GET /v1/apps/app',
          reply(200, {
            id: references.app,
            requirements: { accounts: { primary: setupDefinition(false) } },
          }),
        ),
    )
    yield* Effect.gen(function* () {
      expect(
        (yield* (yield* Executor).reauthorize({ ...beginInput, references: saved }))._tag,
      ).toBe('OpenSignIn')
    }).pipe(Effect.provide(remote.layer))
    const requests = yield* Ref.get(remote.requests)
    expect(
      requests.filter((request) => request.path === 'POST /v1/account-connections'),
    ).toMatchObject([
      {
        body: {
          account: 'saved-account',
          target: { app: references.app, profile: references.profile },
        },
      },
    ])
    expect(requests.some((request) => request.path === 'POST /v1/apps/copies')).toBe(false)
  }).pipe(Effect.scoped),
)

/** Closing an expired reconnect clears the old request before creating its replacement on the same account. */
it.effect('cancels a closed reconnect before replacing its pending request', () =>
  Effect.gen(function* () {
    const remote = yield* setupFixture(false, 'automatic')
    const pending = ExecutorReferences.cases.SigningIn.make({
      service: references.service,
      app: references.app,
      profile: references.profile,
      owner: references.owner,
      authorization: ExecutorAuthorizationId.make('closed'),
    })
    yield* Ref.update(remote.responses, (values) =>
      new Map(values)
        .set(
          'GET /v1/account-connections/closed',
          reply(200, {
            id: 'closed',
            reconnectAccount: { id: 'original-account' },
            state: { status: 'expired' },
          }),
        )
        .set(
          'POST /v1/account-connections/closed/cancel',
          reply(200, {
            id: 'closed',
            reconnectAccount: { id: 'original-account' },
            state: { status: 'expired' },
          }),
        )
        .set(
          'GET /v1/apps/app',
          reply(200, {
            id: references.app,
            requirements: { accounts: { primary: setupDefinition(false) } },
          }),
        )
        .set('GET /v1/tools', reply(422, WireError.cases.OAuthReconnectRequired.make({}))),
    )
    yield* Effect.gen(function* () {
      const step = yield* (yield* Executor).reauthorize({ ...beginInput, references: pending })
      expect(step._tag).toBe('OpenSignIn')
      expect(step.references).toMatchObject({
        app: references.app,
        profile: references.profile,
        authorization: 'authorization',
      })
    }).pipe(Effect.provide(remote.layer))
    const requests = yield* Ref.get(remote.requests)
    const cancellation = requests.findIndex(
      (request) => request.path === 'POST /v1/account-connections/closed/cancel',
    )
    const replacement = requests.findIndex(
      (request) => request.path === 'POST /v1/account-connections',
    )
    expect(cancellation).toBeGreaterThan(-1)
    expect(replacement).toBeGreaterThan(cancellation)
    expect(requests[replacement]).toMatchObject({
      body: {
        account: 'original-account',
        target: { app: references.app, profile: references.profile },
      },
    })
    expect(
      requests.filter((request) => request.path === 'POST /v1/account-connections'),
    ).toHaveLength(1)
    expect(requests.some((request) => request.path === 'POST /v1/apps/copies')).toBe(false)
  }).pipe(Effect.scoped),
)

/** Both import kinds use the SDK custom import endpoint, then the existing scoped copy/profile flow. */
for (const source of [
  ConnectionSource.cases.Mcp.make({
    address: 'https://integration.example/mcp',
    authorization: 'auto',
  }),
  ConnectionSource.cases.OpenApi.make({
    address: 'https://integration.example/openapi.json',
    content: '{"openapi":"3.0.3","paths":{}}',
  }),
]) {
  it.effect(`registers a custom ${source._tag} source under the acting owner`, () =>
    Effect.gen(function* () {
      const remote = yield* fixture()
      yield* Ref.update(remote.responses, (values) =>
        new Map(values).set('POST /dashboard/api/apps/import', reply(200, template)),
      )
      const importer = ConnectionSource.match(source, {
        Mcp: () => remote.layer,
        OpenApi: () =>
          executorLayer.pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  VIVID_EXECUTOR_URL: remote.address,
                  VIVID_EXECUTOR_KEY: 'isolated-test-key',
                }),
              ),
            ),
          ),
      })
      yield* Effect.gen(function* () {
        const executor = yield* Executor
        const step = yield* executor.add({
          source,
          connectionId: ConnectionId.make('custom-copy'),
          service: ServiceId.make('custom-service'),
          owner: references.owner,
          subject: 'acting-person',
          label: 'Records',
          returnAddress: 'https://vivid.example/return',
        })
        expect(step._tag).toBe('Done')
        expect(step.references.owner).toBe(references.owner)
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.find((request) => request.path === 'POST /dashboard/api/apps/import'),
        ).toMatchObject({
          body: {
            source: ConnectionSource.match(source, {
              Mcp: ({ address }) => ({ url: address }),
              OpenApi: ({ content }) => ({ content }),
            }),
          },
        })
        if (ConnectionSource.guards.OpenApi(source))
          expect(
            requests.find((request) => request.path === 'POST /dashboard/api/apps/import'),
          ).not.toHaveProperty('body.source.url')
        expect(requests.find((request) => request.path === 'POST /v1/apps/copies')).toMatchObject({
          body: { owner: references.owner },
        })
        expect(
          requests.find((request) => request.path === 'POST /v1/apps/copy/profiles'),
        ).toMatchObject({ body: { owner: references.owner, subject: 'acting-person' } })
        expect(requests.some((request) => request.path === 'DELETE /v1/apps/template')).toBe(true)
      }).pipe(Effect.provide(importer))
    }).pipe(Effect.scoped),
  )
}

/** Preflight cannot constrain Executor's later fetch, so missing operator configuration fails closed. */
it.effect(
  'refuses URL registration before import when public-only Executor egress is not declared',
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture()
      const unconfigured = executorLayer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              VIVID_EXECUTOR_URL: remote.address,
              VIVID_EXECUTOR_KEY: 'isolated-test-key',
            }),
          ),
        ),
      )
      yield* Effect.gen(function* () {
        const error = yield* (yield* Executor)
          .add({
            connectionId: ConnectionId.make('disabled-import'),
            service,
            owner: references.owner,
            subject: 'acting-person',
            label: 'Disabled import',
            returnAddress: 'https://vivid.example/return',
            source: ConnectionSource.cases.Mcp.make({
              address: 'https://integration.example/mcp',
              authorization: 'auto',
            }),
          })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(ExecutorPublicAddressRequired)
        expect(
          (yield* Ref.get(remote.requests)).some(
            (request) => request.path === 'POST /dashboard/api/apps/import',
          ),
        ).toBe(false)
      }).pipe(Effect.provide(unconfigured))
    }).pipe(Effect.scoped),
)
