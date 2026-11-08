import {
  captureException,
  getClient,
  init,
  setTag,
  wrap,
  reactNavigationIntegration,
} from '@sentry/react-native'
// The SDK's own transport, which hands an envelope to its native half. The package does not
// export it from its entry, and `guarded` needs it to wrap: `init` uses this same function when
// it is given none (`makeNativeTransportFactory` in the SDK's `sdk.js`).
import { makeNativeTransport } from '@sentry/react-native/dist/js/transports/native'
import { Option, Schema } from 'effect'
import * as Updates from 'expo-updates'
import type { ComponentType } from 'react'
import { Platform } from 'react-native'
import { reportsFrom, type Reports } from './build'
import { guarded, scrub, scrubBreadcrumb, scrubTransaction } from './scrub'
import { origin } from './origin'

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
 */
const LEFT_OUT = new Set(['ExpoContext', 'TurboModuleContext'])

/** Register the actual navigation container so spans name routes, never route parameter values. */
export const navigationTelemetry = reactNavigationIntegration({ enableTimeToInitialDisplay: true })

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
 * Start one native client before launch work. Performance and session health are enabled;
 * JavaScript envelopes are rebuilt by the transport allowlist before leaving the phone.
 * Native crash reports take a separate SDK path and retain native stack/device diagnostics.
 * No screenshots, view hierarchy, private request bodies or automatic native breadcrumbs are collected.
 * A failed telemetry start must not prevent the app from opening.
 */
export const startTelemetry = (): void => {
  if (__DEV__ || Platform.OS === 'web') return
  const started = Option.liftThrowable(init)({
    dsn: ADDRESS,
    environment: 'production',
    transport: (given) => guarded(makeNativeTransport(given)),
    integrations: (defaults) => [
      ...defaults.filter(({ name }) => !LEFT_OUT.has(name)),
      navigationTelemetry,
    ],
    beforeSend: scrub,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendTransaction: scrubTransaction,
    enableNativeCrashHandling: true,
    tracesSampleRate: 0.2,
    tracePropagationTargets: Option.toArray(origin),
    propagateTraceparent: true,
    enableAutoPerformanceTracing: true,
    enableAppStartTracking: true,
    enableNativeFramesTracking: true,
    enableStallTracking: true,
    enableUserInteractionTracing: true,
    enableAutoSessionTracking: true,
    sendClientReports: false,
    enableAppHangTracking: true,
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
 * The one option of a started client that Settings reads. `init` writes it itself: whether the
 * SDK's native half is in this install (`enableNative`, set from `NATIVE.isNativeAvailable()` in
 * the SDK's `sdk.js`), whatever it was asked for.
 */
const Started = Schema.Struct({ enableNative: Schema.Boolean })
const decodeStarted = Schema.decodeUnknownOption(Started)

/**
 * What Settings says about reporting on this phone (`build.ts`).
 *
 * It is read when asked and not at load: `index.ts` imports the app, and so every screen, before
 * it calls `startTelemetry`. No client is no start: a development build, the web build, or a
 * start that threw.
 */
export const reports = (): Reports =>
  reportsFrom(
    Option.map(
      Option.flatMap(Option.fromUndefinedOr(getClient()), (client) =>
        decodeStarted(client.getOptions()),
      ),
      ({ enableNative }) => ({ native: enableNative }),
    ),
  )

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

/**
 * Reports a Google sign-in that ended without a session (`SignInLoss` in `google.ts`). These end
 * on the first screen as a state, not as a thrown error, so nothing else reports them. The loss's
 * name is the report's type, which `scrub` keeps; no message, link or code goes with it.
 */
export const captureSignInLoss = (loss: string): void => {
  const lost = new Error(loss)
  lost.name = loss
  captureException(lost)
}
