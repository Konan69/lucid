import { NodeHttpServer } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, Logger, Queue, Ref, Schema } from 'effect'
import { HttpClient, HttpServer, HttpServerResponse } from 'effect/http'
import * as TestClock from 'effect/testing/TestClock'
import { retainCatalog } from './catalog.ts'
import { ExecutorAccessDenied, ExecutorServiceEntry, ExecutorTransportFailure } from './executor.ts'

/** The real HTTP exchange controls availability; the production refresher owns retry timing,
 * publication and cold-reader latches. Queues acknowledge completed attempts without polling. */
const fixture = Effect.fn('CatalogTest.fixture')(function* (initialStatus: number) {
  const status = yield* Ref.make(initialStatus)
  const requests = yield* Ref.make(0)
  const failed = yield* Queue.unbounded<void>()
  const exhausted = yield* Queue.unbounded<void>()
  const server = yield* HttpServer.HttpServer
  yield* server.serve(
    Effect.gen(function* () {
      yield* Ref.update(requests, (count) => count + 1)
      return HttpServerResponse.jsonUnsafe([], { status: yield* Ref.get(status) })
    }),
  )
  const origin = new URL(HttpServer.formatAddress(server.address))
  origin.hostname = '127.0.0.1'
  const client = yield* HttpClient.HttpClient
  const load = Effect.fn('CatalogTest.load')(function* () {
    const response = yield* client
      .get(origin.href)
      .pipe(
        Effect.mapError(() =>
          ExecutorTransportFailure.make({ service: 'connections', tool: null }),
        ),
      )
    if (response.status === 403)
      return yield* ExecutorAccessDenied.make({ service: 'connections', tool: null })
    if (response.status !== 200)
      return yield* ExecutorTransportFailure.make({ service: 'connections', tool: null })
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ExecutorServiceEntry))),
      Effect.mapError(() => ExecutorTransportFailure.make({ service: 'connections', tool: null })),
    )
  })
  const capture = Logger.make(({ message, logLevel }) => {
    if (JSON.stringify(message).includes('Connection catalog refresh failed')) {
      Queue.offerUnsafe(failed, undefined)
      if (logLevel === 'Error') Queue.offerUnsafe(exhausted, undefined)
    }
  })
  const catalog = yield* retainCatalog(load()).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
  )
  return { status, requests, failed, exhausted, catalog }
})

layer(NodeHttpServer.layerTest)((it) => {
  /** Exhausting one fast retry series must not strand cold readers for ten minutes. */
  it.effect('keeps the thirty-second cold recovery pace after transient retries exhaust', () =>
    Effect.gen(function* () {
      const test = yield* fixture(503)
      yield* Queue.take(test.failed)
      for (let retry = 0; retry < 3; retry++) {
        yield* TestClock.adjust('30 seconds')
        yield* Queue.take(test.failed)
      }
      yield* Queue.take(test.exhausted)
      expect(yield* Ref.get(test.requests)).toBe(4)
      yield* Ref.set(test.status, 200)
      yield* TestClock.adjust('30 seconds')
      expect(yield* test.catalog()).toEqual([])
      expect(yield* Ref.get(test.requests)).toBe(5)
    }).pipe(Effect.scoped),
  )

  /** A refusal skips the fast series but cannot end the scope-owned catalog writer. */
  it.effect('rechecks non-transient catalog refusals on the ten-minute refresh', () =>
    Effect.gen(function* () {
      const test = yield* fixture(403)
      yield* Queue.take(test.failed)
      expect((yield* test.catalog().pipe(Effect.flip))._tag).toBe('ServiceUnavailable')
      yield* TestClock.adjust('30 seconds')
      expect(yield* Ref.get(test.requests)).toBe(1)
      yield* Ref.set(test.status, 200)
      yield* TestClock.adjust('570 seconds')
      expect(yield* test.catalog()).toEqual([])
      expect(yield* Ref.get(test.requests)).toBe(2)
    }).pipe(Effect.scoped),
  )
})
