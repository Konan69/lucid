import { expect, it } from '@effect/vitest'
import { NodeHttpServer } from '@effect/platform-node'
import { cutFault } from '@vivid/contracts'
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors'
import {
  Cause,
  ConfigProvider,
  Context,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Redacted,
  Ref,
  Schema,
} from 'effect'
import { TestClock } from 'effect/testing'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpMiddleware from 'effect/unstable/http/HttpMiddleware'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServer from 'effect/unstable/http/HttpServer'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as OtlpExporter from 'effect/unstable/observability/OtlpExporter'
import { ObservabilityConfiguration } from '../config.ts'
import { faultRoutes } from '../http/faults.ts'
import {
  LONGEST_EXPORT,
  MOST_OUTSTANDING,
  observabilityLayer,
  OMITTED,
  REPORT_EVERY_MILLIS,
} from './export.ts'
import { observeFailures } from './failure.ts'
import { Message } from './messages.ts'
import { recordRefusal, Refusal } from './refusal.ts'

/** The slice of OTLP/HTTP JSON these tests read; everything else in a post is left undecoded. */
const Pair = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    stringValue: Schema.optional(Schema.String),
    intValue: Schema.optional(Schema.Number),
  }),
})
const Resource = Schema.Struct({ attributes: Schema.Array(Pair) })
const Scope = Schema.Struct({ name: Schema.String })
const Traces = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Resource,
      scopeSpans: Schema.Array(
        Schema.Struct({
          scope: Scope,
          spans: Schema.Array(
            Schema.Struct({
              traceId: Schema.String,
              parentSpanId: Schema.optional(Schema.String),
              name: Schema.String,
              attributes: Schema.Array(Pair),
              events: Schema.Array(
                Schema.Struct({ name: Schema.String, attributes: Schema.Array(Pair) }),
              ),
              status: Schema.Struct({
                code: Schema.Number,
                message: Schema.optional(Schema.String),
              }),
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
      resource: Resource,
      scopeLogs: Schema.Array(
        Schema.Struct({
          scope: Scope,
          logRecords: Schema.Array(
            Schema.Struct({
              severityText: Schema.String,
              body: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
              attributes: Schema.Array(Pair),
              traceId: Schema.optional(Schema.String),
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

/** The attributes of a span, event, log line or resource, by name: its text, else its integer. */
const valuesOf = (pairs: ReadonlyArray<typeof Pair.Type>) =>
  Object.fromEntries(
    pairs.map(({ key, value }) => [
      key,
      value.stringValue === undefined ? value.intValue : value.stringValue,
    ]),
  )

const CREDENTIAL = 'sentry sentry_key=0123456789abcdef'
const TRACES = '/otlp/v1/traces'
const LOGS = '/otlp/v1/logs'
const METRICS = '/otlp/v1/metrics'

interface Setup {
  /** Routes of the server under test, served beside the receiver and under the exporter. */
  readonly routes: Layer.Layer<never, never, HttpRouter.HttpRouter>
  /** The process environment the exporter is built in. */
  readonly ambient: Record<string, string>
  /** What the receiver does once it has kept a post. */
  readonly answer: Effect.Effect<HttpServerResponse.HttpServerResponse>
}

const answered = Effect.succeed(HttpServerResponse.empty({ status: 200 }))
const plain: Setup = { routes: Layer.empty, ambient: {}, answer: answered }

/**
 * Stands in for the backend: routes that keep every post they are sent and say so on `arrivals`.
 * The handler is untraced, so that receiving spans does not make spans.
 */
const receiving = Effect.fn('Test.receiving')(function* (answer: Setup['answer']) {
  const posts = yield* Ref.make<ReadonlyArray<Post>>([])
  const arrivals = yield* Queue.unbounded<string>()
  const keep = Effect.fnUntraced(function* () {
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
    yield* Queue.offer(arrivals, request.url)
    return yield* answer
  })()
  return {
    arrivals,
    posts,
    routes: Layer.mergeAll(
      HttpRouter.add('POST', TRACES, keep),
      HttpRouter.add('POST', LOGS, keep),
      HttpRouter.add('POST', METRICS, keep),
    ),
  }
})

/**
 * One real HTTP server on a free port that is both the backend and, when a test serves routes,
 * the server under test, with the real exporter installed under it.
 *
 * The backend's three paths are left untraced (`TracerDisabledWhen`), so the server span of a
 * post is not itself exported. Everything else served here runs under the exporter's tracer and
 * logger exactly as the server's routes do in `main.ts`.
 */
const observed = Effect.fn('Test.observed')(function* (setup: Setup) {
  const { arrivals, posts, routes } = yield* receiving(setup.answer)
  // The same address `HttpServer.layerTestClient` prepends for its client (rc.116 HttpServer.ts).
  const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
  const installed = yield* Layer.build(
    observabilityLayer(
      ObservabilityConfiguration.Enabled({
        url: new URL('/otlp', address.replace('0.0.0.0', '127.0.0.1')),
        headers: Redacted.make({ 'x-sentry-auth': CREDENTIAL }),
        environment: Option.some('production'),
        commit: Option.some('abc1234'),
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer)),
  ).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(setup.ambient))))
  yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(routes, setup.routes), { disableLogger: true }).pipe(
      Layer.provide(HttpMiddleware.layerTracerDisabledForUrls([TRACES, LOGS, METRICS])),
    ),
  ).pipe(Effect.provide(installed))

  const decodeTraces = Schema.decodeUnknownEffect(Schema.fromJsonString(Traces))
  const decodeLogs = Schema.decodeUnknownEffect(Schema.fromJsonString(Logs))
  /** What the receiver has been sent so far, decoded. */
  const collect = Effect.fn('Test.collect')(function* () {
    const received = yield* Ref.get(posts)
    const traces = yield* Effect.forEach(
      received.filter((post) => post.path === TRACES),
      (post) => decodeTraces(post.text),
    )
    const logs = yield* Effect.forEach(
      received.filter((post) => post.path === LOGS),
      (post) => decodeLogs(post.text),
    )
    return {
      received,
      /** Every byte that left, for asserting that a text is in none of it. */
      text: received.map((post) => post.text).join('\n'),
      resources: [
        ...traces.flatMap((post) => post.resourceSpans.map((group) => group.resource)),
        ...logs.flatMap((post) => post.resourceLogs.map((group) => group.resource)),
      ],
      scopes: traces.flatMap((post) =>
        post.resourceSpans.flatMap((group) => group.scopeSpans.map((scope) => scope.scope.name)),
      ),
      spans: traces.flatMap((post) =>
        post.resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans)),
      ),
      lines: logs.flatMap((post) =>
        post.resourceLogs.flatMap((group) => group.scopeLogs.flatMap((scope) => scope.logRecords)),
      ),
    }
  })
  return {
    arrivals,
    collect,
    /** Drains the exporters; it waits for the exports it starts, not for the batch timer. */
    flush: Context.get(installed, OtlpExporter.Flusher).flush,
    /** Runs `program` under the exporter, as the server's own code runs. */
    run: <A, E>(program: Effect.Effect<A, E>) =>
      Effect.exit(program).pipe(Effect.provide(installed)),
  }
})

/** Runs `program` under the real exporter, drains it, and returns what the receiver was sent. */
const exported = Effect.fn('Test.exported')(function* <A, E>(program: Effect.Effect<A, E>) {
  const { collect, flush, run } = yield* observed(plain)
  yield* run(program)
  yield* flush
  return yield* collect()
})

/**
 * Sends requests to routes served under the exporter, drains it, and returns what was sent.
 *
 * rc.116 `HttpMiddleware.tracer` ends the server span on a task it schedules when the handler
 * exits, not before the response. That task is queued before the response is written, and the
 * client cannot read the response until the event loop polls again, so the span has ended by the
 * time a request here returns. Every test below asserts that the server span is present, so a
 * change to that ordering fails the test instead of passing it on an empty export.
 *
 * The client sends no trace context of its own (`TracerPropagationEnabled`), so a request carries
 * only the headers a test gives it; otherwise its `traceparent` would outrank them.
 */
const requested = Effect.fn('Test.requested')(function* (
  routes: Setup['routes'],
  requests: ReadonlyArray<HttpClientRequest.HttpClientRequest>,
) {
  const { collect, flush } = yield* observed({ ...plain, routes })
  const client = yield* HttpClient.HttpClient
  const statuses = yield* Effect.forEach(requests, (request) =>
    client.execute(request).pipe(
      Effect.map((response) => response.status),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    ),
  )
  yield* flush
  return { ...(yield* collect()), statuses }
})

/** A foreign SDK's error, whose tag is whatever the SDK assigned: here, text built from data. */
class Foreign extends Error {
  readonly _tag: string
  constructor(tag: string) {
    super('foreign failure')
    this._tag = tag
  }
}

class ProbeRefused extends Schema.TaggedError<ProbeRefused>()(
  'ProbeRefused',
  { message: Schema.String },
  { title: 'Probe refused' },
) {}

const spanNamed = <S extends { readonly name: string }>(spans: ReadonlyArray<S>, name: string) =>
  spans.filter((span) => span.name === name)

/** Every stdout line a test's programs write, as the simple logger renders it. */
const capturing = () => {
  const lines: Array<string> = []
  const capture = Logger.make((entry) => {
    lines.push(Logger.formatSimple.log(entry))
  })
  return { lines, layer: Logger.layer([capture], { mergeWithExisting: true }) }
}

it.effect('exports a typed failure with its tag, as expected, at its boundary', () =>
  Effect.gen(function* () {
    const refuse = Effect.fn('Probe.refuse')(function* () {
      return yield* Effect.fail(new ProbeRefused({ message: 'not today' }))
    }, observeFailures('rpc'))
    const { lines, received, resources, scopes, spans } = yield* exported(refuse())

    const [span] = spanNamed(spans, 'Probe.refuse')
    expect(span === undefined ? {} : valuesOf(span.attributes)).toEqual({
      'error.type': 'ProbeRefused',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
    })
    const line = lines.find((entry) => entry.body.stringValue === Message.failure)
    expect(line === undefined ? '' : line.severityText).toBe('Warn')
    expect(line === undefined ? {} : valuesOf(line.attributes)).toEqual({
      'error.type': 'ProbeRefused',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
    })
    // The exporter is the real one: it sent the configured credential, to traces and logs only,
    // and named the service, the environment and the commit on the resource and nothing else.
    expect(new Set(received.map((post) => post.path))).toEqual(new Set([TRACES, LOGS]))
    expect(received.every((post) => Option.contains(post.credential, CREDENTIAL))).toBe(true)
    expect(resources.length).toBeGreaterThan(1)
    for (const resource of resources)
      expect(valuesOf(resource.attributes)).toEqual({
        'service.name': 'vivid-server',
        'service.version': 'abc1234',
        'deployment.environment': 'production',
        'deployment.environment.name': 'production',
      })
    expect(new Set(scopes)).toEqual(new Set(['vivid-server']))
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('marks a defect as a defect and logs it as an error', () =>
  Effect.gen(function* () {
    const crash = Effect.fn('Probe.crash')(function* () {
      return yield* Effect.die(new TypeError('cannot read the thing'))
    }, observeFailures('schedule'))
    const { lines, spans } = yield* exported(crash())

    const [span] = spanNamed(spans, 'Probe.crash')
    expect(span === undefined ? {} : valuesOf(span.attributes)).toEqual({
      'error.type': 'TypeError',
      'vivid.failure.kind': 'defect',
      'vivid.boundary': 'schedule',
    })
    const line = lines.find((entry) => entry.body.stringValue === Message.defect)
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
    expect(span === undefined ? [] : Object.keys(valuesOf(span.attributes))).toEqual([])
    expect(spanNamed(spans, 'Probe.leave')).toHaveLength(1)
    expect(lines.filter((line) => 'vivid.boundary' in valuesOf(line.attributes))).toEqual([])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('records a refusal as a span event and a log line', () =>
  Effect.gen(function* () {
    const decide = Effect.fn('Probe.decide')(function* () {
      yield* recordRefusal(Refusal.cases.DeviceRefused.make({ reason: 'NotAllowed' }))
      return 'declined'
    })
    const { lines, spans } = yield* exported(decide())

    const refusal = { 'vivid.refusal.kind': 'DeviceRefused', 'vivid.refusal.reason': 'NotAllowed' }
    const [span] = spanNamed(spans, 'Probe.decide')
    const events = span === undefined ? [] : span.events
    expect(events.map((event) => [event.name, valuesOf(event.attributes)])).toEqual([
      [Message.refusal, refusal],
    ])
    const line = lines.find((entry) => entry.body.stringValue === Message.refusal)
    expect(line === undefined ? '' : line.severityText).toBe('Info')
    expect(line === undefined ? {} : valuesOf(line.attributes)).toEqual(refusal)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('exports the type of a failure whose message is private prose, and no prose', () =>
  Effect.gen(function* () {
    // What a model provider's error looks like: the Person's own words, quoted back. No pattern
    // marks this as private, which is why the export keeps a list of what may leave instead.
    const prose = 'Ada asked where her mother lives now and the answer was 12 Marsh Lane'
    const echo = Effect.fn('Probe.echo')(function* () {
      yield* Effect.logInfo(`Asking the provider: ${prose}`)
      return yield* Effect.fail(new ProbeRefused({ message: prose }))
    }, observeFailures('runtime'))
    const { lines, spans, text } = yield* exported(echo())

    const [span] = spanNamed(spans, 'Probe.echo')
    expect(span === undefined ? {} : valuesOf(span.attributes)).toEqual({
      'error.type': 'ProbeRefused',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'runtime',
    })
    // The tracer's exception event keeps its type; its message and stack are gone, and so is the
    // status text. The line logged with prose in its body is still counted, under a placeholder.
    expect(span === undefined ? [] : span.events.map((event) => event.name)).toEqual([
      OMITTED,
      Message.failure,
      'exception',
    ])
    const thrown = span === undefined ? [] : span.events.filter(({ name }) => name === 'exception')
    expect(thrown.map((event) => valuesOf(event.attributes))).toEqual([
      { 'exception.type': 'ProbeRefused' },
    ])
    expect(span === undefined ? {} : span.status).toEqual({ code: 2 })
    expect(lines.map((line) => line.body.stringValue)).toContain(OMITTED)
    expect(text).not.toContain('Marsh Lane')
    expect(text).not.toContain('Ada')
    expect(text).not.toContain('Probe.echo (')
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect("exports none of a Drizzle query error's statement or parameters", () =>
  Effect.gen(function* () {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'messages_key_unique',
      table: 'messages',
    })
    // The installed class: its message is the statement, then every parameter, and a parameter
    // that spans lines puts text after the line a `params:` pattern would stop at.
    const failure = new EffectDrizzleQueryError({
      query: 'insert into messages (body, author) values ($1, $2)',
      params: ['first private line\nsecond private line', 'dami@example.com'],
      cause: driver,
    })
    const store = Effect.fn('Probe.store')(function* () {
      return yield* Effect.fail(failure)
    }, observeFailures('rpc'))
    const { spans, text } = yield* exported(store())

    const [span] = spanNamed(spans, 'Probe.store')
    expect(span === undefined ? {} : valuesOf(span.attributes)).toEqual({
      'error.type': 'EffectDrizzleQueryError',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
      'vivid.failure.root': 'Error',
      'db.response.status_code': '23505',
      'vivid.failure.constraint': 'messages_key_unique',
      'db.collection.name': 'messages',
    })
    for (const secret of ['private line', 'insert into', 'dami@example.com', 'duplicate key'])
      expect(text).not.toContain(secret)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('records every reason of a combined cause and classifies the span by the defect', () =>
  Effect.gen(function* () {
    const both = Effect.fn('Probe.both')(function* () {
      return yield* Effect.failCause(
        Cause.combine(
          Cause.fail(new ProbeRefused({ message: 'refused' })),
          Cause.combine(Cause.die(new RangeError('out of range')), Cause.interrupt(1)),
        ),
      )
    }, observeFailures('rpc'))
    const { lines, spans } = yield* exported(both())

    const [span] = spanNamed(spans, 'Probe.both')
    expect(span === undefined ? {} : valuesOf(span.attributes)).toEqual({
      'error.type': 'RangeError',
      'vivid.failure.kind': 'defect',
      'vivid.boundary': 'rpc',
    })
    const recorded = lines.filter((line) => 'vivid.boundary' in valuesOf(line.attributes))
    expect(
      recorded.map((line) => [line.severityText, valuesOf(line.attributes)['error.type']]),
    ).toEqual([
      ['Warn', 'ProbeRefused'],
      ['Error', 'RangeError'],
    ])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('reports a failure whose tag or name is not an identifier as _OTHER', () =>
  Effect.gen(function* () {
    const tagged = Effect.fn('Probe.tagged')(function* () {
      return yield* Effect.fail(new Foreign('tenant 42: Ada Lovelace'))
    }, observeFailures('rpc'))
    const named = Effect.fn('Probe.named')(function* () {
      return yield* Effect.die(
        Object.assign(new Error('boom'), { name: 'Error for grace@example.com' }),
      )
    }, observeFailures('rpc'))
    const { spans, text } = yield* exported(Effect.all([Effect.exit(tagged()), named()]))

    for (const name of ['Probe.tagged', 'Probe.named']) {
      const [span] = spanNamed(spans, name)
      expect(span === undefined ? {} : valuesOf(span.attributes)).toMatchObject({
        'error.type': '_OTHER',
      })
    }
    expect(text).not.toContain('Lovelace')
    expect(text).not.toContain('grace@example.com')
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('keeps ambient OTEL_RESOURCE_ATTRIBUTES out of the resource', () =>
  Effect.gen(function* () {
    const { collect, flush, run } = yield* observed({
      ...plain,
      ambient: { OTEL_RESOURCE_ATTRIBUTES: 'vivid.secret=hunter2hunter2,team=payments' },
    })
    yield* run(Effect.fn('Probe.work')(() => Effect.logInfo(Message.refusal))())
    yield* flush
    const { resources, text } = yield* collect()

    expect(resources.length).toBeGreaterThan(1)
    for (const resource of resources)
      expect(Object.keys(valuesOf(resource.attributes)).toSorted()).toEqual([
        'deployment.environment',
        'deployment.environment.name',
        'service.name',
        'service.version',
      ])
    expect(text).not.toContain('hunter2hunter2')
    expect(text).not.toContain('payments')
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect("exports no part of a client's fault report", () =>
  Effect.gen(function* () {
    const fault = cutFault({
      surface: 'mobile',
      thrown: new Error('Skia is not linked for dami@example.com'),
      components: '\n    at Composer\n    at Chat',
      build: 'ios 0.1.0 embedded',
    })
    const { lines, spans, statuses, text } = yield* requested(faultRoutes, [
      HttpClientRequest.post('/api/faults').pipe(
        HttpClientRequest.bodyText(JSON.stringify(fault), 'application/json'),
      ),
    ])

    expect(statuses).toEqual([204])
    // The backend learns that a client faulted, as an error line and an event on the route's
    // span, and nothing the client said.
    const line = lines.find((entry) => entry.body.stringValue === Message.fault)
    expect(line === undefined ? '' : line.severityText).toBe('Error')
    expect(line === undefined ? { absent: true } : valuesOf(line.attributes)).toEqual({})
    const [span] = spanNamed(spans, 'Http.Faults.report')
    expect(
      span === undefined ? [] : span.events.map((event) => [event.name, event.attributes]),
    ).toEqual([[Message.fault, []]])
    expect(spanNamed(spans, 'http.server POST')).toHaveLength(1)
    for (const secret of ['Skia', 'dami@example.com', 'Composer', 'ios 0.1.0', 'mobile'])
      expect(text).not.toContain(secret)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect("exports no query, path or header of a provider's sign-in return", () =>
  Effect.gen(function* () {
    // The real route (`connections/return.ts`) needs a database. What is under test is the span
    // the HTTP server makes for any request at that address, so a handler with the same shape
    // stands in: a named program that fails under `observeFailures('http')` and is answered.
    const callback = Effect.fn('Http.Connections.return')(function* () {
      yield* Effect.fail(new ProbeRefused({ message: 'state unknown' })).pipe(
        observeFailures('http'),
        Effect.catch(() => Effect.void),
      )
      return HttpServerResponse.text('done', { status: 200 })
    })
    const { spans, statuses, text } = yield* requested(
      HttpRouter.add('GET', '/api/connections/return', callback()),
      [
        HttpClientRequest.get('/api/connections/return?code=secret-code&state=opaque-state').pipe(
          HttpClientRequest.setHeader('cookie', 'session=private-session'),
          HttpClientRequest.setHeader('user-agent', 'PrivateBrowser/1.0'),
        ),
      ],
    )

    expect(statuses).toEqual([200])
    const [server] = spanNamed(spans, 'http.server GET')
    expect(server === undefined ? {} : valuesOf(server.attributes)).toEqual({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'url.scheme': 'http',
      'http.response.header.content-type': 'text/plain',
    })
    expect(spanNamed(spans, 'Http.Connections.return')).toHaveLength(1)
    for (const secret of [
      'secret-code',
      'opaque-state',
      'code=',
      '/api/connections',
      'private-session',
      'PrivateBrowser',
      '127.0.0.1',
    ])
      expect(text).not.toContain(secret)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('exports no span under a malformed inbound trace id, and no malformed parent', () =>
  Effect.gen(function* () {
    const inbound = Effect.fn('Probe.inbound')(function* () {
      yield* recordRefusal(Refusal.cases.DeviceRefused.make({ reason: 'NotAllowed' }))
      return HttpServerResponse.empty({ status: 204 })
    })
    const trace = '0af7651916cd43dd8448eb211c80319c'
    const { lines, spans, statuses, text } = yield* requested(
      HttpRouter.add('GET', '/probe', inbound()),
      [
        // rc.116 `HttpTraceContext.xb3` takes both of these as sent.
        HttpClientRequest.get('/probe').pipe(
          HttpClientRequest.setHeader('x-b3-traceid', 'forged-trace Ada Lovelace'),
          HttpClientRequest.setHeader('x-b3-spanid', 'forged-span'),
        ),
        // `b3` too: here the trace id is sound and only the parent's span id is not.
        HttpClientRequest.get('/probe').pipe(
          HttpClientRequest.setHeader('b3', `${trace}-forgedparent-1`),
        ),
      ],
    )

    expect(statuses).toEqual([204, 204])
    // The first request's spans are gone; the second's are exported, the server span as a root.
    const servers = spanNamed(spans, 'http.server GET')
    expect(servers.map((span) => [span.traceId, span.parentSpanId])).toEqual([[trace, undefined]])
    expect(spanNamed(spans, 'Probe.inbound').map((span) => span.traceId)).toEqual([trace])
    // Both refusals are still counted; the line written under the dropped span names no trace.
    const refusals = lines.filter((line) => line.body.stringValue === Message.refusal)
    expect(refusals.map((line) => line.traceId)).toEqual([undefined, trace])
    expect(text).not.toContain('forged')
    expect(text).not.toContain('Lovelace')
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('bounds what a backend that never answers can hold, and reports the drops once', () => {
  const stdout = capturing()
  return Effect.gen(function* () {
    const { arrivals, flush, run } = yield* observed({ ...plain, answer: Effect.never })
    const refuse = Effect.fn('Probe.refuse')(function* () {
      return yield* Effect.fail(new ProbeRefused({ message: 'not today' }))
    }, observeFailures('rpc'))
    /** One unit of the server's work, then an export of what it recorded: a span and a line. */
    const round = Effect.fn('Test.round')(function* () {
      yield* run(refuse())
      return yield* Effect.forkChild(flush)
    })

    // Each round's two posts (traces, logs) reach the backend and are never answered. The work
    // itself returned before either was sent: nothing that serves a Person waits on delivery.
    const held: Array<Fiber.Fiber<void>> = []
    for (let outstanding = 0; outstanding < MOST_OUTSTANDING; outstanding += 2) {
      held.push(yield* round())
      yield* Queue.take(arrivals)
      yield* Queue.take(arrivals)
    }
    // The cap is reached. The next round's posts are cancelled without being sent, which ends
    // its export at once and stops both exporters; work after that still completes.
    yield* Fiber.join(yield* round())
    yield* Fiber.join(yield* round())
    expect(yield* Queue.size(arrivals)).toBe(0)
    const reports = () => stdout.lines.filter((line) => line.includes(Message.dropped))
    expect(reports()).toHaveLength(1)
    expect(reports()[0]).toContain('vivid.export.dropped=1')

    // The held posts time out and are dropped too. All of that is one minute's drops, so there
    // is still one report; the backend was never sent more than the cap.
    yield* TestClock.adjust(LONGEST_EXPORT)
    yield* Effect.forEach(held, Fiber.join)
    expect(reports()).toHaveLength(1)
    expect(yield* Queue.size(arrivals)).toBe(0)

    // A minute on, the exporters accept data again and the next drop reports the count so far:
    // the second cancelled post, the eight that timed out, and this one.
    yield* TestClock.adjust(REPORT_EVERY_MILLIS)
    const late = yield* round()
    yield* Queue.take(arrivals)
    yield* Queue.take(arrivals)
    yield* TestClock.adjust(LONGEST_EXPORT)
    yield* Fiber.join(late)
    expect(reports()).toHaveLength(2)
    expect(reports()[1]).toContain(`vivid.export.dropped=${MOST_OUTSTANDING + 2}`)
  }).pipe(Effect.provide(stdout.layer), Effect.provide(NodeHttpServer.layerTest))
})

it.effect('posts nothing when export is disabled', () =>
  Effect.gen(function* () {
    const { posts, routes } = yield* receiving(answered)
    yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true }))
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
