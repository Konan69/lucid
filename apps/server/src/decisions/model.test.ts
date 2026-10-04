import * as TestClock from 'effect/testing/TestClock'
import { expect, it } from '@effect/vitest'
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Logger, Predicate, Schema } from 'effect'
import { AiError, Decision, DecisionModel } from 'effect/unstable/ai'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http'
import {
  decide,
  decideWithin,
  decisionConfigured,
  DecisionUnavailable,
  decisionModelLayer,
  GATEWAY_URL,
} from './model.ts'

const definition = Decision.make({
  input: Schema.String,
  decisions: {
    applies: Decision.probability({
      instructions: 'Applies',
      criteria: { false: 'No', true: 'Yes' },
    }),
  },
})

/** The switch and the provider are chosen through the real library adapter and real Config.
 * The transport records no secret values. */
it.effect.each([
  { config: { VIVID_DECISIONS: 'on', EXPLABS_API_KEY: 'test' }, model: 'jev-latest' },
  {
    config: { VIVID_DECISIONS: 'on', EXPLABS_API_KEY: 'test', VIVID_DECISION_MODEL: 'custom' },
    model: 'custom',
  },
])('switched on, asks the gateway for model $model', ({ config, model }) => {
  const urls: string[] = []
  const bodies: string[] = []
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      urls.push(request.url)
      const body = request.body
      if (Predicate.isTagged(body, 'Uint8Array')) bodies.push(new TextDecoder().decode(body.body))
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({ model, answers: { applies: { type: 'noul', noul: 0.7 } } }),
          ),
        ),
      )
    }),
  )
  return Effect.gen(function* () {
    expect((yield* decide(definition, 'question')).answers.applies.probability).toBe(0.7)
    expect(yield* decisionConfigured).toBe(true)
    expect(urls).toEqual([`${GATEWAY_URL}/systemone`])
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(model)
  }).pipe(
    Effect.provide(
      decisionModelLayer.pipe(
        Layer.provide(transport),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      ),
    ),
  )
})

/** Off is the default and wins over a present key; on without a key is a different fact. Neither
 * makes a request, and neither writes a line per decision. */
it.effect.each([
  { name: 'by default', config: { EXPLABS_API_KEY: 'test' }, reason: 'Disabled' },
  {
    name: 'when switched off',
    config: { VIVID_DECISIONS: 'off', EXPLABS_API_KEY: 'test' },
    reason: 'Disabled',
  },
  { name: 'when on with no key', config: { VIVID_DECISIONS: 'on' }, reason: 'Unconfigured' },
] as const)('$name every decision fails at once as $reason, silently', ({ config, reason }) => {
  const lines: Array<unknown> = []
  const logger = Logger.make(({ message }) => {
    lines.push(message)
  })
  return Effect.gen(function* () {
    const first = yield* Effect.flip(decide(definition, 'one'))
    const second = yield* Effect.flip(decideWithin(definition, 'two', '1 second'))
    expect(first).toBeInstanceOf(DecisionUnavailable)
    expect(first.reason).toBe(reason)
    expect(second.reason).toBe(reason)
    expect(yield* decisionConfigured).toBe(false)
    // One line at start says the state; a decision that was never asked is not an event.
    expect(lines).toHaveLength(1)
  }).pipe(
    Effect.provide(
      decisionModelLayer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die('Unexpected HTTP')),
          ),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      ),
    ),
    Effect.provide(Logger.layer([logger])),
  )
})

/** A fault inside the provider call is an unavailable decision, never a dead caller. */
it.effect('a defect in the provider call is a typed Provider failure', () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decide(definition, 'question'))
    expect(error).toBeInstanceOf(DecisionUnavailable)
    expect(error.reason).toBe('Provider')
  }).pipe(
    Effect.provide(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({ decide: () => Effect.die('library fault') }),
      ),
    ),
  ),
)

/** Provider payloads stop at the decision boundary, including validation failures. */
it.effect('provider failure exposes only a typed unavailable reason', () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decide(definition, 'private input'))
    expect(error).toBeInstanceOf(DecisionUnavailable)
    expect(error.reason).toBe('Provider')
    expect(JSON.stringify(error)).not.toContain('private')
  }).pipe(
    Effect.provide(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: () =>
            Effect.fail(
              AiError.make({
                module: 'Test',
                method: 'decide',
                reason: new AiError.InvalidOutputError({ description: 'private provider payload' }),
              }),
            ),
        }),
      ),
    ),
  ),
)

/** Controllable time proves both budgets without wall-clock sleeps. */
it.effect.each(['10 seconds', '1200 millis'] as const)('bounds a stalled request at %s', (budget) =>
  Effect.gen(function* () {
    const pending = yield* (
      budget === '10 seconds'
        ? decide(definition, 'question')
        : decideWithin(definition, 'question', budget)
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust(budget)
    const error = yield* Effect.flip(Fiber.join(pending))
    expect(error).toBeInstanceOf(DecisionUnavailable)
    expect(error.reason).toBe('TimedOut')
  }).pipe(
    Effect.provide(
      Layer.effect(DecisionModel.DecisionModel, DecisionModel.make({ decide: () => Effect.never })),
    ),
  ),
)

/** The real gateway Layer owns availability, so every differently-budgeted caller shares one gate.
 * Only the HTTP seam is scripted; provider validation and the production gate both run. */
const configuredGateway = (transport: Layer.Layer<HttpClient.HttpClient>) =>
  decisionModelLayer.pipe(
    Layer.provide(transport),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          VIVID_DECISIONS: 'on',
          EXPLABS_API_KEY: 'test',
        }),
      ),
    ),
  )

/** A failed request cools every caller for thirty seconds, then permits one probe. Pending
 * probes reject siblings immediately; success closes the gate and resumes normal concurrency. */
it.effect('shares provider backoff and admits only one successful recovery probe', () =>
  Effect.gen(function* () {
    let requests = 0
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const lines: Array<unknown> = []
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(
        Effect.fn('Test.gateway')(function* (request) {
          requests += 1
          if (requests === 1)
            return HttpClientResponse.fromWeb(request, new Response('{}', { status: 503 }))
          if (requests === 2) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                model: 'jev-latest',
                answers: { applies: { type: 'noul', noul: 0.7 } },
              }),
            ),
          )
        }),
      ),
    )
    yield* Effect.gen(function* () {
      expect((yield* Effect.flip(decide(definition, 'first'))).reason).toBe('Provider')
      expect(
        (yield* Effect.flip(decideWithin(definition, 'other caller', '1 second'))).reason,
      ).toBe('Backoff')
      yield* TestClock.adjust('29 seconds')
      expect((yield* Effect.flip(decide(definition, 'still cooling'))).reason).toBe('Backoff')
      expect(requests).toBe(1)
      yield* TestClock.adjust('1 second')
      const probe = yield* decide(definition, 'probe').pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const siblings = yield* Effect.forEach(
        [1, 2, 3],
        () => Effect.flip(decide(definition, 'sibling')),
        { concurrency: 3 },
      )
      expect(siblings.map((error) => error.reason)).toEqual(['Backoff', 'Backoff', 'Backoff'])
      expect(requests).toBe(2)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(probe)).answers.applies.probability).toBe(0.7)
      expect((yield* decide(definition, 'recovered')).answers.applies.probability).toBe(0.7)
      const transitions = lines.filter((line) =>
        JSON.stringify(line).includes('Decision availability backoff'),
      )
      expect(transitions).toHaveLength(2)
      expect(JSON.stringify(transitions)).toContain('Opened')
      expect(JSON.stringify(transitions)).toContain('Closed')
      // Configuration, three actual attempts and two transitions; gated calls log nothing.
      expect(lines).toHaveLength(6)
    }).pipe(
      Effect.provide(configuredGateway(transport)),
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            lines.push(message)
          }),
        ]),
      ),
    )
  }),
)

/** One short optional timeout cannot penalize every tenant. Two consecutive stalls open
 * admission; the recovery probe is capped at two seconds even for a ten-second caller. */
it.effect('requires two timeouts and caps a failed recovery probe at two seconds', () => {
  let requests = 0
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => {
      requests += 1
      return Effect.never
    }),
  )
  return Effect.gen(function* () {
    for (const attempt of [1, 2]) {
      const pending = yield* decideWithin(definition, 'stall', '100 millis').pipe(Effect.forkChild)
      yield* TestClock.adjust('100 millis')
      expect((yield* Effect.flip(Fiber.join(pending))).reason).toBe('TimedOut')
      expect(requests).toBe(attempt)
    }
    expect((yield* Effect.flip(decide(definition, 'blocked'))).reason).toBe('Backoff')
    yield* TestClock.adjust('30 seconds')
    const probe = yield* decide(definition, 'ten second caller').pipe(Effect.forkChild)
    yield* TestClock.adjust('2 seconds')
    expect((yield* Effect.flip(Fiber.join(probe))).reason).toBe('TimedOut')
    expect(requests).toBe(3)
    expect((yield* Effect.flip(decide(definition, 'fresh window'))).reason).toBe('Backoff')
  }).pipe(Effect.provide(configuredGateway(transport)))
})

/** HTTP status is classified before library errors are flattened. Invalid requests affect
 * only their caller; explicit provider outages immediately suppress sibling requests. */
it.effect.each([
  { status: 400, next: 'Provider', requests: 2 },
  { status: 401, next: 'Provider', requests: 2 },
  { status: 503, next: 'Backoff', requests: 1 },
  { status: 429, next: 'Backoff', requests: 1 },
])('HTTP $status gives the next caller $next', ({ status, next, requests }) => {
  let calls = 0
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{}', { status })))
    }),
  )
  return Effect.gen(function* () {
    expect((yield* Effect.flip(decide(definition, 'first'))).reason).toBe('Provider')
    expect((yield* Effect.flip(decide(definition, 'second'))).reason).toBe(next)
    expect(calls).toBe(requests)
  }).pipe(Effect.provide(configuredGateway(transport)))
})

/** Malformed successful responses demonstrate reachability, not a global outage. */
it.effect('malformed answers do not open the process gate', () => {
  let calls = 0
  return Effect.gen(function* () {
    for (const input of ['first', 'second'])
      expect((yield* Effect.flip(decide(definition, input))).reason).toBe('Provider')
    expect(calls).toBe(2)
  }).pipe(
    Effect.provide(
      configuredGateway(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            calls += 1
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{}')))
          }),
        ),
      ),
    ),
  )
})

/** Interrupting the sole probe must release its lease. The next request still cools briefly,
 * then may probe again instead of being gated forever. */
it.effect('an interrupted recovery probe cannot leave availability stuck', () =>
  Effect.gen(function* () {
    let requests = 0
    const started = yield* Deferred.make<void>()
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests += 1
        if (requests === 2)
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('{}', { status: 503 })),
        )
      }),
    )
    yield* Effect.gen(function* () {
      yield* Effect.flip(decide(definition, 'first'))
      yield* TestClock.adjust('30 seconds')
      const probe = yield* decide(definition, 'interrupted probe').pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(probe)
      expect((yield* Effect.flip(decide(definition, 'cooling'))).reason).toBe('Backoff')
      yield* TestClock.adjust('30 seconds')
      expect((yield* Effect.flip(decide(definition, 'new probe'))).reason).toBe('Provider')
      expect(requests).toBe(3)
    }).pipe(Effect.provide(configuredGateway(transport)))
  }),
)

/** A concurrent success predating the outage is not a recovery probe. Letting it close the gate
 * would make every burst repeat the full timeout even while other requests remain unhealthy. */
it.effect('an older in-flight success cannot close newly opened backoff', () =>
  Effect.gen(function* () {
    let requests = 0
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(
        Effect.fn('Test.olderSuccess')(function* (request) {
          requests += 1
          if (requests === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  model: 'jev-latest',
                  answers: { applies: { type: 'noul', noul: 0.7 } },
                }),
              ),
            )
          }
          return HttpClientResponse.fromWeb(request, new Response('{}', { status: 503 }))
        }),
      ),
    )
    yield* Effect.gen(function* () {
      const older = yield* decide(definition, 'older').pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect((yield* Effect.flip(decide(definition, 'outage'))).reason).toBe('Provider')
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(older)).answers.applies.probability).toBe(0.7)
      expect((yield* Effect.flip(decide(definition, 'still cooling'))).reason).toBe('Backoff')
      expect(requests).toBe(2)
    }).pipe(Effect.provide(configuredGateway(transport)))
  }),
)

/** The provider maps encoding/URL faults into NetworkError too. Only its TransportError
 * reason means an outage; neither local encoding nor a defect can close sibling admission. */
it.effect.each(['TransportError', 'EncodeError', 'Defect'] as const)(
  '%s controls only the appropriate admission scope',
  (failure) => {
    let calls = 0
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        calls += 1
        if (failure === 'Defect') return Effect.die('adapter fault')
        const reason =
          failure === 'TransportError'
            ? new HttpClientError.TransportError({ request })
            : new HttpClientError.EncodeError({ request })
        return Effect.fail(new HttpClientError.HttpClientError({ reason }))
      }),
    )
    return Effect.gen(function* () {
      expect((yield* Effect.flip(decide(definition, 'first'))).reason).toBe('Provider')
      expect((yield* Effect.flip(decide(definition, 'second'))).reason).toBe(
        failure === 'TransportError' ? 'Backoff' : 'Provider',
      )
      expect(calls).toBe(failure === 'TransportError' ? 1 : 2)
    }).pipe(Effect.provide(configuredGateway(transport)))
  },
)
