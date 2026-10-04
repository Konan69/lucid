import {
  Cause,
  Clock,
  Config,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from 'effect'
import { AiError, Decision, DecisionModel } from 'effect/unstable/ai'
import { TypeSafeClient, TypeSafeDecisionModel } from '@effect/ai-typesafe'

/** docs/22, “The trust loop”: the reviewer has ten seconds and one attempt. */
export const DECISION_TIMEOUT = '10 seconds'

/** The most questions accepted in a calibrated gateway request with headroom: twenty
 * succeeded and thirty-nine were rejected with HTTP 400 on 4 Oct 2026. This is the tested
 * payload ceiling, not an inferred provider maximum; effects, relevance and rules share it. */
export const DECISION_QUESTION_LIMIT = 20

/**
 * Vivid's model gateway, Experiential Labs. It serves TypeSafe's System One endpoint
 * (`POST /systemone`) for the Jev decision model under the same key as every other model
 * (`EXPLABS_API_KEY`), so decisions need no provider account of their own. The same address is
 * written in `packages/agent/runtime/src/providers/explabs.ts` and `memory/embeddings.ts`; the
 * server cannot import the runtime package, so this is the server's copy until they share one.
 */
export const GATEWAY_URL = 'https://api.experientiallabs.ai/v1'

/** The decision model as the gateway's `GET /models` names it. `VIVID_DECISION_MODEL` overrides it. */
export const DECISION_MODEL = 'jev-latest'

/**
 * Why a decision was not made. `Disabled` is a deliberate switch (`VIVID_DECISIONS=off`) and
 * `Unconfigured` a missing key: different facts, so different reasons. Callers treat every reason
 * alike, as "do what you would do without a decision"; `Backoff` means another caller already
 * observed a provider outage or holds the sole recovery probe. Authentication marks a rejected
 * credential, announced once by the gate; the reasons exist for logs and operators.
 * It never carries provider payloads or supplied inputs.
 */
export class DecisionUnavailable extends Schema.TaggedError<DecisionUnavailable>()(
  'DecisionUnavailable',
  {
    reason: Schema.Literals([
      'Disabled',
      'Unconfigured',
      'TimedOut',
      'Provider',
      'Backoff',
      'Authentication',
    ]),
  },
  { title: 'Decision unavailable' },
) {}

/**
 * Why a provided model cannot answer, for the models this module builds with no provider.
 *
 * Konan, 4 Oct 2026: "put the jev decision stuff behind a layer so we can flag it off for now".
 * `decisionModelLayer` is that layer. The switch position travels with the model it provides
 * rather than beside it in context: services capture the model when their Layer is built and
 * program runs pick named services out of context (`code/calls.ts`), and a separate value would
 * be lost on either path and silently read as "ready". A model that is not registered here is
 * one somebody supplied to answer (a provider, or a test's script), so it is ready.
 */
const absent = new WeakMap<DecisionModel.DecisionModel, 'Disabled' | 'Unconfigured'>()

/** True only when a decision would reach a provider. Callers use it to skip work, not to choose policy. */
export const decisionConfigured = Effect.map(
  DecisionModel.DecisionModel,
  (model) => !absent.has(model),
)

/** Deliberate absence and an already-observed outage are non-events. Callers must not
 * emit a warning per invocation for these states; the Layer and gate announce transitions. */
export const isDecisionNonEvent = (error: DecisionUnavailable): boolean =>
  nonEventReasons.has(error.reason)

const nonEventReasons = new Set<DecisionUnavailable['reason']>([
  'Disabled',
  'Unconfigured',
  'Backoff',
  'Authentication',
])

/** Thirty seconds suppresses outage traffic. A timeout alone is weak evidence: the first
 * records suspicion and only a later independently admitted timeout closes admission. Thus a single
 * 1.5-second optional request cannot impose a 30-second penalty on every tenant. */
const DECISION_BACKOFF = '30 seconds'
/** Recovery is optional work even for a ten-second trust-loop caller. Two seconds bounds
 * the sole probe; shorter caller budgets remain authoritative. */
const RECOVERY_PROBE_BUDGET = '2 seconds'
/** Suspicion is weak evidence from one bounded attempt. Thirty seconds matches the outage
 * window: an isolated slow call cannot poison a later, otherwise independent interaction. */
const DECISION_SUSPICION_MILLIS = 30_000
/** A rejected credential requires operator repair, unlike transient transport failures.
 * Five minutes reduces repeated probes tenfold versus the thirty-second outage window;
 * one error per window announces the actionable fault without warning on every action.
 * A rebuilt gateway Layer with repaired configuration starts ready immediately. */
const DECISION_AUTHENTICATION_BACKOFF_MILLIS = 300_000

/** A process-local mark survives schema construction without relying on object identity or
 * millisecond uniqueness. It is never persisted or sent to the gateway. */
const SuspicionId = Schema.Symbol.pipe(Schema.brand('DecisionSuspicionId'))

const Availability = Schema.TaggedUnion({
  Ready: {},
  Suspect: { id: SuspicionId, markedAt: Schema.Number, expiresAt: Schema.Number },
  Cooling: { retryAt: Schema.Number },
  CredentialCooling: { retryAt: Schema.Number },
  Probing: {},
})
const Admission = Schema.TaggedUnion({
  Normal: { startedAt: Schema.Number, suspicion: Schema.Option(SuspicionId) },
  Probe: {},
  Backoff: {},
})
const Outcome = Schema.TaggedUnion({
  Success: {},
  Outage: {},
  TimedOut: {},
  RequestFailure: {},
  AuthenticationFailure: {},
  Cancelled: {},
})
const Transition = Schema.TaggedUnion({ Opened: {}, Closed: {}, AuthenticationRejected: {} })
const FailureClassification = Schema.TaggedUnion({
  Outage: {},
  RequestSpecific: {},
  Authentication: {},
})

/** Preserve provider evidence until gate settlement, without exposing payloads to callers. */
class AttemptUnavailable extends Schema.TaggedError<AttemptUnavailable>()(
  'DecisionAttemptUnavailable',
  {
    classification: FailureClassification,
  },
  { title: 'Decision attempt unavailable' },
) {}

/** A timeout carries no HTTP classification: silence is weaker evidence than an outage. */
class AttemptTimedOut extends Schema.TaggedError<AttemptTimedOut>()(
  'DecisionAttemptTimedOut',
  {},
  { title: 'Decision attempt timed out' },
) {}

const ProviderReason = AiError.AiErrorReason.pipe(Schema.toTaggedUnion('_tag'))

/** rc.116 AiError.reasonFromHttpStatus maps 429/5xx to RateLimit/InternalProvider.
 * ai-typesafe internal/errors.ts maps transport AND encode/URL failures to NetworkError;
 * its reason field distinguishes actual transport from caller-specific encoding and URLs. */
const classifyProviderFailure = (error: AiError.AiError) =>
  ProviderReason.matchOrElse(
    error.reason,
    {
      AuthenticationError: () => FailureClassification.cases.Authentication.make({}),
      RateLimitError: () => FailureClassification.cases.Outage.make({}),
      InternalProviderError: () => FailureClassification.cases.Outage.make({}),
      NetworkError: (reason) =>
        reason.reason === 'TransportError'
          ? FailureClassification.cases.Outage.make({})
          : FailureClassification.cases.RequestSpecific.make({}),
    },
    () => FailureClassification.cases.RequestSpecific.make({}),
  )

/** Captured gateway models share one process-lifetime gate; independent test models do not. */
const availability = new WeakMap<DecisionModel.DecisionModel, Ref.Ref<typeof Availability.Type>>()

/** Atomic admission never queues callers behind a probe. */
const admit = Effect.fn('Decisions.admit')(function* (state: Ref.Ref<typeof Availability.Type>) {
  const now = yield* Clock.currentTimeMillis
  const normal = Admission.cases.Normal.make({ startedAt: now, suspicion: Option.none() })
  return yield* Ref.modify(
    state,
    (current): readonly [typeof Admission.Type, typeof Availability.Type] =>
      Availability.match<readonly [typeof Admission.Type, typeof Availability.Type]>(current, {
        Ready: () => [normal, current],
        Suspect: (mark) =>
          now >= mark.expiresAt
            ? [normal, Availability.cases.Ready.make({})]
            : [
                Admission.cases.Normal.make({ startedAt: now, suspicion: Option.some(mark.id) }),
                current,
              ],
        Cooling: ({ retryAt }) =>
          now < retryAt
            ? [Admission.cases.Backoff.make({}), current]
            : [Admission.cases.Probe.make({}), Availability.cases.Probing.make({})],
        CredentialCooling: ({ retryAt }) =>
          now < retryAt
            ? [Admission.cases.Backoff.make({}), current]
            : [Admission.cases.Probe.make({}), Availability.cases.Probing.make({})],
        Probing: () => [Admission.cases.Backoff.make({}), current],
      }),
  )
})

type Settlement = readonly [Option.Option<typeof Transition.Type>, typeof Availability.Type]

/** Credential rejection is a separate process state, never transport-outage evidence.
 * The transition's single error log replaces caller warnings and contains no key or payload. */
const authenticationSettlement = (now: number): Settlement => [
  Option.some(Transition.cases.AuthenticationRejected.make({})),
  Availability.cases.CredentialCooling.make({
    retryAt: now + DECISION_AUTHENTICATION_BACKOFF_MILLIS,
  }),
]

/** Capturing the unique suspicion mark at admission proves the attempt started after it
 * was set, even with equal millisecond timestamps. Concurrent attempts admitted while Ready
 * cannot corroborate one slow moment. A unique mark also prevents a pre-success attempt from
 * corroborating a new mark created after that success; expired evidence is discarded. */
const timeoutSettlement = (
  current: typeof Availability.Type,
  admission: typeof Admission.cases.Normal.Type,
  now: number,
): Settlement => {
  if (!Availability.guards.Suspect(current) || now >= current.expiresAt)
    return [
      Option.none(),
      Availability.cases.Suspect.make({
        id: SuspicionId.make(Symbol()),
        markedAt: now,
        expiresAt: now + DECISION_SUSPICION_MILLIS,
      }),
    ]
  if (
    !Option.exists(admission.suspicion, (id) => id === current.id) ||
    admission.startedAt < current.markedAt
  )
    return [Option.none(), current]
  return [
    Option.some(Transition.cases.Opened.make({})),
    Availability.cases.Cooling.make({
      retryAt: now + Duration.toMillis(Duration.fromInputUnsafe(DECISION_BACKOFF)),
    }),
  ]
}

/** Success and request-specific faults prove reachability and clear suspicion. Confirmed
 * transport/HTTP outages open immediately; only later independent timeouts corroborate. */
const settleNormal = (
  current: typeof Availability.Type,
  outcome: typeof Outcome.Type,
  admission: typeof Admission.cases.Normal.Type,
  now: number,
): Settlement => {
  if (Outcome.guards.AuthenticationFailure(outcome))
    return Availability.guards.CredentialCooling(current)
      ? [Option.none(), current]
      : authenticationSettlement(now)
  if (!Availability.isAnyOf(['Ready', 'Suspect'])(current)) return [Option.none(), current]
  return Outcome.match(outcome, {
    Outage: () => [
      Option.some(Transition.cases.Opened.make({})),
      Availability.cases.Cooling.make({
        retryAt: now + Duration.toMillis(Duration.fromInputUnsafe(DECISION_BACKOFF)),
      }),
    ],
    TimedOut: () => timeoutSettlement(current, admission, now),
    Success: () => [Option.none(), Availability.cases.Ready.make({})],
    RequestFailure: () => [Option.none(), Availability.cases.Ready.make({})],
    AuthenticationFailure: () => authenticationSettlement(now),
    Cancelled: () => [Option.none(), current],
  })
}

/** A request-specific probe failure proves reachability, so it clears the outage. A cancelled
 * or failed probe releases its lease into cooling, never leaving admission stuck forever. */
const settleProbe = (outcome: typeof Outcome.Type, now: number): Settlement => {
  const cooling: Settlement = [
    Option.none(),
    Availability.cases.Cooling.make({
      retryAt: now + Duration.toMillis(Duration.fromInputUnsafe(DECISION_BACKOFF)),
    }),
  ]
  const closed: Settlement = [
    Option.some(Transition.cases.Closed.make({})),
    Availability.cases.Ready.make({}),
  ]
  return Outcome.match(outcome, {
    Success: () => closed,
    RequestFailure: () => closed,
    Outage: () => cooling,
    TimedOut: () => cooling,
    Cancelled: () => cooling,
    AuthenticationFailure: () => authenticationSettlement(now),
  })
}

/** In-flight calls admitted before cooling cannot close or extend it. Only the lease holder
 * settles Probing. Tagged events announce one transition instead of warning every caller. */
const settle = Effect.fn('Decisions.settle')(function* (
  state: Ref.Ref<typeof Availability.Type>,
  admission: typeof Admission.Type,
  outcome: typeof Outcome.Type,
) {
  const now = yield* Clock.currentTimeMillis
  const event = yield* Ref.modify(state, (current): Settlement => {
    if (Admission.guards.Normal(admission)) return settleNormal(current, outcome, admission, now)
    if (Admission.guards.Probe(admission) && Availability.guards.Probing(current))
      return settleProbe(outcome, now)
    return [Option.none(), current]
  })
  if (Option.isSome(event)) {
    if (Transition.guards.AuthenticationRejected(event.value))
      yield* Effect.logError('Decision authentication rejected')
    else yield* Effect.logInfo('Decision availability backoff', { transition: event.value })
  }
})

/** Cancellation carries no error. The classification is still intact here, before public
 * DecisionUnavailable flattens all provider details into a safe caller-facing reason. */
const failedOutcome = (
  cause: Cause.Cause<AttemptUnavailable | AttemptTimedOut>,
): typeof Outcome.Type => {
  const error = Cause.findErrorOption(cause)
  if (Option.isNone(error)) return Outcome.cases.Cancelled.make({})
  if (error.value instanceof AttemptTimedOut) return Outcome.cases.TimedOut.make({})
  return FailureClassification.match(error.value.classification, {
    Outage: (): typeof Outcome.Type => Outcome.cases.Outage.make({}),
    RequestSpecific: (): typeof Outcome.Type => Outcome.cases.RequestFailure.make({}),
    Authentication: (): typeof Outcome.Type => Outcome.cases.AuthenticationFailure.make({}),
  })
}

/** Only safe reason vocabulary leaves the provider boundary; credential failure has
 * already been logged by settlement and callers must not repeat that error as a warning. */
const unavailableReason = (
  error: AttemptUnavailable | AttemptTimedOut,
): DecisionUnavailable['reason'] => {
  if (error instanceof AttemptTimedOut) return 'TimedOut'
  return FailureClassification.match<DecisionUnavailable['reason']>(error.classification, {
    Authentication: () => 'Authentication',
    Outage: () => 'Provider',
    RequestSpecific: () => 'Provider',
  })
}

const Configuration = Schema.TaggedUnion({
  Disabled: {},
  Unconfigured: {},
  Gateway: { key: Schema.Redacted(Schema.NonEmptyString), model: Schema.NonEmptyString },
})

/**
 * `VIVID_DECISIONS` is `on` or `off` and defaults to `off`: decisions stay switched off until
 * someone turns them on. When off, no key is read. Config decodes the secret once.
 */
const configuration = Effect.fn('Decisions.configuration')(function* () {
  const flag = yield* Config.schema(
    Schema.Literals(['on', 'off'] as const),
    'VIVID_DECISIONS',
  ).pipe(Config.withDefault('off' as const))
  if (flag === 'off') return Configuration.cases.Disabled.make({})
  const key = yield* Config.option(
    Config.schema(Schema.Redacted(Schema.NonEmptyString), 'EXPLABS_API_KEY'),
  )
  if (Option.isNone(key)) return Configuration.cases.Unconfigured.make({})
  const model = yield* Config.NonEmptyString('VIVID_DECISION_MODEL').pipe(
    Config.withDefault(DECISION_MODEL),
  )
  return Configuration.cases.Gateway.make({ key: key.value, model })
})()

/**
 * The model provided when there is no provider, registered with its reason. `decideWithin` never
 * calls it. A caller that goes around `decideWithin` gets an immediate typed failure, never a
 * hang: DecisionModel.ts `make` allows only `AiError`, and `InvalidRequestError` is its case for
 * a request that cannot be served.
 */
const absentLayer = (reason: 'Disabled' | 'Unconfigured') =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.map(
      DecisionModel.make({
        decide: () =>
          Effect.fail(
            AiError.make({
              module: 'Vivid.Decisions',
              method: 'decide',
              reason: new AiError.InvalidRequestError({
                description: 'Decisions are not available',
              }),
            }),
          ),
      }),
      (model) => {
        absent.set(model, reason)
        return model
      },
    ),
  )

/** Decisions with no provider configured, for composing code that must work without one. */
export const unconfiguredDecisionLayer = absentLayer('Unconfigured')

/** Decisions switched off, the production default. */
export const disabledDecisionLayer = absentLayer('Disabled')

/**
 * Decisions answered by Jev through the gateway. rc.116 `TypeSafeDecisionModel.make` sends every
 * named decision of a definition in one `systemOne` request; `TypeSafeClient` is pointed at the
 * gateway and uses the surrounding `HttpClient` without retries. Exported for the live
 * evaluations, which ask the real provider whatever the switch says.
 */
export const gatewayDecisionLayer = (options: {
  readonly key: Redacted.Redacted
  readonly model: string
}) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const model = yield* TypeSafeDecisionModel.make({ model: options.model })
      const state = yield* Ref.make<typeof Availability.Type>(Availability.cases.Ready.make({}))
      availability.set(model, state)
      return model
    }),
  ).pipe(Layer.provide(TypeSafeClient.layer({ apiKey: options.key, apiUrl: GATEWAY_URL })))

/**
 * The one place the switch is read and the provider chosen. The state is announced once here,
 * at start, so nothing needs to log it per decision.
 */
export const decisionModelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const selected = yield* configuration
    yield* Effect.logInfo('Decisions', { state: selected._tag })
    return Configuration.match(selected, {
      Disabled: () => disabledDecisionLayer,
      Unconfigured: () => unconfiguredDecisionLayer,
      Gateway: gatewayDecisionLayer,
    })
  }),
)

/**
 * One attempt bounds all questions in a request. Switched off or unconfigured fails at once,
 * before encoding, timers or network, and writes no log line: that is the normal state while
 * decisions are off, not an event. A provider failure, an encoding failure and a defect inside
 * the provider call share the `Provider` reason; a defect is mapped here so that no caller's
 * cache or request can die on a library fault. rc.116 DecisionModel.decide preserves schema
 * encoding services in its context. Transport, HTTP 429/5xx and later independent timeouts open outage backoff; authentication
 * rejection opens its own five-minute window with one error. Suspect expires after thirty seconds; request-specific
 * failures never change other callers' admission. The shared gate rejects outage traffic immediately as
 * Backoff, silently, with one recovery probe after thirty seconds. Admission and settlement
 * are interruption-safe; only the provider attempt is interruptible. Latency and provider-reported
 * usage are logged for actual attempts, with one log on each backoff open/close transition.
 */
export const decideWithin = <
  Input extends Schema.Constraint,
  Decisions extends Record<string, Decision.Any>,
>(
  definition: Decision.Definition<Input, Decisions>,
  input: Input['Type'],
  budget: Duration.Input,
): Effect.Effect<
  DecisionModel.DecideResponse<Decisions>,
  DecisionUnavailable,
  DecisionModel.DecisionModel | Input['EncodingServices']
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const model = yield* DecisionModel.DecisionModel
      const reason = absent.get(model)
      if (reason !== undefined) return yield* new DecisionUnavailable({ reason })
      const state = availability.get(model)
      const admission =
        state === undefined
          ? Admission.cases.Normal.make({
              startedAt: yield* Clock.currentTimeMillis,
              suspicion: Option.none(),
            })
          : yield* admit(state)
      if (Admission.guards.Backoff(admission))
        return yield* new DecisionUnavailable({ reason: 'Backoff' })
      const start = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(
        restore(
          DecisionModel.decide(definition, { input }).pipe(
            // Loud, because a defect is a fault in the provider adapter or in a definition, not an
            // outage; typed, because a caller's cache or request must not die on it.
            Effect.catchDefect(() =>
              Effect.logError('Decision defect').pipe(
                Effect.andThen(
                  Effect.fail(
                    new AttemptUnavailable({
                      classification: FailureClassification.cases.RequestSpecific.make({}),
                    }),
                  ),
                ),
              ),
            ),
            Effect.mapError((error) =>
              error instanceof AttemptUnavailable
                ? error
                : new AttemptUnavailable({
                    classification: classifyProviderFailure(error),
                  }),
            ),
            Effect.timeoutOrElse({
              duration: Admission.guards.Probe(admission)
                ? Duration.min(
                    Duration.fromInputUnsafe(budget),
                    Duration.fromInputUnsafe(RECOVERY_PROBE_BUDGET),
                  )
                : budget,
              orElse: () => Effect.fail(new AttemptTimedOut({})),
            }),
          ),
        ),
      )
      if (state !== undefined) {
        const outcome = Exit.match(exit, {
          onSuccess: () => Outcome.cases.Success.make({}),
          onFailure: failedOutcome,
        })
        yield* settle(state, admission, outcome)
      }
      const latency = (yield* Clock.currentTimeMillis) - start
      if (Exit.isSuccess(exit))
        yield* Effect.logInfo('Decision', {
          latency,
          inputTokens: exit.value.usage.inputTokens,
          outputTokens: exit.value.usage.outputTokens,
        })
      else yield* Effect.logInfo('Decision', { latency })
      return yield* exit.pipe(
        Effect.mapError((error) => new DecisionUnavailable({ reason: unavailableReason(error) })),
      )
    }),
  ).pipe(Effect.withSpan('Decisions.decide'))

/** The trust-loop default keeps the existing two-argument interface stable. */
export const decide = <
  Input extends Schema.Constraint,
  Decisions extends Record<string, Decision.Any>,
>(
  definition: Decision.Definition<Input, Decisions>,
  input: Input['Type'],
): Effect.Effect<
  DecisionModel.DecideResponse<Decisions>,
  DecisionUnavailable,
  DecisionModel.DecisionModel | Input['EncodingServices']
> => decideWithin(definition, input, DECISION_TIMEOUT)
