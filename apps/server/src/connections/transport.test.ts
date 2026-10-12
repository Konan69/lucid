import * as NodeHttp from 'node:http'
import type * as NodeNet from 'node:net'
import { NodeHttpClient, NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node'
import * as Undici from '@effect/platform-node/Undici'
import { describe, expect, it } from '@effect/vitest'
import { ConnectionId, InvalidRequest, ServiceId } from '@vivid/contracts'
import {
  ConfigProvider,
  Effect,
  Layer,
  Redacted,
  Ref,
  Schema,
  Deferred,
  Fiber,
  Scope,
  Queue,
  Result,
  Stream,
} from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import {
  Executor,
  ExecutorAccountId,
  ExecutorAppId,
  ExecutorApprovalUnsupported,
  ExecutorCallOutcome,
  ExecutorAuthorizationId,
  ExecutorOwnerId,
  ExecutorProfileId,
  ExecutorReferences,
  ExecutorResponseInvalid,
  ExecutorSetupRequired,
  ExecutorStep,
  ExecutorStatus,
  executorLayer,
} from './executor.ts'
import { ConnectionSource } from './address.ts'
import { executorFailure } from './errors.ts'
import {
  hostedExecutorFixture,
  hostedPrefix,
  hostedOrganization,
  hostedReturnAddress,
  hostedService,
  remoteEntries,
} from './testing.ts'

const identity = {
  service: hostedService,
  app: ExecutorAppId.make('app'),
  profile: ExecutorProfileId.make('profile'),
  owner: ExecutorOwnerId.make('private-owner'),
  appOwnership: 'Shared' as const,
}
const references = ExecutorReferences.cases.Public.make(identity)
const authorized = ExecutorReferences.cases.Authorized.make({
  ...identity,
  account: ExecutorAccountId.make('account'),
})
const key = ExecutorReferences.cases.EnteringKey.make({
  ...identity,
  authorization: ExecutorAuthorizationId.make('authorization'),
  method: 'providerKey',
  label: 'Work',
})
const signingIn = ExecutorReferences.cases.SigningIn.make({
  ...identity,
  authorization: ExecutorAuthorizationId.make('authorization'),
})
const begin = {
  connectionId: ConnectionId.make('connection'),
  service: hostedService,
  owner: references.owner,
  subject: 'private-person',
  label: 'Work',
  returnAddress: hostedReturnAddress,
}
const keyRequirement = {
  slot: {
    provider: 'provider',
    definition: {
      auth: {
        providerKey: {
          type: 'secrets',
          fields: { properties: { token: { title: 'Access token' } } },
        },
      },
    },
  },
}
const signInRequirement = {
  slot: { provider: 'provider', definition: { auth: { oauth: { type: 'oauth2' } } } },
}
const isFirstInstall = Schema.is(Schema.Struct({ entry: Schema.Literal(hostedService) }))
const decodeInstallName = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)
const approvalRequiredReply = Schema.TaggedStruct('ToolApprovalRequired', {
  app: Schema.String,
  deployment: Schema.String,
  tool: Schema.String,
})
const profileConflictReply = Schema.TaggedStruct('ProfileConflict', {})
/** Raw provider fixtures deliberately permit absent or malformed validation detail so the
 * production decoder, rather than the fixture constructor, determines rejection behavior.
 */
const inputInvalidReply = Schema.TaggedStruct('InputInvalid', {
  app: Schema.optionalKey(Schema.String),
  deployment: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  problems: Schema.optionalKey(Schema.Json),
})
const oauthClientUnavailableReply = Schema.TaggedStruct('OAuthClientUnavailable', {})
const storageErrorReply = Schema.TaggedStruct('StorageError', {})

/** Keep indexed fixture reads total after the test has asserted the expected request count. */
function requestAt<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`Expected request at index ${index}`)
  return item
}

/** Every scenario drives the public Executor service through its Fetch HTTP test Layer. Reusing
 * the captured requests proves route, header, account isolation and submission-body semantics.
 */
const scenario = <E>(
  run: (
    remote: Effect.Success<ReturnType<typeof hostedExecutorFixture>>,
  ) => Effect.Effect<void, E, Executor | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const remote = yield* hostedExecutorFixture()
    // A scenario may fork fibers and register finalizers; they end with the scenario, before
    // the recorded requests are checked.
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(remote.configured)
      return yield* run(remote).pipe(Effect.scoped, Effect.provide(context))
    }).pipe(Effect.scoped)
    const requests = yield* Ref.get(remote.requests)
    // A loopback listener can receive unrelated traffic. Preserve the failing postcondition,
    // but expose a safe receipt before individual assertions hide the request's provenance.
    expect(
      requests
        .filter((request) => !request.path.includes(`${hostedPrefix}/`))
        .map(({ path, peer, headers }) => ({
          path,
          peer,
          host: headers.host,
          userAgent: headers['user-agent'],
          accept: headers.accept,
          authorizationPresent: headers.authorization !== undefined,
          fixtureAuthorization: headers.authorization === 'Bearer isolated-test-key',
        })),
    ).toEqual([])
    for (const request of requests) {
      expect(request.path).toContain(`${hostedPrefix}/`)
      expect(request.headers.authorization).toBe('Bearer isolated-test-key')
      expect(request.headers.accept).toBe('application/json')
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.origin).toBeUndefined()
      if (request.body !== null) expect(request.headers['content-type']).toBe('application/json')
      const sent = JSON.stringify({
        path: request.path,
        search: request.search,
        body: request.body,
      })
      expect(sent).not.toMatch(/"(?:owner|subject)"|[?&](?:owner|subject)=/u)
      expect(sent).not.toContain('private-owner')
      expect(sent).not.toContain('private-person')
      expect(sent).not.toContain('unrelated-account')
    }
  }).pipe(Effect.scoped)

/** Keep failure injection at the HTTP seam so the real status/tag decoder chooses recovery. */
const failRoute = Effect.fn('Executor.TransportTest.failRoute')(function* (
  remote: Effect.Success<ReturnType<typeof hostedExecutorFixture>>,
  path: string,
  reply: { readonly status: number; readonly body: Schema.Json },
) {
  yield* Ref.update(
    remote.replies,
    (replies) =>
      new Map([
        ...replies,
        [`${path.split(' ')[0]} ${hostedPrefix}${path.slice(path.indexOf(' ') + 1)}`, reply],
      ]),
  )
})

describe('Executor hosted transport', () => {
  it.effect(
    'retains validation problems, removes sensitive detail, and permits a corrected retry',
    () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* failRoute(remote, 'POST /apps/app/tools/call', {
            status: 422,
            body: inputInvalidReply.make({
              app: 'internal-app',
              deployment: 'internal-deployment',
              tool: 'read',
              problems: ['Input did not match the tool schema'],
            }),
          })
          const executor = yield* Executor
          const outcome = yield* executor.call({ references, tool: 'read', input: {} })
          expect(ExecutorCallOutcome.guards.Rejected(outcome)).toBe(true)
          expect(outcome).toMatchObject({
            problems: ['Input did not match the tool schema'],
          })
          expect(JSON.stringify(outcome)).not.toMatch(
            /private-value|short-private|internal-app|internal-deployment/,
          )
          yield* Ref.set(remote.replies, new Map())
          const retry = yield* executor.call({
            references,
            tool: 'read',
            input: { repoName: 'facebook/react' },
          })
          expect(retry._tag).toBe('Completed')
        }),
      ),
  )

  it.effect('keeps invalid or absent validation detail a definite rejection', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const executor = yield* Executor
        for (const body of [
          inputInvalidReply.make({}),
          inputInvalidReply.make({ problems: [42] }),
          inputInvalidReply.make({ problems: 'invalid' }),
        ]) {
          yield* failRoute(remote, 'POST /apps/app/tools/call', { status: 422, body })
          expect(yield* executor.call({ references, tool: 'read', input: {} })).toEqual(
            ExecutorCallOutcome.cases.Rejected.make({
              message:
                'Input did not match the tool schema. Inspect the current tool and correct its input.',
            }),
          )
        }
      }),
    ),
  )

  it.effect(
    'accepts future safe field problems without response identity and removes call references',
    () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* failRoute(remote, 'POST /apps/app/tools/call', {
            status: 422,
            body: inputInvalidReply.make({
              problems: [
                'owner: required',
                'id: expected a string',
                'selection app profile account',
              ],
            }),
          })
          const outcome = yield* (yield* Executor).call({
            references: authorized,
            tool: 'read',
            input: {},
          })
          expect(ExecutorCallOutcome.guards.Rejected(outcome)).toBe(true)
          expect(outcome).toMatchObject({
            problems: [
              'owner: required',
              'id: expected a string',
              'selection [REDACTED] [REDACTED] [REDACTED]',
            ],
          })
        }),
      ),
  )

  it.effect('installs one shared app, reuses it, and deduplicates profiles by ConnectionId', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const first = yield* executor.begin(begin)
        const retry = yield* executor.begin(begin)
        const second = yield* executor.begin({
          ...begin,
          connectionId: ConnectionId.make('second'),
          owner: ExecutorOwnerId.make('other-owner'),
          subject: 'other-person',
        })
        expect(retry).toEqual(first)
        expect(second.references.app).toBe(first.references.app)
        expect(second.references.profile).not.toBe(first.references.profile)
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.filter((request) => request.path === `POST ${hostedPrefix}/apps/install`),
        ).toHaveLength(1)
        expect(
          requests.filter((request) => request.path === `GET ${hostedPrefix}/inventory`),
        ).toHaveLength(3)
        expect(
          requests
            .filter((request) => request.path === `POST ${hostedPrefix}/apps/app/profiles`)
            .map((request) => request.body),
        ).toEqual([
          { name: 'Work', accounts: {}, idempotencyKey: 'connection' },
          { name: 'Work', accounts: {}, idempotencyKey: 'connection' },
          { name: 'Work', accounts: {}, idempotencyKey: 'second' },
        ])
        expect(
          requests.find((request) => request.path === `POST ${hostedPrefix}/apps/install`),
        ).toMatchObject({ body: { entry: hostedService, name: expect.any(String) } })
      }),
    ),
  )

  it.effect('installs different app names independently while one install is blocked', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const other = ServiceId.make('other/service')
        yield* Ref.update(remote.catalog, (entries) => [
          ...entries,
          { id: other, kind: 'app', name: 'Other Integration', description: '' },
        ])
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* Ref.set(
          remote.intercept,
          Effect.fn('InstallTest.blockFirst')(function* (request) {
            if (
              request.path === `POST ${hostedPrefix}/apps/install` &&
              isFirstInstall(request.body)
            ) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
          }),
        )
        const executor = yield* Executor
        const first = yield* executor.begin(begin).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const second = yield* executor.begin({
          ...begin,
          service: other,
          connectionId: ConnectionId.make('second'),
        })
        expect(second._tag).toBe('Done')
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        expect(
          (yield* Ref.get(remote.requests)).filter(
            (request) => request.path === `POST ${hostedPrefix}/apps/install`,
          ),
        ).toHaveLength(2)
      }),
    ),
  )

  it.effect('rereads inventory once after another process wins the exact app-name race', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(
          remote.intercept,
          Effect.fn('InstallTest.racingProcess')(function* (request) {
            if (request.path !== `POST ${hostedPrefix}/apps/install`) return
            const payload = decodeInstallName(request.body)
            yield* Ref.set(remote.apps, [{ id: 'app', name: payload.name }])
          }),
        )
        yield* failRoute(remote, 'POST /apps/install', {
          status: 409,
          body: Schema.TaggedStruct('AppNameTaken', {}).make({}),
        })
        expect((yield* (yield* Executor).begin(begin))._tag).toBe('Done')
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.filter((request) => request.path === `GET ${hostedPrefix}/inventory`),
        ).toHaveLength(2)
        expect(
          requests.filter((request) => request.path === `POST ${hostedPrefix}/apps/install`),
        ).toHaveLength(1)
        expect(
          requests.filter((request) => request.path === `GET ${hostedPrefix}/apps/app`),
        ).toHaveLength(1)
      }),
    ),
  )

  it.effect('keeps two distinct Integrations on their own installed app and profile ids', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const other = ServiceId.make('other/service')
        yield* Ref.update(remote.catalog, (entries) => [
          ...entries,
          { id: other, kind: 'app', name: 'Other Integration', description: '' },
        ])
        const executor = yield* Executor
        const first = yield* executor.begin(begin)
        const second = yield* executor.begin({
          ...begin,
          service: other,
          connectionId: ConnectionId.make('second'),
        })
        const repeated = yield* executor.begin({
          ...begin,
          service: other,
          connectionId: ConnectionId.make('third'),
        })
        expect(first.references.app).not.toBe(second.references.app)
        expect(first.references.profile).not.toBe(second.references.profile)
        expect(repeated.references.app).toBe(second.references.app)
        expect(repeated.references.profile).not.toBe(second.references.profile)
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.filter((request) => request.path === `POST ${hostedPrefix}/apps/install`),
        ).toHaveLength(2)
        expect(
          requests.filter(
            (request) =>
              request.path === `POST ${hostedPrefix}/apps/${first.references.app}/profiles`,
          ),
        ).toHaveLength(1)
        expect(
          requests.filter(
            (request) =>
              request.path === `POST ${hostedPrefix}/apps/${second.references.app}/profiles`,
          ),
        ).toHaveLength(2)
        yield* executor.remove(first.references)
        expect(
          (yield* Ref.get(remote.requests))
            .filter((request) => request.path.startsWith('DELETE'))
            .map((request) => request.path),
        ).toEqual([
          `DELETE ${hostedPrefix}/apps/${first.references.app}/profiles/${first.references.profile}`,
        ])
      }),
    ),
  )

  it.effect('ignores foreign requirement shapes and reads only the selected installed app', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const first = yield* executor.begin(begin)
        const installed = yield* Ref.get(remote.apps)
        yield* failRoute(remote, 'GET /inventory', {
          status: 200,
          body: {
            apps: [
              {
                id: 'foreign-app',
                name: 'Other app',
                requirements: {
                  accounts: { many: { definition: { auth: { alien: { type: 'future-auth' } } } } },
                },
              },
              ...installed.map((app) => ({
                id: app.id,
                name: app.name,
                requirements: 'detail must be fetched separately',
              })),
            ],
          },
        })
        const second = yield* executor.begin({
          ...begin,
          connectionId: ConnectionId.make('second'),
        })
        expect(second.references.app).toBe(first.references.app)
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.filter((request) => request.path === `POST ${hostedPrefix}/apps/install`),
        ).toHaveLength(1)
        expect(
          requests.filter((request) => request.path === `GET ${hostedPrefix}/apps/app`),
        ).toHaveLength(1)
        expect(requests.some((request) => request.path.includes('foreign-app'))).toBe(false)
      }),
    ),
  )

  it.effect('imports dedicated public MCP probes without cascading another Connection', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const source = ConnectionSource.cases.Mcp.make({
          address: 'https://example.test/mcp',
          authorization: 'auto',
        })
        yield* Ref.update(remote.replies, (replies) =>
          new Map(replies).set(`DELETE ${hostedPrefix}/apps/app`, {
            status: 200,
            body: { app: 'app' },
          }),
        )
        const executor = yield* Executor
        const first = yield* executor.add({
          ...begin,
          service: ServiceId.make(`url:${source.address}`),
          source,
        })
        const second = yield* executor.add({
          ...begin,
          connectionId: ConnectionId.make('second'),
          service: ServiceId.make(`url:${source.address}`),
          source,
        })
        expect(second.references.app).not.toBe(first.references.app)
        yield* executor.remove(first.references)
        expect((yield* executor.status(second.references))._tag).toBe('Ready')
        expect((yield* executor.tools(second.references)).map((tool) => tool.name)).toEqual([
          'read',
        ])
        const requests = yield* Ref.get(remote.requests)
        const imports = requests.filter(
          (request) => request.path === `POST ${hostedPrefix}/apps/import`,
        )
        expect(imports).toHaveLength(2)
        expect(requestAt(imports, 0).body).toEqual({
          source: { kind: 'mcp', url: source.address, name: expect.any(String) },
        })
        expect(requests.some((request) => request.path === `DELETE ${hostedPrefix}/apps/app`)).toBe(
          true,
        )
      }),
    ),
  )

  it.effect('rejects OpenAPI URL imports unsupported by the hosted source before HTTP', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const source = ConnectionSource.cases.OpenApi.make({
          address: 'https://example.test/openapi.json',
        })
        const error = yield* (yield* Executor).add({ ...begin, source }).pipe(Effect.flip)
        expect(error).toHaveProperty('_tag', 'ExecutorSourceUnsupported')
        expect(executorFailure(error)).toEqual(
          new InvalidRequest({
            message:
              'An OpenAPI document cannot be added as an Integration yet. You can add an MCP server.',
          }),
        )
        expect(
          (yield* Ref.get(remote.requests)).every((request) => request.path.endsWith('/catalog')),
        ).toBe(true)
      }),
    ),
  )

  it.effect('refuses query-bearing import URLs before HTTP with actionable copy', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const source = ConnectionSource.cases.Mcp.make({
          address: 'https://example.test/mcp?token=private-value',
          authorization: 'auto',
        })
        const failure = yield* (yield* Executor).add({ ...begin, source }).pipe(Effect.flip)
        expect(failure._tag).toBe('ExecutorImportQueryUnsupported')
        expect(executorFailure(failure)).toHaveProperty(
          'message',
          'An MCP server address cannot include query parameters. Use its base endpoint address.',
        )
        expect(JSON.stringify(failure)).not.toContain('private-value')
        expect(yield* Ref.get(remote.requests)).toEqual([])
      }),
    ),
  )

  it.effect('does not describe an unknown import refusal as a tool dispatch', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'POST /apps/import', {
          status: 422,
          body: Schema.TaggedStruct('FutureImportFailure', {}).make({}),
        })
        const source = ConnectionSource.cases.Mcp.make({
          address: 'https://example.test/mcp',
          authorization: 'auto',
        })
        const failure = yield* (yield* Executor).add({ ...begin, source }).pipe(Effect.flip)
        expect(executorFailure(failure)).toHaveProperty(
          'message',
          'The Integration management request was refused.',
        )
      }),
    ),
  )

  for (const operation of ['status', 'reauthorize', 'remove'] as const) {
    it.effect(`refuses a mismatching pending profile during ${operation} without mutation`, () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* failRoute(remote, 'GET /connections/authorization', {
            status: 200,
            body: {
              id: 'authorization',
              reconnectAccount: null,
              target: { app: 'app', profile: 'foreign-profile' },
              state: { status: 'pending' },
            },
          })
          const executor = yield* Executor
          const action =
            operation === 'reauthorize'
              ? executor.reauthorize({ ...begin, references: key })
              : executor[operation](key)
          const failure = yield* action.pipe(Effect.flip)
          expect(failure).toBeInstanceOf(ExecutorResponseInvalid)
          expect(
            (yield* Ref.get(remote.requests)).every((request) => request.path.startsWith('GET')),
          ).toBe(true)
        }),
      ),
    )
  }

  it.effect('reads every cursor page and pins the snapshot for invocation', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.paginated, true)
        const executor = yield* Executor
        const tools = yield* executor.tools(references)
        expect(tools.map((tool) => [tool.name, tool.effect])).toEqual([
          ['read', 'read'],
          ['write', 'write'],
        ])
        yield* executor.call({ references, tool: 'write', input: { value: 1 } })
        const requests = yield* Ref.get(remote.requests)
        const pages = requests.filter(
          (request) => request.path === `GET ${hostedPrefix}/apps/app/tools`,
        )
        expect(pages).toHaveLength(2)
        expect(new URLSearchParams(requestAt(pages, 1).search).get('cursor')).toBe(
          'next/with+&symbols',
        )
        expect(new URLSearchParams(requestAt(pages, 1).search).get('expectedProfileRevision')).toBe(
          '1',
        )
        expect(
          requests.find((request) => request.path === `POST ${hostedPrefix}/apps/app/tools/call`),
        ).toMatchObject({
          body: {
            profile: 'profile',
            deployment: 'deployment',
            expectedProfileRevision: 1,
            tool: 'write',
            input: { value: 1 },
          },
        })
      }),
    ),
  )

  it.effect('refuses a repeated cursor instead of returning a partial catalogue', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'GET /apps/app/tools', {
          status: 200,
          body: {
            profile: 'profile',
            profileRevision: 1,
            deployment: 'deployment',
            items: [],
            routers: [],
            next: 'repeated',
          },
        })
        expect(yield* (yield* Executor).tools(references).pipe(Effect.flip)).toBeInstanceOf(
          ExecutorResponseInvalid,
        )
        expect(
          (yield* Ref.get(remote.requests)).filter((request) => request.path.endsWith('/tools')),
        ).toHaveLength(2)
      }),
    ),
  )

  for (const value of [
    {
      title: 'structured result',
      result: {
        content: [{ type: 'text', text: 'Done' }],
        structuredContent: { ok: true },
        isError: false,
      },
    },
    { title: 'array result', result: { result: [1, 2, 3] } },
    { title: 'plain OpenAPI result', result: 'plain OpenAPI result' },
  ]) {
    it.effect(`preserves the raw successful result: ${value.title}`, () =>
      scenario((remote) =>
        Effect.gen(function* () {
          const result = yield* decodeJson(value.result)
          yield* Ref.set(remote.result, result)
          expect(yield* (yield* Executor).call({ references, tool: 'read', input: {} })).toEqual(
            ExecutorCallOutcome.cases.Completed.make({ value: result }),
          )
        }),
      ),
    )
  }

  it.effect(
    'maps isError to the existing tool-error outcome with sensitive diagnostics removed',
    () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.result, {
            content: [{ type: 'text', text: 'Bearer sensitive-provider-value' }],
            isError: true,
          })
          const result = yield* (yield* Executor).call({ references, tool: 'read', input: {} })
          expect(ExecutorCallOutcome.guards.Rejected(result)).toBe(true)
          if (ExecutorCallOutcome.guards.Rejected(result))
            expect(result.message).toContain('sensitive diagnostics were removed')
          expect(JSON.stringify(result)).not.toContain('sensitive-provider-value')
        }),
      ),
  )

  it.effect('reports hosted approval as unsupported with no invented request id', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'POST /apps/app/tools/call', {
          status: 409,
          body: approvalRequiredReply.make({
            app: 'app',
            deployment: 'deployment',
            tool: 'read',
          }),
        })
        const error = yield* (yield* Executor)
          .call({ references, tool: 'read', input: {} })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(ExecutorApprovalUnsupported)
        expect(error).toHaveProperty('tool', 'read')
        expect(error).not.toHaveProperty('requestId')
        const publicError = executorFailure(error)
        expect(publicError).toBeInstanceOf(InvalidRequest)
        expect(publicError.message).toBe(
          'This Integration action needs an approval Vivid cannot give yet.',
        )
      }),
    ),
  )

  it.effect(
    'begins an API-key connection from the real provider method, submits it and reconciles',
    () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.accounts, keyRequirement)
          const executor = yield* Executor
          const step = yield* executor.begin(begin)
          if (!ExecutorStep.guards.EnterKey(step)) throw new Error('Expected key fields')
          expect(step.fields).toEqual([{ name: 'token', label: 'Access token' }])
          expect(step.references.method).toBe('providerKey')
          const result = yield* executor.complete({
            references: step.references,
            fields: { token: Redacted.make('fixture-key') },
          })
          expect(ExecutorReferences.guards.Authorized(result)).toBe(true)
          if (ExecutorReferences.guards.Authorized(result)) {
            expect(result.account).toBe('account')
            expect(result.profile).toBe(step.references.profile)
          }
          const requests = yield* Ref.get(remote.requests)
          expect(
            requests.find(
              (request) => request.path === `POST ${hostedPrefix}/apps/app/connections`,
            ),
          ).toMatchObject({ body: { requirement: 'slot', profile: step.references.profile } })
          expect(
            requests.find(
              (request) => request.path === `POST ${hostedPrefix}/connections/authorization/submit`,
            ),
          ).toMatchObject({
            body: { method: 'providerKey', label: 'Work', fields: { token: 'fixture-key' } },
          })
          expect(requestAt(requests, requests.length - 1).path).toBe(
            `POST ${hostedPrefix}/apps/app/profiles/${step.references.profile}/reconcile`,
          )
        }),
      ),
  )

  it.effect('prefers OAuth for a newly installed mixed-auth catalogue app', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, {
          slot: {
            provider: 'provider',
            definition: {
              auth: {
                ...keyRequirement.slot.definition.auth,
                ...signInRequirement.slot.definition.auth,
              },
            },
          },
        })
        const step = yield* (yield* Executor).begin(begin)
        expect(step._tag).toBe('OpenSignIn')
        expect(
          (yield* Ref.get(remote.requests)).find(
            (request) =>
              request.path === `POST ${hostedPrefix}/connections/authorization/oauth/start`,
          ),
        ).toMatchObject({ body: { method: 'oauth' } })
      }),
    ),
  )

  it.effect('refreshes setup-required catalogue facts after the existing inspection TTL', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, signInRequirement)
        yield* failRoute(remote, 'GET /providers/provider/oauth/oauth/setup', {
          status: 200,
          body: { mode: 'client-required' },
        })
        const executor = yield* Executor
        expect(yield* executor.begin(begin).pipe(Effect.flip)).toBeInstanceOf(ExecutorSetupRequired)
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
        const reads = (yield* Ref.get(remote.requests)).filter((request) =>
          request.path.endsWith('/oauth/oauth/setup'),
        ).length
        yield* Ref.set(remote.replies, new Map())
        yield* TestClock.adjust('9 minutes')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
        expect(
          yield* executor.authorization({
            service: hostedService,
            returnAddress: 'https://other.example.test/return',
          }),
        ).toHaveProperty('_tag', 'SetupRequired')
        expect(
          (yield* Ref.get(remote.requests)).filter((request) =>
            request.path.endsWith('/oauth/oauth/setup'),
          ),
        ).toHaveLength(reads)
        yield* TestClock.adjust('1 minute')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
        expect(
          yield* executor.authorization({
            service: hostedService,
            returnAddress: hostedReturnAddress,
          }),
        ).toHaveProperty('_tag', 'SignIn')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SignIn',
        )
        expect(
          (yield* Ref.get(remote.requests)).filter((request) =>
            request.path.endsWith('/oauth/oauth/setup'),
          ),
        ).toHaveLength(reads + 1)
        expect((yield* executor.begin(begin))._tag).toBe('OpenSignIn')
      }),
    ),
  )

  it.effect('retains refused sign-in for ten minutes despite positive setup, then refreshes', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, signInRequirement)
        yield* failRoute(remote, 'POST /connections/authorization/oauth/start', {
          status: 409,
          body: oauthClientUnavailableReply.make({}),
        })
        const executor = yield* Executor
        expect(yield* executor.begin(begin).pipe(Effect.flip)).toHaveProperty(
          '_tag',
          'ExecutorSignInRequired',
        )
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
        yield* Ref.set(remote.replies, new Map())
        yield* TestClock.adjust('9 minutes')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
        expect(
          yield* executor.authorization({
            service: hostedService,
            returnAddress: hostedReturnAddress,
          }),
        ).toHaveProperty('_tag', 'SetupRequired')
        yield* TestClock.adjust('1 minute')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
        expect(
          yield* executor.authorization({
            service: hostedService,
            returnAddress: hostedReturnAddress,
          }),
        ).toHaveProperty('_tag', 'SignIn')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SignIn',
        )
      }),
    ),
  )

  it.effect(
    'serves retained catalogue facts and retains failed inspections for thirty seconds',
    () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.accounts, signInRequirement)
          const executor = yield* Executor
          yield* executor.begin(begin)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          yield* Ref.set(
            remote.intercept,
            Effect.fn('SetupTest.block')(function* (request) {
              if (request.path.endsWith('/oauth/oauth/setup')) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }
            }),
          )
          yield* failRoute(remote, 'GET /providers/provider/oauth/oauth/setup', {
            status: 500,
            body: storageErrorReply.make({}),
          })
          yield* TestClock.adjust('10 minutes')
          expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
            'authorization._tag',
            'SignIn',
          )
          yield* Deferred.await(entered)
          expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
            'authorization._tag',
            'SignIn',
          )
          yield* Deferred.succeed(release, undefined)
          yield* executor
            .authorization({ service: hostedService, returnAddress: hostedReturnAddress })
            .pipe(Effect.flip)
          const reads = (yield* Ref.get(remote.requests)).filter((request) =>
            request.path.endsWith('/oauth/oauth/setup'),
          ).length
          expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
            'authorization._tag',
            'SignIn',
          )
          yield* TestClock.adjust('29 seconds')
          yield* executor
            .authorization({ service: hostedService, returnAddress: hostedReturnAddress })
            .pipe(Effect.flip)
          expect(
            (yield* Ref.get(remote.requests)).filter((request) =>
              request.path.endsWith('/oauth/oauth/setup'),
            ),
          ).toHaveLength(reads)
          yield* TestClock.adjust('1 second')
          yield* executor
            .authorization({ service: hostedService, returnAddress: hostedReturnAddress })
            .pipe(Effect.flip)
          expect(
            (yield* Ref.get(remote.requests)).filter((request) =>
              request.path.endsWith('/oauth/oauth/setup'),
            ),
          ).toHaveLength(reads + 1)
        }),
      ),
  )

  it.effect('inspects actual setup after authorization cached only catalogue metadata', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, signInRequirement)
        const executor = yield* Executor
        yield* executor.authorization({
          service: hostedService,
          returnAddress: hostedReturnAddress,
        })
        yield* failRoute(remote, 'GET /providers/provider/oauth/oauth/setup', {
          status: 200,
          body: { mode: 'client-required' },
        })
        expect(yield* executor.begin(begin).pipe(Effect.flip)).toHaveProperty(
          '_tag',
          'ExecutorSetupRequired',
        )
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
      }),
    ),
  )

  it.effect('does not publish an in-flight positive inspection over a sign-in refusal', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, signInRequirement)
        const executor = yield* Executor
        yield* executor.begin(begin)
        yield* TestClock.adjust('9 minutes')
        const signInEntered = yield* Deferred.make<void>()
        const signInRelease = yield* Deferred.make<void>()
        const setupEntered = yield* Deferred.make<void>()
        const setupRelease = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() =>
          Effect.all([
            Deferred.succeed(signInRelease, undefined),
            Deferred.succeed(setupRelease, undefined),
          ]),
        )
        const blockSetup = yield* Ref.make(false)
        yield* Ref.set(
          remote.intercept,
          Effect.fn('SetupTest.race')(function* (request) {
            if (request.path.endsWith('/oauth/start')) {
              yield* Deferred.succeed(signInEntered, undefined)
              yield* Deferred.await(signInRelease)
            }
            if (request.path.endsWith('/oauth/oauth/setup') && (yield* Ref.get(blockSetup))) {
              yield* Deferred.succeed(setupEntered, undefined)
              yield* Deferred.await(setupRelease)
            }
          }),
        )
        yield* failRoute(remote, 'POST /connections/authorization/oauth/start', {
          status: 409,
          body: oauthClientUnavailableReply.make({}),
        })
        const pendingSignIn = yield* executor.begin(begin).pipe(Effect.flip, Effect.forkScoped)
        yield* Deferred.await(signInEntered)
        yield* Ref.set(blockSetup, true)
        yield* TestClock.adjust('1 minute')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SignIn',
        )
        yield* Deferred.await(setupEntered)
        const pendingInspection = yield* executor
          .authorization({ service: hostedService, returnAddress: hostedReturnAddress })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        // Immediate startup reaches the pending cache entry before the refusal is recorded.
        yield* Deferred.succeed(signInRelease, undefined)
        expect(yield* Fiber.join(pendingSignIn)).toHaveProperty('_tag', 'ExecutorSignInRequired')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
        yield* Deferred.succeed(setupRelease, undefined)
        expect(yield* Fiber.join(pendingInspection)).toHaveProperty('_tag', 'SetupRequired')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
      }),
    ),
  )

  it.effect('does not publish an in-flight failed inspection over a sign-in refusal', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, signInRequirement)
        const executor = yield* Executor
        yield* executor.begin(begin)
        yield* TestClock.adjust('9 minutes')
        const signInEntered = yield* Deferred.make<void>()
        const signInRelease = yield* Deferred.make<void>()
        const setupEntered = yield* Deferred.make<void>()
        const setupRelease = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() =>
          Effect.all([
            Deferred.succeed(signInRelease, undefined),
            Deferred.succeed(setupRelease, undefined),
          ]),
        )
        const blockSetup = yield* Ref.make(false)
        yield* Ref.set(
          remote.intercept,
          Effect.fn('SetupTest.race')(function* (request) {
            if (request.path.endsWith('/oauth/start')) {
              yield* Deferred.succeed(signInEntered, undefined)
              yield* Deferred.await(signInRelease)
            }
            if (request.path.endsWith('/oauth/oauth/setup') && (yield* Ref.get(blockSetup))) {
              yield* Deferred.succeed(setupEntered, undefined)
              yield* Deferred.await(setupRelease)
            }
          }),
        )
        yield* failRoute(remote, 'POST /connections/authorization/oauth/start', {
          status: 409,
          body: oauthClientUnavailableReply.make({}),
        })
        const pendingSignIn = yield* executor.begin(begin).pipe(Effect.flip, Effect.forkScoped)
        yield* Deferred.await(signInEntered)
        yield* Ref.set(blockSetup, true)
        yield* TestClock.adjust('1 minute')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SignIn',
        )
        yield* Deferred.await(setupEntered)
        yield* failRoute(remote, 'GET /providers/provider/oauth/oauth/setup', {
          status: 500,
          body: storageErrorReply.make({}),
        })
        const pendingInspection = yield* executor
          .authorization({ service: hostedService, returnAddress: hostedReturnAddress })
          .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }))
        // Immediate startup reaches the pending cache entry before the refusal is recorded.
        yield* Deferred.succeed(signInRelease, undefined)
        expect(yield* Fiber.join(pendingSignIn)).toHaveProperty('_tag', 'ExecutorSignInRequired')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
        yield* Deferred.succeed(setupRelease, undefined)
        expect(yield* Fiber.join(pendingInspection)).toHaveProperty('value._tag', 'SetupRequired')
        expect(
          yield* executor.authorization({
            service: hostedService,
            returnAddress: hostedReturnAddress,
          }),
        ).toHaveProperty('_tag', 'SetupRequired')
        expect(remoteEntries(yield* executor.catalog)[0]).toHaveProperty(
          'authorization._tag',
          'SetupRequired',
        )
      }),
    ),
  )

  it.effect('switches a refused custom OAuth import to a dedicated personal-key app', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, signInRequirement)
        const source = ConnectionSource.cases.Mcp.make({
          address: 'https://example.test/mcp',
          authorization: 'auto',
        })
        const input = { ...begin, service: ServiceId.make(`url:${source.address}`), source }
        yield* failRoute(remote, 'GET /providers/provider/oauth/oauth/setup', {
          status: 200,
          body: { mode: 'client-required' },
        })
        const deployed = {
          id: 'keyed-app',
          name: 'Keyed fixture',
          requirements: {
            accounts: {
              service: {
                provider: 'provider',
                definition: {
                  auth: { pat: { type: 'secrets', fields: { properties: { token: {} } } } },
                },
              },
            },
          },
        }
        yield* Ref.update(remote.replies, (replies) =>
          new Map(replies)
            .set(`DELETE ${hostedPrefix}/apps/app`, { status: 200, body: { app: 'app' } })
            .set(`POST ${hostedPrefix}/apps/deploy`, { status: 200, body: deployed }),
        )
        const step = yield* (yield* Executor).add(input)
        expect(ExecutorStep.guards.EnterKey(step)).toBe(true)
        if (!ExecutorStep.guards.EnterKey(step)) return expect.fail('Expected personal key')
        expect(step.references).toMatchObject({
          app: 'keyed-app',
          method: 'pat',
          appOwnership: 'Dedicated',
        })
        expect(step.fields).toEqual([{ name: 'token', label: 'Personal access token' }])
        const requests = yield* Ref.get(remote.requests)
        const remove = requests.findIndex(
          (request) => request.path === `DELETE ${hostedPrefix}/apps/app`,
        )
        const deploy = requests.findIndex(
          (request) => request.path === `POST ${hostedPrefix}/apps/deploy`,
        )
        expect(remove).toBeGreaterThan(-1)
        expect(deploy).toBeGreaterThan(remove)
        return yield* Effect.void
      }),
    ),
  )

  it.effect('retains refusal while ordinary inspections exceed cache capacity', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const otherServices = Array.from({ length: 1300 }, (_, index) =>
          ServiceId.make(`service-${index}`),
        )
        const others = otherServices.map((id) => ({
          id,
          kind: 'mcp',
          name: 'Test Integration',
          description: 'Test service',
          connectUrl: 'https://example.test',
        }))
        yield* Ref.update(remote.catalog, (current) => [...current, ...others])
        yield* Ref.set(remote.accounts, signInRequirement)
        yield* failRoute(remote, 'POST /connections/authorization/oauth/start', {
          status: 409,
          body: oauthClientUnavailableReply.make({}),
        })
        const executor = yield* Executor
        yield* executor.begin(begin).pipe(Effect.flip)
        yield* Ref.set(remote.replies, new Map())
        for (const service of otherServices) {
          yield* executor.authorization({ service, returnAddress: hostedReturnAddress })
        }
        expect(
          yield* executor.authorization({
            service: hostedService,
            returnAddress: hostedReturnAddress,
          }),
        ).toHaveProperty('_tag', 'SetupRequired')
      }),
    ),
  )

  it.effect('inspects OAuth setup and starts with the matching deployment redirect', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, signInRequirement)
        const step = yield* (yield* Executor).begin(begin)
        expect(ExecutorStep.guards.OpenSignIn(step)).toBe(true)
        if (ExecutorStep.guards.OpenSignIn(step))
          expect(step.address).toBe(
            'https://provider.example.test/sign-in?state=hosted-fixture-oauth-state-00000000',
          )
        expect(step).not.toHaveProperty('url')
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.some(
            (request) =>
              request.path === `GET ${hostedPrefix}/providers/provider/oauth/oauth/setup`,
          ),
        ).toBe(true)
        expect(
          requests.find(
            (request) =>
              request.path === `POST ${hostedPrefix}/connections/authorization/oauth/start`,
          ),
        ).toMatchObject({ body: { method: 'oauth', label: 'Work' } })
      }),
    ),
  )

  it.effect(
    'refuses a mismatching redirect URI without leaking either URL or deleting shared code',
    () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.accounts, signInRequirement)
          yield* Ref.set(remote.redirectUri, 'https://executor.example.test/private-callback')
          const error = yield* (yield* Executor).begin(begin).pipe(Effect.flip)
          expect(error).toBeInstanceOf(ExecutorSetupRequired)
          expect(remoteEntries(yield* (yield* Executor).catalog)[0]).toHaveProperty(
            'authorization._tag',
            'SetupRequired',
          )
          expect(JSON.stringify(executorFailure(error))).not.toMatch(/https?:|private-callback/u)
          expect(
            (yield* Ref.get(remote.requests))
              .filter((request) => request.path.startsWith('DELETE'))
              .map((request) => request.path),
          ).toEqual([`DELETE ${hostedPrefix}/apps/app/profiles/profile-connection`])
        }),
      ),
  )

  it.effect(
    'cleans up a profile after a lost authorization create and preserves that failure if cleanup fails',
    () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.accounts, keyRequirement)
          yield* failRoute(remote, 'POST /apps/app/connections', {
            status: 502,
            body: Schema.TaggedStruct('StorageError', {}).make({}),
          })
          yield* failRoute(remote, 'DELETE /apps/app/profiles/profile-connection', {
            status: 409,
            body: profileConflictReply.make({}),
          })
          const failure = yield* (yield* Executor).begin(begin).pipe(Effect.flip)
          expect(failure._tag).toBe('ExecutorExecutionUncertain')
          expect(
            (yield* Ref.get(remote.requests))
              .filter((request) => request.path.startsWith('DELETE'))
              .map((request) => request.path),
          ).toEqual([`DELETE ${hostedPrefix}/apps/app/profiles/profile-connection`])
        }),
      ),
  )

  it.effect('completes OAuth by callback URL under the key and reconciles the saved profile', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const callback = `${hostedReturnAddress}?code=fixture-code&state=fixture-state`
        const result = yield* (yield* Executor).completeSignIn({
          references: signingIn,
          callbackAddress: Redacted.make(callback),
        })
        expect(ExecutorReferences.guards.Authorized(result)).toBe(true)
        if (ExecutorReferences.guards.Authorized(result)) {
          expect(result.account).toBe('account')
          expect(result.profile).toBe('profile')
        }
        expect(
          (yield* Ref.get(remote.requests)).find(
            (request) =>
              request.path === `POST ${hostedPrefix}/connections/authorization/oauth/complete`,
          ),
        ).toMatchObject({ body: { callbackUrl: callback } })
      }),
    ),
  )

  it.effect('reads a healthy profile before proving tool readiness', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        expect(yield* (yield* Executor).status(references)).toEqual(
          ExecutorStatus.cases.Ready.make({ references }),
        )
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests
            .filter((request) => !request.path.endsWith('/catalog'))
            .map((request) => request.path),
        ).toEqual([
          `GET ${hostedPrefix}/apps/app/profiles/profile`,
          `GET ${hostedPrefix}/apps/app/tools`,
        ])
      }),
    ),
  )

  it.effect('renews only the saved account and reuses its profile', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.accounts, keyRequirement)
        const executor = yield* Executor
        yield* executor.begin(begin)
        yield* failRoute(remote, 'GET /apps/app/profiles/profile', {
          status: 200,
          body: { id: 'profile', status: 'needs-setup', failure: 'accounts' },
        })
        yield* failRoute(remote, 'POST /apps/app/profiles/profile/reconcile', {
          status: 200,
          body: { id: 'profile', status: 'needs-setup', failure: 'accounts' },
        })
        const step = yield* executor.reauthorize({ ...begin, references: authorized })
        expect(ExecutorStep.guards.EnterKey(step)).toBe(true)
        if (ExecutorStep.guards.EnterKey(step)) expect(step.references).toEqual(key)
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.filter(
            (request) => request.path === `POST ${hostedPrefix}/accounts/account/connections`,
          ),
        ).toHaveLength(1)
        expect(
          requests.filter((request) => request.path === `POST ${hostedPrefix}/apps/app/profiles`),
        ).toHaveLength(1)
      }),
    ),
  )

  it.effect('does not delete an account when removing its profile fails', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'DELETE /apps/app/profiles/profile', {
          status: 409,
          body: profileConflictReply.make({}),
        })
        expect(yield* (yield* Executor).remove(authorized).pipe(Effect.flip)).toHaveProperty(
          '_tag',
          'ExecutorConflict',
        )
        expect(
          (yield* Ref.get(remote.requests)).some(
            (request) => request.path === `DELETE ${hostedPrefix}/accounts/account`,
          ),
        ).toBe(false)
      }),
    ),
  )

  it.effect('retries a partial remove through an already absent profile and account', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const executor = yield* Executor
        yield* failRoute(remote, 'DELETE /accounts/account', {
          status: 409,
          body: profileConflictReply.make({}),
        })
        expect(yield* executor.remove(authorized).pipe(Effect.flip)).toHaveProperty(
          '_tag',
          'ExecutorConflict',
        )
        yield* failRoute(remote, 'DELETE /apps/app/profiles/profile', {
          status: 404,
          body: Schema.TaggedStruct('ProfileNotFound', {}).make({}),
        })
        yield* failRoute(remote, 'DELETE /accounts/account', {
          status: 404,
          body: Schema.TaggedStruct('AccountNotFound', {}).make({}),
        })
        yield* executor.remove(authorized)
        expect(
          (yield* Ref.get(remote.requests))
            .filter((request) => request.path.startsWith('DELETE'))
            .map((request) => request.path),
        ).toEqual([
          `DELETE ${hostedPrefix}/apps/app/profiles/profile`,
          `DELETE ${hostedPrefix}/accounts/account`,
          `DELETE ${hostedPrefix}/apps/app/profiles/profile`,
          `DELETE ${hostedPrefix}/accounts/account`,
        ])
      }),
    ),
  )

  it.effect('removes the profile before its exact account and preserves the shared app', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* (yield* Executor).remove(authorized)
        expect(
          (yield* Ref.get(remote.requests))
            .filter((request) => request.path.startsWith('DELETE'))
            .map((request) => request.path),
        ).toEqual([
          `DELETE ${hostedPrefix}/apps/app/profiles/profile`,
          `DELETE ${hostedPrefix}/accounts/account`,
        ])
      }),
    ),
  )

  for (const pending of [key, signingIn]) {
    it.effect(`removes the saved reconnect account while ${pending._tag}`, () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* failRoute(remote, 'GET /connections/authorization', {
            status: 200,
            body: {
              id: 'authorization',
              reconnectAccount: { id: 'account' },
              target: null,
              state: { status: 'pending' },
            },
          })
          yield* (yield* Executor).remove(pending)
          expect(
            (yield* Ref.get(remote.requests))
              .filter((request) => request.path.startsWith('DELETE'))
              .map((request) => request.path),
          ).toEqual([
            `DELETE ${hostedPrefix}/apps/app/profiles/profile`,
            `DELETE ${hostedPrefix}/accounts/account`,
          ])
        }),
      ),
    )
  }

  it.effect('lets pending requests expire and deletes only their profile', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* (yield* Executor).remove(key)
        expect(
          (yield* Ref.get(remote.requests))
            .filter((request) => !request.path.endsWith('/catalog'))
            .map((request) => request.path),
        ).toEqual([
          `GET ${hostedPrefix}/connections/authorization`,
          `DELETE ${hostedPrefix}/apps/app/profiles/profile`,
        ])
      }),
    ),
  )

  for (const [tag, status, failure] of [
    ['OAuthRenewalFailed', 502, 'Rejected'],
    ['AppProviderFailed', 502, 'Rejected'],
    ['ToolListingTimedOut', 504, 'Rejected'],
    ['BuildMemoryExceeded', 422, 'Rejected'],
    ['AccountRequired', 409, 'NotReady'],
    ['ToolKindMismatch', 409, 'Rejected'],
    ['OAuthCompletionFailed', 422, 'Rejected'],
    ['Unauthorized', 403, 'ExecutorAccessDenied'],
  ] as const) {
    it.effect(`maps hosted ${tag} without provider diagnostics`, () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* failRoute(remote, 'POST /apps/app/tools/call', {
            status,
            body: { _tag: tag, message: 'secret-provider-diagnostic' },
          })
          const operation = (yield* Executor).call({ references, tool: 'read', input: {} })
          const outcome =
            failure === 'ExecutorAccessDenied'
              ? yield* operation.pipe(Effect.flip)
              : yield* operation
          expect(outcome._tag).toBe(failure)
          expect(JSON.stringify(outcome)).not.toContain('secret-provider-diagnostic')
        }),
      ),
    )
  }
})

const Exchange = Schema.TaggedUnion({
  Received: { path: Schema.String, port: Schema.Finite },
  Released: { path: Schema.String, port: Schema.Finite },
})

/**
 * NodeHttpServer.makeHandler interrupts held streams on premature close; their finalizers
 * report release. Build the listener before the Agent and Executor, so even a failed socket
 * assertion tears down the catalogue refresher, then Agent, then listener without a clock wait.
 */
const unreadTransport = Effect.fn('ExecutorTest.unreadTransport')(function* () {
  const receipts = yield* Queue.unbounded<typeof Exchange.Type>()
  const sockets = new Map<number, NodeNet.Socket>()
  const dispatcher = Layer.effect(
    NodeHttpClient.Dispatcher,
    Effect.acquireRelease(
      Effect.sync(() => {
        const connector = Undici.buildConnector({})
        return new Undici.Agent({
          connect: (options, callback) =>
            connector(options, (...args) => {
              const [error, socket] = args
              if (error === null) {
                const port = socket.localPort
                if (port === undefined) throw new Error('Connected socket has no local port')
                sockets.set(port, socket)
              }
              callback(...args)
            }),
        })
      }),
      (agent) => Effect.promise(() => agent.destroy()),
    ),
  )
  const exchange = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const port = NodeHttpServerRequest.toIncomingMessage(request).socket.remotePort
    if (port === undefined) return expect.fail('Request socket has no remote port')
    const path = request.url
    yield* Queue.offer(receipts, Exchange.cases.Received.make({ path, port }))
    return HttpServerResponse.stream(
      Stream.make(new TextEncoder().encode('incomplete')).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(Queue.offer(receipts, Exchange.cases.Released.make({ path, port }))),
      ),
      { status: 401 },
    )
  }).pipe(Effect.withSpan('ExecutorTest.exchange'))
  const listener = HttpServer.serve(exchange).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0 })),
  )
  const configured = Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const origin = new URL(HttpServer.formatAddress(server.address))
      origin.hostname = '127.0.0.1'
      return executorLayer.pipe(
        Layer.provide(NodeHttpClient.layerUndiciNoDispatcher.pipe(Layer.provide(dispatcher))),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              GOOGLE_CLIENT_ID: 'isolated-test-client',
              GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
              VIVID_EXECUTOR_URL: origin.href.replace(/\/$/u, ''),
              VIVID_EXECUTOR_KEY: 'isolated-test-key',
              VIVID_EXECUTOR_ORGANIZATION: hostedOrganization,
              VIVID_EXECUTOR_PUBLIC_ONLY: true,
            }),
          ),
        ),
      )
    }),
  ).pipe(Layer.provide(listener))
  return { receipts, sockets, configured }
})

/** Status rejects the first profile 401 without decoding; its incomplete response belongs to that call. */
it.effect('releases an unread Executor 401 before returning access denied', () =>
  Effect.gen(function* () {
    const remote = yield* unreadTransport()
    const path = `${hostedPrefix}/apps/app/profiles/profile`
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(remote.configured)
      return yield* Effect.gen(function* () {
        const result = yield* (yield* Executor).status(references).pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure._tag).toBe('ExecutorAccessDenied')
        // Catalogue receipts use other paths and sockets; only this operation's port proves ownership.
        let received = yield* Queue.take(remote.receipts)
        while (!Exchange.guards.Received(received) || received.path !== path) {
          received = yield* Queue.take(remote.receipts)
        }
        const socket = remote.sockets.get(received.port)
        if (socket === undefined) return expect.fail('Received port has no recorded client socket')
        // RED must fail synchronously here, before waiting for the held stream's release.
        expect(socket.destroyed).toBe(true)
        let released = yield* Queue.take(remote.receipts)
        while (released.path !== path || released.port !== received.port) {
          released = yield* Queue.take(remote.receipts)
        }
        expect(released).toEqual(Exchange.cases.Released.make({ path, port: received.port }))
        return undefined
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)
  }),
)

/** Dedicated source/deployment deletion follows profile and credential revocation. Shared code
 * retains the earlier tests' behavior; only the saved lifecycle grants app deletion authority. */
it.effect('removes dedicated app code after the exact profile and account', () =>
  scenario((remote) =>
    Effect.gen(function* () {
      yield* Ref.update(remote.replies, (replies) =>
        new Map(replies).set(`DELETE ${hostedPrefix}/apps/app`, {
          status: 200,
          body: { app: 'app' },
        }),
      )
      const dedicated = ExecutorReferences.cases.Authorized.make({
        service: authorized.service,
        app: authorized.app,
        profile: authorized.profile,
        owner: authorized.owner,
        account: authorized.account,
        appOwnership: 'Dedicated',
      })
      yield* (yield* Executor).remove(dedicated)
      const requests = yield* Ref.get(remote.requests)
      expect(
        requests
          .filter((request) => request.path.startsWith('DELETE'))
          .map((request) => request.path),
      ).toEqual([
        `DELETE ${hostedPrefix}/apps/app/profiles/profile`,
        `DELETE ${hostedPrefix}/accounts/account`,
        `DELETE ${hostedPrefix}/apps/app`,
      ])
    }),
  ),
)
