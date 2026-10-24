import * as NodeHttp from 'node:http'
import { describe, expect, layer } from '@effect/vitest'
import { Clock, Deferred, Effect, Fiber, Predicate, Queue, Result } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { PageNetwork, pageNetworkLayer } from './network.ts'

/** Public seam tests use deliberate DNS/HTTP Layers; the socket adapter is separately exercised for real. */
describe('Public pages', () => {
  layer(pageNetworkLayer)((it) => {
    it.effect(
      'pins the actual Node socket to the supplied IP, keeps Host, bounds body bytes and closes requests',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const socketClosed = yield* Deferred.make<void>()
            const server = NodeHttp.createServer((request, response) => {
              if (request.url === '/large')
                request.socket.once('close', () => Deferred.doneUnsafe(socketClosed, Effect.void))
              response.setHeader('Content-Type', 'text/plain')
              if (request.url === '/large') {
                // Leave the response open: only the reader's size refusal can close this socket.
                response.write('x'.repeat(524_289))
                return
              }
              response.end(request.headers.host)
            })
            yield* Effect.acquireRelease(
              Effect.callback<void>((resume) => {
                server.listen(0, '127.0.0.1', () => resume(Effect.void))
                server.on('error', () => resume(Effect.die('Test server could not start')))
              }),
              () =>
                Effect.callback<void>((resume) => {
                  server.closeAllConnections()
                  server.close(() => resume(Effect.void))
                }),
            )
            const address = server.address()
            if (address === null || Predicate.isString(address))
              return yield* Effect.die('Missing test listener')
            const network = yield* PageNetwork
            const url = new URL(`http://never-resolve.invalid:${address.port}/`)
            const response = yield* network.request(url, { address: '127.0.0.1', family: 4 })
            expect(response.body).toBe(url.host)
            const refused = yield* network
              .request(new URL('/large', url), { address: '127.0.0.1', family: 4 })
              .pipe(Effect.flip)
            expect(refused.reason).toBe('not a readable page')
            yield* Deferred.await(socketClosed)
            return yield* Effect.void
          }),
        ).pipe(Effect.scoped),
    )
  })
})

/** The real HTTP body controls progress. Clock.sleep observes watchdog acquisition, so each
 * advance follows the client's byte receipt rather than the server's write callback. */
layer(pageNetworkLayer)((tests) => {
  tests.effect(
    'keeps a progressing page past ten seconds and closes a body that stops producing bytes',
    () =>
      Effect.gen(function* () {
        const responses = yield* Queue.unbounded<NodeHttp.ServerResponse>()
        const server = NodeHttp.createServer((_request, response) => {
          response.setHeader('Content-Type', 'text/plain')
          response.flushHeaders()
          Queue.offerUnsafe(responses, response)
        })
        yield* Effect.acquireRelease(
          Effect.callback<void>((resume) => {
            server.listen(0, '127.0.0.1', () => resume(Effect.void))
          }),
          () =>
            Effect.callback<void>((resume) => {
              server.closeAllConnections()
              server.close(() => resume(Effect.void))
            }),
        )
        const address = server.address()
        if (address === null || Predicate.isString(address))
          return yield* Effect.die('Missing test listener')
        const clock = yield* Clock.Clock
        const armed = yield* Queue.unbounded<void>()
        const observed: Clock.Clock = {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: (duration) =>
            Queue.offer(armed, undefined).pipe(Effect.andThen(clock.sleep(duration))),
        }
        const network = yield* PageNetwork
        const request = network
          .request(new URL(`http://page.test:${address.port}/`), {
            address: '127.0.0.1',
            family: 4,
          })
          .pipe(Effect.provideService(Clock.Clock, observed))
        const reading = yield* request.pipe(Effect.forkScoped)
        yield* Queue.take(armed)
        const response = yield* Queue.take(responses)
        yield* Queue.take(armed)
        for (const part of ['one', 'two', 'three']) {
          yield* TestClock.adjust('9 seconds')
          response.write(part)
          yield* Queue.take(armed)
        }
        response.end()
        expect((yield* Fiber.join(reading)).body).toBe('onetwothree')
        const stalled = yield* request.pipe(Effect.result, Effect.forkScoped)
        yield* Queue.take(armed)
        const idle = yield* Queue.take(responses)
        const idleClosed = yield* Deferred.make<void>()
        idle.once('close', () => Deferred.doneUnsafe(idleClosed, Effect.void))
        yield* Queue.take(armed)
        yield* TestClock.adjust('10 seconds')
        idle.end('late body')
        const expired = yield* Fiber.join(stalled)
        expect(
          Result.match(expired, {
            onFailure: (failure) => failure.reason,
            onSuccess: () => 'completed',
          }),
        ).toBe('could not be reached')
        yield* Deferred.await(idleClosed)
      }).pipe(Effect.scoped),
  )
})
