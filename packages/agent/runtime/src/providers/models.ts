import { createModels, type AuthContext } from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { settings } from './budget.ts'
import { provider as openrouter } from './openrouter.ts'
import { DEFAULT_MODEL, provider as opencode } from './opencode.ts'
import { provider as rehearsal } from './rehearsal.ts'

/** An undeclared selection cannot silently change the model a Person asked Vivid to use. */
/** @public The declaration emitter must name this error in modelsLayer failures. */
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()(
  'ModelUnavailable',
  { model: Schema.String },
  { title: 'Configured model is not declared' },
) {}

/**
 * Build an isolated collection for Harness.open, without a global registry or credential files.
 * Config owns the same two optional settings as main. Keys stay Redacted until Pi's auth
 * adapter requests one, and missing keys remain absent so Pi reports unconfigured auth.
 * Rehearsal is installed only for the exact rehearsal/ prefix; unknown models fail here.
 */
export const makeProviders = Effect.fn('Providers.make')(function* () {
  const modelName = yield* Config.String('VIVID_MODEL').pipe(Config.withDefault(DEFAULT_MODEL))
  const opencodeKey = yield* Config.option(Config.Redacted('OPENCODE_API_KEY'))
  const openrouterKey = yield* Config.option(Config.Redacted('OPENROUTER_API_KEY'))
  const keys = new Map([
    ['OPENROUTER_API_KEY', openrouterKey],
    ['OPENCODE_API_KEY', opencodeKey],
  ])
  const authContext: AuthContext = {
    /** Pi requires a Promise; reveal only the requested key at this SDK authority boundary. */
    env: (name) =>
      Promise.resolve(
        Option.getOrUndefined(
          Option.flatMap(Option.fromUndefinedOr(keys.get(name)), (key) =>
            Option.map(key, Redacted.value),
          ),
        ),
      ),
    /** These gateways use environment keys exclusively and never consult ambient auth files. */
    fileExists: () => Promise.resolve(false),
  }
  const models = createModels({ authContext })
  models.setProvider(opencode)
  models.setProvider(openrouter)
  if (modelName.startsWith('rehearsal/')) models.setProvider(rehearsal)
  const selected = models
    .getModels()
    .find((candidate) => `${candidate.provider}/${candidate.id}` === modelName)
  if (selected === undefined) return yield* new ModelUnavailable({ model: modelName })
  const model = { provider: selected.provider, modelId: selected.id } satisfies ModelRef
  return { models, model, modelName, settings }
})
