import type { Models as ModelCollection } from '@earendil-works/pi-ai'
import type { HarnessSettings, ModelRef } from '@earendil-works/pi-durable'
import { Context, Effect, Layer } from 'effect'
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- The providers unit exports this constructor and no Layer; this module is the Layer that owns it.
import { makeProviders } from './providers/models.ts'

export interface ModelsService {
  /** Every declared provider, with the keys it may use. */
  readonly collection: ModelCollection
  /** The model `VIVID_MODEL` selects, or the default; each delivery's conversation is set to it. */
  readonly selected: ModelRef
  /** The same selection as the `provider/model` text `/health` reports. */
  readonly name: string
  /** The request budget the providers ask the Harness to apply (`providers/budget.ts`). */
  readonly settings: HarnessSettings
}

/**
 * The models every Person's conversations run on. A service, so the process decides once which
 * providers exist and a test supplies a scripted one without touching the environment.
 */
export class Models extends Context.Service<Models, ModelsService>()('vivid/Runtime/Models') {}

/** `providers/models.ts` reads the selection and the keys; an undeclared selection stops startup. */
export const modelsLayer = Layer.effect(
  Models,
  Effect.map(makeProviders(), (providers) =>
    Models.of({
      collection: providers.models,
      selected: providers.model,
      name: providers.modelName,
      settings: providers.settings,
    }),
  ),
)
