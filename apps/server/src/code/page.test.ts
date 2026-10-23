import * as NodeHttp from 'node:http'
import { describe, expect, layer } from '@effect/vitest'
import { Deferred, Effect, Predicate } from 'effect'
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
