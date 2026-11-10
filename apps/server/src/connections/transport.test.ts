import * as NodeHttp from 'node:http'
import type * as NodeNet from 'node:net'
import { NodeHttpClient, NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node'
import * as Undici from '@effect/platform-node/Undici'
import { describe, expect, it } from '@effect/vitest'
import {
  ConnectionId,
  CodeName,
  InvalidRequest,
  ServiceId,
  IntegrationPause,
  IntegrationRequestId,
} from '@vivid/contracts'
import {
  Clock,
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
  ExecutorAppOwnership,
  ExecutorAccessDenied,
  Executor,
  ExecutorAccountId,
  ExecutorAppId,
  ExecutorCallOutcome,
  ExecutorAuthorizationId,
  ExecutorOwnerId,
  ExecutorBinding,
  ExecutorReferences,
  ExecutorResponseInvalid,
  ExecutorSetupRequired,
  ExecutorStep,
  executorLayer,
  installationCaller,
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
  appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
  service: hostedService,
  app: ExecutorAppId.make('app'),
  binding: ExecutorBinding.cases.Public.make({}),
  owner: ExecutorOwnerId.make('private-owner'),
}
const references = ExecutorReferences.cases.Public.make(identity)
const authorized = ExecutorReferences.cases.Authorized.make({
  ...identity,
  binding: ExecutorBinding.cases.Account.make({ requirement: 'slot', scope: 'user' }),
  account: ExecutorAccountId.make('account'),
})
const key = ExecutorReferences.cases.EnteringKey.make({
  ...identity,
  binding: ExecutorBinding.cases.Account.make({ requirement: 'slot', scope: 'user' }),
  authorization: ExecutorAuthorizationId.make('authorization'),
  method: 'providerKey',
  label: 'Work',
})
const signingIn = ExecutorReferences.cases.SigningIn.make({
  ...identity,
  binding: ExecutorBinding.cases.Account.make({ requirement: 'slot', scope: 'user' }),
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
    scope: 'user',
    cardinality: 'one',
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
  slot: {
    provider: 'provider',
    scope: 'user',
    cardinality: 'one',
    definition: { auth: { oauth: { type: 'oauth2' } } },
  },
}
const isFirstInstall = Schema.is(Schema.Struct({ entry: Schema.Literal(hostedService) }))
const decodeInstallName = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)
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
        .filter(
          (request) => !request.path.includes(`${hostedPrefix}/`) && request.path !== 'POST /mcp',
        )
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
      expect(request.path === 'POST /mcp' || request.path.includes(`${hostedPrefix}/`)).toBe(true)
      expect(request.headers.authorization).toBe('Bearer isolated-test-key')
      expect(request.headers.accept).toBe(
        request.path === 'POST /mcp' ? 'application/json, text/event-stream' : 'application/json',
      )
      if (request.path === 'POST /mcp') {
        expect(request.headers['mcp-name']).toBe(decodeMcpName(request.body).params.name)
        expect(request.headers['mcp-method']).toBe('tools/call')
        expect(request.headers['mcp-protocol-version']).toBe('2026-07-28')
        expect(request.headers['x-executor-organization']).toBe(hostedOrganization)
      }
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

const approvalRequiredReply = Schema.TaggedStruct('ToolApprovalRequired', {})
const elicitationFailedReply = Schema.TaggedStruct('ToolElicitationFailed', {
  reason: Schema.String,
  mayHaveWritten: Schema.Boolean,
})

/** Direct call fixtures name an app that already exists, as their saved references do. */
const calling = <E>(run: Parameters<typeof scenario<E>>[0]) =>
  scenario((remote) =>
    Effect.gen(function* () {
      yield* Ref.set(remote.apps, [{ id: 'app', name: 'Call fixture' }])
      yield* Ref.update(
        remote.replies,
        (all) =>
          new Map([
            ...all,
            [
              `POST ${hostedPrefix}/apps/app/tools/call`,
              { status: 409, body: approvalRequiredReply.make({}) },
            ],
          ]),
      )
      yield* run(remote)
    }),
  )

const decodeMcpName = Schema.decodeUnknownSync(
  Schema.Struct({ params: Schema.Struct({ name: Schema.String }) }),
)

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
        [
          path === 'POST /mcp'
            ? path
            : `${path.split(' ')[0]} ${hostedPrefix}${path.slice(path.indexOf(' ') + 1)}`,
          reply,
        ],
      ]),
  )
})

describe('Executor hosted transport', () => {
  it.effect('returns an ordinary REST read over 100 KB without entering MCP', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const value = 'x'.repeat(150_000)
        yield* Ref.set(remote.result, value)
        const result = yield* (yield* Executor)
          .as(installationCaller)
          .call({ references, tool: 'read', input: {} })
        expect(result).toEqual(ExecutorCallOutcome.cases.Completed.make({ value }))
        expect(
          (yield* Ref.get(remote.requests)).filter((request) => request.path === 'POST /mcp'),
        ).toHaveLength(0)
      }),
    ),
  )

  it.effect('switches once from the REST approval refusal to the same MCP call', () =>
    calling((remote) =>
      Effect.gen(function* () {
        const result = yield* (yield* Executor)
          .as(installationCaller)
          .call({ references, tool: 'read', input: { marker: 'same-call' } })
        expect(ExecutorCallOutcome.guards.Completed(result)).toBe(true)
        const posts = (yield* Ref.get(remote.requests)).filter((request) =>
          request.path.startsWith('POST'),
        )
        expect(posts.map((request) => request.path)).toEqual([
          `POST ${hostedPrefix}/apps/app/tools/call`,
          'POST /mcp',
        ])
        expect(requestAt(posts, 0).body).toEqual({
          version: 'version',
          kind: 'query',
          tool: 'read',
          input: { marker: 'same-call' },
        })
        expect(requestAt(posts, 1).body).toMatchObject({
          params: {
            name: 'call',
            arguments: {
              calls: { path: 'tools["slug-app"]["read"]', input: { marker: 'same-call' } },
            },
          },
        })
      }),
    ),
  )

  for (const tool of ['read', 'write'] as const) {
    it.effect(`keeps a truncated MCP ${tool} definite`, () =>
      calling((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.paginated, true)
          const message =
            'The tool ran, but its 150001-byte result would pass the 100000-byte output limit.'
          yield* Ref.set(
            remote.replies,
            new Map([
              ...(yield* Ref.get(remote.replies)),
              [
                'POST /mcp',
                {
                  status: 200,
                  body: {
                    jsonrpc: '2.0',
                    id: 1,
                    result: {
                      structuredContent: {
                        status: 'completed',
                        execution: {
                          ok: true,
                          value: { ok: false, error: { kind: 'Truncated', message } },
                        },
                      },
                    },
                  },
                },
              ],
            ]),
          )
          const result = yield* (yield* Executor)
            .as(installationCaller)
            .call({ references, tool, input: {} })
          expect(result).toEqual(
            tool === 'read'
              ? ExecutorCallOutcome.cases.Rejected.make({ message })
              : ExecutorCallOutcome.cases.Completed.make({ value: null }),
          )
        }),
      ),
    )
  }

  it.effect('never reissues REST typed-input failure through MCP', () =>
    calling((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'POST /apps/app/tools/call', {
          status: 409,
          body: elicitationFailedReply.make({ reason: 'unavailable', mayHaveWritten: true }),
        })
        const result = yield* (yield* Executor)
          .as(installationCaller)
          .call({ references, tool: 'read', input: {} })
        expect(ExecutorCallOutcome.guards.UncertainPause(result)).toBe(true)
        expect(
          (yield* Ref.get(remote.requests)).filter((request) => request.path === 'POST /mcp'),
        ).toHaveLength(0)
      }),
    ),
  )

  it.effect(
    'retains validation problems, removes sensitive detail, and permits a corrected retry',
    () =>
      calling((remote) =>
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
          const outcome = yield* executor
            .as(installationCaller)
            .call({ references, tool: 'read', input: {} })
          expect(ExecutorCallOutcome.guards.Rejected(outcome)).toBe(true)
          expect(outcome).toMatchObject({
            problems: ['Input did not match the tool schema'],
          })
          expect(JSON.stringify(outcome)).not.toMatch(
            /private-value|short-private|internal-app|internal-deployment/,
          )
          yield* Ref.set(remote.replies, new Map())
          const retry = yield* executor.as(installationCaller).call({
            references,
            tool: 'read',
            input: { repoName: 'facebook/react' },
          })
          expect(retry._tag).toBe('Completed')
        }),
      ),
  )

  it.effect('keeps invalid or absent validation detail a definite rejection', () =>
    calling((remote) =>
      Effect.gen(function* () {
        const executor = yield* Executor
        for (const body of [
          inputInvalidReply.make({}),
          inputInvalidReply.make({ problems: [42] }),
          inputInvalidReply.make({ problems: 'invalid' }),
        ]) {
          yield* failRoute(remote, 'POST /apps/app/tools/call', { status: 422, body })
          expect(
            yield* executor.as(installationCaller).call({ references, tool: 'read', input: {} }),
          ).toEqual(
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
      calling((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.selections, new Map([['app', { slot: ['account'] }]]))
          yield* failRoute(remote, 'POST /apps/app/tools/call', {
            status: 422,
            body: inputInvalidReply.make({
              problems: [
                'owner: required',
                'id: expected a string',
                'selection app version account',
              ],
            }),
          })
          const outcome = yield* (yield* Executor).as(installationCaller).call({
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

  it.effect('maps an MCP HTTP 401 before decoding its body', () =>
    calling((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'POST /mcp', { status: 401, body: 'private-provider-diagnostic' })
        const refused = yield* (yield* Executor)
          .as(installationCaller)
          .call({ references, tool: 'read', input: {} })
          .pipe(Effect.flip)
        expect(refused).toBeInstanceOf(ExecutorAccessDenied)
        expect(JSON.stringify(refused)).not.toContain('private-provider-diagnostic')
      }),
    ),
  )

  it.effect('keeps a pre-dispatch JSON-RPC refusal definite even with unrelated error data', () =>
    calling((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'POST /mcp', {
          status: 400,
          body: {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32602,
              message: 'private-provider-diagnostic',
              data: { field: 'private-value' },
            },
          },
        })
        const refused = yield* (yield* Executor)
          .as(installationCaller)
          .call({ references, tool: 'read', input: {} })
        expect(ExecutorCallOutcome.guards.Rejected(refused)).toBe(true)
        expect(JSON.stringify(refused)).not.toContain('private-')
      }),
    ),
  )

  for (const kind of ['call', 'resume'] as const) {
    it.effect(`bounds an uninterruptible MCP ${kind} at ninety seconds without retrying`, () =>
      calling((remote) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const held = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(held, undefined))
          const now = yield* Clock.currentTimeMillis
          yield* Ref.set(remote.intercept, (request) =>
            request.path === 'POST /mcp'
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(held)))
              : Effect.void,
          )
          const operations = (yield* Executor).as(installationCaller)
          yield* operations.tools(references)
          const operation =
            kind === 'call'
              ? operations.call({ references, tool: 'read', input: {} })
              : operations.resume({
                  effect: 'read',
                  pause: IntegrationPause.cases.Input.make({
                    requestId: IntegrationRequestId.make(`elc_${crypto.randomUUID()}`),
                    expiresAt: now + 900_000,
                    form: {
                      mode: 'form',
                      message: 'Test deadline',
                      requestedSchema: { type: 'object', properties: {} },
                    },
                  }),
                  response: { action: 'accept', content: {} },
                })
          const running = yield* operation.pipe(Effect.uninterruptible, Effect.forkScoped)
          yield* Deferred.await(entered)
          yield* TestClock.adjust('90 seconds')
          expect(yield* Fiber.join(running)).toEqual(
            ExecutorCallOutcome.cases.OutcomeUnknown.make(
              kind === 'call'
                ? {
                    failure: [
                      {
                        service: 'executor',
                        operation: CodeName.make('Executor.call'),
                        tag: CodeName.make('ExecutorTransportFailure'),
                      },
                    ],
                  }
                : {},
            ),
          )
          expect(
            (yield* Ref.get(remote.requests)).filter((request) => request.path === 'POST /mcp'),
          ).toHaveLength(1)
        }),
      ),
    )
  }

  it.effect('distinguishes a missing MCP tool from an unknown failure code', () =>
    calling((remote) =>
      Effect.gen(function* () {
        for (const kind of ['UnknownTool', 'ToolFailure'] as const) {
          yield* failRoute(remote, 'POST /mcp', {
            status: 200,
            body: {
              jsonrpc: '2.0',
              id: 1,
              result: {
                structuredContent: {
                  status: 'completed',
                  execution: {
                    ok: true,
                    value: {
                      ok: false,
                      error: {
                        kind,
                        message: 'private-provider-diagnostic',
                        response: { code: 'FutureFailure', status: 500, retryable: false },
                      },
                    },
                  },
                },
              },
            },
          })
          const result = yield* (yield* Executor)
            .as(installationCaller)
            .call({ references, tool: 'read', input: {} })
          expect(result._tag).toBe(kind === 'UnknownTool' ? 'Rejected' : 'OutcomeUnknown')
          expect(JSON.stringify(result)).not.toContain('private-provider-diagnostic')
        }
      }),
    ),
  )

  it.effect('marks an unreadable MCP input form as an uncertain pause', () =>
    calling((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'POST /mcp', {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id: 1,
            result: {
              structuredContent: {
                status: 'input-required',
                requestId: 'elc_invalid-form',
                expiresAt: 900_000,
                elicitation: {
                  mode: 'form',
                  message: 'Unsupported form',
                  requestedSchema: {
                    type: 'object',
                    properties: { unsupported: { type: 'object' } },
                  },
                },
              },
            },
          },
        })
        const result = yield* (yield* Executor)
          .as(installationCaller)
          .call({ references, tool: 'read', input: {} })
        expect(ExecutorCallOutcome.guards.UncertainPause(result)).toBe(true)
      }),
    ),
  )

  it.effect('allocates an app per Connection and reuses only the exact Connection retry', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const first = yield* executor.as(installationCaller).begin(begin)
        expect(yield* executor.as(installationCaller).begin(begin)).toEqual(first)
        const second = yield* executor.as(installationCaller).begin({
          ...begin,
          connectionId: ConnectionId.make('second'),
          owner: ExecutorOwnerId.make('other-owner'),
          subject: 'other-person',
        })
        expect(second.references.app).not.toBe(first.references.app)
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.filter((request) => request.path === `POST ${hostedPrefix}/apps/install`),
        ).toHaveLength(2)
        expect(requests.some((request) => request.path.includes('/profiles'))).toBe(false)
        yield* executor.as(installationCaller).remove(first.references)
        expect(
          (yield* Ref.get(remote.requests))
            .filter((request) => request.path.startsWith('DELETE'))
            .map((request) => request.path),
        ).toEqual([`DELETE ${hostedPrefix}/apps/${first.references.app}`])
        expect((yield* executor.as(installationCaller).status(second.references))._tag).toBe(
          'Ready',
        )
      }),
    ),
  )

  it.effect('installs different app names independently while one install is blocked', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const other = ServiceId.make('other/service')
        yield* Ref.update(remote.catalog, (entries) => [
          ...entries,
          {
            id: other,
            package: '@test/service',
            auth: [],
            icons: [],
            name: 'Other Integration',
            description: '',
          },
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
        const first = yield* executor.as(installationCaller).begin(begin).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const second = yield* executor.as(installationCaller).begin({
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
        expect((yield* (yield* Executor).as(installationCaller).begin(begin))._tag).toBe('Done')
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

  it.effect('gives repeated services distinct apps even for the same Person', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const first = yield* executor.as(installationCaller).begin(begin)
        const second = yield* executor.as(installationCaller).begin({
          ...begin,
          connectionId: ConnectionId.make('second'),
        })
        const third = yield* executor
          .as(installationCaller)
          .begin({ ...begin, connectionId: ConnectionId.make('third') })
        expect(
          new Set([first.references.app, second.references.app, third.references.app]).size,
        ).toBe(3)
        expect(
          (yield* Ref.get(remote.requests)).filter(
            (request) => request.path === `POST ${hostedPrefix}/apps/install`,
          ),
        ).toHaveLength(3)
      }),
    ),
  )

  it.effect('ignores foreign requirement shapes and reads only the selected installed app', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const executor = yield* Executor
        const first = yield* executor.as(installationCaller).begin(begin)
        const installed = yield* Ref.get(remote.apps)
        yield* failRoute(remote, 'GET /inventory', {
          status: 200,
          body: {
            links: [],
            accounts: [],
            apps: [
              {
                id: 'foreign-app',
                name: 'Other app',
                copiedFrom: null,
                activeVersion: 'version',
                requirements: {
                  accounts: { many: { definition: { auth: { alien: { type: 'future-auth' } } } } },
                },
              },
              ...installed.map((app) => ({
                id: app.id,
                name: app.name,
                copiedFrom: null,
                activeVersion: 'version',
                requirements: 'detail must be fetched separately',
              })),
            ],
          },
        })
        const second = yield* executor.as(installationCaller).begin({
          ...begin,
          connectionId: ConnectionId.make('second'),
        })
        expect(second.references.app).not.toBe(first.references.app)
        const requests = yield* Ref.get(remote.requests)
        expect(
          requests.filter((request) => request.path === `POST ${hostedPrefix}/apps/install`),
        ).toHaveLength(2)
        expect(
          requests.filter((request) => request.path === `GET ${hostedPrefix}/apps/app-2`),
        ).toHaveLength(0)
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
        const first = yield* executor.as(installationCaller).add({
          ...begin,
          service: ServiceId.make(`url:${source.address}`),
          source,
        })
        const second = yield* executor.as(installationCaller).add({
          ...begin,
          connectionId: ConnectionId.make('second'),
          service: ServiceId.make(`url:${source.address}`),
          source,
        })
        expect(second.references.app).not.toBe(first.references.app)
        yield* executor.as(installationCaller).remove(first.references)
        expect((yield* executor.as(installationCaller).status(second.references))._tag).toBe(
          'Ready',
        )
        expect(
          (yield* executor.as(installationCaller).tools(second.references)).map(
            (tool) => tool.name,
          ),
        ).toEqual(['read'])
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
        const error = yield* (yield* Executor)
          .as(installationCaller)
          .add({ ...begin, source })
          .pipe(Effect.flip)
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
        const failure = yield* (yield* Executor)
          .as(installationCaller)
          .add({ ...begin, source })
          .pipe(Effect.flip)
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
        const failure = yield* (yield* Executor)
          .as(installationCaller)
          .add({ ...begin, source })
          .pipe(Effect.flip)
        expect(executorFailure(failure)).toHaveProperty(
          'message',
          'The Integration management request was refused.',
        )
      }),
    ),
  )

  for (const operation of ['status', 'reauthorize', 'remove'] as const) {
    it.effect(
      `refuses a mismatching pending requirement during ${operation} without mutation`,
      () =>
        scenario((remote) =>
          Effect.gen(function* () {
            yield* failRoute(remote, 'GET /connections/authorization', {
              status: 200,
              body: {
                id: 'authorization',
                reconnectAccount: null,
                target: { app: 'app', requirement: 'foreign-requirement' },
                state: { status: 'pending' },
              },
            })
            const executor = yield* Executor
            const action =
              operation === 'reauthorize'
                ? executor.as(installationCaller).reauthorize({ ...begin, references: key })
                : executor.as(installationCaller)[operation](key)
            const failure = yield* action.pipe(Effect.flip)
            expect(failure).toBeInstanceOf(ExecutorResponseInvalid)
            expect(
              (yield* Ref.get(remote.requests)).every((request) => request.path.startsWith('GET')),
            ).toBe(true)
          }),
        ),
    )
  }

  it.effect('reads every cursor page and dispatches the discovered tool through MCP', () =>
    calling((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.paginated, true)
        const executor = yield* Executor
        const tools = yield* executor.as(installationCaller).tools(references)
        expect(tools.map((tool) => [tool.name, tool.effect])).toEqual([
          ['read', 'read'],
          ['write', 'write'],
        ])
        yield* executor
          .as(installationCaller)
          .call({ references, tool: 'write', input: { value: 1 } })
        const requests = yield* Ref.get(remote.requests)
        const pages = requests.filter(
          (request) => request.path === `GET ${hostedPrefix}/apps/app/tools`,
        )
        expect(pages).toHaveLength(2)
        expect(new URLSearchParams(requestAt(pages, 1).search).get('cursor')).toBe(
          'next/with+&symbols',
        )
        expect(new URLSearchParams(requestAt(pages, 1).search).get('version')).toBe('version')
        expect(requests.find((request) => request.path === 'POST /mcp')).toMatchObject({
          body: {
            method: 'tools/call',
            params: {
              name: 'call',
              arguments: { calls: { path: 'tools["slug-app"]["write"]', input: { value: 1 } } },
            },
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
            version: 'version',
            accounts: { app: {} },
            items: [],
            routers: [],
            next: 'repeated',
          },
        })
        expect(
          yield* (yield* Executor).as(installationCaller).tools(references).pipe(Effect.flip),
        ).toBeInstanceOf(ExecutorResponseInvalid)
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
      calling((remote) =>
        Effect.gen(function* () {
          const result = yield* decodeJson(value.result)
          yield* Ref.set(remote.result, result)
          expect(
            yield* (yield* Executor)
              .as(installationCaller)
              .call({ references, tool: 'read', input: {} }),
          ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: result }))
        }),
      ),
    )
  }

  it.effect(
    'maps isError to the existing tool-error outcome with sensitive diagnostics removed',
    () =>
      calling((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.result, {
            content: [{ type: 'text', text: 'Bearer sensitive-provider-value' }],
            isError: true,
          })
          const result = yield* (yield* Executor)
            .as(installationCaller)
            .call({ references, tool: 'read', input: {} })
          expect(ExecutorCallOutcome.guards.Rejected(result)).toBe(true)
          if (ExecutorCallOutcome.guards.Rejected(result))
            expect(result.message).toContain('sensitive diagnostics were removed')
          expect(JSON.stringify(result)).not.toContain('sensitive-provider-value')
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
          const step = yield* executor.as(installationCaller).begin(begin)
          if (!ExecutorStep.guards.EnterKey(step)) throw new Error('Expected key fields')
          expect(step.fields).toEqual([{ name: 'token', label: 'Access token' }])
          expect(step.references.method).toBe('providerKey')
          const result = yield* executor.as(installationCaller).complete({
            references: step.references,
            fields: { token: Redacted.make('fixture-key') },
          })
          expect(ExecutorReferences.guards.Authorized(result)).toBe(true)
          if (ExecutorReferences.guards.Authorized(result)) {
            expect(result.account).toBe('account')
            expect(result.binding).toEqual(step.references.binding)
          }
          const requests = yield* Ref.get(remote.requests)
          expect(
            requests.find(
              (request) =>
                request.path === `POST ${hostedPrefix}/apps/app/accounts/user/slot/connections`,
            ),
          ).toMatchObject({ body: {} })
          expect(
            requests.find(
              (request) => request.path === `POST ${hostedPrefix}/connections/authorization/submit`,
            ),
          ).toMatchObject({
            body: { method: 'providerKey', label: 'Work', fields: { token: 'fixture-key' } },
          })
          expect(requestAt(requests, requests.length - 1).path).toBe(
            `POST ${hostedPrefix}/connections/authorization/submit`,
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
            scope: 'user',
            cardinality: 'one',
            definition: {
              auth: {
                ...keyRequirement.slot.definition.auth,
                ...signInRequirement.slot.definition.auth,
              },
            },
          },
        })
        const step = yield* (yield* Executor).as(installationCaller).begin(begin)
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
          body: { clients: [], mode: 'client-required' },
        })
        const executor = yield* Executor
        expect(
          yield* executor.as(installationCaller).begin(begin).pipe(Effect.flip),
        ).toBeInstanceOf(ExecutorSetupRequired)
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
        expect((yield* executor.as(installationCaller).begin(begin))._tag).toBe('OpenSignIn')
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
        expect(
          yield* executor.as(installationCaller).begin(begin).pipe(Effect.flip),
        ).toHaveProperty('_tag', 'ExecutorSignInRequired')
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
          yield* executor.as(installationCaller).begin(begin)
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
          body: { clients: [], mode: 'client-required' },
        })
        expect(
          yield* executor.as(installationCaller).begin(begin).pipe(Effect.flip),
        ).toHaveProperty('_tag', 'ExecutorSetupRequired')
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
        yield* executor.as(installationCaller).begin(begin)
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
        const pendingSignIn = yield* executor
          .as(installationCaller)
          .begin(begin)
          .pipe(Effect.flip, Effect.forkScoped)
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
        yield* executor.as(installationCaller).begin(begin)
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
        const pendingSignIn = yield* executor
          .as(installationCaller)
          .begin(begin)
          .pipe(Effect.flip, Effect.forkScoped)
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
          body: { clients: [], mode: 'client-required' },
        })
        const deployed = {
          id: 'keyed-app',
          name: 'Keyed fixture',
          requirements: {
            accounts: {
              service: {
                provider: 'provider',
                scope: 'user',
                cardinality: 'one',
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
        const step = yield* (yield* Executor).as(installationCaller).add(input)
        expect(ExecutorStep.guards.EnterKey(step)).toBe(true)
        if (!ExecutorStep.guards.EnterKey(step)) return expect.fail('Expected personal key')
        expect(step.references).toMatchObject({
          app: 'keyed-app',
          method: 'pat',
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
          package: '@test/service',
          auth: [],
          icons: [],
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
        yield* executor.as(installationCaller).begin(begin).pipe(Effect.flip)
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
        const step = yield* (yield* Executor).as(installationCaller).begin(begin)
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

  it.effect('completes OAuth without issuing any removed profile route', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const result = yield* (yield* Executor).as(installationCaller).completeSignIn({
          references: signingIn,
          callbackAddress: Redacted.make(
            'https://vivid.example.test/api/connections/return?code=secret',
          ),
        })
        expect(result._tag).toBe('Authorized')
        expect(result.binding).toEqual(signingIn.binding)
        expect(
          (yield* Ref.get(remote.requests)).some((request) => request.path.includes('/profiles')),
        ).toBe(false)
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
      calling((remote) =>
        Effect.gen(function* () {
          yield* failRoute(remote, 'POST /apps/app/tools/call', {
            status,
            body: { _tag: tag, message: 'secret-provider-diagnostic' },
          })
          const operation = (yield* Executor)
            .as(installationCaller)
            .call({ references, tool: 'read', input: {} })
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

  it.effect('refuses a different account in a dedicated app before dispatch', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.selections, new Map([['app', { slot: ['someone-else'] }]]))
        const result = yield* (yield* Executor).as(installationCaller).call({
          references: authorized,
          tool: 'read',
          input: {},
        })
        expect(result._tag).toBe('NotReady')
        expect(
          (yield* Ref.get(remote.requests)).some((request) => request.path === 'POST /mcp'),
        ).toBe(false)
      }),
    ),
  )

  it.effect(
    'preflights links, unlinks the exact account, deletes its dedicated app, and revokes credentials last',
    () =>
      scenario((remote) =>
        Effect.gen(function* () {
          yield* Ref.set(remote.apps, [{ id: 'app', name: 'Dedicated' }])
          yield* failRoute(remote, 'GET /apps/app/accounts/user', {
            status: 200,
            body: [{ requirement: 'slot', account: { id: 'account' } }],
          })
          yield* failRoute(remote, 'GET /apps/app/accounts/app', { status: 200, body: [] })
          yield* Ref.set(remote.intercept, (request) =>
            request.path === `DELETE ${hostedPrefix}/apps/app/accounts/user/slot/account`
              ? Ref.update(remote.replies, (replies) =>
                  new Map(replies).set(`GET ${hostedPrefix}/apps/app/accounts/user`, {
                    status: 200,
                    body: [],
                  }),
                )
              : Effect.void,
          )
          yield* (yield* Executor).as(installationCaller).remove(authorized)
          expect(
            (yield* Ref.get(remote.requests))
              .filter((request) => request.path.startsWith('DELETE'))
              .map((request) => request.path),
          ).toEqual([
            `DELETE ${hostedPrefix}/apps/app/accounts/user/slot/account`,
            `DELETE ${hostedPrefix}/apps/app`,
            `DELETE ${hostedPrefix}/accounts/account`,
          ])
        }),
      ),
  )

  it.effect('finishes pending removal when a prior attempt already removed its exact app', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* failRoute(remote, 'GET /connections/authorization', {
          status: 404,
          body: Schema.TaggedStruct('AppNotFound', {}).make({}),
        })
        yield* (yield* Executor).as(installationCaller).remove(signingIn)
        expect(
          (yield* Ref.get(remote.requests))
            .filter((request) => request.path.startsWith('DELETE'))
            .map((request) => request.path),
        ).toEqual([])
        expect((yield* Ref.get(remote.requests)).map((request) => request.path)).toContain(
          `GET ${hostedPrefix}/inventory`,
        )
      }),
    ),
  )

  it.effect('does not delete the app or account after unlink refusal', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        yield* Ref.set(remote.apps, [{ id: 'app', name: 'Dedicated' }])
        yield* failRoute(remote, 'GET /apps/app/accounts/user', {
          status: 200,
          body: [{ requirement: 'slot', account: { id: 'account' } }],
        })
        yield* failRoute(remote, 'GET /apps/app/accounts/app', { status: 200, body: [] })
        yield* failRoute(remote, 'DELETE /apps/app/accounts/user/slot/account', {
          status: 409,
          body: Schema.TaggedStruct('AppWebhooksActive', {}).make({}),
        })
        expect(
          (yield* (yield* Executor).as(installationCaller).remove(authorized).pipe(Effect.flip))
            ._tag,
        ).toBe('ExecutorConflict')
        expect(
          (yield* Ref.get(remote.requests)).filter((request) => request.path.startsWith('DELETE')),
        ).toHaveLength(1)
      }),
    ),
  )
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

/** Status rejects the first tools-page 401 without decoding; its incomplete response belongs to that call. */
it.effect('releases an unread Executor 401 before returning access denied', () =>
  Effect.gen(function* () {
    const remote = yield* unreadTransport()
    const path = `${hostedPrefix}/apps/app/tools`
    yield* Effect.gen(function* () {
      const context = yield* Layer.build(remote.configured)
      return yield* Effect.gen(function* () {
        const result = yield* (yield* Executor)
          .as(installationCaller)
          .status(references)
          .pipe(Effect.result)
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
