import * as NodeHttp from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { describe, expect, it, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { ServiceAuthorization, ServiceId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Ref } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as NetAddress from 'effect/net/NetAddress'
import { Executor, executorLayer } from './executor.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionHandlers } from './handlers.ts'
import {
  connectionTestLayer,
  fixture,
  hostedOrganization,
  hostedPrefix,
  hostedExecutorFixture,
  hostedService,
  remoteEntries,
} from './testing.ts'
import { ServerConfig } from '../config.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'

const catalogHints = {
  public: { authorization: 'None', auth: [] },
  key: { authorization: 'KnownAfterInstall', auth: [{ method: 'key', kind: 'secrets' }] },
  mixed: { authorization: 'SignIn', auth: [{ method: 'oauth', kind: 'oauth2' }] },
} as const

// A made-up service family: Google is not a catalogue install, the server carries it itself.
const calendar = {
  id: 'curated/acme-calendar',
  package: '@test/acme',
  auth: [{ method: 'key', kind: 'secrets' }],
  icons: [],
  name: 'Acme Calendar',
  description: 'Manage Acme calendars',
}

/** Only catalogue HTTP is simulated: decoding, retained availability and connection guards
 * are the production adapter. Any import or sign-in request is observable and rejected. */
const remote = Effect.fn('ConnectionsSetupTest.remote')(function* () {
  const requests = yield* Ref.make<readonly string[]>([])
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  const handler = Effect.fn('ConnectionsSetupTest.http')(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* Ref.update(requests, (items) => [...items, `${request.method} ${request.url}`])
    if (request.method === 'GET' && request.url === `${hostedPrefix}/catalog`)
      return HttpServerResponse.jsonUnsafe([
        calendar,
        { ...calendar, id: 'curated/acme-mail', name: 'Acme Mail', description: 'Acme Mail API' },
        { ...calendar, id: 'curated/acme-drive', name: 'Acme Drive' },
        {
          ...calendar,
          id: 'unknown-auth',
          name: 'Unknown',
          description: 'An unsupported authorization method',
          auth: [{ method: 'future', kind: 'future' }],
        },
        { ...calendar, id: 'unsupported', icons: 'malformed' },
        {
          ...calendar,
          id: 'public',
          name: 'Public',
          description: 'Public API',
          auth: [],
        },
      ])
    return HttpServerResponse.empty({ status: 404 })
  })
  yield* server.serve(handler())
  if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die('Expected TCP address')
  const url = yield* Effect.fromResult(NetAddress.toUrl(server.address))
  const configured = executorLayer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          GOOGLE_CLIENT_ID: 'isolated-test-client',
          GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
          VIVID_EXECUTOR_URL: url.href.replace(/\/$/u, ''),
          VIVID_EXECUTOR_KEY: 'isolated-test-key',
          VIVID_EXECUTOR_ORGANIZATION: hostedOrganization,
        }),
      ),
    ),
  )
  return { requests, configured }
})

it.effect('decodes declared methods and skips malformed auth entries through Executor HTTP', () =>
  Effect.gen(function* () {
    const http = yield* remote()
    yield* Effect.gen(function* () {
      // This HTTP feed records discovery of absent and unknown installation hints.
      const context = yield* Layer.build(http.configured)
      return yield* Effect.gen(function* () {
        const executor = yield* Executor
        const entries = remoteEntries(yield* executor.catalog)
        expect(entries).toHaveLength(4)
        expect(entries.slice(0, 3).map((entry) => entry.authorization._tag)).toEqual([
          'KnownAfterInstall',
          'KnownAfterInstall',
          'KnownAfterInstall',
        ])
        expect(entries[3]).toHaveProperty('authorization._tag', 'None')
        expect(
          (yield* Ref.get(http.requests)).every((path) => path === `GET ${hostedPrefix}/catalog`),
        ).toBe(true)
      }).pipe(Effect.provide(context))
    }).pipe(Effect.scoped)
  }).pipe(Effect.scoped),
)

describe.skipIf(!testDatabaseConfigured)('setup-required public discovery', () => {
  layer(connectionTestLayer)((test) => {
    test.effect(
      'preserves key setup for catalogue services and withholds malformed auth entries',
      () =>
        Effect.gen(function* () {
          const { ownerActor, threadId } = yield* fixture()
          const http = yield* remote()
          const auth = AuthState.Vivid({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            threadId,
          })
          const store = connectionStoreLayer.pipe(Layer.provide(http.configured))
          yield* Effect.gen(function* () {
            // The store and catalogue cache must use this case's controlled HTTP feed.
            const context = yield* Layer.build(Layer.fresh(store))
            return yield* Effect.gen(function* () {
              const found = yield* connectionHandlers.FindIntegrations({ query: 'Acme' })
              expect(found.integrations.map((entry) => entry.name)).toEqual([
                'Acme Calendar',
                'Acme Mail',
                'Acme Drive',
              ])
              expect(found.integrations).toMatchObject([
                {
                  authorization: ServiceAuthorization.cases.KnownAfterInstall.make({}),
                  connected: false,
                },
                {
                  authorization: ServiceAuthorization.cases.KnownAfterInstall.make({}),
                  connected: false,
                },
                {
                  authorization: ServiceAuthorization.cases.KnownAfterInstall.make({}),
                  connected: false,
                },
              ])
              expect(
                (yield* (yield* ConnectionStore).catalog()).some(
                  (entry) => entry.id === 'unknown-auth',
                ),
              ).toBe(false)
              const error = yield* connectionHandlers
                .OfferConnection({
                  service: ServiceId.make('unknown-auth'),
                  reason: 'Read calendar',
                  wanted: 'Service',
                })
                .pipe(Effect.flip)
              expect(error._tag).toBe('InvalidRequest')
              expect(error.message).toBe('Unknown integration.')
              expect(
                (yield* Ref.get(http.requests)).every(
                  (path) => path === `GET ${hostedPrefix}/catalog`,
                ),
              ).toBe(true)
            }).pipe(Effect.provide(context))
          }).pipe(Effect.scoped, Effect.provideService(AuthContext, auth))
        }).pipe(Effect.scoped),
    )
  })
})

/** Cross the real store and hosted HTTP adapter: no fake availability result can hide the Begin guard. */
describe.skipIf(!testDatabaseConfigured)('catalogue Begin with declared auth methods', () => {
  layer(connectionTestLayer)((test) => {
    for (const [name, accounts, expected] of [
      ['public', {}, 'Done'],
      [
        'key',
        {
          slot: {
            provider: 'provider',
            definition: {
              auth: { key: { type: 'secrets', fields: { properties: { token: {} } } } },
            },
          },
        },
        'EnterKey',
      ],
      [
        'mixed',
        {
          slot: {
            provider: 'provider',
            definition: {
              auth: {
                key: { type: 'secrets', fields: { properties: { token: {} } } },
                oauth: { type: 'oauth2' },
              },
            },
          },
        },
        'OpenSignIn',
      ],
    ] as const) {
      test.effect(`installs ${name} and reaches ${expected}`, () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const host = yield* hostedExecutorFixture()
          yield* Ref.set(host.accounts, accounts)
          yield* Ref.set(host.catalog, [
            {
              id: hostedService,
              name: 'Test Integration',
              description: '',
              package: '@test/source',
              icons: [],
              auth: catalogHints[name].auth,
            },
          ])
          yield* Ref.set(
            host.redirectUri,
            new URL('/api/connections/return', (yield* ServerConfig).PUBLIC_URL).href,
          )
          yield* Effect.gen(function* () {
            // This installation recorder owns the account requirements selected by the current variant.
            const context = yield* Layer.build(host.configured)
            return yield* Effect.gen(function* () {
              // Capture the variant's installed Executor rather than the shared probe adapter.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
              return yield* Effect.gen(function* () {
                const store = yield* ConnectionStore
                expect(remoteEntries(yield* store.catalog())[0]).toHaveProperty(
                  'authorization._tag',
                  catalogHints[name].authorization,
                )
                const step = yield* store.begin(ownerActor, {
                  from: 'Web',
                  service: hostedService,
                  name: 'Work',
                  shared: false,
                })
                expect(step._tag).toBe(expected)
                expect(
                  (yield* Ref.get(host.requests)).some(
                    (request) => request.path === `POST ${hostedPrefix}/apps/install`,
                  ),
                ).toBe(true)
              }).pipe(Effect.provide(context))
            }).pipe(Effect.scoped, Effect.provide(context))
          }).pipe(Effect.scoped)
        }).pipe(Effect.scoped),
      )
    }
  })
})
