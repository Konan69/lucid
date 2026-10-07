import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

const defaultDevelopmentRendererUrl = Schema.decodeSync(Schema.URLFromString)(
  'http://127.0.0.1:5178',
)

/** Invalid runtime configuration names the variable without exposing its supplied value. */
export class DesktopConfigurationInvalid extends Schema.TaggedError<DesktopConfigurationInvalid>()(
  'DesktopConfigurationInvalid',
  { variable: Schema.String },
  { title: 'Desktop configuration is invalid' },
) {}

/**
 * Read the development renderer address through Effect Config. Packaged builds ignore this value,
 * but decoding it at startup keeps development navigation on one explicit, validated origin.
 */
export const loadDevelopmentRendererUrl = Effect.fn('DesktopConfig.loadRendererUrl')(function* () {
  return yield* Config.schema(Schema.URLFromString, 'VIVID_DESKTOP_RENDERER_URL').pipe(
    Config.withDefault(defaultDevelopmentRendererUrl),
    Effect.mapError(
      () => new DesktopConfigurationInvalid({ variable: 'VIVID_DESKTOP_RENDERER_URL' }),
    ),
  )
})
