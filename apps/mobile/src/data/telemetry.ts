import { captureException, init, setTag, wrap } from '@sentry/react-native'
// The SDK's own transport, which hands an envelope to its native half. The package does not
// export it from its entry, and `settings` needs it to wrap in its guard: `init` uses this same
// function when it is given none (`makeNativeTransportFactory` in the SDK's `sdk.js`).
import { makeNativeTransport } from '@sentry/react-native/dist/js/transports/native'
import { Option } from 'effect'
import * as Updates from 'expo-updates'
import type { ComponentType } from 'react'
import { Platform } from 'react-native'
import { reports, settings } from './options'

/**
 * Sending the phone app's errors and crashes to Sentry, beside the report `fault.ts` sends to
 * Vivid's own server. That one carries the message and is read in the server's log; this one is
 * what alerts, counts and groups, it carries only what `scrub.ts` allows, and it is the only one
 * that sees a crash in native code, which ends the app before any JavaScript can report it.
 *
 * The SDK has a native half (the pod and the Gradle dependency its config plugin adds, `app.json`),
 * so this cannot reach a binary built before it: the app's version, which is also its
 * over-the-air runtime version, went from 0.1.0 to 0.2.0 with it.
 */

/**
 * Where the mobile project takes reports. Sentry calls this a DSN and makes it public by design:
 * it can only add a report, and it is in every app that reports.
 */
const ADDRESS =
  'https://ba7de7687324a34c72e9d950c027259e@o4512198444384256.ingest.us.sentry.io/4512198445760512'

/**
 * Which over-the-air update is running, as the tags the SDK's own `ExpoContext` would have set.
 * A value expo-updates does not have (a build with updates off has no channel) is not a tag.
 */
const updates = () =>
  [
    ['expo.updates.update_id', Updates.updateId],
    ['expo.updates.channel', Updates.channel],
    ['expo.updates.runtime_version', Updates.runtimeVersion],
  ] as const

/**
 * Starts reporting. Called once at launch, first (`index.ts`), so an error in anything that
 * starts after it is reported. Whether it starts is `reports` and what it starts with is
 * `settings`, both in `options.ts`, which also says what a native crash report can carry.
 *
 * A start that throws is left at that. This runs before the app is registered, so an exception
 * here would be an app that does not open, and reporting errors is not worth the app. Nothing is
 * reported for that launch and nothing else is tried.
 *
 * `release` is left to the SDK, which reads it from the binary: the bundle identifier, the app's
 * version and its build number (`nativeReleaseIntegration`), the same for a JavaScript error and
 * a native crash.
 */
export const startTelemetry = (): void => {
  if (!reports({ development: __DEV__, platform: Platform.OS })) return
  const started = Option.liftThrowable(init)({
    ...settings(makeNativeTransport),
    dsn: ADDRESS,
    environment: 'production',
  })
  if (Option.isNone(started)) return
  // After the start, because a tag set on the scope is only copied to the native SDK once the
  // SDK has taken over the scope (`enableSyncToNative` in the SDK's `init`).
  for (const [name, value] of updates()) if (value !== null) setTag(name, value)
}

/**
 * The root component as the SDK wants it registered: inside its own wrapper, which is where it
 * hears touches from (each becomes a breadcrumb, and `scrubBreadcrumb` drops those). A
 * development build registers the root as it is, since nothing was started for the wrapper to
 * report to.
 */
export const reporting = (Root: ComponentType): ComponentType =>
  reports({ development: __DEV__, platform: Platform.OS }) ? wrap(Root) : Root

/**
 * Reports an error a boundary caught while drawing (`ui/Recover.tsx`). The SDK's own handler only
 * hears what nothing caught, and a boundary catches.
 *
 * An error nothing caught needs no call from here. The SDK takes React Native's global handler
 * when it starts, reports, and then calls the handler that was there before it
 * (`reactNativeErrorHandlersIntegration`). `watchFaults` (`fault.ts`) takes the handler after
 * that and does the same, so one uncaught error reaches Vivid's server, then Sentry, then React
 * Native's own handling, once each.
 */
export const captureFault = (thrown: Error): void => {
  captureException(thrown)
}
