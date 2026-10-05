import {
  IPCMode,
  childProcessIntegration,
  init,
  makeElectronOfflineTransport,
} from '@sentry/electron/main'
import * as Option from 'effect/Option'
import { app, session } from 'electron'
import { guarded, scrub, scrubBreadcrumb } from './scrub.ts'
import { APP_PARTITION } from './session.ts'

/**
 * Sending the desktop app's errors to Sentry: the main process's own, and every one the window
 * hands over. The window draws the web app's pages, and its session refuses each request that is
 * not to the selected Vivid (`secureSession`), so a page cannot reach Sentry by itself. The pages
 * start `@sentry/electron/renderer` instead (`apps/web/src/data/telemetry.ts`), which passes each
 * report here, and this process sends it. Everything the desktop app reports, from either
 * process, therefore goes to the one desktop project and through the one `scrub`.
 */

/**
 * Where the desktop project takes reports. Sentry calls this a DSN and makes it public by design:
 * it can only add a report.
 */
const ADDRESS =
  'https://63d18276d50109656bb64f5817adf408@o4512198444384256.ingest.us.sentry.io/4512198462210048'

/**
 * The commit this build was made from, or empty when the build was given none. Written in by the
 * build (`define` in `scripts/build.mjs`), so it exists only in a built main process; it is read
 * inside `startTelemetry`, which only a packaged app gets past the first line of.
 */
declare const __VIVID_COMMIT__: string

/**
 * Whether this process started reporting. It is written once, by `startTelemetry`, before the app
 * is ready and so before any window exists to ask.
 */
let started = false

/**
 * Whether this process is sending error reports. A window is told when it is made (`window.ts`),
 * and its page starts its own half only then: that half does nothing but hand reports here.
 */
export const reporting = (): boolean => started

/**
 * Starts reporting. Called once, as the first thing the main process does (`main.ts`): before the
 * app is ready, which the SDK requires for its scheme, and before `main.ts` registers Vivid's own
 * scheme, which would otherwise be replaced by the SDK's (Electron keeps only the last call to
 * `registerSchemesAsPrivileged`; once started, the SDK adds its scheme to every later call:
 * `configureProtocol` in `@sentry/electron` `main/ipc.js`).
 *
 * Only a packaged app reports. A development run and a test stop at the first line.
 *
 * A start that throws leaves `reporting` false and is left at that. This is the first thing the
 * app does, so an exception here would be an app that does not open, and reporting errors is not
 * worth the app. Nothing else is tried: there is no second way to report that would be any safer.
 *
 * Each option, and why:
 * - `ipcMode: Protocol` with the app's session in `getSessions`: the window sends its reports by
 *   a request to the SDK's `sentry-ipc` scheme, which the SDK answers in the sessions named here.
 *   The window is in the app's own partition, not the default session the SDK assumes. The other
 *   mode needs a preload script the SDK finds by its path in `node_modules`, and this process is
 *   one bundled file (`scripts/build.mjs`), so that path does not exist in a packaged app.
 * - `tracesSampleRate: 0`: errors only. Vivid had a telemetry volume problem.
 * - `dataCollection`: this SDK version (core 11.1.0) has no `sendDefaultPii`. It collects by
 *   default and each kind is turned off by name; `userInfo: false` is also what tells Sentry not
 *   to record the address a report came from (`getSdkInfo` in `main/context.js`).
 * - `SentryMinidump` is left out. It uploads the crash dump Chromium writes when a process dies
 *   in native code, and a dump is a copy of that process's stack memory: it can hold the text of
 *   a Thread, and nothing here could cut that out. So a native crash is reported as the fact
 *   that the process ended (`childProcessIntegration`, told to report `crashed` and `oom` as
 *   well, which it otherwise leaves to the dump) and without the dump.
 * - `MainProcessSession` is left out: a session record for each launch is volume, not an error.
 * - `sendClientReports: false`: the SDK's own counts of what it dropped are not errors either.
 * - `transport`: the SDK's own (Electron's network stack, with a queue on disk for when it is
 *   offline), inside `guarded` (`scrub.ts`), so only scrubbed error reports leave whatever else
 *   is handed to it. That matters most here: a window's session records, replays and attachments
 *   are passed to this process's client as they are (`handleEnvelope` in `main/ipc.js`), and the
 *   guard is what stops them. It is outside the offline queue, so nothing is written to disk
 *   that would not be sent. It is made inside the start, so a failure to make it is caught with
 *   the rest.
 */
export const startTelemetry = (): void => {
  if (!app.isPackaged) return
  const commit = __VIVID_COMMIT__ === '' ? '' : `+${__VIVID_COMMIT__.slice(0, 12)}`
  const outcome = Option.liftThrowable(init)({
    dsn: ADDRESS,
    transport: (given) => guarded(makeElectronOfflineTransport()(given)),
    release: `vivid-desktop@${app.getVersion()}${commit}`,
    environment: 'production',
    ipcMode: IPCMode.Protocol,
    getSessions: () => [session.fromPartition(APP_PARTITION)],
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
    integrations: (defaults) => [
      ...defaults.filter(
        ({ name }) =>
          name !== 'SentryMinidump' && name !== 'MainProcessSession' && name !== 'ChildProcess',
      ),
      childProcessIntegration({
        events: ['abnormal-exit', 'launch-failed', 'integrity-failure', 'crashed', 'oom'],
      }),
    ],
    beforeSend: scrub,
    beforeBreadcrumb: scrubBreadcrumb,
  })
  started = Option.isSome(outcome)
}
