import { Config, Effect, Layer, Option, Schema } from 'effect'
import { AiError, Decision, DecisionModel } from 'effect/unstable/ai'
import { TypeSafeClient, TypeSafeDecisionModel } from '@effect/ai-typesafe'
import { OpenRouterClient, OpenRouterDecisionModel } from '@effect/ai-openrouter'

export const DECISION_TIMEOUT = '10 seconds'

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

/** An unavailable provider is a typed AiError, never an empty successful judgment.
 * DecisionModel.ts make requires AiError; its InvalidRequestError represents missing authority. */
export const unconfiguredDecisionLayer = Layer.effect(
  DecisionModel.DecisionModel,
  DecisionModel.make({
    decide: () =>
      Effect.fail(
        AiError.make({
          module: 'Vivid.Decisions',
          method: 'decide',
          reason: new AiError.InvalidRequestError({
            description: 'Configure TYPESAFE_API_KEY or OPENROUTER_API_KEY',
          }),
        }),
      ),
  }),
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

/** One attempt bounds every judgment, including multi-question requests. Callers own
 * conservative recovery. Generic types preserve Decision.ts's inferred answer contract. */
export const decide = <
  Input extends Schema.Constraint,
  Decisions extends Record<string, Decision.Any>,
>(
  definition: Decision.Definition<Input, Decisions>,
  input: Input['Type'],
) => DecisionModel.decide(definition, { input }).pipe(Effect.timeout(DECISION_TIMEOUT))
