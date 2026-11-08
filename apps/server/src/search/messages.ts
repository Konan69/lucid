import { Context, Effect, Layer, Redacted, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import {
  RuntimeSearchAnswer,
  RuntimeSearchBody,
  type MessageHit,
  type PersonId,
} from '@vivid/contracts'
import { ServerConfig } from '../config.ts'
import { cellNodes } from '../runtime/transport.ts'

/**
 * The Person's conversation runtime did not answer the search: unreachable, refused, or an answer
 * that did not decode. Search says the words were not searched rather than that nothing matched.
 */
export class MessagesUnreachable extends Schema.TaggedError<MessagesUnreachable>()(
  'MessagesUnreachable',
  {},
  { title: 'Conversation words could not be searched' },
) {}

export interface MessageSearchService {
  /** Matching messages in the named Threads of the Person's own cell, newest first. */
  readonly search: (
    person: PersonId,
    body: RuntimeSearchBody,
  ) => Effect.Effect<ReadonlyArray<MessageHit>, MessagesUnreachable>
}

/**
 * Searching the words of a Person's conversations. They are kept by Pi in the Person's cell, not
 * in the product database (`packages/agent/runtime/AGENTS.md`), so the server asks the cell
 * (`POST /persons/:personId/search`, `packages/contracts/src/runtime.ts`) with the runtime token,
 * through the same cell ingress failover as Memory (`runtime/client.ts` `cellMemoryLayer`).
 */
export class MessageSearch extends Context.Service<MessageSearch, MessageSearchService>()(
  'vivid/MessageSearch',
) {}

const decodeAnswer = HttpClientResponse.schemaBodyJson(RuntimeSearchAnswer)

export const messageSearchLayer = Layer.effect(
  MessageSearch,
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const http = cellNodes(yield* HttpClient.HttpClient, config.RUNTIME_URLS)
    const token = Redacted.value(config.RUNTIME_TOKEN)
    return MessageSearch.of({
      search: Effect.fn('MessageSearch.search')(
        function* (person: PersonId, body: RuntimeSearchBody) {
          const request = yield* HttpClientRequest.schemaBodyJson(RuntimeSearchBody)(
            HttpClientRequest.post(
              new URL(`/persons/${encodeURIComponent(person)}/search`, config.RUNTIME_URLS[0]),
            ).pipe(HttpClientRequest.bearerToken(token)),
            body,
          )
          const response = yield* http.execute(request)
          if (response.status !== 200) return yield* new MessagesUnreachable()
          return (yield* decodeAnswer(response)).hits
        },
        Effect.scoped,
        // Only the failure's tag is logged: a body or a URL can quote what was searched for.
        Effect.tapError((error) => Effect.logWarning('Message search failed', error._tag)),
        Effect.mapError(() => new MessagesUnreachable()),
      ),
    })
  }),
)
