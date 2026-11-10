import {
  ConversationTooLarge,
  ConversationFrame,
  PersonId,
  RuntimeRefusal,
  ThreadId,
} from '@vivid/contracts'
import { Effect, Predicate, Schema, Stream } from 'effect'
import * as Sse from 'effect/encoding/Sse'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

/** A lost connection or invalid response supplies no evidence of an explicit runtime refusal. */
export class RuntimeTransportFailed extends Schema.TaggedError<RuntimeTransportFailed>()(
  'RuntimeTransportFailed',
  { personId: PersonId, threadId: ThreadId },
  { title: 'Runtime transport failed' },
) {}

/** The runtime's closed refusal crosses unchanged; provider diagnostics never cross. */
export class RuntimeRejected extends Schema.TaggedError<RuntimeRejected>()(
  'RuntimeRejected',
  {
    personId: PersonId,
    threadId: ThreadId,
    refusal: RuntimeRefusal,
  },
  { title: 'Runtime rejected the request' },
) {}

export interface Address {
  readonly personId: PersonId
  readonly threadId: ThreadId
}

/** Every node can forward to a cell's owner. Only a transport failure advances ingress;
 * a runtime refusal, bad payload or interrupted request must retain its own meaning. */
export const cellNodes = (http: HttpClient.HttpClient, nodes: readonly [URL, ...URL[]]) => {
  const scoped = HttpClient.withScope(http)
  return HttpClient.transform(scoped, (effect, request) => {
    let response = effect
    for (const node of nodes.slice(1)) {
      response = response.pipe(
        Effect.catchIf(
          (error) => Predicate.isTagged(error.reason, 'TransportError'),
          () => {
            const url = new URL(request.url)
            return scoped.execute(
              HttpClientRequest.setUrl(request, new URL(url.pathname + url.search, node)),
            )
          },
        ),
      )
    }
    return response
  })
}

/** One scoped response, checked before its body is consumed by the caller's decoder. */
export const requestRuntime = Effect.fn('Runtime.request')(function* <R>(
  http: HttpClient.HttpClient.With<HttpClientError.HttpClientError, R>,
  request: HttpClientRequest.HttpClientRequest,
  address: Address,
) {
  const transport = () => RuntimeTransportFailed.make(address)
  const response = yield* HttpClient.withScope(http)
    .execute(request)
    .pipe(Effect.mapError(transport))
  if (response.status >= 200 && response.status < 300) return response
  const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
    Effect.mapError(transport),
  )
  return yield* RuntimeRejected.make({ ...address, refusal })
})

/**
 * Effect 4.0.2's SSE decoder handles split UTF-8, multiline data and comments before schema ingress.
 * A Whole contains the transcript. Limit pending events to 32 Mi UTF-16 code units, above the
 * default 10 Mi limit but finite even when upstream never terminates an event.
 */
const conversationFrameLimit = 32 * 1024 * 1024

export const conversationFrames = (
  response: HttpClientResponse.HttpClientResponse,
  address: Address,
) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(
      Sse.decodeDataSchema(ConversationFrame, { maxEventSize: conversationFrameLimit }),
    ),
    Stream.map((event) => event.data),
    Stream.mapError((error) =>
      Predicate.isTagged(error, 'SseError')
        ? ConversationTooLarge.make({ threadId: address.threadId, limit: conversationFrameLimit })
        : RuntimeTransportFailed.make(address),
    ),
  )
