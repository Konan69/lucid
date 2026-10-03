import { NodeHttpServer } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { ServiceUnavailable } from '@vivid/contracts'
import { memoryFailure } from './handlers.js'
import { ConfigProvider, Effect, Layer, Result } from 'effect'
import { HttpClient, HttpClientRequest, HttpServer, HttpServerResponse } from 'effect/unstable/http'
import { describe, expect } from 'vitest'
import {
  Embeddings,
  EmbeddingDimensionMismatch,
  MemoryRateLimited,
  embeddingsLayer,
} from './embeddings.js'

/** A real ephemeral HTTP server exercises transport/status decoding while keeping the provider's availability under test control. */
const localProvider = (response: HttpServerResponse.HttpServerResponse) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const client = yield* HttpClient.HttpClient
      yield* server.serve(Effect.succeed(response))
      const url = new URL(HttpServer.formatAddress(server.address))
      url.hostname = '127.0.0.1'
      url.pathname = '/embeddings'
      return HttpClient.mapRequest(client, (request) =>
        HttpClientRequest.setUrl(request, url.toString()),
      )
    }),
  ).pipe(Layer.provide(NodeHttpServer.layerTest))

/** No fixture vector reaches Helix: these tests check provider protocol failures through the actual HTTP adapter. */
describe('Embedding HTTP failures', () => {
  it.effect(
    'retains Retry-After on a memory unavailable response',
    () =>
      Effect.gen(function* () {
        const embeddings = yield* Embeddings
        const result = yield* embeddings.embed(['a rate-limited request']).pipe(Effect.result)
        if (Result.isSuccess(result)) expect.fail('Expected a rate limit')
        expect(result.failure).toBeInstanceOf(MemoryRateLimited)
        if (result.failure instanceof MemoryRateLimited) {
          expect(result.failure.service).toBe('memory')
          expect(result.failure.retryAfter).toBe('7')
          const publicFailure = yield* memoryFailure(result.failure).pipe(Effect.flip)
          expect(publicFailure).toBeInstanceOf(ServiceUnavailable)
          expect(Object.hasOwn(publicFailure, 'retryAfter')).toBe(false)
        }
      }).pipe(
        Effect.provide(embeddingsLayer),
        Effect.provide(
          ConfigProvider.layerAdd(
            ConfigProvider.fromUnknown({ EXPLABS_API_KEY: 'local-protocol-test' }),
            { asPrimary: true },
          ),
        ),
        Effect.provide(
          localProvider(HttpServerResponse.empty({ status: 429, headers: { 'retry-after': '7' } })),
        ),
      ),
    { timeout: 10000 },
  )

  it.effect(
    'reports actual and configured vector dimensions',
    () =>
      Effect.gen(function* () {
        const embeddings = yield* Embeddings
        const result = yield* embeddings
          .embed(['a dimension-mismatched request'])
          .pipe(Effect.result)
        if (Result.isSuccess(result)) expect.fail('Expected a dimension mismatch')
        expect(result.failure).toBeInstanceOf(EmbeddingDimensionMismatch)
        if (result.failure instanceof EmbeddingDimensionMismatch) {
          expect(result.failure.expected).toBe(2)
          expect(result.failure.actual).toBe(3)
        }
      }).pipe(
        Effect.provide(embeddingsLayer),
        Effect.provide(
          ConfigProvider.layerAdd(
            ConfigProvider.fromUnknown({ EXPLABS_API_KEY: 'local-protocol-test' }),
            { asPrimary: true },
          ),
        ),
        Effect.provide(
          localProvider(
            HttpServerResponse.jsonUnsafe({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
          ),
        ),
        Effect.provide(
          ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ VIVID_EMBEDDING_DIMENSIONS: 2 }), {
            asPrimary: true,
          }),
        ),
      ),
    { timeout: 10000 },
  )
})
