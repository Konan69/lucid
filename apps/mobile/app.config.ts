import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import type { ConfigContext, ExpoConfig } from 'expo/config'
import {
  AndroidConfig,
  IOSConfig,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withPlugins,
} from 'expo/config-plugins'

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

/**
 * The pictures of Vivid's launch cover (`modules/splash`): the face whole, which the system's launch
 * screen shows, and the face without its eyes, which the cover draws its own eyes over. Each is
 * kept at three scales in `modules/splash/images`.
 */
const SPLASH_IMAGES = ['VividSplash', 'VividSplashDisc']

/**
 * Puts the launch cover's pictures in the app's asset catalog and makes the system's launch
 * screen the face on the plain background. Without it iOS drops its launch screen as soon as the
 * app has a window and the window shows its bare background until React Native has drawn: a white
 * (or black) screen on every launch. `modules/splash/ios/VividSplash.m` holds the same face from
 * there until the app has drawn, so the two read as one.
 *
 * The pictures go in the catalog because both readers look in the main bundle: the launch screen
 * (`UILaunchScreen` `UIImageName`) and the cover's `imageNamed:`. A storyboard named in
 * `UILaunchStoryboardName` would win over `UILaunchScreen`, so the template's is taken off. This
 * was first assembled by hand into the 0.3.2 and 0.3.3 builds (`Info.plist` and the pictures beside
 * the executable); this is the same result from the repository.
 */
const withSplash = (config: ExpoConfig): ExpoConfig =>
  withInfoPlist(
    withDangerousMod(config, [
      'ios',
      (step) => {
        const catalog = NodePath.join(
          IOSConfig.Paths.getSourceRoot(step.modRequest.projectRoot),
          'Images.xcassets',
        )
        const images = NodePath.join(step.modRequest.projectRoot, 'modules', 'splash', 'images')
        for (const name of SPLASH_IMAGES) {
          const set = NodePath.join(catalog, `${name}.imageset`)
          NodeFS.mkdirSync(set, { recursive: true })
          const files = ['', '@2x', '@3x'].map((scale) => `${name}${scale}.png`)
          for (const file of files)
            NodeFS.copyFileSync(NodePath.join(images, file), NodePath.join(set, file))
          const entries = files.map((filename, index) => ({
            idiom: 'universal',
            filename,
            scale: `${index + 1}x`,
          }))
          NodeFS.writeFileSync(
            NodePath.join(set, 'Contents.json'),
            `${JSON.stringify({ images: entries, info: { version: 1, author: 'xcode' } }, null, 2)}\n`,
          )
        }
        return Promise.resolve(step)
      },
    ]),
    (plist) => {
      delete plist.modResults['UILaunchStoryboardName']
      plist.modResults['UILaunchScreen'] = {
        UIImageName: 'VividSplash',
        UIImageRespectsSafeAreaInsets: false,
      }
      return plist
    },
  )

/**
 * Whether this build is signed by a free Apple ID (a "personal team"), set by
 * `VIVID_IOS_PERSONAL_TEAM=1` in the environment of whoever builds. A personal team cannot sign
 * push, App Groups or extension targets, and an IPA that asks for them does not install. So such
 * a build drops the widget extension and those entitlements, and the same source builds either
 * way. Ported from T3 Code mobile (`apps/mobile/app.config.ts`, `isIosPersonalTeamBuild`, and
 * `plugins/withoutIosPersonalTeamCapabilities.cjs`).
 */
const PERSONAL_TEAM = process.env['VIVID_IOS_PERSONAL_TEAM'] === '1'

/** The entitlements a personal team cannot sign, taken off its build. */
const withoutPaidTeamCapabilities = (config: ExpoConfig): ExpoConfig =>
  withEntitlementsPlist(config, (plist) => {
    delete plist.modResults['aps-environment']
    delete plist.modResults['com.apple.security.application-groups']
    delete plist.modResults['com.apple.developer.associated-domains']
    return plist
  })

/**
 * The widget extension: a Live Activity and a widget that show what Vivid is doing in the
 * Person's Threads while the app is closed, updated from the server. As T3 Code mobile's
 * `AgentActivity` (`apps/mobile/app.config.ts`, `widgetsPlugin`): its own bundle under the app's,
 * one App Group shared with the app, remote updates, and the frequent-updates budget because a
 * Run can change its state many times an hour. The layout ships over the air (`expo-widgets`
 * draws it with `@expo/ui`); only the target and its capabilities are native.
 */
const withThreadActivity = (config: ExpoConfig, app: string): ExpoConfig =>
  withPlugins(config, [
    [
      'expo-widgets',
      {
        bundleIdentifier: `${app}.widgets`,
        groupIdentifier: `group.${app}`,
        enablePushNotifications: true,
        frequentUpdates: true,
        widgets: [
          {
            name: 'ThreadActivity',
            displayName: 'Vivid at work',
            description: 'What Vivid is doing in your Threads.',
            android: null,
            ios: { supportedFamilies: ['systemSmall', 'systemMedium', 'accessoryRectangular'] },
          },
        ],
      },
    ],
  ])

/**
 * "Share to Vivid" from any app: a link, words, pictures or files from the system's share sheet
 * land in Vivid. `expo-sharing`'s share extension with T3 Code mobile's settings
 * (`apps/mobile/app.config.ts`, `sharingPlugin`): its own bundle and the App Group it shares
 * with the app, one link, up to eight pictures, films or files. A personal team cannot sign an
 * extension, so its build has the share sheet off on iOS, as T3's does; Android needs no signing
 * and always takes shares. What a share does once it is in the app ships over the air.
 */
const withShareTarget = (config: ExpoConfig, app: string): ExpoConfig =>
  withPlugins(config, [
    [
      'expo-sharing',
      {
        ios: {
          enabled: !PERSONAL_TEAM,
          extensionBundleIdentifier: `${app}.sharing`,
          appGroupId: `group.${app}`,
          activationRule: {
            supportsText: true,
            supportsWebUrlWithMaxCount: 1,
            supportsImageWithMaxCount: 8,
            supportsMovieWithMaxCount: 8,
            supportsFileWithMaxCount: 8,
          },
        },
        android: {
          enabled: true,
          singleShareMimeTypes: ['*/*'],
          multipleShareMimeTypes: ['*/*'],
        },
      },
    ],
  ])

/**
 * Links on the Vivid server's own address open the app (a notification, a shared Thread, the end
 * of a sign-in), and the system offers the Person's saved Vivid password, as T3 Code mobile's
 * `associatedDomains` do. The address is the build's `VIVID_SERVER`; the server answers
 * `/.well-known/apple-app-site-association` for it. Only a paid team can sign it.
 */
const withServerLinks = (config: ExpoConfig, server: string): ExpoConfig => {
  const host = new URL(server).host
  return {
    ...config,
    ios: {
      ...config.ios,
      associatedDomains: [`applinks:${host}`, `webcredentials:${host}`],
    },
  }
}

/** A paid team's build gets the widget extension; a personal team's loses what it cannot sign. */
const withSigning = (config: ExpoConfig): ExpoConfig => {
  const { ios } = config
  if (ios === undefined || ios.bundleIdentifier === undefined)
    throw new Error('app.json must name the iOS bundle.')
  const app = ios.bundleIdentifier
  return PERSONAL_TEAM
    ? withoutPaidTeamCapabilities(withShareTarget(config, app))
    : withShareTarget(withThreadActivity(config, app), app)
}

export default ({ config }: ConfigContext): Partial<ExpoConfig> => {
  const server = process.env['VIVID_SERVER']
  const telemetryEnvironment = process.env['VIVID_ENVIRONMENT'] ?? 'production'
  if (telemetryEnvironment !== 'production' && telemetryEnvironment !== 'verification')
    throw new Error('VIVID_ENVIRONMENT must be production or verification for phone builds')
  // Expo hands over `app.json` typed as possibly partial. A config plugin needs the whole thing,
  // and an `app.json` that does not name the app is a broken build, so it fails here.
  const { name, slug } = config
  if (name === undefined || slug === undefined) throw new Error('app.json must name the app.')
  const base = withSigning(
    withSplash(
      withSentryOff({
        ...config,
        name,
        slug,
        extra: { ...config.extra, telemetryEnvironment },
      }),
    ),
  )
  if (server === undefined || server === '') return { ...base, updates: { enabled: false } }
  const linked = PERSONAL_TEAM ? base : withServerLinks(base, server)
  return {
    ...linked,
    extra: { ...linked.extra, server },
    updates: {
      enabled: true,
      url: new URL(`${server.replace(/\/+$/u, '')}/api/updates/manifest`).toString(),
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
  }
}
