import { expect, it } from '@effect/vitest'
import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node'
import { cutFault, ServiceId } from '@vivid/contracts'
import { getTableName } from 'drizzle-orm'
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors'
import {
  Cause,
  ConfigProvider,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Queue,
  Redacted,
  Ref,
  Schema,
  Stream,
  Tracer,
} from 'effect'
import { TestClock } from 'effect/testing'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpMiddleware from 'effect/unstable/http/HttpMiddleware'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServer from 'effect/unstable/http/HttpServer'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as OtlpExporter from 'effect/unstable/observability/OtlpExporter'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as RpcSerialization from 'effect/unstable/rpc/RpcSerialization'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'
import { ObservabilityConfiguration } from '../config.ts'
import { faultRoutes } from '../http/faults.ts'
import { threads } from '../threads/tables.ts'
import {
  LONGEST_EXPORT,
  MOST_DATABASE_CODES,
  MOST_OUTSTANDING,
  MOST_TYPE_NAMES,
  observabilityLayer,
  PAUSE_MILLIS,
} from './export.ts'
import { observeFailures } from './failure.ts'
import { Message, OMITTED } from './messages.ts'
import { recordRefusal, Refusal } from './refusal.ts'

/** The slice of OTLP/HTTP JSON these tests read; everything else in a post is left undecoded. */
const Pair = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    stringValue: Schema.optional(Schema.String),
    intValue: Schema.optional(Schema.Finite),
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
              links: Schema.Array(Schema.Struct({ traceId: Schema.String })),
              events: Schema.Array(
                Schema.Struct({ name: Schema.String, attributes: Schema.Array(Pair) }),
              ),
              status: Schema.Struct({
                code: Schema.Finite,
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
  /** What the host names the commit, as `VIVID_COMMIT` would hold it. */
  readonly commit: string
}

const answered = Effect.succeed(HttpServerResponse.empty({ status: 200 }))
const plain: Setup = { routes: Layer.empty, ambient: {}, answer: answered, commit: 'abc1234' }

/** Text that has the shape of an identifier, a slug and a media subtype, and came from data. */
const PRIVATE = 'PrivateTokenABC123'

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
 * the server under test, with the real exporter installed under it, posting through the HTTP
 * client `main.ts` gives it (`NodeHttpClient.layerUndici`).
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
        commit: Option.some(setup.commit),
      }),
    ).pipe(Layer.provide(NodeHttpClient.layerUndici)),
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
      /** How many spans each traces post carried, in the order the posts arrived. */
      batches: traces.map(
        (post) =>
          post.resourceSpans.flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans))
            .length,
      ),
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

class ProbeWrapped extends Schema.TaggedError<ProbeWrapped>()(
  'ProbeWrapped',
  { cause: Schema.Unknown },
  { title: 'Probe wrapped' },
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
      return yield* new ProbeRefused({ message: 'not today' })
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
      return yield* new ProbeRefused({ message: prose })
    }, observeFailures('runtime'))
    const { lines, spans, text } = yield* exported(echo())

    const [span] = spanNamed(spans, 'Probe.echo')
    expect(span === undefined ? {} : valuesOf(span.attributes)).toEqual({
      'error.type': 'ProbeRefused',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'runtime',
    })
    // The tracer's exception event is kept and nothing on it is: its message and stack are prose,
    // and its type is `error.name`, a string that only a fixed name may pass as. The span's own
    // `error.type` above is where a declared type is exported. The status text is gone too, and
    // the line logged with prose in its body is still counted, under a placeholder.
    expect(span === undefined ? [] : span.events.map((event) => event.name)).toEqual([
      OMITTED,
      Message.failure,
      'exception',
    ])
    const thrown = span === undefined ? [] : span.events.filter(({ name }) => name === 'exception')
    expect(thrown.map((event) => valuesOf(event.attributes))).toEqual([{}])
    expect(span === undefined ? {} : span.status).toEqual({ code: 2 })
    expect(lines.map((line) => line.body.stringValue)).toContain(OMITTED)
    expect(text).not.toContain('Marsh Lane')
    expect(text).not.toContain('Ada')
    expect(text).not.toContain('Probe.echo (')
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect("exports none of a Drizzle query error's statement or parameters", () =>
  Effect.gen(function* () {
    const table = getTableName(threads)
    const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'messages_key_unique',
      table,
    })
    // The installed class: its message is the statement, then every parameter, and a parameter
    // that spans lines puts text after the line a `params:` pattern would stop at.
    const failure = new EffectDrizzleQueryError({
      query: 'insert into messages (body, author) values ($1, $2)',
      params: ['first private line\nsecond private line', 'dami@example.com'],
      cause: driver,
    })
    const store = Effect.fn('Probe.store')(function* () {
      return yield* failure
    }, observeFailures('rpc'))
    const { spans, text } = yield* exported(store())

    const [span] = spanNamed(spans, 'Probe.store')
    expect(span === undefined ? {} : valuesOf(span.attributes)).toEqual({
      'error.type': 'EffectDrizzleQueryError',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
      'vivid.failure.root': 'Error',
      'db.response.status_code': '23505',
      'db.collection.name': table,
    })
    for (const secret of ['private line', 'insert into', 'dami@example.com', 'duplicate key'])
      expect(text).not.toContain(secret)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('exports a table name only when Vivid declares that table, and no constraint', () => {
  const stdout = capturing()
  return Effect.gen(function* () {
    // `table` and `constraint` are properties of whatever was thrown. A driver sets them from
    // the schema; anything else can set them from anything.
    const foreign = Object.assign(new Error('refused'), {
      code: '23505',
      constraint: `${PRIVATE}_constraint`,
      table: `${PRIVATE}_table`,
    })
    const store = Effect.fn('Probe.store')(function* () {
      return yield* new EffectDrizzleQueryError({ query: 'select 1', params: [], cause: foreign })
    }, observeFailures('rpc'))
    const { lines, spans, text } = yield* exported(store())

    const expected = {
      'error.type': 'EffectDrizzleQueryError',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
      'vivid.failure.root': 'Error',
      'db.response.status_code': '23505',
    }
    const [span] = spanNamed(spans, 'Probe.store')
    expect(span === undefined ? {} : valuesOf(span.attributes)).toEqual(expected)
    const line = lines.find((entry) => entry.body.stringValue === Message.failure)
    expect(line === undefined ? {} : valuesOf(line.attributes)).toEqual(expected)
    expect(text).not.toContain(PRIVATE)
    // Both names are still on the server's own line, for whoever reads stdout.
    const recorded = stdout.lines.filter((entry) => entry.includes(Message.failure))
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toContain(`vivid.failure.constraint=${PRIVATE}_constraint`)
    expect(recorded[0]).toContain(`db.collection.name=${PRIVATE}_table`)
  }).pipe(Effect.provide(stdout.layer), Effect.provide(NodeHttpServer.layerTest))
})

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

it.effect('exports no failure type that is a property of what was thrown', () =>
  Effect.gen(function* () {
    // Each of these has the shape of an identifier, which is why shape decides nothing: the type
    // exported is the one a class gives, and a foreign failure's tag or name is not one.
    const tagged = Effect.fn('Probe.tagged')(function* () {
      return yield* Effect.fail(new Foreign(PRIVATE))
    }, observeFailures('rpc'))
    const named = Effect.fn('Probe.named')(function* () {
      return yield* Effect.die(Object.assign(new TypeError('boom'), { name: PRIVATE }))
    }, observeFailures('rpc'))
    const rooted = Effect.fn('Probe.rooted')(function* () {
      return yield* new ProbeWrapped({ cause: { name: PRIVATE, _tag: PRIVATE } })
    }, observeFailures('rpc'))
    const { spans, text } = yield* exported(
      Effect.all([Effect.exit(tagged()), Effect.exit(named()), Effect.exit(rooted())]),
    )

    const typed = (name: string) => {
      const [span] = spanNamed(spans, name)
      return span === undefined ? {} : valuesOf(span.attributes)
    }
    expect(typed('Probe.tagged')).toEqual({
      'error.type': '_OTHER',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
    })
    expect(typed('Probe.named')).toEqual({
      'error.type': 'TypeError',
      'vivid.failure.kind': 'defect',
      'vivid.boundary': 'rpc',
    })
    expect(typed('Probe.rooted')).toEqual({
      'error.type': 'ProbeWrapped',
      'vivid.failure.kind': 'expected',
      'vivid.boundary': 'rpc',
    })
    // The tracer's exception events for the same failures carry the name as text; none leaves.
    expect(text).not.toContain(PRIVATE)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('exports a refusal field only when its value is one of a closed set', () => {
  const stdout = capturing()
  return Effect.gen(function* () {
    const decide = Effect.fn('Probe.decide')(function* () {
      // A service id is an open string: an Integration a Person imported names its own.
      yield* recordRefusal(
        Refusal.cases.IntegrationNotReady.make({ service: ServiceId.make(PRIVATE) }),
      )
      // An annotation under a refusal key whose value is in no schema is not a refusal field.
      yield* Effect.annotateLogs(Effect.logInfo(Message.refusal), {
        'vivid.refusal.kind': PRIVATE,
        'vivid.refusal.reason': PRIVATE,
      })
      yield* recordRefusal(
        Refusal.cases.ActionBlocked.make({ effect: 'destructive', target: 'Desktop' }),
      )
    })
    const { lines, text } = yield* exported(decide())

    const refusals = lines.filter((line) => line.body.stringValue === Message.refusal)
    expect(refusals.map((line) => valuesOf(line.attributes))).toEqual([
      { 'vivid.refusal.kind': 'IntegrationNotReady' },
      {},
      {
        'vivid.refusal.kind': 'ActionBlocked',
        'vivid.refusal.effect': 'destructive',
        'vivid.refusal.target': 'Desktop',
      },
    ])
    expect(text).not.toContain(PRIVATE)
    // The service is still on the server's own line.
    expect(stdout.lines.some((line) => line.includes(`vivid.refusal.service=${PRIVATE}`))).toBe(
      true,
    )
  }).pipe(Effect.provide(stdout.layer), Effect.provide(NodeHttpServer.layerTest))
})

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

it.effect('names the commit on the resource only when it is a commit', () =>
  Effect.gen(function* () {
    // What `VIVID_COMMIT` would hold if a credential were pasted into it.
    const { collect, flush, run } = yield* observed({ ...plain, commit: `ghp_${PRIVATE}` })
    yield* run(Effect.fn('Probe.work')(() => Effect.logInfo(Message.refusal))())
    yield* flush
    const { resources, text } = yield* collect()

    expect(resources.length).toBeGreaterThan(1)
    for (const resource of resources)
      expect(valuesOf(resource.attributes)).toEqual({
        'service.name': 'vivid-server',
        'deployment.environment': 'production',
        'deployment.environment.name': 'production',
      })
    expect(text).not.toContain(PRIVATE)
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
      // A header is the sender's text on the way in and a handler's on the way out, and
      // `application/<anything>` is a well-formed media type.
      return HttpServerResponse.text('done', {
        status: 200,
        contentType: `application/answer-${PRIVATE}`,
      })
    })
    const { spans, statuses, text } = yield* requested(
      HttpRouter.add('GET', '/api/connections/return', callback()),
      [
        HttpClientRequest.get('/api/connections/return?code=secret-code&state=opaque-state').pipe(
          HttpClientRequest.setHeader('cookie', 'session=private-session'),
          HttpClientRequest.setHeader('user-agent', 'PrivateBrowser/1.0'),
          HttpClientRequest.setHeader('content-type', `application/private-token-${PRIVATE}`),
        ),
      ],
    )

    expect(statuses).toEqual([200])
    const [server] = spanNamed(spans, 'http.server GET')
    expect(server === undefined ? {} : valuesOf(server.attributes)).toEqual({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'url.scheme': 'http',
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
      PRIVATE,
      'content-type',
    ])
      expect(text).not.toContain(secret)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect(
  'exports no span under a malformed or all-zero inbound trace id, and no such parent',
  () =>
    Effect.gen(function* () {
      const inbound = Effect.fn('Probe.inbound')(function* () {
        yield* recordRefusal(Refusal.cases.DeviceRefused.make({ reason: 'NotAllowed' }))
        return HttpServerResponse.empty({ status: 204 })
      })
      const trace = '0af7651916cd43dd8448eb211c80319c'
      const rooted = '4bf92f3577b34da6a3ce929d0e0e4736'
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
          // Hexadecimal, and neither of the two lengths a trace id has.
          HttpClientRequest.get('/probe').pipe(
            HttpClientRequest.setHeader('b3', '463ac35c9f6413ad463ac35c-a2fb4a1d1a96d312-1'),
          ),
          // Well formed and all zero, which OpenTelemetry defines as no id: a 64-bit B3 trace id
          // that widening would turn into the all-zero 128-bit one, then that one as sent.
          HttpClientRequest.get('/probe').pipe(
            HttpClientRequest.setHeader('b3', '0000000000000000-a2fb4a1d1a96d312-1'),
          ),
          HttpClientRequest.get('/probe').pipe(
            HttpClientRequest.setHeader('b3', `${'0'.repeat(32)}-a2fb4a1d1a96d312-1`),
          ),
          // A sound trace id whose parent span id is all zero.
          HttpClientRequest.get('/probe').pipe(
            HttpClientRequest.setHeader('b3', `${rooted}-0000000000000000-1`),
          ),
        ],
      )

      expect(statuses).toEqual([204, 204, 204, 204, 204, 204])
      // The second and last requests' spans are exported, the server span as a root; the spans of
      // every other request are gone.
      const servers = spanNamed(spans, 'http.server GET')
      expect(servers.map((span) => [span.traceId, span.parentSpanId])).toEqual([
        [trace, undefined],
        [rooted, undefined],
      ])
      expect(spanNamed(spans, 'Probe.inbound').map((span) => span.traceId)).toEqual([trace, rooted])
      // Every refusal is still counted. A line written under a dropped span is filed under that
      // span's own trace id, which the server made: an id, a different one for each request, and
      // never the text that was sent.
      const refusals = lines.filter((line) => line.body.stringValue === Message.refusal)
      const filed = refusals.map((line) => (line.traceId === undefined ? '' : line.traceId))
      expect([filed[1], filed[5]]).toEqual([trace, rooted])
      const made = [filed[0], filed[2], filed[3], filed[4]]
      expect(made.map((id) => id !== undefined && /^[0-9a-f]{32}$/.test(id))).toEqual([
        true,
        true,
        true,
        true,
      ])
      expect(new Set([...made, trace, rooted]).size).toBe(6)
      expect(filed).toHaveLength(6)
      expect(text).not.toContain('forged')
      expect(text).not.toContain('Lovelace')
      expect(text).not.toContain('463ac35c9f6413ad463ac35c')
      expect(text).not.toContain('0'.repeat(16))
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('files a 64-bit B3 trace under its 128-bit form, on spans, links and lines alike', () =>
  Effect.gen(function* () {
    const short = '463ac35c9f6413ad'
    const caller = 'a2fb4a1d1a96d312'
    const wide = `0000000000000000${short}`
    const inbound = Effect.fn('Probe.inbound')(function* () {
      yield* recordRefusal(Refusal.cases.DeviceRefused.make({ reason: 'NotAllowed' }))
      // A span elsewhere that points back at this trace, by the id as the caller sent it.
      yield* Effect.fn('Probe.linked')(() => Effect.void)().pipe(
        Effect.linkSpans(Tracer.externalSpan({ traceId: short, spanId: caller })),
        Effect.withParentSpan(Tracer.externalSpan({ traceId: short, spanId: caller })),
      )
      return HttpServerResponse.empty({ status: 204 })
    })
    const { lines, spans, statuses } = yield* requested(
      HttpRouter.add('GET', '/probe', inbound()),
      [
        // A valid 64-bit trace id, as B3 allows.
        HttpClientRequest.get('/probe').pipe(
          HttpClientRequest.setHeader('b3', `${short}-${caller}-1`),
        ),
      ],
    )

    expect(statuses).toEqual([204])
    // The server span is the caller's child, and everything beneath it is in the same trace.
    const servers = spanNamed(spans, 'http.server GET')
    expect(servers.map((span) => [span.traceId, span.parentSpanId])).toEqual([[wide, caller]])
    const [server] = servers
    const [handler] = spanNamed(spans, 'Probe.inbound')
    expect(handler === undefined ? '' : handler.traceId).toBe(wide)
    expect(server === undefined || handler === undefined ? '' : handler.parentSpanId).not.toBe(
      undefined,
    )
    const [linked] = spanNamed(spans, 'Probe.linked')
    expect(linked === undefined ? [] : [linked.traceId, linked.parentSpanId]).toEqual([
      wide,
      caller,
    ])
    expect(linked === undefined ? [] : linked.links).toEqual([{ traceId: wide }])
    const refusals = lines.filter((line) => line.body.stringValue === Message.refusal)
    expect(refusals.map((line) => line.traceId)).toEqual([wide])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

/** One product call, served the way `rpc/server.ts` serves `VividRpc` over plain HTTP. */
const probes = RpcGroup.make(
  Rpc.make('Echo', { payload: { note: Schema.String }, success: Schema.String }),
)
const probeRoutes = RpcServer.layerHttp({ group: probes, path: '/rpc', protocol: 'http' }).pipe(
  Layer.provide(
    probes.toLayer({
      Echo: Effect.fn('Probe.echo')(function* ({ note }) {
        return yield* Effect.succeed(note)
      }),
    }),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
)

it.effect('builds no span name from what a request carries, over HTTP or RPC', () =>
  Effect.gen(function* () {
    // A dotted identifier: the one shape of data the span-name rule cannot tell from a name
    // written in code, so the one that would be exported if a producer ever built a name from it.
    const marker = 'Ada.Lovelace'
    const visit = Effect.fn('Probe.visit')(function* () {
      return yield* Effect.succeed(HttpServerResponse.empty({ status: 204 }))
    })
    const { collect, flush } = yield* observed({
      ...plain,
      routes: Layer.mergeAll(HttpRouter.add('GET', '/probe/:who', visit()), probeRoutes),
    })
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.setUrlParam('who', marker)),
      HttpClient.mapRequest(HttpClientRequest.setHeader('x-who', marker)),
    )
    const sent = Effect.provideService(HttpClient.TracerPropagationEnabled, false)

    // In the path, the query and a header of a plain request.
    const visited = yield* sent(http.execute(HttpClientRequest.get(`/probe/${marker}`)))
    expect(visited.status).toBe(204)
    // In the payload, the query and a header of a product call.
    const client = yield* RpcClient.make(probes).pipe(
      Effect.provide(
        // The test client has already put the server's address in front, so the path goes after.
        RpcClient.layerProtocolHttp({
          url: '',
          transformClient: HttpClient.mapRequest(HttpClientRequest.appendUrl('/rpc')),
        }).pipe(
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        ),
      ),
    )
    expect(
      yield* client.Echo({ note: marker }).pipe(RpcClient.withHeaders({ 'x-who': marker })),
    ).toBe(marker)
    // As the name of a call the contract does not declare: rc.116 `RpcServer.ts` names its span
    // `RpcServer.<tag>`, and must not for a tag it did not find in the group.
    const undeclared = yield* sent(
      http.execute(
        HttpClientRequest.post('/rpc').pipe(
          HttpClientRequest.bodyText(
            `{"_tag":"Request","id":"1","tag":"${marker}","payload":{},"headers":[]}\n`,
            'application/ndjson',
          ),
        ),
      ),
    )
    expect(undeclared.status).toBe(200)
    yield* flush
    const { spans, text } = yield* collect()

    // The spans those requests made are all here, under names from code.
    const names = spans.map((span) => span.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'http.server GET',
        'Probe.visit',
        'http.server POST',
        'RpcServer.Echo',
        'Probe.echo',
      ]),
    )
    expect(names.filter((name) => name.includes('Ada') || name.includes('Lovelace'))).toEqual([])
    // And nowhere else in what left.
    expect(text).not.toContain('Lovelace')
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

/** What a drop report says, read from its stdout line: the signal, the count, and the pause. */
const reported = (line: string) =>
  ['vivid.export.signal', 'vivid.export.dropped', 'vivid.export.paused_seconds']
    .map((key) =>
      Option.fromNullishOr(new RegExp(`${key}=(\\w+)`).exec(line)).pipe(
        Option.flatMap((match) => Option.fromUndefinedOr(match[1])),
        Option.getOrElse(() => 'absent'),
      ),
    )
    .join(' ')

/** The report of a drop that paused `signal`, `dropped` batches after that signal's last report. */
const paused = (signal: 'traces' | 'logs', dropped: number) =>
  `${signal} ${dropped} ${PAUSE_MILLIS / 1000}`

it.effect('bounds what a backend that never answers can hold, and reports each pause once', () => {
  const stdout = capturing()
  return Effect.gen(function* () {
    const { arrivals, flush, run } = yield* observed({ ...plain, answer: Effect.never })
    const refuse = Effect.fn('Probe.refuse')(function* () {
      return yield* new ProbeRefused({ message: 'not today' })
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
    // One report for each signal, written by the drop that paused it, and it says so.
    // The two exporters run on their own fibers, so which report is written first is not promised.
    expect(reports()).toHaveLength(2)
    expect(new Set(reports().map(reported))).toEqual(
      new Set([paused('traces', 1), paused('logs', 1)]),
    )

    // The held posts time out and are dropped too. They fall inside the pauses already
    // reported, so there is no new report; the backend was never sent more than the cap.
    yield* TestClock.adjust(LONGEST_EXPORT)
    yield* Effect.forEach(held, Fiber.join)
    expect(reports()).toHaveLength(2)
    expect(yield* Queue.size(arrivals)).toBe(0)

    // A minute on, the exporters accept data again, and the next drop of each signal starts its
    // next pause and reports the count so far: the four that timed out, and this one.
    yield* TestClock.adjust(PAUSE_MILLIS)
    const late = yield* round()
    yield* Queue.take(arrivals)
    yield* Queue.take(arrivals)
    yield* TestClock.adjust(LONGEST_EXPORT)
    yield* Fiber.join(late)
    const perSignal = MOST_OUTSTANDING / 2 + 1
    expect(reports()).toHaveLength(4)
    expect(new Set(reports().slice(2).map(reported))).toEqual(
      new Set([paused('traces', perSignal), paused('logs', perSignal)]),
    )
  }).pipe(Effect.provide(stdout.layer), Effect.provide(NodeHttpServer.layerTest))
})

/**
 * A response body that starts and never ends. The first bytes put the headers on the wire; then
 * nothing more comes. `closed` is offered when the server abandons writing it, which
 * `NodeHttpServer` does by interrupting the request when the socket closes under it, so taking
 * from `closed` is waiting on the backend's own receipt that a connection has gone.
 */
const stalling = (closed: Queue.Queue<void>) =>
  Stream.concat(Stream.make(new TextEncoder().encode('{')), Stream.never).pipe(
    Stream.ensuring(Queue.offer(closed, undefined)),
  )

it.effect('gives a refused export one attempt, keeps nothing of it, and reports the drop', () => {
  const stdout = capturing()
  return Effect.gen(function* () {
    // A backend that answers at once, refuses, and asks to be tried again in an hour. rc.116
    // `OtlpExporter.ts` would wait that hour with the batch in hand, once per batch. The hour is
    // short on purpose: the logs exporter wakes every second of the time that passes below. The refusal
    // has a body that never ends and that nothing reads (`stalling`).
    const closed = yield* Queue.unbounded<void>()
    const { arrivals, collect, flush, run } = yield* observed({
      ...plain,
      answer: Effect.sync(() =>
        HttpServerResponse.stream(stalling(closed), {
          status: 429,
          headers: { 'retry-after': '3600' },
        }),
      ),
    })
    const refuse = Effect.fn('Probe.refuse')(function* () {
      return yield* new ProbeRefused({ message: 'not today' })
    }, observeFailures('rpc'))
    const reports = () => stdout.lines.filter((line) => line.includes(Message.dropped))

    const ROUNDS = 5
    for (let round = 1; round <= ROUNDS; round += 1) {
      // The server's work goes on logging, and each minute's batch is exported. The export ends
      // without the clock moving, so no fiber is left waiting out a retry with a batch in hand.
      yield* run(refuse())
      yield* flush
      yield* Queue.take(arrivals)
      yield* Queue.take(arrivals)
      // Both connections are given up with the export, though the refusal's body never ended.
      yield* Queue.takeN(closed, 2)
      expect(yield* Queue.size(arrivals)).toBe(0)
      expect(reports()).toHaveLength(round * 2)
      // The exporters accept data again a minute after a drop.
      yield* TestClock.adjust(PAUSE_MILLIS)
    }
    // Long past the hour the backend asked for, nothing was sent a second time.
    yield* TestClock.adjust(Duration.hours(2))
    expect(yield* Queue.size(arrivals)).toBe(0)
    // Each post carried its own minute's span and no earlier one: a refused batch is not kept.
    const { batches, received } = yield* collect()
    expect(received).toHaveLength(ROUNDS * 2)
    expect(batches).toEqual(Array.from({ length: ROUNDS }, () => 1))
    // Every refused batch is reported: each one paused its signal, so each has its own line.
    for (const signal of ['traces', 'logs'] as const)
      expect(reports().filter((line) => reported(line) === paused(signal, 1))).toHaveLength(ROUNDS)
  }).pipe(Effect.provide(stdout.layer), Effect.provide(NodeHttpServer.layerTest))
})

it.effect('holds a place until the answer ends, and gives the connection back with it', () => {
  const stdout = capturing()
  return Effect.gen(function* () {
    // A backend that answers `200`, starts the body and never finishes it (`stalling`).
    const closed = yield* Queue.unbounded<void>()
    const { arrivals, flush, run } = yield* observed({
      ...plain,
      answer: Effect.sync(() =>
        HttpServerResponse.stream(stalling(closed), {
          status: 200,
          contentType: 'application/json',
        }),
      ),
    })
    const refuse = Effect.fn('Probe.refuse')(function* () {
      return yield* new ProbeRefused({ message: 'not today' })
    }, observeFailures('rpc'))
    const round = Effect.fn('Test.round')(function* () {
      yield* run(refuse())
      return yield* Effect.forkChild(flush)
    })
    const reports = () => stdout.lines.filter((line) => line.includes(Message.dropped))

    const held: Array<Fiber.Fiber<void>> = []
    for (let outstanding = 0; outstanding < MOST_OUTSTANDING; outstanding += 2) {
      held.push(yield* round())
      yield* Queue.take(arrivals)
      yield* Queue.take(arrivals)
    }
    // Headers have been answered for every one of them, and each still holds its place: the
    // next export is turned away unsent, so no ninth connection is opened.
    yield* Fiber.join(yield* round())
    expect(yield* Queue.size(arrivals)).toBe(0)
    expect(reports()).toHaveLength(2)
    expect(yield* Queue.size(closed)).toBe(0)

    // The time limit runs to the end of the body. When it passes, each export is dropped, and
    // the backend sees each of its eight connections close: a place given back is a socket
    // given back. Waiting on `closed` is waiting on the server's own receipt of that.
    yield* TestClock.adjust(LONGEST_EXPORT)
    yield* Effect.forEach(held, Fiber.join)
    yield* Queue.takeN(closed, MOST_OUTSTANDING)

    // The places are free again: a minute on, an export is sent.
    yield* TestClock.adjust(PAUSE_MILLIS)
    const late = yield* round()
    yield* Queue.take(arrivals)
    yield* Queue.take(arrivals)
    yield* TestClock.adjust(LONGEST_EXPORT)
    yield* Fiber.join(late)
    yield* Queue.takeN(closed, 2)
    const perSignal = MOST_OUTSTANDING / 2 + 1
    expect(reports()).toHaveLength(4)
    expect(new Set(reports().slice(2).map(reported))).toEqual(
      new Set([paused('traces', perSignal), paused('logs', perSignal)]),
    )
  }).pipe(Effect.provide(stdout.layer), Effect.provide(NodeHttpServer.layerTest))
})

it.effect('pauses a signal for a minute after one failed export, then sends again', () => {
  const stdout = capturing()
  return Effect.gen(function* () {
    // A backend that is down for its first two posts, one of each signal, and well after.
    const answers = yield* Ref.make(0)
    const { arrivals, collect, flush, run } = yield* observed({
      ...plain,
      answer: Ref.getAndUpdate(answers, (count) => count + 1).pipe(
        Effect.map((count) => HttpServerResponse.empty({ status: count < 2 ? 503 : 200 })),
      ),
    })
    const named = (name: string) =>
      Effect.fn(name)(function* () {
        return yield* new ProbeRefused({ message: 'not today' })
      }, observeFailures('rpc'))()
    const reports = () => stdout.lines.filter((line) => line.includes(Message.dropped))

    // One failed attempt for each signal. The line on stdout says which, and for how long.
    yield* run(named('Probe.before'))
    yield* flush
    yield* Queue.take(arrivals)
    yield* Queue.take(arrivals)
    expect(reports()).toHaveLength(2)
    expect(new Set(reports().map(reported))).toEqual(
      new Set([paused('traces', 1), paused('logs', 1)]),
    )

    // Inside the pause nothing is buffered and nothing is sent: this is the gap in the backend.
    yield* run(named('Probe.during'))
    yield* flush
    expect(yield* Queue.size(arrivals)).toBe(0)

    // When the pause has ended, a new batch is sent and accepted.
    yield* TestClock.adjust(PAUSE_MILLIS)
    yield* run(named('Probe.after'))
    yield* flush
    yield* Queue.take(arrivals)
    yield* Queue.take(arrivals)
    expect(yield* Queue.size(arrivals)).toBe(0)
    const { batches, received, spans } = yield* collect()
    expect(received).toHaveLength(4)
    expect(batches).toEqual([1, 1])
    // The refused batch was posted once and the accepted one once; the pause's span never left.
    expect(spans.map((span) => span.name)).toEqual(['Probe.before', 'Probe.after'])
    // Nothing was dropped after the first two, so stdout has no further report.
    expect(reports()).toHaveLength(2)
  }).pipe(Effect.provide(stdout.layer), Effect.provide(NodeHttpServer.layerTest))
})

/** The instance type of the classes `declared` makes. */
interface Declared {
  readonly cause: unknown
}

/** A handler whose every trap throws, for a `Proxy` that cannot be read in any way. */
const refusing: ProxyHandler<object> = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error(PRIVATE)
    },
  },
)

/** A `Proxy` after `revoke`: every operation on it, `typeof` aside, is a `TypeError`. */
const revoked = (): object => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}

/**
 * The loggers installed where this runs, without the two Effect installs by default: the
 * exporter's, alone. Those two read what is logged themselves, with or without export.
 */
const exportersOnly = Effect.fn('Test.exportersOnly')(function* () {
  const loggers = yield* Logger.CurrentLoggers
  return new Set(
    [...loggers].filter(
      (logger) => logger !== Logger.defaultLogger && logger !== Logger.tracerLogger,
    ),
  )
})

/**
 * Values that run their own code, or never end, when something reads them as an error: what a
 * provider SDK, a driver or a bug can throw. Each is made fresh, with private text where a
 * message goes.
 */
const hostile: ReadonlyArray<readonly [label: string, make: () => object]> = [
  [
    'an Error whose name throws',
    () =>
      Object.defineProperty(new Error(PRIVATE), 'name', {
        get: () => {
          throw new Error(PRIVATE)
        },
      }),
  ],
  [
    'an Error that is its own cause',
    () => {
      const error = new Error(PRIVATE)
      error.cause = error
      return error
    },
  ],
  [
    'an Error in a cycle of two causes',
    () => {
      const first = new Error(PRIVATE)
      first.cause = new Error(PRIVATE, { cause: first })
      return first
    },
  ],
  ['a Proxy whose traps throw', () => new Proxy({}, refusing)],
  ['a revoked Proxy', revoked],
]

/** Each hostile value, once as a typed failure and once as a defect. */
const hostileCases = hostile.flatMap(([label, make]) =>
  (['Fail', 'Die'] as const).map((kind) => ({ label, kind, value: make() })),
)
type HostileCase = (typeof hostileCases)[number]

/**
 * What a caller was handed for one hostile case, in a form that can be compared without reading
 * the value: how many reasons the cause has, and whether the one reason is of the kind that was
 * raised and holds the very object that was raised. `expect` is never given the value itself,
 * because printing it would run its code.
 */
const outcomeOf = <A>({ kind, label, value }: HostileCase, exit: Exit.Exit<A, unknown>) => {
  const reasons = Exit.isFailure(exit) ? exit.cause.reasons : []
  const [reason] = reasons
  const same =
    reason !== undefined &&
    ((kind === 'Fail' && Cause.isFailReason(reason) && Object.is(reason.error, value)) ||
      (kind === 'Die' && Cause.isDieReason(reason) && Object.is(reason.defect, value)))
  return { label, kind, reasons: reasons.length, same }
}

const unchanged = ({ kind, label }: HostileCase) => ({ label, kind, reasons: 1, same: true })

it.effect('ends a span whose failure cannot be read, and hands the caller that failure only', () =>
  Effect.gen(function* () {
    const { collect, flush, run } = yield* observed(plain)
    const raise = Effect.fn('Probe.hostile')(function* ({ kind, value }: HostileCase) {
      return yield* kind === 'Fail' ? Effect.fail(value) : Effect.die(value)
    }, observeFailures('rpc'))
    // The same failure through a span that no recorder reads it under: only the tracer does.
    const bare = Effect.fn('Probe.bare')(function* ({ kind, value }: HostileCase) {
      return yield* kind === 'Fail' ? Effect.fail(value) : Effect.die(value)
    })

    const outcomes = yield* Effect.forEach(hostileCases, (entry) =>
      Effect.all([run(raise(entry)), run(bare(entry))]).pipe(
        Effect.map((exits) => exits.map((exit) => outcomeOf(entry, exit))),
      ),
    )
    yield* flush
    const { spans, text } = yield* collect()

    // Ending the span added nothing to the cause: one reason, of the kind raised, the same object.
    expect(outcomes).toEqual(hostileCases.map((entry) => [unchanged(entry), unchanged(entry)]))
    // Every span was still exported, as failed, with the type its class gives and no text. A
    // defect that is an `Error` is named so; nothing names a typed failure of no declared class.
    const types = (name: string) =>
      spanNamed(spans, name).map((span) => [
        span.status,
        span.events
          .filter((event) => event.name === 'exception')
          .map((event) => valuesOf(event.attributes)),
      ])
    const error = [{ code: 2 }, [{ 'exception.type': 'Error' }]]
    const other = [{ code: 2 }, [{}]]
    const expected = [other, error, other, error, other, error, other, other, other, other]
    expect(types('Probe.hostile')).toEqual(expected)
    expect(types('Probe.bare')).toEqual(expected)
    expect(
      spanNamed(spans, 'Probe.hostile').map((span) => valuesOf(span.attributes)['error.type']),
    ).toEqual(expected.map((entry) => (entry === error ? 'Error' : '_OTHER')))
    expect(text).not.toContain(PRIVATE)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('still exports an ordinary failed span with its type, on the span and its event', () =>
  Effect.gen(function* () {
    const crash = Effect.fn('Probe.crash')(function* () {
      return yield* Effect.die(new TypeError('cannot read the thing'))
    }, observeFailures('rpc'))
    const { spans } = yield* exported(crash())

    const [span] = spanNamed(spans, 'Probe.crash')
    expect(span === undefined ? {} : valuesOf(span.attributes)['error.type']).toBe('TypeError')
    expect(span === undefined ? {} : span.status).toEqual({ code: 2 })
    expect(
      span === undefined
        ? []
        : span.events
            .filter((event) => event.name === 'exception')
            .map((event) => valuesOf(event.attributes)),
    ).toEqual([{ 'exception.type': 'TypeError' }])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect(
  'leaves off an attribute or an annotation that is not a plain value, and exports the rest',
  () =>
    Effect.gen(function* () {
      const { collect, flush, run } = yield* observed(plain)
      // A value that throws when anything reads it, under a key the allowlist names.
      const annotate = Effect.fn('Probe.annotated')(function* () {
        yield* Effect.annotateCurrentSpan('vivid.boundary', revoked())
        return 'done'
      })
      const log = Effect.fn('Probe.logged')(function* () {
        yield* Effect.logInfo(Message.failure).pipe(
          Effect.annotateLogs('vivid.boundary', revoked()),
          // Effect's own loggers print the annotation; only the exporter's is under test.
          Effect.provideService(Logger.CurrentLoggers, yield* exportersOnly()),
        )
        return 'done'
      })
      const exits = [yield* run(annotate()), yield* run(log())]
      yield* flush
      const { lines, spans } = yield* collect()

      expect(exits).toEqual([Exit.succeed('done'), Exit.succeed('done')])
      // The value is not a string, a number or a boolean, so it was never read; the span and the
      // line it was on are exported without it.
      expect(spanNamed(spans, 'Probe.annotated').map((span) => valuesOf(span.attributes))).toEqual([
        {},
      ])
      expect(spanNamed(spans, 'Probe.logged')).toHaveLength(1)
      expect(
        lines
          .filter((line) => line.body.stringValue === Message.failure)
          .map((line) => valuesOf(line.attributes)),
      ).toEqual([{}])
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

/**
 * `[0]` replaced thirty times by `[previous, previous]`: thirty-one arrays that rc.116
 * `OtlpResource.unknownToAttributeValue` converts into two to the power of thirty leaves. Handed
 * to that function, a test that uses it does not fail; it never ends.
 */
const doubling = () =>
  Array.from({ length: 30 }).reduce<ReadonlyArray<unknown>>((previous) => [previous, previous], [0])

it.effect('gives the exporter no object to walk, wherever one is attached', () =>
  Effect.gen(function* () {
    const { collect, flush, run } = yield* observed(plain)
    const graph = doubling()
    const caller = Tracer.externalSpan({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'a2fb4a1d1a96d312',
    })
    // Under a key the allowlist names, so that only the value's kind keeps it out.
    const attribute = Effect.fn('Probe.attribute')(function* () {
      yield* Effect.annotateCurrentSpan('vivid.boundary', graph)
      return 'done'
    })
    const created = Effect.succeed('done').pipe(
      Effect.withSpan('Probe.created', { attributes: { 'vivid.boundary': graph } }),
    )
    const event = Effect.fn('Probe.event')(function* () {
      const span = yield* Effect.currentSpan
      span.event(Message.refusal, 0n, { 'vivid.boundary': graph })
      return 'done'
    })
    const linked = Effect.fn('Probe.linked')(() => Effect.succeed('done'))().pipe(
      Effect.linkSpans(caller, { 'vivid.boundary': graph }),
    )
    const annotation = Effect.fn('Probe.annotation')(function* () {
      yield* Effect.logInfo(Message.failure).pipe(
        Effect.annotateLogs('vivid.boundary', graph),
        Effect.provideService(Logger.CurrentLoggers, yield* exportersOnly()),
      )
      return 'done'
    })
    const message = Effect.fn('Probe.message')(function* () {
      yield* Effect.logInfo(graph).pipe(
        Effect.provideService(Logger.CurrentLoggers, yield* exportersOnly()),
      )
      return 'done'
    })
    const neighbour = Effect.fn('Probe.neighbour')(function* () {
      yield* recordRefusal(Refusal.cases.DeviceRefused.make({ reason: 'NotAllowed' }))
      return 'done'
    })
    const exits = yield* Effect.forEach(
      [attribute(), created, event(), linked, annotation(), message(), neighbour()],
      run,
    )
    yield* flush
    const { lines, spans } = yield* collect()

    expect(exits).toEqual(Array.from({ length: 7 }, () => Exit.succeed('done')))
    // Each span is exported without the value, and the work beside them as it was.
    const attributes = (name: string) =>
      spanNamed(spans, name).map((span) => valuesOf(span.attributes))
    expect(attributes('Probe.attribute')).toEqual([{}])
    expect(attributes('Probe.created')).toEqual([{}])
    expect(
      spanNamed(spans, 'Probe.event').map((span) =>
        span.events.map((entry) => [entry.name, valuesOf(entry.attributes)]),
      ),
    ).toEqual([[[Message.refusal, {}]]])
    expect(spanNamed(spans, 'Probe.linked').map((span) => span.links)).toEqual([
      [{ traceId: caller.traceId }],
    ])
    expect(spanNamed(spans, 'Probe.neighbour')).toHaveLength(1)
    const bodies = (name: string) => {
      const [span] = spanNamed(spans, name)
      return lines
        .filter((line) => span !== undefined && line.traceId === span.traceId)
        .map((line) => [line.body.stringValue, Object.keys(valuesOf(line.attributes))])
    }
    expect(bodies('Probe.annotation')).toEqual([[Message.failure, []]])
    // A message that is not one of the fixed ones is the placeholder, whatever it was.
    expect(bodies('Probe.message')).toEqual([[OMITTED, []]])
    expect(bodies('Probe.neighbour').map(([body]) => body)).toEqual([Message.refusal])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('drops a value too long to be an attribute without reading it', () =>
  Effect.gen(function* () {
    const { collect, flush, run } = yield* observed(plain)
    // Ten megabytes under a key the allowlist names. Only its length is asked.
    const long = 'x'.repeat(10 * 1024 * 1024)
    const annotate = Effect.fn('Probe.long')(function* () {
      yield* Effect.annotateCurrentSpan('vivid.boundary', long)
      yield* Effect.annotateCurrentSpan(long, 'rpc')
      yield* Effect.logInfo(Message.failure).pipe(
        Effect.annotateLogs('vivid.boundary', long),
        Effect.provideService(Logger.CurrentLoggers, yield* exportersOnly()),
      )
      return 'done'
    })
    const exit = yield* run(annotate())
    yield* flush
    const { lines, spans, text } = yield* collect()

    expect(exit).toEqual(Exit.succeed('done'))
    expect(spanNamed(spans, 'Probe.long').map((span) => valuesOf(span.attributes))).toEqual([{}])
    expect(
      lines
        .filter((line) => line.body.stringValue === Message.failure)
        .map((line) => valuesOf(line.attributes)),
    ).toEqual([{}])
    // Nothing of it was serialized: everything that left is a few kilobytes.
    expect(text.length).toBeLessThan(64 * 1024)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

/** A getter that throws as soon as it is read, with private text for a message. */
const throwing = (): never => {
  throw new Error(PRIVATE)
}

it.effect('makes a span from options or a parent that cannot be read, and changes no outcome', () =>
  Effect.gen(function* () {
    const { collect, flush, run } = yield* observed(plain)
    // A parent whose trace id throws when read: rc.116 `SpanImpl` reads it for the child's own.
    const parent = () =>
      Object.defineProperty(
        Tracer.externalSpan({
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'a2fb4a1d1a96d312',
        }),
        'traceId',
        { get: throwing },
      )
    const child = Effect.fn('Probe.child')(function* () {
      // What a client would send on as this request's trace: the span's own id, read here.
      const span = yield* Effect.currentSpan
      return [span.traceId.length, span.spanId.length, span.sampled] as const
    })
    const direct = Effect.fn('Probe.direct')(function* () {
      const tracer = yield* Tracer.Tracer
      const options = {
        name: 'Probe.hostile',
        parent: Option.none<Tracer.AnySpan>(),
        annotations: Context.empty(),
        links: [],
        startTime: 0n,
        kind: 'internal' as const,
        root: true,
        sampled: true,
      }
      // Options whose name throws, then options whose parent does.
      const spans = [
        tracer.span(Object.defineProperty({ ...options }, 'name', { get: throwing })),
        tracer.span({ ...options, parent: Option.some(parent()) }),
      ]
      for (const span of spans) span.end(1n, Exit.succeed('done'))
      return spans.map((span) => [span.traceId.length, span.spanId.length, span.sampled] as const)
    })
    const neighbour = Effect.fn('Probe.neighbour')(() => Effect.succeed('done'))
    const exits = [
      yield* run(child().pipe(Effect.withParentSpan(parent()))),
      yield* run(direct()),
      yield* run(neighbour()),
    ]
    yield* flush
    const { spans, text } = yield* collect()

    // Each span has ids of its own and is not sampled, so nothing under it is exported.
    expect(exits).toEqual([
      Exit.succeed([32, 16, false]),
      Exit.succeed([
        [32, 16, false],
        [32, 16, false],
      ]),
      Exit.succeed('done'),
    ])
    expect(spanNamed(spans, 'Probe.child')).toEqual([])
    expect(spanNamed(spans, 'Probe.hostile')).toEqual([])
    expect(spanNamed(spans, 'Probe.direct')).toHaveLength(1)
    expect(spanNamed(spans, 'Probe.neighbour')).toHaveLength(1)
    expect(text).not.toContain(PRIVATE)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('forwards at most 128 links, whatever the collection that holds them answers', () =>
  Effect.gen(function* () {
    const { collect, flush, run } = yield* observed(plain)
    const link: Tracer.SpanLink = {
      span: Tracer.externalSpan({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'a2fb4a1d1a96d312',
      }),
      attributes: {},
    }
    // A million links in an array whose `slice` hands back the array itself, so a cap taken with
    // the array's own method caps nothing.
    const endless = () => {
      const links = Array.from({ length: 1_000_000 }, () => link)
      links.slice = () => links
      return links
    }
    // A collection that throws when it is asked anything, how long it is first of all.
    const unsized = () => new Proxy([link], { get: throwing })
    const options = (name: string, links: Array<Tracer.SpanLink>) => ({
      name,
      parent: Option.none<Tracer.AnySpan>(),
      annotations: Context.empty(),
      links,
      startTime: 0n,
      kind: 'internal' as const,
      root: true,
      sampled: true,
    })
    const created = Effect.fn('Probe.created')(function* () {
      const tracer = yield* Tracer.Tracer
      const spans = [
        tracer.span(options('Probe.endless', endless())),
        tracer.span(options('Probe.unsized', unsized())),
      ]
      for (const span of spans) span.end(1n, Exit.succeed('done'))
      return spans.map((span) => [span.links.length, span.sampled] as const)
    })
    const added = Effect.fn('Probe.added')(function* () {
      const span = yield* Effect.currentSpan
      span.addLinks(unsized())
      const before = span.links.length
      // Twice, so that the second call finds no room left.
      span.addLinks(endless())
      span.addLinks(endless())
      return [before, span.links.length] as const
    })
    const exits = [yield* run(created()), yield* run(added())]
    yield* flush
    const { spans, text } = yield* collect()

    // Options whose links cannot be read make a span that records nothing (`unreadable`); links
    // that cannot be read when they are added are not added, and the span goes on.
    expect(exits).toEqual([
      Exit.succeed([
        [128, true],
        [0, false],
      ]),
      Exit.succeed([0, 128]),
    ])
    const linksOf = (name: string) => spanNamed(spans, name).map((span) => span.links.length)
    expect(linksOf('Probe.endless')).toEqual([128])
    expect(linksOf('Probe.unsized')).toEqual([])
    expect(linksOf('Probe.added')).toEqual([128])
    expect(text).not.toContain(PRIVATE)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect(
  'files a line under its trace whether or not its span is sampled, and under no id that is not one',
  () =>
    Effect.gen(function* () {
      const { collect, flush, run } = yield* observed(plain)
      // A line under a span that is not sampled, whose parent is: the trace is exported, so the
      // line belongs to it although its own span is not.
      const quiet = Effect.fn('Probe.parent')(function* () {
        const parent = yield* Effect.currentSpan
        yield* Effect.logInfo(Message.failure).pipe(
          Effect.withSpan('Probe.quiet', { sampled: false }),
          Effect.provideService(Logger.CurrentLoggers, yield* exportersOnly()),
        )
        return parent.traceId
      })
      // Lines directly under a caller's span whose trace id is not one: text, one digit short, and
      // all zero.
      const malformed = ['not-a-trace-id', '0af7651916cd43dd8448eb211c80319', '0'.repeat(32)]
      const stray = Effect.fn('Probe.stray')(function* () {
        const loggers = yield* exportersOnly()
        yield* Effect.forEach(malformed, (traceId) =>
          Effect.logInfo(Message.defect).pipe(
            Effect.withParentSpan(Tracer.externalSpan({ traceId, spanId: 'a2fb4a1d1a96d312' })),
            Effect.provideService(Logger.CurrentLoggers, loggers),
          ),
        )
        return 'done'
      })
      const [first, second] = [yield* run(quiet()), yield* run(stray())]
      yield* flush
      const { lines, spans } = yield* collect()

      const [parent] = spanNamed(spans, 'Probe.parent')
      expect(parent === undefined ? '' : parent.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(first).toEqual(Exit.succeed(parent === undefined ? '' : parent.traceId))
      expect(second).toEqual(Exit.succeed('done'))
      // The unsampled span itself did not leave; the line under it did, in its parent's trace.
      expect(spanNamed(spans, 'Probe.quiet')).toEqual([])
      const tracesOf = (body: string) =>
        lines.filter((line) => line.body.stringValue === body).map((line) => line.traceId)
      expect(tracesOf(Message.failure)).toEqual([parent === undefined ? '' : parent.traceId])
      expect(tracesOf(Message.defect)).toEqual(malformed.map(() => undefined))
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('exports a line logged with a cause that cannot be read, and the log call succeeds', () =>
  Effect.gen(function* () {
    const { collect, flush, run } = yield* observed(plain)
    const log = Effect.fn('Probe.logged')(function* ({ kind, value }: HostileCase) {
      // Effect's own loggers render a logged cause themselves, with or without export, so they
      // are left out: what is under test is what the exporter's logger adds.
      yield* Effect.logError(
        Message.defect,
        kind === 'Fail' ? Cause.fail(value) : Cause.die(value),
      ).pipe(Effect.provideService(Logger.CurrentLoggers, yield* exportersOnly()))
      return 'done'
    })
    const exits = yield* Effect.forEach(hostileCases, (entry) => run(log(entry)))
    yield* flush
    const { lines, text } = yield* collect()

    expect(exits).toEqual(hostileCases.map(() => Exit.succeed('done')))
    const logged = lines.filter((line) => line.body.stringValue === Message.defect)
    expect(logged.map((line) => valuesOf(line.attributes))).toEqual(hostileCases.map(() => ({})))
    expect(text).not.toContain(PRIVATE)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

/**
 * A failure of a class declared with `Schema.TaggedError` under a tag that is given, not written:
 * what a dependency building error classes from text it was handed would do, and what the cap
 * bounds.
 */
const declared = (tag: string, cause: Declared['cause']): Declared =>
  new (Schema.TaggedError<Declared>()(tag, { cause: Schema.Unknown }))({ cause })

/** The attributes of every failure line, in the order the lines were written. */
const failureLines = (
  lines: ReadonlyArray<{ readonly attributes: ReadonlyArray<typeof Pair.Type> }>,
) =>
  lines.flatMap((line) => {
    const values = valuesOf(line.attributes)
    return 'vivid.boundary' in values ? [values] : []
  })

it.effect('names at most 256 failure types in one process, spans and lines together', () =>
  Effect.gen(function* () {
    const { collect, flush, run } = yield* observed(plain)
    // Recorded with no span of the exporter's current: the type is on a log line and no span.
    const logged = (failure: Declared | Foreign) =>
      Effect.exit(Effect.fail(failure).pipe(observeFailures('rpc')))
    // Recorded with no logger installed: the type is on a span and no log line.
    const traced = Effect.fn('Probe.traced')(function* (failure: Declared | Foreign) {
      return yield* Effect.fail(failure)
    }, observeFailures('rpc'))
    const tracedOnly = (failure: Declared | Foreign) =>
      Effect.exit(traced(failure)).pipe(Effect.provideService(Logger.CurrentLoggers, new Set()))
    const tags = Array.from({ length: MOST_TYPE_NAMES }, (_, index) => `Bulk${index}`)

    // `_OTHER` first, on both signals, and then one name for every place: the even ones on spans
    // only, the odd ones on lines only. Were `_OTHER` to take a place, the last name would not
    // fit. The flush serializes both signals, in whichever order, with every place then taken.
    yield* run(
      Effect.gen(function* () {
        yield* tracedOnly(new Foreign('unnamed'))
        yield* logged(new Foreign('unnamed'))
        yield* Effect.forEach(tags, (tag, index) =>
          index % 2 === 0 ? tracedOnly(declared(tag, undefined)) : logged(declared(tag, undefined)),
        )
      }),
    )
    yield* flush
    // A name that arrives after that, on a span and on a line. Half the admitted names came from
    // each signal, so a signal with a budget of its own would still have room for these. Then
    // admitted names again, each on the signal that did not admit it, and as a root.
    yield* run(
      Effect.gen(function* () {
        yield* tracedOnly(declared('Late', undefined))
        yield* tracedOnly(declared('Bulk1', undefined))
        yield* logged(declared('Later', undefined))
        yield* logged(declared('Bulk0', declared('Latest', undefined)))
        yield* logged(declared('Bulk2', declared('Bulk1', undefined)))
      }),
    )
    yield* flush
    const { lines, spans } = yield* collect()

    const onSpans = spanNamed(spans, 'Probe.traced').map(
      (span) => valuesOf(span.attributes)['error.type'],
    )
    const onLines = failureLines(lines).map((values) => [
      values['error.type'],
      values['vivid.failure.root'],
    ])
    const even = tags.filter((_, index) => index % 2 === 0)
    const odd = tags.filter((_, index) => index % 2 === 1)
    expect(onSpans).toEqual(['_OTHER', ...even, '_OTHER', 'Bulk1'])
    expect(onLines).toEqual([
      ['_OTHER', undefined],
      ...odd.map((tag) => [tag, undefined]),
      ['_OTHER', undefined],
      ['Bulk0', '_OTHER'],
      ['Bulk2', 'Bulk1'],
    ])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('exports at most 64 database codes in one process, and none after that', () =>
  Effect.gen(function* () {
    const refused = (code: string) =>
      Effect.exit(
        Effect.fail(
          new ProbeWrapped({ cause: Object.assign(new Error('refused'), { code }) }),
        ).pipe(observeFailures('rpc')),
      )
    const codes = Array.from({ length: MOST_DATABASE_CODES + 1 }, (_, index) =>
      String(index).padStart(5, '0'),
    )
    const { lines } = yield* exported(
      Effect.forEach([...codes, '00000'], refused, { discard: true }),
    )

    // The 65th distinct code is left off its line; one admitted before it still passes.
    expect(failureLines(lines).map((values) => values['db.response.status_code'])).toEqual([
      ...codes.slice(0, MOST_DATABASE_CODES),
      undefined,
      '00000',
    ])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('posts nothing when export is disabled', () =>
  Effect.gen(function* () {
    const { posts, routes } = yield* receiving(answered)
    yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true }))
    const refuse = Effect.fn('Probe.refuse')(function* () {
      return yield* new ProbeRefused({ message: 'not today' })
    }, observeFailures('rpc'))
    yield* Effect.scoped(
      Effect.exit(refuse()).pipe(
        Effect.provide(observabilityLayer(ObservabilityConfiguration.Disabled())),
      ),
    )
    expect(yield* Ref.get(posts)).toEqual([])
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)
