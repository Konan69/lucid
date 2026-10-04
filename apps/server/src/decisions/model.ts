import { Clock, Config, Duration, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect'
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
 * alike, as "do what you would do without a decision"; the reason exists for logs and operators.
 * It never carries provider payloads or supplied inputs.
 */
export class DecisionUnavailable extends Schema.TaggedError<DecisionUnavailable>()(
  'DecisionUnavailable',
  { reason: Schema.Literals(['Disabled', 'Unconfigured', 'TimedOut', 'Provider']) },
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
  TypeSafeDecisionModel.layer({ model: options.model }).pipe(
    Layer.provide(TypeSafeClient.layer({ apiKey: options.key, apiUrl: GATEWAY_URL })),
  )

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
 * encoding services in its context. Only latency and provider-reported usage are logged.
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
  Effect.gen(function* () {
    const reason = absent.get(yield* DecisionModel.DecisionModel)
    if (reason !== undefined) return yield* new DecisionUnavailable({ reason })
    const start = yield* Clock.currentTimeMillis
    const exit = yield* Effect.exit(
      DecisionModel.decide(definition, { input }).pipe(
        Effect.catchDefect(() => Effect.fail(new DecisionUnavailable({ reason: 'Provider' }))),
        Effect.mapError(() => new DecisionUnavailable({ reason: 'Provider' })),
        Effect.timeoutOrElse({
          duration: budget,
          orElse: () => Effect.fail(new DecisionUnavailable({ reason: 'TimedOut' })),
        }),
      ),
    )
    const latency = (yield* Clock.currentTimeMillis) - start
    if (Exit.isSuccess(exit))
      yield* Effect.logInfo('Decision', {
        latency,
        inputTokens: exit.value.usage.inputTokens,
        outputTokens: exit.value.usage.outputTokens,
      })
    else yield* Effect.logInfo('Decision', { latency })
    return yield* exit
  }).pipe(Effect.withSpan('Decisions.decide'))

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
