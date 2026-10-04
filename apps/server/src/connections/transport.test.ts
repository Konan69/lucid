import { describe, expect, it } from '@effect/vitest'
import { ConnectionId, InvalidRequest, ServiceId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Redacted, Ref, Schema } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
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
  hostedReturnAddress,
  hostedService,
} from './testing.ts'

const identity = {
  service: hostedService,
  app: ExecutorAppId.make('app'),
  profile: ExecutorProfileId.make('profile'),
  owner: ExecutorOwnerId.make('private-owner'),
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
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)
const approvalRequiredReply = Schema.TaggedStruct('ToolApprovalRequired', {
  app: Schema.String,
  deployment: Schema.String,
  tool: Schema.String,
})
const profileConflictReply = Schema.TaggedStruct('ProfileConflict', {})

/** Keep indexed fixture reads total after the test has asserted the expected request count. */
function requestAt<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`Expected request at index ${index}`)
  return item
}

/** Every scenario drives the public Executor service with the production HTTP Layer. Reusing
 * the captured requests proves route, header, account isolation and submission-body semantics.
 */
const scenario = <E>(
  run: (
    remote: Effect.Success<ReturnType<typeof hostedExecutorFixture>>,
  ) => Effect.Effect<void, E, Executor>,
) =>
  Effect.gen(function* () {
    const remote = yield* hostedExecutorFixture()
    yield* run(remote).pipe(Effect.provide(remote.configured))
    const requests = yield* Ref.get(remote.requests)
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

  it.effect('imports one shared MCP app with the source-verified body', () =>
    scenario((remote) =>
      Effect.gen(function* () {
        const source = ConnectionSource.cases.Mcp.make({
          address: 'https://example.test/mcp',
          authorization: 'apiKey',
        })
        const executor = yield* Executor
        const first = yield* executor.add({
          ...begin,
          service: ServiceId.make(`url:${source.address}`),
          source,
        })
        yield* executor.remove(first.references)
        const second = yield* executor.add({
          ...begin,
          connectionId: ConnectionId.make('second'),
          service: ServiceId.make(`url:${source.address}`),
          source,
        })
        expect(second.references.app).toBe(first.references.app)
        const requests = yield* Ref.get(remote.requests)
        const imports = requests.filter(
          (request) => request.path === `POST ${hostedPrefix}/apps/import`,
        )
        expect(imports).toHaveLength(1)
        expect(requestAt(imports, 0).body).toEqual({
          source: { kind: 'mcp', url: source.address, name: expect.any(String) },
        })
        expect(requests.some((request) => request.path === `DELETE ${hostedPrefix}/apps/app`)).toBe(
          false,
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

it.effect('requires organization configuration when URL and key enable Executor', () =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      return (yield* Executor).configured
    }).pipe(
      Effect.provide(
        executorLayer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                VIVID_EXECUTOR_URL: 'https://executor.example.test',
                VIVID_EXECUTOR_KEY: 'isolated-test-key',
              }),
            ),
          ),
        ),
      ),
      Effect.flip,
    )
    expect(JSON.stringify(result)).toContain('VIVID_EXECUTOR_ORGANIZATION')
    expect(JSON.stringify(result)).not.toContain('isolated-test-key')
  }),
)
