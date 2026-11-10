import { Message } from '../observability/messages.ts'
import {
  Cause,
  Clock,
  Config,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Schedule,
  type Scope,
} from 'effect'
import { AiError, Decision, DecisionModel } from 'effect/ai'
import { TypeSafeClient, TypeSafeDecisionModel } from '@effect/ai-typesafe'
import { serverModelGateway } from '../config.ts'

/** docs/22, “The trust loop”: the reviewer has ten seconds and one attempt. */
const DECISION_TIMEOUT = '10 seconds'

/** The most questions accepted in a calibrated gateway request with headroom: twenty
 * succeeded and thirty-nine were rejected with HTTP 400 on 4 Oct 2026. This is the tested
 * payload ceiling, not an inferred provider maximum; effects, relevance and rules share it. */
export const DECISION_QUESTION_LIMIT = 20

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

/** Reports provider configuration independently of the outage gate. Cache Layers
 * use this to avoid allocating entries when decisions are deliberately absent. */
export const decisionConfigured = Effect.map(
  DecisionModel.DecisionModel,
  (model) => !absent.has(model),
)

/** Deliberate absence, an observed outage and adapter-observed permission failures
 * need no duplicate caller warning. Permission errors keep the existing public
 * Provider reason; their identity records that this adapter already announced them. */
export const isDecisionNonEvent = (error: DecisionUnavailable): boolean =>
  nonEventReasons.has(error.reason) || observedPermissionFailures.has(error)

const observedPermissionFailures = new WeakSet<DecisionUnavailable>()

const nonEventReasons = new Set<DecisionUnavailable['reason']>([
  'Disabled',
  'Unconfigured',
  'Backoff',
  'Authentication',
])

/** Thirty seconds suppresses outage traffic. One timeout records suspicion;
 * only a later independently admitted calibrated stall closes admission. A
 * single 1800ms optional timeout cannot penalize every tenant for thirty seconds. */
const DECISION_BACKOFF = '30 seconds'
/** Gateway jev-latest, 4 Oct 2026, round-five twenty-question warm maximum:
 * 1773ms (effects), versus 1389ms in the earlier relevance cohort. 2200ms adds
 * 427ms (24%) above the larger observed sample. A shorter timeout is evidence
 * only about that caller's optional-work budget, never process-wide health. */
const DECISION_OUTAGE_MINIMUM_MILLIS = 2200
/** Recovery owns a 2500ms budget independently of the caller's remaining time.
 * This leaves 727ms (41%) above the measured 1773ms warm maximum and exceeds
 * the calibrated outage-evidence floor; a short discovery cannot starve recovery. */
const RECOVERY_PROBE_BUDGET = '2500 millis'
/** Suspicion is weak evidence from one bounded attempt. Thirty seconds matches the outage
 * window: an isolated slow call cannot poison a later, otherwise independent interaction. */
const DECISION_SUSPICION_MILLIS = 30_000
/** A rejected credential requires operator repair, unlike transient transport failures.
 * Five minutes reduces repeated probes tenfold versus the thirty-second outage window;
 * one error per window announces the actionable fault without warning on every action.
 * A rebuilt gateway Layer with repaired configuration starts ready immediately. */
const DECISION_AUTHENTICATION_BACKOFF_MILLIS = 300_000
/** A 403 may be payload-specific, so requests remain admitted. One warning per
 * minute coalesces repeated rejection without suppressing a later healthy call;
 * this matches the metadata failure-cache interval while bounding log volume. */
const DECISION_PERMISSION_WARNING_INTERVAL_MILLIS = 60_000

/** A process-local mark survives schema construction without relying on object identity or
 * millisecond uniqueness. It is never persisted or sent to the gateway. */
const SuspicionId = Schema.Symbol.pipe(Schema.brand('DecisionSuspicionId'))

const Availability = Schema.TaggedUnion({
  Ready: {},
  Suspect: { id: SuspicionId, markedAt: Schema.Finite, expiresAt: Schema.Finite },
  Cooling: { retryAt: Schema.Finite },
  CredentialCooling: { retryAt: Schema.Finite },
  Probing: {},
})
const Admission = Schema.TaggedUnion({
  Normal: { startedAt: Schema.Finite, suspicion: Schema.Option(SuspicionId) },
  Probe: {},
  Backoff: {},
})
const Outcome = Schema.TaggedUnion({
  Success: {},
  Outage: {},
  TimedOut: {},
  CallerLocalTimeout: {},
  RequestFailure: {},
  AuthenticationFailure: {},
  Cancelled: {},
})
const Transition = Schema.TaggedUnion({ Opened: {}, Closed: {}, AuthenticationRejected: {} })
const FailureClassification = Schema.TaggedUnion({
  Outage: {},
  RequestSpecific: {},
  Permission: {},
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
  { budgetMillis: Schema.Finite },
  { title: 'Decision attempt timed out' },
) {}

const ProviderReason = AiError.AiErrorReason.pipe(Schema.toTaggedUnion('_tag'))

/** rc.116 AiError.reasonFromHttpStatus maps 429/5xx to RateLimit/InternalProvider.
 * ai-typesafe internal/errors.ts maps transport AND encode/URL failures to NetworkError;
 * its reason field distinguishes actual transport from caller-specific encoding and URLs.
 * AuthenticationError kind InvalidKey (401) proves rejected credentials; 403 maps
 * to InsufficientPermissions and can reflect this payload: it remains local,
 * with adapter-owned warnings throttled independently of request admission. */
const classifyProviderFailure = (error: AiError.AiError) =>
  ProviderReason.matchOrElse(
    error.reason,
    {
      AuthenticationError: (reason) =>
        reason.kind === 'InvalidKey'
          ? FailureClassification.cases.Authentication.make({})
          : FailureClassification.cases.Permission.make({}),
      RateLimitError: () => FailureClassification.cases.Outage.make({}),
      InternalProviderError: () => FailureClassification.cases.Outage.make({}),
      NetworkError: (reason) =>
        reason.reason === 'TransportError'
          ? FailureClassification.cases.Outage.make({})
          : FailureClassification.cases.RequestSpecific.make({}),
    },
    () => FailureClassification.cases.RequestSpecific.make({}),
  )

/** Recovery belongs to the model Layer, not the request that acquires its lease.
 * Keeping the scope with the gate lets a short caller leave without cancelling I/O;
 * closing the Layer still interrupts that I/O and settles its lease. */
interface ModelAvailability {
  readonly state: Ref.Ref<typeof Availability.Type>
  readonly scope: Scope.Scope
  readonly permissionWarningAfter: Ref.Ref<number>
}
const availability = new WeakMap<DecisionModel.DecisionModel, ModelAvailability>()

/** Read-only preflight for callers that prepare expensive decision inputs. False
 * means the model is absent, still cooling, or already probing. An elapsed cooling
 * window is eligible: the next actual attempt may acquire the recovery lease.
 * Reading never expires suspicion, acquires that lease, changes the gate, logs,
 * or attempts a decision. This is a snapshot, not a reservation: another caller
 * can open backoff or acquire the probe before preparation finishes. */
export const decisionUnavailability = Effect.fn('Decisions.unavailability')(function* () {
  const model = yield* DecisionModel.DecisionModel
  const reason = absent.get(model)
  if (reason !== undefined) return Option.some(reason)
  const state = availability.get(model)
  if (state === undefined) return Option.none<DecisionUnavailable['reason']>()
  const current = yield* Ref.get(state.state)
  const now = yield* Clock.currentTimeMillis
  return Availability.match<Option.Option<DecisionUnavailable['reason']>>(current, {
    Ready: () => Option.none(),
    Suspect: () => Option.none(),
    Cooling: ({ retryAt }) => (now >= retryAt ? Option.none() : Option.some('Backoff')),
    CredentialCooling: ({ retryAt }) =>
      now >= retryAt ? Option.none() : Option.some('Authentication'),
    Probing: () => Option.some('Backoff'),
  })
})

/** Existing callers need only readiness; the reviewer also records the closed reason above. */
export const decisionWouldAttempt = decisionUnavailability().pipe(Effect.map(Option.isNone))

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
 * transport/HTTP outages open immediately; only later independent stalls corroborate.
 * Caller cancellation after the calibrated evidence floor has observed the same
 * silence as a timeout. Short interruption remains local and cannot penalize tenants. */
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
    Cancelled: () =>
      now - admission.startedAt >= DECISION_OUTAGE_MINIMUM_MILLIS
        ? timeoutSettlement(current, admission, now)
        : [Option.none(), current],
    CallerLocalTimeout: () => [Option.none(), current],
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
    CallerLocalTimeout: () => cooling,
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
  if (error.value instanceof AttemptTimedOut)
    return error.value.budgetMillis < DECISION_OUTAGE_MINIMUM_MILLIS
      ? Outcome.cases.CallerLocalTimeout.make({})
      : Outcome.cases.TimedOut.make({})
  return FailureClassification.match(error.value.classification, {
    Outage: (): typeof Outcome.Type => Outcome.cases.Outage.make({}),
    RequestSpecific: (): typeof Outcome.Type => Outcome.cases.RequestFailure.make({}),
    Permission: (): typeof Outcome.Type => Outcome.cases.RequestFailure.make({}),
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
    Permission: () => 'Provider',
  })
}

const Configuration = Schema.TaggedUnion({
  Disabled: {},
  Gateway: {
    key: Schema.Redacted(Schema.NonEmptyString),
    url: Schema.NonEmptyString,
    model: Schema.NonEmptyString,
  },
})

/**
 * `VIVID_DECISIONS` is `on` or `off` and defaults to `off`: decisions stay switched off until
 * someone turns them on. When off, no key is read. Config decodes the secret once.
 */
const configuration = Effect.gen(function* () {
  const flag = yield* Config.schema(
    Schema.Literals(['on', 'off'] as const),
    'VIVID_DECISIONS',
  ).pipe(Config.withDefault('off' as const))
  if (flag === 'off') return Configuration.cases.Disabled.make({})
  const gateway = yield* serverModelGateway
  const model = yield* Config.NonEmptyString('VIVID_DECISION_MODEL').pipe(
    Config.withDefault(DECISION_MODEL),
  )
  return Configuration.cases.Gateway.make({ key: gateway.key, url: gateway.url, model })
}).pipe(Effect.withSpan('Decisions.configuration'))

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
 * Decisions answered by Jev through the selected gateway. Effect 4.0.2 `TypeSafeDecisionModel.make` sends every
 * named decision of a definition in one `systemOne` request; `TypeSafeClient` is pointed at the
 * gateway and uses the surrounding `HttpClient` without retries. Exported for the live
 * evaluations, which ask the real provider whatever the switch says. OpenRouter exposes the
 * same System One protocol and accepts the bare jev-latest id, so no decision translation is needed.
 * https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request
 */
export const gatewayDecisionLayer = (options: {
  readonly key: Redacted.Redacted
  readonly url: string
  readonly model: string
}) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const model = yield* TypeSafeDecisionModel.make({ model: options.model })
      const state = yield* Ref.make<typeof Availability.Type>(Availability.cases.Ready.make({}))
      const scope = yield* Effect.scope
      const permissionWarningAfter = yield* Ref.make(0)
      availability.set(model, { state, scope, permissionWarningAfter })
      return model
    }),
  ).pipe(Layer.provide(TypeSafeClient.layer({ apiKey: options.key, apiUrl: options.url })))

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
      Gateway: gatewayDecisionLayer,
    })
  }),
)

/** The provider boundary owns validation, defects and its independent I/O timer.
 * Preserve the classification until settlement; safe public reasons are derived later. */
const attemptDecision = <
  Input extends Schema.Constraint,
  Decisions extends Record<string, Decision.Any>,
>(
  definition: Decision.Definition<Input, Decisions>,
  input: Input['Type'],
  budget: Duration.Input,
) =>
  DecisionModel.decide(definition, { input }).pipe(
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
        : new AttemptUnavailable({ classification: classifyProviderFailure(error) }),
    ),
    Effect.timeoutOrElse({
      duration: budget,
      orElse: () =>
        Effect.fail(
          new AttemptTimedOut({
            budgetMillis: Duration.toMillis(Duration.fromInputUnsafe(budget)),
          }),
        ),
    }),
  )

/** The gateway announces payload-specific permission rejection once per interval,
 * while leaving admission open. Custom supplied models have no shared adapter
 * lifecycle; their permission failures are announced at their attempt boundary. */
const warnPermission = Effect.fn('Decisions.warnPermission')(function* (
  shared: Option.Option<ModelAvailability>,
) {
  if (Option.isNone(shared)) {
    yield* Effect.logWarning('Decision permission rejected')
    return
  }
  const now = yield* Clock.currentTimeMillis
  const announce = yield* Ref.modify(shared.value.permissionWarningAfter, (next) =>
    now >= next ? [true, now + DECISION_PERMISSION_WARNING_INTERVAL_MILLIS] : [false, next],
  )
  if (announce) yield* Effect.logWarning('Decision permission rejected')
})

/** Preserve the public error vocabulary and signature. Identity marks only the
 * permission failures this adapter owns, so caller recovery cannot log them again. */
const publicUnavailable = (error: AttemptUnavailable | AttemptTimedOut) => {
  const unavailable = new DecisionUnavailable({ reason: unavailableReason(error) })
  if (
    error instanceof AttemptUnavailable &&
    FailureClassification.guards.Permission(error.classification)
  )
    observedPermissionFailures.add(unavailable)
  return unavailable
}

/** Settlement and its receipt cannot be cancelled after the provider exits. rc.116
 * forkIn owns a probe in the Layer scope; the same attempt settlement handles its
 * independent timeout or Layer shutdown even when its initiating caller has left. */
const completeAttempt = <A extends { readonly usage: DecisionModel.DecisionUsage }, R>(
  attempt: Effect.Effect<A, AttemptUnavailable | AttemptTimedOut, R>,
  state: Option.Option<ModelAvailability>,
  admission: typeof Admission.Type,
): Effect.Effect<A, DecisionUnavailable, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(restore(attempt))
      if (Option.isSome(state)) {
        const outcome = Exit.match(exit, {
          onSuccess: () => Outcome.cases.Success.make({}),
          onFailure: failedOutcome,
        })
        yield* settle(state.value.state, admission, outcome)
      }
      const latency = (yield* Clock.currentTimeMillis) - start
      if (Exit.isSuccess(exit))
        yield* Effect.logInfo('Decision', {
          latency,
          inputTokens: exit.value.usage.inputTokens,
          outputTokens: exit.value.usage.outputTokens,
        })
      else {
        yield* Effect.logInfo('Decision', { latency })
        const error = Cause.findErrorOption(exit.cause)
        if (
          Option.isSome(error) &&
          error.value instanceof AttemptUnavailable &&
          FailureClassification.guards.Permission(error.value.classification)
        )
          yield* warnPermission(state)
      }
      return yield* exit.pipe(Effect.mapError(publicUnavailable))
    }),
  )

/** OFF and unconfigured fail before encoding, timers or network. Admission and
 * settlement are interruption-safe; normal calls wait only their supplied budget.
 * Transport/429/5xx open backoff immediately; independent calibrated stalls
 * corroborate suspicion. Short timeouts remain caller-local, and 401 opens a
 * separate five-minute credential window. After cooling, one Layer-owned probe
 * has 2500ms to settle the gate. Its initiating caller waits at most its own
 * budget and may leave sooner; siblings fail as Backoff without queueing.
 * Each actual attempt logs one latency receipt and gate transitions log once. */
export const decideWithin = <
  Input extends Schema.Constraint,
  Decisions extends Record<string, Decision.Any>,
>(
  definition: Decision.Definition<Input, Decisions>,
  input: Input['Type'],
  budget: Duration.Input,
  retries: 0 | 1 = 0,
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
      const shared = availability.get(model)
      const admission =
        shared === undefined
          ? Admission.cases.Normal.make({
              startedAt: yield* Clock.currentTimeMillis,
              suspicion: Option.none(),
            })
          : yield* admit(shared.state)
      if (Admission.guards.Backoff(admission))
        return yield* new DecisionUnavailable({ reason: 'Backoff' })
      const state = Option.fromUndefinedOr(shared)
      if (Admission.guards.Probe(admission) && shared !== undefined) {
        const probe = yield* completeAttempt(
          attemptDecision(definition, input, RECOVERY_PROBE_BUDGET),
          state,
          admission,
        ).pipe(Effect.forkIn(shared.scope))
        return yield* restore(
          Fiber.join(probe).pipe(
            Effect.timeoutOrElse({
              duration: budget,
              orElse: () => Effect.fail(new DecisionUnavailable({ reason: 'TimedOut' })),
            }),
          ),
        )
      }
      return yield* restore(
        completeAttempt(
          attemptDecision(definition, input, budget).pipe(
            Effect.retry({
              schedule: Schedule.recurs(retries).pipe(
                Schedule.setInputType<AttemptUnavailable | AttemptTimedOut>(),
                Schedule.tap(({ input }) => {
                  const attributes = {
                    'vivid.review.reason': unavailableReason(input),
                    'vivid.review.retry': 'Taken',
                  }
                  return Effect.annotateCurrentSpan(attributes).pipe(
                    Effect.andThen(
                      Effect.logWarning(Message.reviewRetry).pipe(Effect.annotateLogs(attributes)),
                    ),
                  )
                }),
              ),
              while: (error) => {
                const reason = unavailableReason(error)
                return reason === 'TimedOut' || reason === 'Provider'
              },
            }),
          ),
          state,
          admission,
        ),
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
