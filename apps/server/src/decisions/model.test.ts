import * as TestClock from 'effect/testing/TestClock'
import { expect, it } from '@effect/vitest'
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Logger, Predicate, Schema } from 'effect'
import { AiError, Decision, DecisionModel } from 'effect/unstable/ai'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http'
import {
  decide,
  decideWithin,
  decisionConfigured,
  isDecisionNonEvent,
  decisionWouldAttempt,
  DECISION_OUTAGE_MINIMUM_MILLIS,
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
    expect(yield* decisionWouldAttempt).toBe(true)
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
    expect(yield* decisionWouldAttempt).toBe(false)
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
      // Preflight observes admission without transport or a lease. Repeated
      // observations after cooling below must still leave the real probe free.
      expect(yield* decisionWouldAttempt).toBe(true)
      expect(requests).toBe(0)
      expect((yield* Effect.flip(decide(definition, 'first'))).reason).toBe('Provider')
      expect(
        (yield* Effect.flip(decideWithin(definition, 'other caller', '1 second'))).reason,
      ).toBe('Backoff')
      expect(yield* decisionWouldAttempt).toBe(false)
      yield* TestClock.adjust('29 seconds')
      expect((yield* Effect.flip(decide(definition, 'still cooling'))).reason).toBe('Backoff')
      expect(requests).toBe(1)
      yield* TestClock.adjust('1 second')
      for (const inspection of [1, 2, 3]) {
        void inspection
        expect(yield* decisionWouldAttempt).toBe(true)
      }
      expect(requests).toBe(1)
      const probe = yield* decide(definition, 'probe').pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(yield* decisionWouldAttempt).toBe(false)
      const siblings = yield* Effect.forEach(
        [1, 2, 3],
        () => Effect.flip(decide(definition, 'sibling')),
        { concurrency: 3 },
      )
      expect(siblings.map((error) => error.reason)).toEqual(['Backoff', 'Backoff', 'Backoff'])
      expect(requests).toBe(2)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(probe)).answers.applies.probability).toBe(0.7)
      expect(yield* decisionWouldAttempt).toBe(true)
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

/** One short optional timeout cannot penalize every tenant. Two calibrated stalls open
 * admission; the recovery probe has its own 2500ms budget even for a short caller. */
it.effect('requires calibrated timeouts and gives a recovery probe its own budget', () => {
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
      const pending = yield* decideWithin(definition, 'stall', DECISION_OUTAGE_MINIMUM_MILLIS).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust(DECISION_OUTAGE_MINIMUM_MILLIS)
      expect((yield* Effect.flip(Fiber.join(pending))).reason).toBe('TimedOut')
      expect(requests).toBe(attempt)
    }
    expect((yield* Effect.flip(decide(definition, 'blocked'))).reason).toBe('Backoff')
    yield* TestClock.adjust('30 seconds')
    const probe = yield* decideWithin(definition, 'short caller', '100 millis').pipe(
      Effect.forkChild,
    )
    yield* TestClock.adjust('100 millis')
    expect((yield* Effect.flip(Fiber.join(probe))).reason).toBe('TimedOut')
    expect(requests).toBe(3)
    expect(yield* decisionWouldAttempt).toBe(false)
    yield* TestClock.adjust('2400 millis')
    expect((yield* Effect.flip(decide(definition, 'fresh window'))).reason).toBe('Backoff')
  }).pipe(Effect.provide(configuredGateway(transport)))
})

/** HTTP status is classified before library errors are flattened. Invalid requests affect
 * only their caller; explicit provider outages immediately suppress sibling requests. */
it.effect.each([
  { status: 400, next: 'Provider', requests: 2 },
  { status: 401, next: 'Backoff', requests: 1 },
  { status: 403, next: 'Provider', requests: 2 },
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
    expect((yield* Effect.flip(decide(definition, 'first'))).reason).toBe(
      status === 401 ? 'Authentication' : 'Provider',
    )
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

/** Caller interruption abandons only its wait. The bounded Layer-owned probe
 * keeps its lease until its independent timeout, then releases into cooling. */
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
      yield* TestClock.adjust('2500 millis')
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

/** Two concurrent requests share one slow moment. Only a later admitted attempt can
 * corroborate suspicion; this crosses the real gateway admission and timeout boundary. */
it.effect('concurrent timeouts do not open admission without a later attempt', () =>
  Effect.gen(function* () {
    let calls = 0
    const started = yield* Deferred.make<void>()
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        calls += 1
        return (calls === 2 ? Deferred.succeed(started, undefined) : Effect.void).pipe(
          Effect.andThen(Effect.never),
        )
      }),
    )
    yield* Effect.gen(function* () {
      const burst = yield* Effect.forEach(
        [1, 2],
        () => Effect.flip(decideWithin(definition, 'burst', DECISION_OUTAGE_MINIMUM_MILLIS)),
        { concurrency: 'unbounded' },
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust(DECISION_OUTAGE_MINIMUM_MILLIS)
      expect((yield* Fiber.join(burst)).map((error) => error.reason)).toEqual([
        'TimedOut',
        'TimedOut',
      ])
      const later = yield* decideWithin(definition, 'later', DECISION_OUTAGE_MINIMUM_MILLIS).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust(DECISION_OUTAGE_MINIMUM_MILLIS)
      expect((yield* Effect.flip(Fiber.join(later))).reason).toBe('TimedOut')
      expect(calls).toBe(3)
      expect((yield* Effect.flip(decide(definition, 'gated'))).reason).toBe('Backoff')
    }).pipe(Effect.provide(configuredGateway(transport)))
  }),
)

/** A suspicion mark has a lifetime, not a permanent process-wide timeout counter. */
it.effect('expired suspicion cannot corroborate a later isolated timeout', () => {
  let calls = 0
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls += 1
      if (calls <= 2) return Effect.never
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              model: 'jev-latest',
              answers: { applies: { type: 'noul', noul: 0.7 } },
            }),
          ),
        ),
      )
    }),
  )
  return Effect.gen(function* () {
    for (const attempt of [1, 2]) {
      if (attempt === 2) yield* TestClock.adjust('30 seconds')
      const pending = yield* decideWithin(
        definition,
        'isolated stall',
        DECISION_OUTAGE_MINIMUM_MILLIS,
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(DECISION_OUTAGE_MINIMUM_MILLIS)
      expect((yield* Effect.flip(Fiber.join(pending))).reason).toBe('TimedOut')
    }
    expect((yield* decide(definition, 'reachable')).answers.applies.probability).toBe(0.7)
    expect(calls).toBe(3)
  }).pipe(Effect.provide(configuredGateway(transport)))
})

/** A success between two timeouts breaks the streak through the public decision API. */
it.effect('a success between timeouts resets the evidence', () => {
  let calls = 0
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls += 1
      if (calls === 1 || calls === 3) return Effect.never
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              model: 'jev-latest',
              answers: { applies: { type: 'noul', noul: 0.7 } },
            }),
          ),
        ),
      )
    }),
  )
  return Effect.gen(function* () {
    for (const attempt of [1, 2]) {
      void attempt
      const pending = yield* decideWithin(definition, 'stall', DECISION_OUTAGE_MINIMUM_MILLIS).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust(DECISION_OUTAGE_MINIMUM_MILLIS)
      expect((yield* Effect.flip(Fiber.join(pending))).reason).toBe('TimedOut')
      expect((yield* decide(definition, 'success')).answers.applies.probability).toBe(0.7)
    }
    expect(calls).toBe(4)
  }).pipe(Effect.provide(configuredGateway(transport)))
})

/** A revoked key produces one actionable error per credential window, with no per-action
 * caller warning. Unauthorized maps to InvalidKey in the pinned AiError source;
 * payload-specific forbidden responses have a separate caller-local test. */
it.effect.each([401])('HTTP %s closes credentials for five minutes with one error', (status) => {
  let calls = 0
  const lines: { readonly level: string; readonly message: string }[] = []
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{}', { status })))
    }),
  )
  return Effect.gen(function* () {
    expect((yield* Effect.flip(decide(definition, 'rejected'))).reason).toBe('Authentication')
    for (let index = 0; index < 20; index += 1)
      expect((yield* Effect.flip(decide(definition, 'gated'))).reason).toBe('Backoff')
    yield* TestClock.adjust('4 minutes')
    expect((yield* Effect.flip(decide(definition, 'still gated'))).reason).toBe('Backoff')
    expect(calls).toBe(1)
    const errors = lines.filter((line) => line.level === 'Error')
    expect(errors).toHaveLength(1)
    expect(errors.map((line) => line.message).join()).toContain('Decision authentication rejected')
    expect(lines.filter((line) => line.level === 'Warn')).toHaveLength(0)
    yield* TestClock.adjust('1 minute')
    expect((yield* Effect.flip(decide(definition, 'new window'))).reason).toBe('Authentication')
    expect(calls).toBe(2)
    expect(lines.filter((line) => line.level === 'Error')).toHaveLength(2)
  }).pipe(
    Effect.provide(configuredGateway(transport)),
    Effect.provide(
      Logger.layer([
        Logger.make(({ logLevel, message }) => {
          lines.push({ level: logLevel, message: JSON.stringify(message) })
        }),
      ]),
    ),
  )
})

/** Repeated exhausted discovery budgets cannot become evidence about all tenants.
 * Only the caller's deadline is crossed; a subsequent healthy request still runs. */
it.effect('short-budget timeouts do not corroborate process-wide outage', () => {
  let calls = 0
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls += 1
      if (calls <= 3) return Effect.never
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              model: 'jev-latest',
              answers: { applies: { type: 'noul', noul: 0.7 } },
            }),
          ),
        ),
      )
    }),
  )
  return Effect.gen(function* () {
    for (const attempt of [1, 2, 3]) {
      const pending = yield* decideWithin(definition, 'short remainder', '850 millis').pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust('850 millis')
      expect((yield* Effect.flip(Fiber.join(pending))).reason).toBe('TimedOut')
      expect(calls).toBe(attempt)
    }
    expect((yield* decide(definition, 'healthy')).answers.applies.probability).toBe(0.7)
    expect(calls).toBe(4)
  }).pipe(Effect.provide(configuredGateway(transport)))
})

/** A recovery request admitted by a short-budget caller must have enough time to
 * establish reachability; the caller's budget cannot cause perpetual backoff. */
it.effect.each([100, 1800, 2000])('a healthy probe outlives a %sms caller budget', (budget) =>
  Effect.gen(function* () {
    let calls = 0
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const settled = yield* Deferred.make<void>()
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(
        Effect.fn('Test.probeBudget')(function* (request) {
          calls += 1
          if (calls === 1)
            return HttpClientResponse.fromWeb(request, new Response('{}', { status: 503 }))
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
        }),
      ),
    )
    yield* Effect.gen(function* () {
      yield* Effect.flip(decide(definition, 'outage'))
      yield* TestClock.adjust('30 seconds')
      const pending = yield* decideWithin(definition, 'probe', budget).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust(budget)
      expect((yield* Effect.flip(Fiber.join(pending))).reason).toBe('TimedOut')
      expect(yield* decisionWouldAttempt).toBe(false)
      yield* TestClock.adjust('400 millis')
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(settled)
      expect(yield* decisionWouldAttempt).toBe(true)
      expect((yield* decide(definition, 'recovered')).answers.applies.probability).toBe(0.7)
      expect(calls).toBe(3)
    }).pipe(
      Effect.provide(configuredGateway(transport)),
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            if (JSON.stringify(message).includes('Closed'))
              Deferred.doneUnsafe(settled, Effect.void)
          }),
        ]),
      ),
    )
  }),
)

/** A filter may reject one tool description with 403. It proves reachability,
 * including during recovery; it cannot re-open a process credential window. */
it.effect('a forbidden recovery payload releases the outage gate for other callers', () => {
  let calls = 0
  const statuses = [503, 403, 200]
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const status = statuses[calls]
      calls += 1
      if (status === undefined) return Effect.die('Unexpected request')
      const body =
        status === 200
          ? JSON.stringify({
              model: 'jev-latest',
              answers: { applies: { type: 'noul', noul: 0.7 } },
            })
          : '{}'
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })))
    }),
  )
  return Effect.gen(function* () {
    expect((yield* Effect.flip(decide(definition, 'outage'))).reason).toBe('Provider')
    yield* TestClock.adjust('30 seconds')
    expect((yield* Effect.flip(decide(definition, 'forbidden payload'))).reason).toBe('Provider')
    expect((yield* decide(definition, 'different payload')).answers.applies.probability).toBe(0.7)
    expect(calls).toBe(3)
  }).pipe(Effect.provide(configuredGateway(transport)))
})

/** Recovery is background work, but never process-root work. Closing the model
 * Layer interrupts the actual HTTP attempt after its initiating wait has ended. */
it.effect('Layer shutdown interrupts a detached recovery probe', () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    let calls = 0
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        calls += 1
        if (calls === 1)
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response('{}', { status: 503 })),
          )
        return Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
        )
      }),
    )
    yield* Effect.gen(function* () {
      yield* Effect.flip(decide(definition, 'outage'))
      yield* TestClock.adjust('30 seconds')
      const pending = yield* decideWithin(definition, 'probe', '100 millis').pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust('100 millis')
      expect((yield* Effect.flip(Fiber.join(pending))).reason).toBe('TimedOut')
    }).pipe(Effect.provide(configuredGateway(transport)))
    yield* Deferred.await(stopped)
    expect(calls).toBe(2)
  }),
)

/** A gateway rejecting every payload must not flood caller warnings, but a 403
 * cannot suppress another payload's attempt. Clock controls the log interval. */
it.effect('persistent 403 responses warn once per minute without closing admission', () => {
  let calls = 0
  const warnings: string[] = []
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls += 1
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response('{}', { status: 403 })),
      )
    }),
  )
  return Effect.gen(function* () {
    for (const attempt of [1, 2, 3]) {
      void attempt
      const error = yield* Effect.flip(decide(definition, 'forbidden'))
      expect(error.reason).toBe('Provider')
      expect(isDecisionNonEvent(error)).toBe(true)
      expect(yield* decisionWouldAttempt).toBe(true)
    }
    expect(calls).toBe(3)
    expect(warnings).toHaveLength(1)
    yield* TestClock.adjust('59 seconds')
    yield* Effect.flip(decide(definition, 'same interval'))
    expect(warnings).toHaveLength(1)
    yield* TestClock.adjust('1 second')
    yield* Effect.flip(decide(definition, 'next interval'))
    expect(warnings).toHaveLength(2)
    expect(warnings.every((line) => line.includes('Decision permission rejected'))).toBe(true)
    expect(calls).toBe(5)
  }).pipe(
    Effect.provide(configuredGateway(transport)),
    Effect.provide(
      Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === 'Warn') warnings.push(JSON.stringify(message))
        }),
      ]),
    ),
  )
})

/** A caller's outer reviewer deadline can interrupt HTTP before the decision's
 * own timer fires. Long observed silence must mark Suspect, so one later
 * independently admitted stall opens the gate; brief cancellation must not. */
it.effect.each([
  { elapsed: 500, suspected: false },
  { elapsed: 2199, suspected: false },
  { elapsed: 2200, suspected: true },
  { elapsed: 2300, suspected: true },
])('interruption after $elapsed ms contributes suspicion: $suspected', ({ elapsed, suspected }) =>
  Effect.gen(function* () {
    let calls = 0
    const started = yield* Deferred.make<void>()
    const laterStarted = yield* Deferred.make<void>()
    const transport = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        calls += 1
        if (calls <= 2)
          return Deferred.succeed(calls === 1 ? started : laterStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          )
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                model: 'jev-latest',
                answers: { applies: { type: 'noul', noul: 0.7 } },
              }),
            ),
          ),
        )
      }),
    )
    yield* Effect.gen(function* () {
      const pending = yield* decide(definition, 'caller interrupted').pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust(elapsed)
      yield* Fiber.interrupt(pending)
      expect(yield* decisionWouldAttempt).toBe(true)
      const later = yield* decideWithin(
        definition,
        'independent stall',
        DECISION_OUTAGE_MINIMUM_MILLIS,
      ).pipe(Effect.forkChild)
      yield* Deferred.await(laterStarted)
      yield* TestClock.adjust(DECISION_OUTAGE_MINIMUM_MILLIS)
      expect((yield* Effect.flip(Fiber.join(later))).reason).toBe('TimedOut')
      if (suspected) {
        expect(yield* decisionWouldAttempt).toBe(false)
        expect((yield* Effect.flip(decide(definition, 'gated'))).reason).toBe('Backoff')
        expect(calls).toBe(2)
      } else {
        expect(yield* decisionWouldAttempt).toBe(true)
        expect((yield* decide(definition, 'healthy')).answers.applies.probability).toBe(0.7)
        expect(calls).toBe(3)
      }
    }).pipe(Effect.provide(configuredGateway(transport)))
  }),
)
