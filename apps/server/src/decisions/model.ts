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
 * observed a provider outage or holds the sole recovery probe; the reason exists for logs and operators.
 * It never carries provider payloads or supplied inputs.
 */
export class DecisionUnavailable extends Schema.TaggedError<DecisionUnavailable>()(
  'DecisionUnavailable',
  { reason: Schema.Literals(['Disabled', 'Unconfigured', 'TimedOut', 'Provider', 'Backoff']) },
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

/** Thirty seconds suppress repeated full caller budgets during an outage while allowing quick
 * recovery. This is shorter than the tool-effect failure cache's minute: a fresh tool or relevance
 * call can discover recovery first. Only the configured provider Layer owns this process state. */
const DECISION_BACKOFF = '30 seconds'

const Availability = Schema.TaggedUnion({
  Ready: {},
  Cooling: { retryAt: Schema.Number },
  Probing: {},
})
const Admission = Schema.TaggedUnion({ Normal: {}, Probe: {}, Backoff: {} })
const Outcome = Schema.TaggedUnion({ Success: {}, Failure: {}, Cancelled: {} })

/** Captured models keep the same gate across service Layers and direct callers. Disabled and
 * unconfigured models never enter this registry; supplied independent models retain their policy. */
const availability = new WeakMap<DecisionModel.DecisionModel, Ref.Ref<typeof Availability.Type>>()

/** Atomic admission allows exactly one recovery probe after cooling, even across concurrent callers.
 * Ready calls remain concurrent; backoff never queues work or starts a provider request. */
const admit = Effect.fn('Decisions.admit')(function* (state: Ref.Ref<typeof Availability.Type>) {
  const now = yield* Clock.currentTimeMillis
  return yield* Ref.modify(
    state,
    (current): readonly [typeof Admission.Type, typeof Availability.Type] =>
      Availability.match(current, {
        Ready: (): readonly [typeof Admission.Type, typeof Availability.Type] => [
          Admission.cases.Normal.make({}),
          current,
        ],
        Cooling: ({ retryAt }): readonly [typeof Admission.Type, typeof Availability.Type] =>
          now < retryAt
            ? [Admission.cases.Backoff.make({}), current]
            : [Admission.cases.Probe.make({}), Availability.cases.Probing.make({})],
        Probing: (): readonly [typeof Admission.Type, typeof Availability.Type] => [
          Admission.cases.Backoff.make({}),
          current,
        ],
      }),
  )
})

/** Older in-flight successes cannot close a newly opened gate; only its recovery probe can.
 * Older failures cannot extend cooling or replace an active probe. Cancellation of a probe
 * starts another cooling window so interruption cannot leave the gate probing forever. */
const settle = Effect.fn('Decisions.settle')(function* (
  state: Ref.Ref<typeof Availability.Type>,
  admission: typeof Admission.Type,
  outcome: typeof Outcome.Type,
) {
  const retryAt =
    (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.fromInputUnsafe(DECISION_BACKOFF))
  const event = yield* Ref.modify(
    state,
    (current): readonly [Option.Option<string>, typeof Availability.Type] => {
      if (
        Admission.guards.Normal(admission) &&
        Outcome.guards.Failure(outcome) &&
        Availability.guards.Ready(current)
      )
        return [Option.some('opened'), Availability.cases.Cooling.make({ retryAt })]
      if (!Admission.guards.Probe(admission) || !Availability.guards.Probing(current))
        return [Option.none(), current]
      return Outcome.match(outcome, {
        Success: (): readonly [Option.Option<string>, typeof Availability.Type] => [
          Option.some('closed'),
          Availability.cases.Ready.make({}),
        ],
        Failure: () => [Option.none(), Availability.cases.Cooling.make({ retryAt })],
        Cancelled: () => [Option.none(), Availability.cases.Cooling.make({ retryAt })],
      })
    },
  )
  if (Option.isSome(event))
    yield* Effect.logInfo('Decision availability backoff', { state: event.value })
})

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
 * encoding services in its context. The shared gate rejects outage traffic immediately as
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
      const admission = state === undefined ? Admission.cases.Normal.make({}) : yield* admit(state)
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
                Effect.andThen(Effect.fail(new DecisionUnavailable({ reason: 'Provider' }))),
              ),
            ),
            Effect.mapError(() => new DecisionUnavailable({ reason: 'Provider' })),
            Effect.timeoutOrElse({
              duration: budget,
              orElse: () => Effect.fail(new DecisionUnavailable({ reason: 'TimedOut' })),
            }),
          ),
        ),
      )
      if (state !== undefined) {
        const outcome = Exit.match(exit, {
          onSuccess: () => Outcome.cases.Success.make({}),
          onFailure: (cause) =>
            Option.isSome(Cause.findErrorOption(cause))
              ? Outcome.cases.Failure.make({})
              : Outcome.cases.Cancelled.make({}),
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
      return yield* exit
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
