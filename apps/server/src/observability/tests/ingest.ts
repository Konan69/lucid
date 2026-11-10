import * as NodeHttp from 'node:http'
import * as Sentry from '@sentry/effect/server'
import { expect } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Predicate, Schema } from 'effect'
import { incidentsLayer } from '../incidents.ts'
import { issuesLayer } from '../issues.ts'

/** The part of a Sentry event these tests read, from the envelope the SDK posts. */
const SentEvent = Schema.Struct({
  level: Schema.String,
  message: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  contexts: Schema.Struct({
    trace: Schema.Struct({ trace_id: Schema.String, span_id: Schema.String }),
  }),
})
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(SentEvent))

/**
 * A real HTTP receiver standing in for Sentry's ingest, and `issuesLayer` initialising the real SDK
 * against it, as `issues.test.ts` does. Every envelope the SDK posts is kept.
 */
export const ingest = Effect.gen(function* () {
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
  const issues = issuesLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
          VIVID_ENVIRONMENT: 'verification',
          VIVID_BUILD_COMMIT: '345752f63b966b1b693df1e283e34ec7fb866920',
        }),
      ),
    ),
  )
  const context = yield* Layer.build(Layer.mergeAll(issues, incidentsLayer))
  /** Waits for the SDK to post what it holds, then reads each envelope's event item. */
  const events = Effect.gen(function* () {
    expect(yield* Effect.promise(() => Promise.resolve(Sentry.flush(3000)))).toBe(true)
    return yield* Effect.forEach(received, (envelope) => {
      // An envelope is a header line, then an item header and its payload per item.
      const [, , payload] = envelope.split('\n')
      return decodeEvent(payload ?? '')
    })
  })
  return { context, events, received }
})
