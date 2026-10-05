import { captureException, init, wrap } from '@sentry/react-native'
import type { ComponentType } from 'react'
import { scrub, scrubBreadcrumb } from './scrub'

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
 * Starts reporting. Called once at launch, first (`index.ts`), so an error in anything that
 * starts after it is reported. Only a release build reports: a development build stops at the
 * first line, and without a start every capture below does nothing.
 *
 * `release` is left to the SDK, which reads it from the binary: the bundle identifier, the app's
 * version and its build number (`nativeReleaseIntegration`), the same for a JavaScript error and
 * a native crash. Which over-the-air update was running is added by the SDK too, as the tags
 * `expo.updates.update_id`, `expo.updates.channel` and `expo.updates.runtime_version`
 * (`expoContextIntegration`), which `scrub.ts` keeps.
 *
 * Each option, and why:
 * - `tracesSampleRate: 0` and every tracing switch off: errors and crashes only. Vivid had a
 *   telemetry volume problem. The switches are named one by one because this SDK installs its
 *   tracing instruments whenever `tracesSampleRate` is a number, zero included
 *   (`hasTracingEnabled` in `integrations/default.js`).
 * - `enableAutoSessionTracking: false`: a session record for each launch is volume, not an error.
 * - `enableAppHangTracking: false`: a slow screen is not a crash, and each one would be a report.
 * - `sendDefaultPii: false`, with no screenshot and no view hierarchy (both off unless asked
 *   for): nothing of the screen or the Person is attached.
 * - `enableNetworkBreadcrumbs: false`: the native SDK would otherwise note every request with its
 *   whole address, and a native crash report is sent without passing `scrub`. The requests made
 *   from JavaScript are still noted, through `scrubBreadcrumb`, which cuts the query off.
 * - `enableCaptureFailedRequests: false`: a failed request is not reported as an error by itself.
 */
export const startTelemetry = (): void => {
  if (__DEV__) return
  init({
    dsn: ADDRESS,
    environment: 'production',
    tracesSampleRate: 0,
    enableAutoPerformanceTracing: false,
    enableAppStartTracking: false,
    enableNativeFramesTracking: false,
    enableStallTracking: false,
    enableUserInteractionTracing: false,
    enableAutoSessionTracking: false,
    enableAppHangTracking: false,
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableNetworkBreadcrumbs: false,
    enableCaptureFailedRequests: false,
    beforeSend: scrub,
    beforeBreadcrumb: scrubBreadcrumb,
  })
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
