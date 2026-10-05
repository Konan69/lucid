import { init as startInDesktop, makeRendererTransport } from '@sentry/electron/renderer'
import { captureReactException, init, makeFetchTransport } from '@sentry/react'
import { Option } from 'effect'
import type { ErrorInfo } from 'react'
import { settings, startsIn } from './options'

/**
 * Sending the web app's errors to Sentry, beside the report `fault.ts` sends to Vivid's own
 * server. That one carries the message and is read in the server's log; this one is what alerts,
 * counts and groups, and it carries only what `scrub.ts` allows.
 *
 * The same built pages run in two places, and each reports to its own Sentry project:
 * - In a browser this starts `@sentry/react` with the web project's address below.
 * - In the desktop app the pages are loaded by its shell (`apps/desktop/src/main/renderer.ts`),
 *   whose session refuses every request that is not to the selected Vivid (`secureSession`), so
 *   a report could not reach Sentry from the page at all. There this starts
 *   `@sentry/electron/renderer` instead, around the same React SDK: it hands each report to the
 *   desktop's main process, which sends it to the desktop project
 *   (`apps/desktop/src/main/telemetry.ts`). The page is given no address of its own there, so it
 *   is never started twice. It starts only when the shell says its main process is reporting
 *   (`reporting` on the bridge): a shell run from source reports nothing, and a page that started
 *   anyway would instrument itself and call a main process that is not listening.
 *
 * "In the desktop app" means in its own window. Vivid opened in the desktop app's browser pane is
 * a page in a browser view, with no bridge, and takes the first way (`startsIn` in `options.ts`).
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
 * Starts reporting. Called once by the entry (`main.tsx`) before anything is drawn, so an error
 * while the first screen is drawn is reported too. Where it starts, if anywhere, is `startsIn`
 * (`options.ts`); what it starts with is `settings` there, around the SDK's own transport for the
 * place: in a browser its fetch transport, in the desktop app's window the one that hands a
 * report to the main process.
 *
 * A start that throws is left at that. This runs before the app is drawn, so an exception here
 * would be a blank page, and reporting errors is not worth the app. Nothing is reported for that
 * visit and nothing else is tried: there is no second way to report that would be any safer.
 */
export const startTelemetry = (): void => {
  // The desktop app's preload puts its bridge on its own window (`data/pages.ts`); nothing else does.
  const shell = 'vivid' in globalThis
  const start = startsIn({
    production: import.meta.env.PROD,
    shell,
    // A shell built before the bridge said whether it reports has no such field, which is a no.
    reporting: shell && globalThis.vivid.reporting,
  })
  if (start === 'Shell')
    Option.liftThrowable(() => startInDesktop(settings(makeRendererTransport), init))()
  if (start === 'Browser')
    Option.liftThrowable(init)({
      ...settings(makeFetchTransport),
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
