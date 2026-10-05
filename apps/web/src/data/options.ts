import type { Transport } from '@sentry/core'
import type { BrowserOptions } from '@sentry/react'
import { guarded, scrub, scrubBreadcrumb } from './scrub'

/**
 * What the web app's error reporting is started with, and where. Both are worked out here, apart
 * from the SDK (`telemetry.ts` starts it), so they can be checked without a browser: a setting
 * taken out of here by mistake is a report that leaves unscrubbed, and nothing would look wrong.
 */

/** How the SDK is handed the thing that sends: a function from its settings to a transport. */
type Sender = NonNullable<BrowserOptions['transport']>

/**
 * Where reporting starts for a page:
 * - `Browser`: with the web project's address, straight to Sentry.
 * - `Shell`: inside the desktop app's own window, by handing reports to its main process.
 * - `Nowhere`: not at all.
 */
export type Start = 'Browser' | 'Shell' | 'Nowhere'

/**
 * Decides where reporting starts. Only a production build reports. A page with the desktop app's
 * bridge on its window is in that app's own window, and reports through the shell exactly when
 * the shell says its main process is reporting (`reporting` on the bridge); a shell run from
 * source says no, and so does one built before the bridge said anything.
 *
 * Every other page is a page in a browser, and that includes one case inside the desktop app:
 * Vivid opened in the app's browser pane (`apps/desktop/src/main/browser.ts`). A page there is a
 * guest with no bridge, on purpose, so it is the web app in a browser view and reports to the web
 * project like any browser, whatever the shell around it is doing. The shell's `reporting` is a
 * fact about the app's own window only.
 */
export const startsIn = (page: {
  readonly production: boolean
  readonly shell: boolean
  readonly reporting: boolean
}): Start => {
  if (!page.production) return 'Nowhere'
  if (!page.shell) return 'Browser'
  return page.reporting ? 'Shell' : 'Nowhere'
}

/**
 * The settings both places share: errors only, and nothing collected that `scrub.ts` would have
 * to remove again. `send` is the SDK transport for the place; it is wrapped in `guarded` here, so
 * no caller can start the SDK with a bare one.
 *
 * - `tracesSampleRate: 0` and no tracing, replay, profiling or feedback integration: Vivid had a
 *   telemetry volume problem, and this adds one report for each error and nothing else.
 * - `dataCollection`: this SDK version (core 11.1.0) has no `sendDefaultPii`. It collects by
 *   default and each kind is turned off by name (`DataCollection` in `@sentry/core`
 *   `types/datacollection.d.ts`). `userInfo: false` is also what tells Sentry not to record the
 *   address a report came from (`infer_ip: 'never'`, `client.js` in `@sentry/browser`).
 * - `BrowserSession` is left out of the default integrations: it sends a session record for each
 *   page load and each move between screens, which is volume that is not an error.
 * - `sendClientReports: false`: the SDK's own counts of what it dropped are not errors either.
 */
export const settings = (send: Sender) =>
  ({
    transport: (given): Transport => guarded(send(given)),
    beforeSend: scrub,
    beforeBreadcrumb: scrubBreadcrumb,
    tracesSampleRate: 0,
    sendClientReports: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    integrations: (defaults) => defaults.filter(({ name }) => name !== 'BrowserSession'),
  }) satisfies BrowserOptions
