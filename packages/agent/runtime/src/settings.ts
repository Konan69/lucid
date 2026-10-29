import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Redacted from 'effect/Redacted'
import { AiError, DecisionModel } from 'effect/ai'
import { TypeSafeClient, TypeSafeDecisionModel } from '@effect/ai-typesafe'
import { Option, Schema } from 'effect'

/** The cell's private product authority. Storage and lifecycle come from celld. */
export interface RuntimeSettingsService {
  readonly token: Redacted.Redacted
  readonly serverUrl: URL
}

export class RuntimeSettings extends Context.Service<RuntimeSettings, RuntimeSettingsService>()(
  'vivid/Runtime/Settings',
) {}

/** Decode the Worker environment once before opening the Person's Harness. */
export const settingsLayer = Layer.effect(
  RuntimeSettings,
  Effect.gen(function* () {
    return RuntimeSettings.of({
      token: yield* Config.Redacted('VIVID_RUNTIME_TOKEN'),
      serverUrl: yield* Config.URL('VIVID_SERVER_URL'),
    })
  }),
)

/** Disabled or unconfigured decisions fail locally. Learning considers the exchange instead. */
const disabledDecisions = Layer.effect(
  DecisionModel.DecisionModel,
  DecisionModel.make({
    decide: () =>
      Effect.fail(
        AiError.make({
          module: 'Vivid.Learning',
          method: 'decide',
          reason: new AiError.InvalidRequestError({ description: 'Decisions unavailable' }),
        }),
      ),
  }),
)

/** OpenRouter implements TypeSafe's System One protocol. No key is read while switched off. */
export const decisionLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flag = yield* Config.schema(Schema.Literals(['on', 'off']), 'VIVID_DECISIONS').pipe(
      Config.withDefault('off'),
    )
    if (flag === 'off') return disabledDecisions
    const key = yield* Config.option(Config.Redacted('OPENROUTER_API_KEY'))
    if (Option.isNone(key)) return disabledDecisions
    return TypeSafeDecisionModel.layer({ model: 'jev-latest' }).pipe(
      Layer.provide(
        TypeSafeClient.layer({
          apiKey: key.value,
          apiUrl: 'https://openrouter.ai/api/v1',
        }),
      ),
    )
  }),
)
