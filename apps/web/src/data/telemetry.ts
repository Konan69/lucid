import { init as startInDesktop, makeRendererTransport } from '@sentry/electron/renderer'
import { captureReactException, init, makeFetchTransport, type BrowserOptions } from '@sentry/react'
import { Option } from 'effect'
import type { ErrorInfo } from 'react'
import { guarded, scrub, scrubBreadcrumb } from './scrub'

/**
 * Sending the web app's errors to Sentry, beside the report `fault.ts` sends to Vivid's own
 * server. That one carries the message and is read in the server's log; this one is what alerts,
 * counts and groups, and it carries only what `scrub.ts` allows.
 *
 * The same built pages run in two places, and each reports to its own Sentry project:
 * - In a browser this starts `@sentry/react` with the web project's address below.
 * - In the desktop app the pages are loaded by its shell (`apps/desktop/src/main/window.ts`),
 *   whose session refuses every request that is not to the selected Vivid (`secureSession` in `apps/desktop/src/main/session.ts`), so
 *   a report could not reach Sentry from the page at all. There this starts
 *   `@sentry/electron/renderer` instead, around the same React SDK: it hands each report to the
 *   desktop's main process, which sends it to the desktop project
 *   (`apps/desktop/src/main/telemetry.ts`). The page is given no address of its own there, so it
 *   is never started twice. It starts only when the shell says its main process is reporting
 *   (`reporting` on the bridge): a shell run from source reports nothing, and a page that started
 *   anyway would instrument itself and call a main process that is not listening.
 */

/**
 * Where the web project takes reports. Sentry calls this a DSN and makes it public by design: it
 * can only add a report, and it is in every page that reports.
 */
const ADDRESS =
  'https://15b5e8aa82a1b9abaf5689e424d5cd08@o4512198444384256.ingest.us.sentry.io/4512198446743552'

/**
 * Which build this is: the app's version, then the commit when the build was given one. Written
 * in by the build (`define` in `vite.config.ts`), so it exists only in a built page; it is read
 * inside `startTelemetry`, which only a built page calls.
 */
declare const __VIVID_RELEASE__: string

/**
 * What both places share: errors only, and nothing collected that `scrub.ts` would have to
 * remove again.
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
const options: BrowserOptions = {
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
  beforeSend: scrub,
  beforeBreadcrumb: scrubBreadcrumb,
}

/**
 * Starts reporting. Called once by the entry (`main.tsx`) before anything is drawn, so an error
 * while the first screen is drawn is reported too. Only a production build reports: a
 * development page and a test never start this, and without it every capture below does nothing.
 *
 * Each place wraps its transport in `guarded` (`scrub.ts`), so only scrubbed error reports leave
 * whatever else the SDK tries to send: in a browser the SDK's own fetch transport, in the desktop
 * app the one that hands a report to the main process.
 *
 * A start that throws is left at that. This runs before the app is drawn, so an exception here
 * would be a blank page, and reporting errors is not worth the app. Nothing is reported for that
 * visit and nothing else is tried: there is no second way to report that would be any safer.
 */
export const startTelemetry = (): void => {
  if (!import.meta.env.PROD) return
  // The desktop app's preload puts its bridge on the window (`data/pages.ts`); nothing else does.
  if ('vivid' in globalThis) {
    if (!globalThis.vivid.reporting) return
    Option.liftThrowable(() =>
      startInDesktop(
        { ...options, transport: (given) => guarded(makeRendererTransport(given)) },
        init,
      ),
    )()
    return
  }
  Option.liftThrowable(init)({
    ...options,
    transport: (given) => guarded(makeFetchTransport(given)),
    dsn: ADDRESS,
    release: __VIVID_RELEASE__,
    environment: 'production',
  })
}

/**
 * Reports an error a boundary caught while drawing (`ui/Recover.tsx`), with React's component
 * stack. The SDK's own handlers only see what nothing caught, and a boundary catches.
 */
export const captureFault = (thrown: Error, info: ErrorInfo): void => {
  captureReactException(thrown, info)
}
