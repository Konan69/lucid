import type { Transport } from '@sentry/core'
import type { ReactNativeOptions } from '@sentry/react-native'
import { guarded, scrub, scrubBreadcrumb } from './scrub'

/**
 * What the phone app's error reporting is started with, and whether it starts. Both are worked
 * out here, apart from the SDK and from React Native (`telemetry.ts` starts it), so they can be
 * checked in a test: a setting taken out of here by mistake is a report that leaves unscrubbed,
 * or a native crash report that carries more, and nothing would look wrong.
 */

/** How the SDK is handed the thing that sends: a function from its settings to a transport. */
type Sender = NonNullable<ReactNativeOptions['transport']>

/**
 * Only a release build on a phone reports. A development build does not, and neither does the
 * web build of this app, which has no native half for the SDK's transport to hand a report to.
 */
export const reports = (build: { readonly development: boolean; readonly platform: string }) =>
  !build.development && build.platform !== 'web'

/**
 * The SDK's integrations Vivid leaves out, by the names the SDK gives them:
 * - `ExpoContext` copies everything expo-updates knows into the native SDK's scope, and reports a
 *   launch that fell back to the built-in JavaScript with expo-updates' own free-text reason
 *   (`setExpoUpdatesNativeContext` and `captureEmergencyLaunchEvent` in the SDK's
 *   `integrations/expocontext.js`). `startTelemetry` (`telemetry.ts`) sets the three tags that matter itself.
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
 * The settings the SDK is started with. `send` is the SDK's own transport; it is wrapped in
 * `guarded` here, so no caller can start the SDK with a bare one.
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
 * - the release, the environment, the SDK's own name and version, and the two tags the bridge
 *   adds to say the report is native (`event.origin`, `event.environment`).
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
export const settings = (send: Sender) =>
  ({
    transport: (given): Transport => guarded(send(given)),
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
  }) satisfies ReactNativeOptions
