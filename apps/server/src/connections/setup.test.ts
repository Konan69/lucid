import * as NodeHttp from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { describe, expect, it, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { ServiceAuthorization } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Ref } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as NetAddress from 'effect/unstable/net/NetAddress'
import { Executor, executorLayer, connectionSetupMessage } from './executor.ts'
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

// A made-up service family: Google is not a catalogue install, the server carries it itself.
const calendar = {
  id: 'curated/acme-calendar',
  kind: 'app',
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
          auth: { kind: 'future' },
        },
        { ...calendar, id: 'unsupported', kind: 'graphql' },
        {
          ...calendar,
          id: 'public',
          name: 'Public',
          description: 'Public API',
          auth: { kind: 'none' },
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

it.effect(
  'defers absent auth until installation and preserves unknown hints as setup required through Executor HTTP',
  () =>
    Effect.gen(function* () {
      const http = yield* remote()
      yield* Effect.gen(function* () {
        const executor = yield* Executor
        const entries = remoteEntries(yield* executor.catalog())
        expect(entries).toHaveLength(5)
        expect(entries.slice(0, 4).map((entry) => entry.authorization._tag)).toEqual([
          'KnownAfterInstall',
          'KnownAfterInstall',
          'KnownAfterInstall',
          'SetupRequired',
        ])
        expect(entries[4]).toHaveProperty('authorization._tag', 'None')
        expect(
          (yield* Ref.get(http.requests)).every((path) => path === `GET ${hostedPrefix}/catalog`),
        ).toBe(true)
      }).pipe(Effect.provide(http.configured))
    }).pipe(Effect.scoped),
)

describe.skipIf(!testDatabaseConfigured)('setup-required public discovery', () => {
  layer(connectionTestLayer)((test) => {
    test.effect(
      'preserves deferred setup for a catalogue service and refuses an unknown auth hint before import',
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
            const service = (yield* (yield* ConnectionStore).catalog()).find(
              (entry) => entry.id === 'unknown-auth',
            )
            if (service === undefined) expect.fail('Expected the unknown-auth service')
            const error = yield* connectionHandlers
              .OfferConnection({ service: service.id, reason: 'Read calendar', wanted: 'Service' })
              .pipe(Effect.flip)
            expect(error._tag).toBe('InvalidRequest')
            expect(error.message).toBe(connectionSetupMessage)
            expect(
              (yield* Ref.get(http.requests)).every(
                (path) => path === `GET ${hostedPrefix}/catalog`,
              ),
            ).toBe(true)
          }).pipe(Effect.provide(store, { local: true }), Effect.provideService(AuthContext, auth))
        }).pipe(Effect.scoped),
    )
  })
})

/** Cross the real store and hosted HTTP adapter: no fake availability result can hide the Begin guard. */
describe.skipIf(!testDatabaseConfigured)('catalogue Begin without auth hints', () => {
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
          yield* Ref.set(
            host.redirectUri,
            new URL('/api/connections/return', (yield* ServerConfig).PUBLIC_URL).href,
          )
          yield* Effect.gen(function* () {
            const store = yield* ConnectionStore
            expect(remoteEntries(yield* store.catalog())[0]).toHaveProperty(
              'authorization._tag',
              'KnownAfterInstall',
            )
            const step = yield* store.begin(ownerActor, {
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
          }).pipe(
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provide(host.configured),
          )
        }).pipe(Effect.scoped),
      )
    }
  })
})
