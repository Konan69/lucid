import { NodeFileSystem } from '@effect/platform-node'
import { ServiceId, ServiceUnavailable } from '@vivid/contracts'
import { Config, Effect, FileSystem, Option, Schema } from 'effect'

/** Operator configuration holds only the web client and native Executor template identities.
 * Executor's StartConnectionOAuth persists each supplied client encrypted under its actual
 * owner/provider/callback/scopes key (sdk implementation/oauth.ts resolveSetup/beginOAuth).
 * Grants remain entirely in Executor; this file never contains a Person's Google tokens.
 */
const GoogleInstallation = Schema.Struct({
  client: Schema.Struct({
    clientId: Schema.RedactedFromValue(Schema.NonEmptyString),
    clientSecret: Schema.RedactedFromValue(Schema.NonEmptyString),
  }),
  apps: Schema.NonEmptyArray(
    Schema.Struct({
      service: ServiceId,
      name: Schema.NonEmptyString,
      app: Schema.NonEmptyString,
      provider: Schema.NonEmptyString,
    }),
  ),
})
export type GoogleInstallation = typeof GoogleInstallation.Type
const decodeInstallation = Schema.decodeUnknownEffect(Schema.fromJsonString(GoogleInstallation))
export const encodeGoogleClient = Schema.encodeEffect(GoogleInstallation.fields.client)
export const googleReturnPath = '/api/connections/google/return'
export const GoogleState = Schema.String.check(Schema.isMinLength(32)).pipe(
  Schema.brand('GoogleState'),
)

/** Invalid configuration fails without rendering supplied client values in schema diagnostics. */
export const loadGoogleInstallation = Effect.fn('Executor.googleInstallation')(function* () {
  const path = yield* Config.option(Config.String('VIVID_EXECUTOR_GOOGLE_CONFIG'))
  if (Option.isNone(path)) return Option.none<GoogleInstallation>()
  const installation = yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* decodeInstallation(yield* fs.readFileString(path.value))
  }).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.mapError(() =>
      ServiceUnavailable.make({
        service: 'connections',
        message: 'The Google operator configuration could not be loaded.',
      }),
    ),
  )
  return Option.some(installation)
})

/** Only explicitly installed templates receive operator authority; catalog names grant none. */
export function googleApp(installation: Option.Option<GoogleInstallation>, service: ServiceId) {
  return Option.flatMap(installation, (value) =>
    Option.fromUndefinedOr(value.apps.find((app) => app.service === service)),
  )
}

export const decodeGoogleState = Schema.decodeUnknownEffect(GoogleState)
