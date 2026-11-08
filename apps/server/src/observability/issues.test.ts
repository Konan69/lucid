import * as NodeHttp from 'node:http'
import * as Sentry from '@sentry/effect/server'
import { expect, it } from '@effect/vitest'
import { DatabaseFailure, Forbidden } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Predicate } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { observeFailures } from './failure.ts'
import { issuesLayer } from './issues.ts'

it.live(
  'reports a recovered HTTP dependency failure once with origin frames and no private text',
  () =>
    Effect.gen(function* () {
      const received: Array<string> = []
      const receiver = NodeHttp.createServer((request, response) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          body += chunk
        })
        request.on('end', () => {
          received.push(body)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{}')
        })
      })
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          receiver.once('error', (error) => resume(Effect.die(error)))
          receiver.listen(0, '127.0.0.1', () => resume(Effect.void))
        }),
        () =>
          Effect.callback<void>((resume) => {
            receiver.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)))
          }),
      )
      const address = receiver.address()
      if (address === null || Predicate.isString(address)) throw new Error('Missing receiver port')
      const configuration = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
          VIVID_ENVIRONMENT: 'verification',
          VIVID_BUILD_COMMIT: '345752f63b966b1b693df1e283e34ec7fb866920',
        }),
      )
      const failed = new DatabaseFailure({ message: 'PRIVATE_MARKER' })
      const routes = Layer.mergeAll(
        HttpRouter.add(
          'GET',
          '/broken',
          Effect.fail(failed).pipe(
            observeFailures('http'),
            Effect.catchTag('DatabaseFailure', () =>
              Effect.succeed(HttpServerResponse.empty({ status: 503 })),
            ),
          ),
        ),
        HttpRouter.add(
          'GET',
          '/refused',
          Effect.fail(new Forbidden({ message: 'normal refusal' })).pipe(
            observeFailures('http'),
            Effect.catchTag('Forbidden', () =>
              Effect.succeed(HttpServerResponse.empty({ status: 403 })),
            ),
          ),
        ),
      ).pipe(Layer.provideMerge(issuesLayer), Layer.provide(configuration))
      const handler = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (web) => Effect.promise(() => web.dispose()),
      )
      const response = yield* Effect.promise(() =>
        handler.handler(new Request('http://verification/broken')),
      )
      expect(response.status).toBe(503)
      const refusal = yield* Effect.promise(() =>
        handler.handler(new Request('http://verification/refused')),
      )
      expect(refusal.status).toBe(403)
      expect(yield* Effect.promise(() => Promise.resolve(Sentry.flush(3000)))).toBe(true)
      expect(received).toHaveLength(1)
      const wire = received.join('')
      expect(wire).toContain('DatabaseFailure')
      expect(wire).toContain('issues.test.ts')
      expect(wire).toContain('verification')
      expect(wire).not.toContain('PRIVATE_MARKER')
      expect(wire).not.toContain('normal refusal')
    }).pipe(Effect.scoped),
)
