import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { SearchResult, SessionId, ThreadId, Workspace } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Effect, Layer, Option, Queue, Redacted, Ref, Schema } from 'effect'
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { findPerson } from '../auth/access.ts'
import { ServerConfig } from '../config.ts'
import { testConfigLayer, testDatabaseConfigured } from '../database/testdb.ts'
import { workLayer } from '../database/work.ts'
import { libraryStoreLayer } from '../library/store.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { productFixture, productLayer } from '../runtime/testing.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { searchHandlers } from './handlers.ts'
import { messageSearchLayer } from './messages.ts'

const bodyJson = HttpServerRequest.schemaBodyJson(Schema.Json)

/**
 * The Person's cell as the server meets it over HTTP: it records what it is asked and answers
 * what the case sets. The cell's own search is proven against a real Pi store in
 * `packages/agent/runtime/src/recall.test.ts`; this proves what the server names and makes of it.
 */
const fixture = Effect.fn('Search.test.fixture')(function* () {
  const mine = yield* productFixture()
  const theirs = yield* productFixture()
  const found = yield* findPerson(mine.personId)
  if (Option.isNone(found)) return yield* Effect.sync(() => expect.fail('Missing fixture Person'))
  const requests = yield* Queue.unbounded<{ readonly url: string; readonly body: Schema.Json }>()
  const response = yield* Ref.make(HttpServerResponse.empty({ status: 503 }))
  const platform = yield* Layer.build(NodeHttpServer.layerTest)
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(platform))
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      yield* Queue.offer(requests, { url: request.url, body: yield* bodyJson })
      return yield* Ref.get(response)
    }),
  )
  const url = new URL(HttpServer.formatAddress(server.address))
  url.hostname = '127.0.0.1'
  const config = yield* ServerConfig
  const services = yield* Layer.build(
    messageSearchLayer.pipe(
      Layer.provide([
        NodeHttpClient.layerUndici,
        Layer.succeed(ServerConfig, {
          ...config,
          RUNTIME_URLS: [url],
          RUNTIME_TOKEN: Redacted.make('search-fixture-token'),
        }),
      ]),
    ),
  )
  const auth = AuthState.Person({
    person: found.value,
    workspace: Workspace.cases.Personal.make({}),
    sessionId: SessionId.make(crypto.randomUUID()),
  })
  return { mine, theirs, requests, response, services, auth }
})

/** The production Thread and Library stores over the disposable database. */
const storesLayer = Layer.mergeAll(threadStoreLayer, libraryStoreLayer).pipe(
  Layer.provideMerge(workLayer.pipe(Layer.provideMerge(productLayer))),
  Layer.provideMerge(silentChangesLayer),
)

describe.skipIf(!testDatabaseConfigured)('Search over conversation words', () => {
  layer(Layer.mergeAll(storesLayer, testConfigLayer))((it) => {
    it.effect('names only the Person’s own Threads to their cell and opens hits on them', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const search = (query: string) =>
          searchHandlers
            .Search({ query })
            .pipe(
              Effect.provideContext(test.services),
              Effect.provideService(AuthContext, test.auth),
            )
        const hit = {
          threadId: test.mine.threadId,
          messageId: 'entry-4',
          author: 'Person',
          at: '2026-11-08T12:00:00.000Z',
          snippet: 'Book the venue for Friday',
        }
        yield* Ref.set(
          test.response,
          HttpServerResponse.jsonUnsafe({
            // A hit in a Thread the server did not name is never shown.
            hits: [hit, { ...hit, threadId: ThreadId.make('not-named') }],
          }),
        )
        const answered = yield* search('  venue ')
        expect(yield* Queue.take(test.requests)).toEqual({
          url: `/persons/${test.mine.personId}/search`,
          body: { query: 'venue', threadIds: [test.mine.threadId], limit: 20 },
        })
        expect(answered.messages).toBe('Searched')
        const messages = answered.results.flatMap((result) =>
          SearchResult.guards.Message(result) ? [[result.thread.id, result.hit]] : [],
        )
        expect(messages).toEqual([[test.mine.threadId, hit]])

        // A cell that cannot answer is said, not passed off as no match.
        yield* Ref.set(test.response, HttpServerResponse.empty({ status: 503 }))
        const missed = yield* search('venue')
        yield* Queue.take(test.requests)
        expect(missed.messages).toBe('Unavailable')
        expect(missed.results.some(SearchResult.guards.Message)).toBe(false)

        // An empty query lists recent Threads and asks the cell nothing.
        const recent = yield* search('')
        expect(recent.messages).toBe('NotAsked')
        expect(yield* Queue.size(test.requests)).toBe(0)
      }),
    )
  })
})
