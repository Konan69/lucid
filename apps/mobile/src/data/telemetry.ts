import { captureException, init, setTag, wrap } from '@sentry/react-native'
// The SDK's own transport, which hands an envelope to its native half. The package does not
// export it from its entry, and `guarded` needs it to wrap: `init` uses this same function when
// it is given none (`makeNativeTransportFactory` in the SDK's `sdk.js`).
import { makeNativeTransport } from '@sentry/react-native/dist/js/transports/native'
import { Option } from 'effect'
import * as Updates from 'expo-updates'
import type { ComponentType } from 'react'
import { Platform } from 'react-native'
import { guarded, scrub, scrubBreadcrumb } from './scrub'

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
 * The SDK's integrations Vivid leaves out, by the names the SDK gives them:
 * - `ExpoContext` copies everything expo-updates knows into the native SDK's scope, and reports a
 *   launch that fell back to the built-in JavaScript with expo-updates' own free-text reason
 *   (`setExpoUpdatesNativeContext` and `captureEmergencyLaunchEvent` in the SDK's
 *   `integrations/expocontext.js`). `startTelemetry` sets the three tags that matter itself.
 * - `TurboModuleContext` writes the native module and method being called into the native scope
 *   on every call. Only what `startTelemetry` names goes into that scope.
 * - `ExpoUpdatesListener` and `TimeToDisplay` are tracing instruments; this SDK installs the
 *   second whenever `tracesSampleRate` is a number, zero included (`integrations/default.js`).
 */
const LEFT_OUT = new Set([
  'ExpoContext',
  'TurboModuleContext',
  'ExpoUpdatesListener',
  'TimeToDisplay',
])

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
 * starts after it is reported. Only a release build on a phone reports: a development build and
 * the web build stop at the first line, and without a start every capture below does nothing.
 *
 * A start that throws is left at that. This runs before the app is registered, so an exception
 * here would be an app that does not open, and reporting errors is not worth the app. Nothing is
 * reported for that launch and nothing else is tried.
 *
 * `release` is left to the SDK, which reads it from the binary: the bundle identifier, the app's
 * version and its build number (`nativeReleaseIntegration`), the same for a JavaScript error and
 * a native crash.
 *
 * ## The two ways a report leaves
 *
 * A report made in JavaScript (an error, a rejected promise, what a boundary caught) passes
 * `scrub` and `scrubBreadcrumb`, and then `guarded` around the transport, which lets only
 * scrubbed error reports through (`scrub.ts`).
 *
 * A crash in native code does not. The native SDK writes it as the app dies and sends it on the
 * next launch, and the SDK removes `beforeSend`, `beforeBreadcrumb` and `integrations` from the
 * options before it starts its native half (`initNativeSdk` in the SDK's `wrapper.js`): a
 * function cannot cross to native code. Native crash reporting stays on, because finding a native
 * crash on a phone is the main reason this exists, so what such a report can carry is limited
 * here by what the native SDK is given and what it is told not to collect.
 *
 * What JavaScript puts into the native scope, which a native report includes (`scopeSync.js`):
 * - the three update tags below, and nothing else that is set: no user, no extra, no context;
 * - the breadcrumbs that passed `scrubBreadcrumb`, so a request's method, status and place and a
 *   move between screens.
 *
 * What a native crash report can still carry that no code here sees, read from the SDK's bridge
 * (`ios/RNSentryStart.m`, `android/.../RNSentryStart.java`) and its options, not from the native
 * SDKs themselves, whose source is not installed:
 * - the native exception's type and its reason string, written by the system or by the native
 *   code that failed. This is free text and is not checked by anything here;
 * - the native stack frames and the loaded images they belong to;
 * - the facts about the device, the system and the app that the native SDK collects itself;
 * - the release and the environment given below.
 *
 * ## Each option, and why
 * - `tracesSampleRate: 0` and every tracing switch off: errors and crashes only. Vivid had a
 *   telemetry volume problem.
 * - `enableAutoSessionTracking: false` and `sendClientReports: false`: a session record for each
 *   launch and the SDK's counts of what it dropped are volume, not errors. Both reach the native
 *   SDKs too, which read the same names.
 * - `enableAppHangTracking: false`: a slow screen is not a crash, and each one would be a report.
 *   This is the iPhone's switch. Android's is not an option of this SDK; it is turned off in the
 *   app's manifest (`io.sentry.anr.enable`, written by `app.config.ts`).
 * - `sendDefaultPii: false`, `attachScreenshot: false`, `attachViewHierarchy: false`: nothing of
 *   the screen or the Person is attached, in JavaScript or natively.
 * - The native breadcrumb switches are all off, so the only breadcrumbs in the native scope are
 *   the scrubbed ones from JavaScript. On the iPhone `enableNetworkBreadcrumbs` would note every
 *   request with its whole address, and `enableAutoBreadcrumbTracking` every touch and screen
 *   (`SentryAutoBreadcrumbTrackingIntegration` in sentry-cocoa 9.30.0 starts the touch tracker
 *   under that switch). On Android the five named here are the ones this SDK passes on; touches
 *   are a sixth it does not, turned off in the manifest (`io.sentry.breadcrumbs.user-interaction`).
 * - `enableCaptureFailedRequests: false`: a failed request is not reported as an error by itself.
 * - `enableNativeCrashHandling: true` is the SDK's default, written out because it is the point.
 */
export const startTelemetry = (): void => {
  if (__DEV__ || Platform.OS === 'web') return
  const started = Option.liftThrowable(init)({
    dsn: ADDRESS,
    environment: 'production',
    transport: (given) => guarded(makeNativeTransport(given)),
    integrations: (defaults) => defaults.filter(({ name }) => !LEFT_OUT.has(name)),
    beforeSend: scrub,
    beforeBreadcrumb: scrubBreadcrumb,
    enableNativeCrashHandling: true,
    tracesSampleRate: 0,
    enableAutoPerformanceTracing: false,
    enableAppStartTracking: false,
    enableNativeFramesTracking: false,
    enableStallTracking: false,
    enableUserInteractionTracing: false,
    enableAutoSessionTracking: false,
    sendClientReports: false,
    enableAppHangTracking: false,
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableCaptureFailedRequests: false,
    enableNetworkBreadcrumbs: false,
    enableAutoBreadcrumbTracking: false,
    enableNetworkEventBreadcrumbs: false,
    enableActivityLifecycleBreadcrumbs: false,
    enableAppLifecycleBreadcrumbs: false,
    enableSystemEventBreadcrumbs: false,
    enableAppComponentBreadcrumbs: false,
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
export const reporting = (Root: ComponentType): ComponentType => (__DEV__ ? Root : wrap(Root))

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
