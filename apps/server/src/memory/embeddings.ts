import { ServiceUnavailable } from '@vivid/contracts'
import {
  Array as Arr,
  Cache,
  Exit,
  Context,
  Effect,
  Layer,
  Option,
  Order,
  Redacted,
  Schema,
} from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse, Headers } from 'effect/unstable/http'
import { optionalSetting, requiredSetting } from '../config.ts'

/**
 * The model gateway's key. Memory embeds through the gateway and the background model (Thread
 * titles, what Vivid learns after a Run) completes through it, so a server does not run without
 * it: it is required while the server is composed and its absence stops launch naming it.
 */
export const modelGatewayKey = requiredSetting(
  'EXPLABS_API_KEY',
  Schema.RedactedFromValue(Schema.NonEmptyString),
  'the model gateway key',
)

/**
 * One dimension recipe governs provider validation and Helix index bootstrap. Both embedding
 * settings have a default, so absence is fine; a malformed value stops launch naming the variable.
 */
export const embeddingDimensions = optionalSetting(
  'VIVID_EMBEDDING_DIMENSIONS',
  Schema.Int.check(Schema.isGreaterThan(0)),
  'a positive whole number',
).pipe(Effect.map(Option.getOrElse(() => 1536)))
export const embeddingModel = optionalSetting(
  'VIVID_EMBEDDING_MODEL',
  Schema.NonEmptyString,
  'a model name',
).pipe(Effect.map(Option.getOrElse(() => 'text-embedding-3-small')))

/** A rate limit is unavailable memory; retain the provider's seconds or HTTP-date without inventing a delay. */
export class MemoryRateLimited extends Schema.TaggedError<MemoryRateLimited>()(
  'MemoryRateLimited',
  {
    service: Schema.Literal('memory'),
    message: ServiceUnavailable.fields.message,
    retryAfter: Schema.NullOr(Schema.String),
  },
  { title: 'Memory rate limited' },
) {}

export class ProviderRejected extends Schema.TaggedError<ProviderRejected>()(
  'MemoryProviderRejected',
  {
    operation: Schema.String,
    status: Schema.Number,
  },
  { title: 'MemoryProviderRejected' },
) {}
export class ProviderMalformed extends Schema.TaggedError<ProviderMalformed>()(
  'MemoryProviderMalformed',
  {
    operation: Schema.String,
  },
  { title: 'MemoryProviderMalformed' },
) {}
export class EmbeddingDimensionMismatch extends Schema.TaggedError<EmbeddingDimensionMismatch>()(
  'EmbeddingDimensionMismatch',
  {
    expected: Schema.Number,
    actual: Schema.Number,
  },
  { title: 'EmbeddingDimensionMismatch' },
) {}
export class EmbeddingBatchMismatch extends Schema.TaggedError<EmbeddingBatchMismatch>()(
  'EmbeddingBatchMismatch',
  {
    expected: Schema.Number,
    actual: Schema.Number,
  },
  { title: 'EmbeddingBatchMismatch' },
) {}

export type ProviderFailure =
  | ServiceUnavailable
  | MemoryRateLimited
  | ProviderRejected
  | ProviderMalformed
export type EmbeddingFailure = ProviderFailure | EmbeddingDimensionMismatch | EmbeddingBatchMismatch

/** Share provider status handling between embedding and extraction so 429 always preserves Retry-After. */
export const providerResponse = Effect.fn('Memory.providerResponse')(function* (
  client: HttpClient.HttpClient,
  input: { readonly key: Redacted.Redacted; readonly path: string; readonly body: Schema.Json },
) {
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(`https://api.experientiallabs.ai/v1/${input.path}`).pipe(
      HttpClientRequest.bearerToken(input.key),
    ),
    input.body,
  ).pipe(Effect.mapError(() => ProviderMalformed.make({ operation: input.path })))
  const response = yield* client.execute(request).pipe(
    Effect.mapError((error) =>
      ServiceUnavailable.make({
        service: 'memory',
        message: `Model gateway transport failed (${error.reason._tag})`,
      }),
    ),
  )
  if (response.status === 429) {
    return yield* Effect.fail(
      MemoryRateLimited.make({
        service: 'memory',
        message: 'The model gateway rate limited memory',
        retryAfter: Option.getOrNull(Headers.get(response.headers, 'retry-after')),
      }),
    )
  }
  if (response.status >= 500) {
    return yield* Effect.fail(
      ServiceUnavailable.make({ service: 'memory', message: 'The model gateway is unavailable' }),
    )
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      ProviderRejected.make({ operation: input.path, status: response.status }),
    )
  }
  return response
})

const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      embedding: Schema.Array(Schema.Number.check(Schema.isFinite())),
    }),
  ),
})
const decodeEmbeddings = HttpClientResponse.schemaBodyJson(EmbeddingResponse)

export interface EmbeddingsService {
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbeddingFailure>
}
export class Embeddings extends Context.Service<Embeddings, EmbeddingsService>()(
  'vivid/Embeddings',
) {}

/** Validate ordering, batch coverage and dimensions before a provider vector can reach an index. */
export const embeddingsLayer = Layer.effect(
  Embeddings,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    // Memory needs the gateway for every embedding, so the key is required while the server is
    // composed. The gateway not answering later is a typed failure on that call, below.
    const key = yield* modelGatewayKey
    const model = yield* embeddingModel
    const dimensions = yield* embeddingDimensions
    /** Cache successes for warm recall and identical remembers; failed/rate-limited requests are never cached. */
    const embedBatch = Effect.fn('Embeddings.embed')(function* (texts) {
      if (texts.length === 0) return []
      const response = yield* providerResponse(client, {
        key,
        path: 'embeddings',
        body: { model, input: [...texts] },
      })
      const decoded = yield* decodeEmbeddings(response).pipe(
        Effect.mapError(() => ProviderMalformed.make({ operation: 'embeddings' })),
      )
      const ordered = Arr.sortWith(decoded.data, (item) => item.index, Order.Number)
      if (ordered.length !== texts.length || ordered.some((item, index) => item.index !== index)) {
        return yield* Effect.fail(
          EmbeddingBatchMismatch.make({ expected: texts.length, actual: ordered.length }),
        )
      }
      for (const item of ordered) {
        if (item.embedding.length !== dimensions) {
          return yield* Effect.fail(
            EmbeddingDimensionMismatch.make({
              expected: dimensions,
              actual: item.embedding.length,
            }),
          )
        }
      }
      return ordered.map((item) => item.embedding)
    })
    const cache = yield* Cache.makeWith((text: string) => embedBatch([text]), {
      capacity: 256,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? '30 minutes' : 0),
    })
    return Embeddings.of({
      embed: Effect.fn('Embeddings.embed')(function* (texts) {
        const first = Arr.head(texts)
        if (texts.length === 1 && Option.isSome(first)) return yield* Cache.get(cache, first.value)
        const vectors = yield* embedBatch(texts)
        // A validated batch warms the same single-text cache used by subsequent remembers and recalls.
        yield* Effect.forEach(
          Arr.zip(texts, vectors),
          ([text, vector]) => Cache.set(cache, text, [vector]),
          { discard: true },
        )
        return vectors
      }),
    })
  }),
)
