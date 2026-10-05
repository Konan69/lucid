import type { ConfigContext, ExpoConfig } from 'expo/config'
import { AndroidConfig, withAndroidManifest } from 'expo/config-plugins'

/**
 * Adds the one value a build is given from outside: where its Vivid is. `app.json` stays the
 * whole static config; this file only lays the address over it from `VIVID_SERVER` in the
 * environment of whoever runs the build, so no address is ever committed. The app decodes
 * `extra.server` in `src/data/origin.ts`. With the variable unset, `extra.server` is absent and
 * the app says so.
 *
 * The same address is where the build asks for newer JavaScript (`updates.url`, answered by
 * `apps/server/src/updates`), so a build with no address also has updates off: there is nobody to
 * ask. The path is added to the address as given, so a Vivid mounted under a path keeps it, as
 * the app's own reading of the address does (`src/data/server.ts`). `new URL` throws on an address
 * that does not parse, which fails the build instead of shipping a binary that can never update.
 *
 * `checkAutomatically: 'ON_LOAD'` with `fallbackToCacheTimeout: 0` is the launch behavior of the
 * reference this was ported from (`apps/mobile/app.config.ts` in the T3 Code fork): start at once
 * on the newest bundle already on the phone and fetch a newer one in the background, never hold
 * the first frame on the network.
 */
/**
 * The two things Sentry's Android SDK collects that its React Native options cannot switch off,
 * switched off where that SDK reads its settings before any option: the app's manifest
 * (`ManifestMetadataReader` in sentry-android 8.59.0, the version `@sentry/react-native` 8.29.0
 * builds against; `SentryAndroid.init` applies the manifest first and the options after).
 * - `io.sentry.anr.enable`: a report each time the app stops answering for five seconds. Vivid
 *   reports errors and crashes, not slowness (`src/data/telemetry.ts`).
 * - `io.sentry.breadcrumbs.user-interaction`: a note of every touch, kept by the native SDK and
 *   sent with a native crash, which no JavaScript gets to check.
 */
const SENTRY_OFF = ['io.sentry.anr.enable', 'io.sentry.breadcrumbs.user-interaction']

/** Writes `SENTRY_OFF` into the generated Android manifest, each as `false`. */
const withSentryOff = (config: ExpoConfig): ExpoConfig =>
  withAndroidManifest(config, (manifest) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest.modResults)
    for (const name of SENTRY_OFF)
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, name, 'false')
    return manifest
  })

export default ({ config }: ConfigContext): Partial<ExpoConfig> => {
  const server = process.env['VIVID_SERVER']
  // Expo hands over `app.json` typed as possibly partial. A config plugin needs the whole thing,
  // and an `app.json` that does not name the app is a broken build, so it fails here.
  const { name, slug } = config
  if (name === undefined || slug === undefined) throw new Error('app.json must name the app.')
  const base = withSentryOff({ ...config, name, slug })
  if (server === undefined || server === '') return { ...base, updates: { enabled: false } }
  return {
    ...base,
    extra: { ...base.extra, server },
    updates: {
      enabled: true,
      url: new URL(`${server.replace(/\/+$/u, '')}/api/updates/manifest`).toString(),
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
  }
}
