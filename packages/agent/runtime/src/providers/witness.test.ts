import { NodeHttpServer } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { HttpServer, HttpServerResponse } from 'effect/http'
import { witness } from './witness.ts'

/** Real HTTP receipts prove that observing a refusal never adds a second provider request. */
layer(NodeHttpServer.layerTest, { excludeTestServices: true })((it) => {
  it.effect('returns an empty 400 once and still redacts credentials from later refusals', () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      let requests = 0
      yield* server.serve(
        Effect.sync(() => {
          requests += 1
          if (requests === 1)
            return HttpServerResponse.empty({
              status: 400,
              headers: { 'x-request-id': 'empty-refusal' },
            })
          return HttpServerResponse.text('Rejected fixture-private-key', { status: 400 })
        }),
      )
      const url = new URL(HttpServer.formatAddress(server.address))
      url.hostname = '127.0.0.1'
      const send = witness(globalThis.fetch.bind(globalThis))
      const refused = yield* Effect.tryPromise((signal) =>
        send(url, { method: 'POST', body: '{}', signal }),
      )
      expect(refused.status).toBe(400)
      expect(refused.headers.get('x-request-id')).toBe('empty-refusal')
      expect(yield* Effect.tryPromise(() => refused.text())).toBe('')
      expect(requests).toBe(1)
      const redacted = yield* Effect.tryPromise((signal) =>
        send(
          new Request(url, {
            method: 'POST',
            body: '{}',
            headers: { authorization: 'Bearer fixture-private-key' },
            signal,
          }),
        ),
      )
      expect(redacted.status).toBe(400)
      expect(yield* Effect.tryPromise(() => redacted.text())).toBe('Rejected [redacted]')
      expect(requests).toBe(2)
    }),
  )
})
