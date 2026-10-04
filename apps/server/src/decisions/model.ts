import { Clock, Config, Duration, Effect, Exit, Layer, Option, Schema } from 'effect'
import { Decision, DecisionModel } from 'effect/unstable/ai'
import { TypeSafeClient, TypeSafeDecisionModel } from '@effect/ai-typesafe'
import { OpenRouterClient, OpenRouterDecisionModel } from '@effect/ai-openrouter'

/** docs/22, “The trust loop”: the reviewer has ten seconds and one attempt. */
export const DECISION_TIMEOUT = '10 seconds'

/** Callers need the unavailable reason, never provider payloads or supplied inputs. */
export class DecisionUnavailable extends Schema.TaggedError<DecisionUnavailable>()(
  'DecisionUnavailable',
  { reason: Schema.Literals(['Unconfigured', 'TimedOut', 'Provider']) },
  { title: 'Decision unavailable' },
) {}

const Configuration = Schema.TaggedUnion({
  TypeSafe: { key: Schema.Redacted(Schema.NonEmptyString), model: Schema.NonEmptyString },
  OpenRouter: { key: Schema.Redacted(Schema.NonEmptyString), model: Schema.NonEmptyString },
  Unconfigured: {},
})

/** Config decodes secrets once. TypeSafe takes precedence; an absent override uses the
 * selected provider's model name, not an alias borrowed from the other provider. */
const configuration = Effect.fn('Decisions.configuration')(function* () {
  const typesafe = yield* Config.option(
    Config.schema(Schema.Redacted(Schema.NonEmptyString), 'TYPESAFE_API_KEY'),
  )
  const model = yield* Config.option(Config.NonEmptyString('VIVID_DECISION_MODEL'))
  if (Option.isSome(typesafe))
    return Configuration.cases.TypeSafe.make({
      key: typesafe.value,
      model: Option.getOrElse(model, () => 'jev-1.13.0'),
    })
  const openrouter = yield* Config.option(
    Config.schema(Schema.Redacted(Schema.NonEmptyString), 'OPENROUTER_API_KEY'),
  )
  if (Option.isSome(openrouter))
    return Configuration.cases.OpenRouter.make({
      key: openrouter.value,
      model: Option.getOrElse(model, () => 'typesafe/jev-1.13'),
    })
  return Configuration.cases.Unconfigured.make({})
})()

/** A model with no provider has identity, but no runnable request. DecisionModel's
 * library interface permits only AiError, so its inert method is never entered by
 * our public boundary. Identity makes absence explicit without disguising it as an
 * invalid provider request or adding context requirements to existing callers. */
const unconfiguredModel = DecisionModel.DecisionModel.of({
  [DecisionModel.TypeId]: DecisionModel.TypeId,
  decide: () => Effect.never,
})
export const unconfiguredDecisionLayer = Layer.succeed(
  DecisionModel.DecisionModel,
  unconfiguredModel,
)

/** External/test models are configured by construction; the absent provider is
 * distinguished before lookup, encoding, timeout setup or network work. */
export const decisionConfigured = Effect.map(
  DecisionModel.DecisionModel,
  (model) => model !== unconfiguredModel,
)

/** rc.116 TypeSafeDecisionModel.make and OpenRouterDecisionModel.make send every
 * named decision through one provider request. Both clients use the server HttpClient
 * without retries; only this composition root selects credentials and provider. */
export const decisionModelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const selected = yield* configuration
    if (Configuration.guards.Unconfigured(selected))
      yield* Effect.logWarning('Decisions unconfigured: TYPESAFE_API_KEY or OPENROUTER_API_KEY')
    return Configuration.match(selected, {
      TypeSafe: ({ key, model }) =>
        TypeSafeDecisionModel.layer({ model }).pipe(
          Layer.provide(TypeSafeClient.layerConfig({ apiKey: Config.succeed(key) })),
        ),
      OpenRouter: ({ key, model }) =>
        OpenRouterDecisionModel.layer({ model }).pipe(
          Layer.provide(OpenRouterClient.layerConfig({ apiKey: Config.succeed(key) })),
        ),
      Unconfigured: () => unconfiguredDecisionLayer,
    })
  }),
)

/** One attempt bounds all questions in a request. Encoding and provider failures
 * share the Provider reason; absence and time exhaustion remain distinguishable.
 * rc.116 DecisionModel.decide preserves schema encoding services in its context.
 * Only latency and provider-reported usage are logged, once per judgment. */
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
    const start = yield* Clock.currentTimeMillis
    // Separate provider failure mapping from the final latency/usage accounting.
    const operation = Effect.fn('Decisions.attempt')(function* () {
      if (!(yield* decisionConfigured))
        return yield* Effect.fail(new DecisionUnavailable({ reason: 'Unconfigured' }))
      return yield* DecisionModel.decide(definition, { input }).pipe(
        Effect.mapError(() => new DecisionUnavailable({ reason: 'Provider' })),
        Effect.timeoutOrElse({
          duration: budget,
          orElse: () => Effect.fail(new DecisionUnavailable({ reason: 'TimedOut' })),
        }),
      )
    })()
    const exit = yield* Effect.exit(operation)
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
