import { NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ServiceUnavailable } from '@vivid/contracts'
import { ConfigProvider, Context, Effect, Layer, Ref } from 'effect'
import { HttpClient, HttpClientRequest, HttpServer, HttpServerResponse } from 'effect/http'
import { ConfigurationError } from '../config.ts'
import { HelixMemory, helixMemoryLayer, MemoryPartition } from './helix.js'

/**
 * The stand-in Helix: whether it answers, and how many requests reached it. The test flips
 * `answering`; nothing is restarted and no Layer is rebuilt, which is the claim.
 */
interface StandInService {
  readonly answering: Ref.Ref<boolean>
  readonly requests: Ref.Ref<number>
}
class StandIn extends Context.Service<StandIn, StandInService>()('vivid/test/HelixStandIn') {}

const standInLayer = Layer.effect(
  StandIn,
  Effect.gen(function* () {
    return StandIn.of({ answering: yield* Ref.make(false), requests: yield* Ref.make(0) })
  }),
)

/**
 * Every answer carries every projection the bootstrap and the read decode (an index that is
 * already active, no stored embedding space, no scopes), so one body serves each request and the
 * decoders, which ignore keys they did not ask for, stay the real ones.
 */
const everything = { index: { kind: 'already_active' }, configurations: [], scopes: [] }

/** A real ephemeral HTTP server keeps transport and status decoding real; only Helix is played. */
const helixClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const standIn = yield* StandIn
    const server = yield* HttpServer.HttpServer
    const client = yield* HttpClient.HttpClient
    yield* server.serve(
      Effect.gen(function* () {
        yield* Ref.update(standIn.requests, (count) => count + 1)
        return (yield* Ref.get(standIn.answering))
          ? HttpServerResponse.jsonUnsafe(everything)
          : HttpServerResponse.empty({ status: 503 })
      }),
    )
    const url = new URL(HttpServer.formatAddress(server.address))
    url.hostname = '127.0.0.1'
    url.pathname = '/v2/query'
    return HttpClient.mapRequest(client, (request) =>
      HttpClientRequest.setUrl(request, url.toString()),
    )
  }),
).pipe(Layer.provide(NodeHttpServer.layerTest))

const settings = (values: Readonly<Record<string, string>>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values))

const memory = helixMemoryLayer.pipe(
  Layer.provide(helixClient),
  Layer.provideMerge(standInLayer),
  Layer.provide(settings({ VIVID_HELIX_URL: 'http://helix.invalid' })),
)

describe('Memory readiness', () => {
  layer(helixClient.pipe(Layer.provideMerge(standInLayer)))((it) => {
    for (const address of [
      undefined,
      'helix',
      'vivid-helix.railway.internal:8080',
      'ftp://helix.invalid',
      ' ',
    ]) {
      const values = address === undefined ? {} : { VIVID_HELIX_URL: address }
      const name =
        address === undefined
          ? 'refuses to compose without the Helix address and names it'
          : `refuses to compose with an address no request can be sent to (${address})`
      it.effect(name, () =>
        Effect.gen(function* () {
          const failure = yield* Layer.build(helixMemoryLayer).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown(values),
            ),
            Effect.scoped,
            Effect.flip,
          )
          expect(failure).toBeInstanceOf(ConfigurationError)
          expect(failure).toHaveProperty('variable', 'VIVID_HELIX_URL')
        }),
      )
    }
  })

  layer(memory)((it) => {
    it.effect(
      'fails the call while Helix is down and works on the next call once it answers, with nothing rebuilt',
      () =>
        Effect.gen(function* () {
          const { answering, requests } = yield* StandIn
          // Acquired while Helix was down: the server composes all the same.
          const helix = yield* HelixMemory
          const partition = MemoryPartition.make('p-readiness')

          const down = yield* helix.scopes(partition).pipe(Effect.flip)
          expect(down).toBeInstanceOf(ServiceUnavailable)
          expect(down).toMatchObject({ service: 'memory' })

          // Helix answers. The very next call bootstraps and reads; nobody restarted anything.
          yield* Ref.set(answering, true)
          expect(yield* helix.scopes(partition)).toEqual([])

          // Readiness succeeded once and is remembered: a call is now exactly one request.
          const settled = yield* Ref.get(requests)
          expect(yield* helix.scopes(partition)).toEqual([])
          expect(yield* Ref.get(requests)).toBe(settled + 1)

          // A later outage is told on its own call and is over when Helix answers again.
          yield* Ref.set(answering, false)
          expect(yield* helix.scopes(partition).pipe(Effect.flip)).toBeInstanceOf(
            ServiceUnavailable,
          )
          yield* Ref.set(answering, true)
          expect(yield* helix.scopes(partition)).toEqual([])
        }),
    )
  })
})
