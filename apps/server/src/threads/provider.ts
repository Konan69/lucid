import { Effect, Option, Schema } from 'effect'
import { HttpClient, HttpClientRequest, Headers } from 'effect/http'
import type { serverModelGateway } from '../config.ts'

/** Preserve provider rate-limit evidence without inventing a retry delay. */
class TitleRateLimited extends Schema.TaggedError<TitleRateLimited>()(
  'TitleRateLimited',
  {
    message: Schema.String,
    retryAfter: Schema.NullOr(Schema.String),
  },
  { title: 'Title model rate limited' },
) {}

class TitleProviderUnavailable extends Schema.TaggedError<TitleProviderUnavailable>()(
  'TitleProviderUnavailable',
  { message: Schema.String },
  { title: 'Title model unavailable' },
) {}

class ProviderRejected extends Schema.TaggedError<ProviderRejected>()(
  'TitleProviderRejected',
  {
    operation: Schema.String,
    status: Schema.Finite,
  },
  { title: 'TitleProviderRejected' },
) {}
export class ProviderMalformed extends Schema.TaggedError<ProviderMalformed>()(
  'TitleProviderMalformed',
  {
    operation: Schema.String,
  },
  { title: 'TitleProviderMalformed' },
) {}
export type ProviderFailure =
  | TitleProviderUnavailable
  | TitleRateLimited
  | ProviderRejected
  | ProviderMalformed
/** Keep model transport, rate limits and malformed responses distinct for title generation. */
export const providerResponse = Effect.fn('TitleModel.providerResponse')(function* (
  client: HttpClient.HttpClient,
  input: {
    readonly gateway: Effect.Success<typeof serverModelGateway>
    readonly path: string
    readonly body: Schema.Json
  },
) {
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(`${input.gateway.url}/${input.path}`).pipe(
      HttpClientRequest.bearerToken(input.gateway.key),
    ),
    input.body,
  ).pipe(Effect.mapError(() => ProviderMalformed.make({ operation: input.path })))
  const response = yield* client.execute(request).pipe(
    Effect.mapError((error) =>
      TitleProviderUnavailable.make({
        message: `Model gateway transport failed (${error.reason._tag})`,
      }),
    ),
  )
  if (response.status === 429) {
    return yield* TitleRateLimited.make({
      message: 'The model gateway rate limited title generation',
      retryAfter: Option.getOrNull(Headers.get(response.headers, 'retry-after')),
    })
  }
  if (response.status >= 500) {
    return yield* TitleProviderUnavailable.make({
      message: 'The model gateway is unavailable',
    })
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* ProviderRejected.make({ operation: input.path, status: response.status })
  }
  return response
})
