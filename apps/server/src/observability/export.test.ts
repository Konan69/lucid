import { expect, it } from '@effect/vitest'
import { NodeHttpServer } from '@effect/platform-node'
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServer from 'effect/unstable/http/HttpServer'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as OtlpExporter from 'effect/unstable/observability/OtlpExporter'
import { ObservabilityConfiguration } from '../config.ts'
import { observabilityLayer } from './export.ts'
import { observeFailures } from './failure.ts'
import { recordRefusal, Refusal } from './refusal.ts'

/** The slice of OTLP/HTTP JSON these tests read; everything else in a post is left undecoded. */
const Pair = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
})
const Resource = Schema.Struct({ attributes: Schema.Array(Pair) })
const Traces = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Resource,
      scopeSpans: Schema.Array(
        Schema.Struct({
          spans: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              attributes: Schema.Array(Pair),
              events: Schema.Array(
                Schema.Struct({ name: Schema.String, attributes: Schema.Array(Pair) }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
})
const Logs = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      scopeLogs: Schema.Array(
        Schema.Struct({
          logRecords: Schema.Array(
            Schema.Struct({
              severityText: Schema.String,
              body: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
              attributes: Schema.Array(Pair),
            }),
          ),
        }),
      ),
    }),
  ),
})

interface Post {
  readonly path: string
  readonly credential: Option.Option<string>
  readonly text: string
}

/** The text attributes of a span, event, log line or resource, by name. */
const textOf = (pairs: ReadonlyArray<typeof Pair.Type>) =>
  Object.fromEntries(
    pairs.flatMap(({ key, value }) =>
      value.stringValue === undefined ? [] : [[key, value.stringValue] as const],
    ),
  )

const CREDENTIAL = 'sentry sentry_key=0123456789abcdef'

/**
 * Stands in for the backend: a real HTTP server on a free port that keeps every post it is sent.
 * It is built before the exporter is installed, so its own request handling runs under the native
 * tracer and never exports spans about receiving spans.
 */
const receive = Effect.fn('Test.receiver')(function* () {
  const posts = yield* Ref.make<ReadonlyArray<Post>>([])
  const keep = Effect.fn('Test.keep')(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const text = yield* request.text
    yield* Ref.update(posts, (all) => [
      ...all,
      {
        path: request.url,
        credential: Option.fromUndefinedOr(request.headers['x-sentry-auth']),
        text,
      },
    ])
    return HttpServerResponse.empty({ status: 200 })
  })()
  yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add('POST', '/otlp/v1/traces', keep),
        HttpRouter.add('POST', '/otlp/v1/logs', keep),
        HttpRouter.add('POST', '/otlp/v1/metrics', keep),
      ),
      { disableLogger: true },
    ),
  )
  // The same address `HttpServer.layerTestClient` prepends for its client (rc.116 HttpServer.ts).
  const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
  return { posts, url: new URL('/otlp', address.replace('0.0.0.0', '127.0.0.1')) }
})

/**
 * Runs `program` under the real exporter, then drains it and returns what the receiver was sent.
 * `Flusher.flush` waits for the exports it starts, so nothing here depends on the batch timer.
 */
const exported = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const { posts, url } = yield* receive()
    const installed = yield* Layer.build(
      observabilityLayer(
        ObservabilityConfiguration.Enabled({
          url,
          headers: Redacted.make({ 'x-sentry-auth': CREDENTIAL }),
          environment: Option.some('production'),
          commit: Option.some('abc1234'),
        }),
      ).pipe(Layer.provide(FetchHttpClient.layer)),
    )
    yield* Effect.exit(program).pipe(Effect.provide(installed))
    yield* Context.get(installed, OtlpExporter.Flusher).flush
    const received = yield* Ref.get(posts)
    const decodeTraces = Schema.decodeUnknownEffect(Schema.fromJsonString(Traces))
    const decodeLogs = Schema.decodeUnknownEffect(Schema.fromJsonString(Logs))
    const traces = yield* Effect.forEach(
      received.filter((post) => post.path === '/otlp/v1/traces'),
      (post) => decodeTraces(post.text),
    )
    const logs = yield* Effect.forEach(
      received.filter((post) => post.path === '/otlp/v1/logs'),
      (post) => decodeLogs(post.text),
    )
    return {
      received,
      resources: traces.flatMap((post) => post.resourceSpans.map((group) => group.resource)),
      spans: traces.flatMap((post) =>
        post.resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans)),
      ),
      lines: logs.flatMap((post) =>
        post.resourceLogs.flatMap((group) => group.scopeLogs.flatMap((scope) => scope.logRecords)),
      ),
    }
  })

class ProbeRefused extends Schema.TaggedError<ProbeRefused>()(
  'ProbeRefused',
  { message: Schema.String },
  { title: 'Probe refused' },
) {}

const spanNamed = <S extends { readonly name: string }>(spans: ReadonlyArray<S>, name: string) =>
  spans.filter((span) => span.name === name)

it.effect('exports a typed failure with its tag, as expected, at its boundary', () =>
  Effect.gen(function* () {
    const refuse = Effect.fn('Probe.refuse')(function* () {
      return yield* Effect.fail(new ProbeRefused({ message: 'not today' }))
    }, observeFailures('rpc'))
    const { lines, received, resources, spans } = yield* exported(refuse())

    const [span] = spanNamed(spans, 'Probe.refuse')
    expect(span === undefined ? {} : textOf(span.attributes)).toEqual({
      'error.type': 'ProbeRefused',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
      'vivid.failure.message': 'not today',
    })
    const line = lines.find((entry) => entry.body.stringValue === 'Failure reached a boundary')
    expect(line === undefined ? '' : line.severityText).toBe('Warn')
    expect(line === undefined ? {} : textOf(line.attributes)).toMatchObject({
      'error.type': 'ProbeRefused',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
    })
    // The exporter is the real one: it sent the configured credential, to traces and logs only,
    // and named the service, the environment and the commit on the resource.
    expect(new Set(received.map((post) => post.path))).toEqual(
      new Set(['/otlp/v1/traces', '/otlp/v1/logs']),
    )
    expect(received.every((post) => Option.contains(post.credential, CREDENTIAL))).toBe(true)
    expect(resources.map((resource) => textOf(resource.attributes))).toContainEqual(
      expect.objectContaining({
        'service.name': 'vivid-server',
        'service.version': 'abc1234',
        'deployment.environment': 'production',
        'deployment.environment.name': 'production',
      }),
    )
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('marks a defect as a defect and logs it as an error', () =>
  Effect.gen(function* () {
    const crash = Effect.fn('Probe.crash')(function* () {
      return yield* Effect.die(new TypeError('cannot read the thing'))
    }, observeFailures('schedule'))
    const { lines, spans } = yield* exported(crash())

    const [span] = spanNamed(spans, 'Probe.crash')
    expect(span === undefined ? {} : textOf(span.attributes)).toEqual({
      'error.type': 'TypeError',
      'vivid.failure.kind': 'defect',
      'vivid.boundary': 'schedule',
      'vivid.failure.message': 'cannot read the thing',
    })
    const line = lines.find((entry) => entry.body.stringValue === 'Defect reached a boundary')
    expect(line === undefined ? '' : line.severityText).toBe('Error')
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('records nothing for an interruption', () =>
  Effect.gen(function* () {
    const leave = Effect.fn('Probe.leave')(function* () {
      return yield* Effect.interrupt
    }, observeFailures('http'))
    const { lines, spans } = yield* exported(leave())

    const [span] = spanNamed(spans, 'Probe.leave')
    expect(span === undefined ? [] : Object.keys(textOf(span.attributes))).not.toContain(
      'vivid.failure.kind',
    )
    expect(spanNamed(spans, 'Probe.leave')).toHaveLength(1)
    expect(lines.filter((line) => 'vivid.boundary' in textOf(line.attributes))).toEqual([])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('records a refusal as a span event and a log line', () =>
  Effect.gen(function* () {
    const decide = Effect.fn('Probe.decide')(function* () {
      yield* recordRefusal(Refusal.cases.DeviceRefused.make({ reason: 'NotAllowed' }))
      return 'declined'
    })
    const { lines, spans } = yield* exported(decide())

    const [span] = spanNamed(spans, 'Probe.decide')
    const events = span === undefined ? [] : span.events
    expect(events.map((event) => [event.name, textOf(event.attributes)])).toEqual([
      [
        'vivid.refusal',
        expect.objectContaining({
          'vivid.refusal.kind': 'DeviceRefused',
          'vivid.refusal.reason': 'NotAllowed',
        }),
      ],
    ])
    const line = lines.find((entry) => entry.body.stringValue === 'vivid.refusal')
    expect(line === undefined ? '' : line.severityText).toBe('Info')
    expect(line === undefined ? {} : textOf(line.attributes)).toMatchObject({
      'vivid.refusal.kind': 'DeviceRefused',
      'vivid.refusal.reason': 'NotAllowed',
    })
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('redacts a credential in an error message everywhere it is exported', () =>
  Effect.gen(function* () {
    const leak = Effect.fn('Probe.leak')(function* () {
      return yield* Effect.fail(
        new ProbeRefused({ message: 'provider said no: Bearer hunter2hunter2 token=s3cr3tvalue' }),
      )
    }, observeFailures('runtime'))
    const { received, spans } = yield* exported(leak())

    const [span] = spanNamed(spans, 'Probe.leak')
    expect(span === undefined ? {} : textOf(span.attributes)).toMatchObject({
      'vivid.failure.message': 'provider said no: Bearer [REDACTED] token=[REDACTED]',
    })
    // The tracer's own exception event and the log line quote the message too; none may leak it.
    expect(received.length).toBeGreaterThan(0)
    for (const post of received) {
      expect(post.text).not.toContain('hunter2hunter2')
      expect(post.text).not.toContain('s3cr3tvalue')
    }
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('posts nothing when export is disabled', () =>
  Effect.gen(function* () {
    const { posts } = yield* receive()
    const refuse = Effect.fn('Probe.refuse')(function* () {
      return yield* Effect.fail(new ProbeRefused({ message: 'not today' }))
    }, observeFailures('rpc'))
    yield* Effect.scoped(
      Effect.exit(refuse()).pipe(
        Effect.provide(observabilityLayer(ObservabilityConfiguration.Disabled())),
      ),
    )
    expect(yield* Ref.get(posts)).toEqual([])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)
