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
import { connectionTestLayer, fixture, hostedOrganization, hostedPrefix } from './testing.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'

const calendar = {
  id: 'curated/google-calendar',
  kind: 'app',
  name: 'Google Calendar',
  description: 'Manage Google calendars',
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
        { ...calendar, id: 'curated/google-gmail', name: 'Gmail', description: 'Gmail REST API' },
        { ...calendar, id: 'curated/google-drive', name: 'Google Drive' },
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
          VIVID_EXECUTOR_URL: url.href.replace(/\/$/u, ''),
          VIVID_EXECUTOR_KEY: 'isolated-test-key',
          VIVID_EXECUTOR_ORGANIZATION: hostedOrganization,
        }),
      ),
    ),
  )
  return { requests, configured }
})

it.effect('lists missing and unknown authentication as setup required through Executor HTTP', () =>
  Effect.gen(function* () {
    const http = yield* remote()
    yield* Effect.gen(function* () {
      const executor = yield* Executor
      const entries = yield* executor.catalog()
      expect(entries).toHaveLength(5)
      expect(entries.slice(0, 4).map((entry) => entry.authorization._tag)).toEqual([
        'SetupRequired',
        'SetupRequired',
        'SetupRequired',
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
    test.effect('preserves setup state for Google and refuses a card before any import', () =>
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
          const found = yield* connectionHandlers.FindIntegrations({ query: 'Google' })
          expect(found.integrations.map((entry) => entry.name)).toEqual([
            'Google Calendar',
            'Gmail',
            'Google Drive',
          ])
          expect(found.integrations).toMatchObject([
            { authorization: ServiceAuthorization.cases.SetupRequired.make({}), connected: false },
            { authorization: ServiceAuthorization.cases.SetupRequired.make({}), connected: false },
            { authorization: ServiceAuthorization.cases.SetupRequired.make({}), connected: false },
          ])
          const service = (yield* (yield* ConnectionStore).catalog())[0]
          if (service === undefined) expect.fail('Expected Google Calendar')
          const error = yield* connectionHandlers
            .OfferConnection({ service: service.id, reason: 'Read calendar' })
            .pipe(Effect.flip)
          expect(error._tag).toBe('InvalidRequest')
          expect(error.message).toBe(connectionSetupMessage)
          expect(
            (yield* Ref.get(http.requests)).every((path) => path === `GET ${hostedPrefix}/catalog`),
          ).toBe(true)
        }).pipe(Effect.provide(store, { local: true }), Effect.provideService(AuthContext, auth))
      }).pipe(Effect.scoped),
    )
  })
})
