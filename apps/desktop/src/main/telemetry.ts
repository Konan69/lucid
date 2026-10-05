import {
  IPCMode,
  childProcessIntegration,
  init,
  makeElectronOfflineTransport,
  makeElectronTransport,
} from '@sentry/electron/main'
import * as Option from 'effect/Option'
import { app, session } from 'electron'
import { reports, settings } from './options.ts'
import { APP_PARTITION } from './session.ts'

/**
 * Sending the desktop app's errors to Sentry: the main process's own, and every one the window
 * hands over. The window draws the web app's pages, and its session refuses each request that is
 * not to the selected Vivid (`secureSession`), so a page cannot reach Sentry by itself. The pages
 * start `@sentry/electron/renderer` instead (`apps/web/src/data/telemetry.ts`), which passes each
 * report here, and this process sends it. Everything the main process and the app's own window
 * report therefore goes to the one desktop project and through the one `scrub`.
 *
 * That is the app's own window, not every page the app can show. Vivid opened in the browser
 * pane (`browser.ts`) is a guest with no preload and no bridge: there it is the web app in a
 * browser view, and it reports to the web project by itself, as it would in any browser, whether
 * or not this process is reporting (`startsIn` in `apps/web/src/data/options.ts`).
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
 * Whether it starts is `reports` and what it starts with is `settings`, both in `options.ts`,
 * which is given here the parts that only exist inside Electron.
 *
 * A start that throws leaves `reporting` false and is left at that. This is the first thing the
 * app does, so an exception here would be an app that does not open, and reporting errors is not
 * worth the app. Nothing else is tried: there is no second way to report that would be any safer.
 */
export const startTelemetry = (): void => {
  if (!reports({ packaged: app.isPackaged })) return
  const commit = __VIVID_COMMIT__ === '' ? '' : `+${__VIVID_COMMIT__.slice(0, 12)}`
  const outcome = Option.liftThrowable(init)({
    ...settings({
      online: makeElectronTransport,
      queued: makeElectronOfflineTransport,
      protocol: IPCMode.Protocol,
      sessions: () => [session.fromPartition(APP_PARTITION)],
      ended: childProcessIntegration,
    }),
    dsn: ADDRESS,
    release: `vivid-desktop@${app.getVersion()}${commit}`,
    environment: 'production',
  })
  started = Option.isSome(outcome)
}
