import * as NodeHttp from 'node:http'
import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Ref, Schema, Layer, Option } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { PageResolver, PageFailure } from '../code/address.ts'
import { PageNetwork } from '../code/network.ts'
import { pageReaderLayer } from '../code/page.ts'
import * as NetAddress from 'effect/unstable/net/NetAddress'
import {
  ConnectionSource,
  makeConnectionAddressLayer,
  ConnectionAddressUnreachable,
  ConnectionAddress,
  inspectAddress,
  publicAddress,
} from './address.ts'

const specification = {
  openapi: '3.0.3',
  info: { title: 'Records', version: '1' },
  servers: [{ url: 'https://integration.example/api' }],
  paths: {
    '/health': { get: { operationId: 'health', responses: { '200': { description: 'Healthy' } } } },
  },
}
const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

/** The test transport explicitly routes a public hostname to its own local HTTP fixture.
 * Production still uses its dedicated dispatcher and never permits local URL inputs.
 */
const fixture = Effect.fn('AddressTest.fixture')(function* () {
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '127.0.0.1',
    port: 0,
  })
  const requests = yield* Ref.make<readonly string[]>([])
  const handler = Effect.fn('AddressTest.request')(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* Ref.update(requests, (items) => [...items, `${request.method} ${request.url}`])
    expect(request.headers.authorization).toBeUndefined()
    if (request.url === '/spec' || request.url === '/spec?format=json')
      return HttpServerResponse.jsonUnsafe(specification)
    if (request.url === '/redirect')
      return HttpServerResponse.empty({ status: 302, headers: { location: '/spec' } })
    if (request.url === '/openapi.json')
      return HttpServerResponse.empty({ status: 302, headers: { location: '/spec?format=json' } })
    if (request.url === '/private')
      return HttpServerResponse.empty({
        status: 302,
        headers: { location: 'http://127.0.0.1:55433/' },
      })
    if (request.url === '/linked')
      return HttpServerResponse.text(
        '<html><body><a href="https://integration.example/spec">OpenAPI specification</a></body></html>',
        { headers: { 'content-type': 'text/html' } },
      )
    if (request.url === '/linkedredirect')
      return HttpServerResponse.text(
        '<html><body><a href="https://integration.example/openapi.json">OpenAPI specification</a></body></html>',
        { headers: { 'content-type': 'text/html' } },
      )
    if (request.url === '/docs')
      return HttpServerResponse.text('<html><body>API documentation</body></html>', {
        headers: { 'content-type': 'text/html' },
      })
    if (request.url === '/key')
      return HttpServerResponse.empty({ status: 401, headers: { 'www-authenticate': 'Bearer' } })
    if (request.url === '/oauth')
      return HttpServerResponse.empty({
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer resource_metadata="https://integration.example/.well-known/oauth-protected-resource"',
        },
      })
    if (request.method === 'GET')
      return HttpServerResponse.empty({ status: request.url === '/negotiated' ? 406 : 405 })
    if (request.url === '/postredirect')
      return HttpServerResponse.empty({ status: 307, headers: { location: '/mcp' } })
    if (request.url === '/postprivate')
      return HttpServerResponse.empty({
        status: 307,
        headers: { location: 'http://127.0.0.1:55433/' },
      })
    const body = yield* request.json.pipe(Effect.flatMap(decodeJson))
    expect(body).toMatchObject({ method: 'initialize' })
    return HttpServerResponse.jsonUnsafe({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'Fixture', version: '1' },
      },
    })
  })
  yield* server.serve(handler())
  if (!NetAddress.isInetAddress(server.address))
    return yield* Effect.die('Fixture did not allocate TCP')
  const base = (yield* Effect.fromResult(NetAddress.toUrl(server.address))).href.replace(/\/$/u, '')
  const transport = yield* HttpClient.HttpClient
  const client = HttpClient.mapRequest(transport, (request) =>
    HttpClientRequest.setUrl(request, request.url.replace('https://integration.example', base)),
  )
  const pages = pageReaderLayer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(
          PageResolver,
          PageResolver.of({
            resolve: Effect.fn('AddressTest.resolvePage')(() =>
              Effect.succeed([{ address: '93.184.215.14', family: 4 }]),
            ),
          }),
        ),
        Layer.succeed(
          PageNetwork,
          PageNetwork.of({
            request: Effect.fn('AddressTest.pageNetwork')(function* (url) {
              const response = yield* client
                .get(url.href)
                .pipe(Effect.mapError(() => new PageFailure({ reason: 'could not be reached' })))
              const contentType = response.headers['content-type']
              if (contentType === undefined)
                return yield* Effect.fail(new PageFailure({ reason: 'not a readable page' }))
              return {
                status: response.status,
                location: Option.fromUndefinedOr(response.headers.location),
                contentType,
                body: yield* response.text.pipe(
                  Effect.mapError(() => new PageFailure({ reason: 'could not be reached' })),
                ),
              }
            }),
          }),
        ),
      ),
    ),
  )
  return { client, requests, pages }
})

describe('public integration addresses', () => {
  it.effect('resolves a docs link and spec redirect to the final import URL', () =>
    Effect.gen(function* () {
      const { client, pages, requests } = yield* fixture()
      const result = yield* inspectAddress('https://integration.example/linkedredirect').pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(pages),
      )
      expect(result).toEqual(
        ConnectionSource.cases.OpenApi.make({
          address: 'https://integration.example/spec?format=json',
        }),
      )
      expect(yield* Ref.get(requests)).toContain('GET /openapi.json')
      expect(yield* Ref.get(requests)).toContain('GET /spec?format=json')
    }).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.scoped),
  )
  it.effect('initializes MCP when its GET endpoint rejects content negotiation', () =>
    Effect.gen(function* () {
      const { client, pages, requests } = yield* fixture()
      const result = yield* inspectAddress('https://integration.example/negotiated').pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(pages),
      )
      expect(result).toEqual(
        ConnectionSource.cases.Mcp.make({
          address: 'https://integration.example/negotiated',
          authorization: 'auto',
        }),
      )
      expect(yield* Ref.get(requests)).toEqual(['GET /negotiated', 'POST /negotiated'])
    }).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.scoped),
  )
  it.effect('accepts public specification query parameters and retains the checked URL', () =>
    Effect.gen(function* () {
      const { client, pages, requests } = yield* fixture()
      const result = yield* inspectAddress('https://integration.example/spec?format=json').pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(pages),
      )
      expect(result).toEqual(
        ConnectionSource.cases.OpenApi.make({
          address: 'https://integration.example/spec?format=json',
        }),
      )
      expect(yield* Ref.get(requests)).toContain('GET /spec?format=json')
    }).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.scoped),
  )
  it.effect(
    'probes a real local MCP protocol fixture and reads a local OpenAPI fixture through the network boundary',
    () =>
      Effect.gen(function* () {
        const { client, requests, pages } = yield* fixture()
        const inspect = (path: string) =>
          inspectAddress(`https://integration.example${path}`).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provide(pages),
          )
        expect(yield* inspect('/mcp')).toEqual(
          ConnectionSource.cases.Mcp.make({
            address: 'https://integration.example/mcp',
            authorization: 'auto',
          }),
        )
        expect(yield* inspect('/linked')).toEqual(
          ConnectionSource.cases.OpenApi.make({
            address: 'https://integration.example/spec',
          }),
        )
        expect(yield* inspect('/postredirect')).toEqual(
          ConnectionSource.cases.Mcp.make({
            address: 'https://integration.example/mcp',
            authorization: 'auto',
          }),
        )
        expect(yield* inspect('/postprivate').pipe(Effect.flip)).toMatchObject({
          reason: 'not a public web address',
        })
        expect(yield* inspect('/spec')).toEqual(
          ConnectionSource.cases.OpenApi.make({
            address: 'https://integration.example/spec',
          }),
        )
        expect(yield* inspect('/redirect')).toEqual(
          ConnectionSource.cases.OpenApi.make({
            address: 'https://integration.example/spec',
          }),
        )
        expect(yield* inspect('/key')).toEqual(
          ConnectionSource.cases.Mcp.make({
            address: 'https://integration.example/key',
            authorization: 'apiKey',
          }),
        )
        expect(yield* inspect('/oauth')).toEqual(
          ConnectionSource.cases.Mcp.make({
            address: 'https://integration.example/oauth',
            authorization: 'auto',
          }),
        )
        expect(yield* Ref.get(requests)).toContain('POST /mcp')
        expect(yield* inspect('/private').pipe(Effect.flip)).toMatchObject({
          reason: 'not a public web address',
        })
        expect(yield* Ref.get(requests)).not.toContain('GET /')
        expect(yield* inspect('/docs').pipe(Effect.flip)).toMatchObject({
          reason: 'documentation page has no OpenAPI specification link',
        })
      }).pipe(Effect.provide(NodeHttpClient.layerUndici), Effect.scoped),
  )
  it.effect(
    'refuses private literals, credential URLs and names resolving to loopback at socket creation',
    () =>
      Effect.gen(function* () {
        for (const address of [
          'http://127.1/',
          'http://2130706433/',
          'http://169.254.169.254/',
          'http://10.0.0.1/',
          'http://[::1]/',
          'http://[::ffff:127.0.0.1]/',
          'https://localhost/',
          'https://service.internal/',
          'https://user:key@example.com/',
        ])
          expect(publicAddress(address)).toBeUndefined()
        const reader = yield* ConnectionAddress
        expect(yield* reader.inspect('http://127.0.0.1/').pipe(Effect.flip)).toMatchObject({
          reason: 'not a public web address',
        })
        expect(
          yield* reader.inspect('https://integration.example/').pipe(Effect.flip),
        ).toBeInstanceOf(ConnectionAddressUnreachable)
      }).pipe(
        Effect.provide(
          makeConnectionAddressLayer((_hostname, _options, callback) =>
            callback(null, [{ address: '127.0.0.1', family: 4 }]),
          ),
        ),
        Effect.scoped,
      ),
  )
})
