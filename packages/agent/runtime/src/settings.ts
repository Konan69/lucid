import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Redacted from 'effect/Redacted'

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
