import type { Integration, Transport } from '@sentry/core'
import type { ElectronMainOptions } from '@sentry/electron/main'
import { guarded, scrub, scrubBreadcrumb } from './scrub.ts'

/**
 * What the desktop app's error reporting is started with, and whether it starts. Both are worked
 * out here, apart from the SDK and from Electron (`telemetry.ts` starts it), so they can be
 * checked in a test: a setting taken out of here by mistake is a report that leaves unscrubbed,
 * and nothing would look wrong.
 */

/** What the SDK hands a transport when it makes one. */
type Given = Parameters<NonNullable<ElectronMainOptions['transport']>>[0]

/** How the SDK is handed the thing that sends: a function from its settings to a transport. */
type Sender = (given: Given) => Transport

/**
 * The parts of the start that only exist inside Electron, handed in by `telemetry.ts`:
 * - `online`: the SDK's transport that sends over Electron's network stack
 *   (`makeElectronTransport`).
 * - `queued`: the SDK's wrapper that keeps on disk what could not be sent and sends it later
 *   (`makeElectronOfflineTransport`), around whichever transport it is given.
 * - `protocol`: the SDK's name for hearing a window's reports over its own scheme
 *   (`IPCMode.Protocol`).
 * - `sessions`: the Chromium sessions that scheme is answered in.
 * - `ended`: the SDK's integration that reports a process that ended, set to report these reasons.
 */
interface Parts {
  readonly online: Sender
  readonly queued: (base: Sender) => Sender
  readonly protocol: NonNullable<ElectronMainOptions['ipcMode']>
  readonly sessions: NonNullable<ElectronMainOptions['getSessions']>
  readonly ended: (reasons: {
    readonly events: ReadonlyArray<
      'abnormal-exit' | 'launch-failed' | 'integrity-failure' | 'crashed' | 'oom'
    >
  }) => Integration
}

/** Only a packaged app reports. One run from source, and a test, do not. */
export const reports = (app: { readonly packaged: boolean }): boolean => app.packaged

/** The SDK's integrations Vivid leaves out or replaces, by the names the SDK gives them. */
const LEFT_OUT = new Set(['SentryMinidump', 'MainProcessSession', 'ChildProcess'])

/**
 * The settings the main process starts the SDK with. Each, and why:
 * - `transport`: the guard is on twice (`guarded` in `scrub.ts`). Around the whole transport, so
 *   only scrubbed error reports are sent or written to the queue on disk, whatever is handed to
 *   it: a window's session records, replays and attachments are passed to this process's client
 *   as they are (`handleEnvelope` in `@sentry/electron` `main/ipc.js`). And again on the
 *   transport under the queue, because the queue sends what it finds on disk straight to that
 *   one (`flushIn` in `@sentry/core` `transports/offline.js`), and what is on disk may have been
 *   written by a build from before the guard.
 * - `ipcMode` with the app's session in `getSessions`: the window sends its reports by a request
 *   to the SDK's `sentry-ipc` scheme, which the SDK answers in the sessions named here. The
 *   window is in the app's own partition, not the default session the SDK assumes. The other
 *   mode needs a preload script the SDK finds by its path in `node_modules`, and this process is
 *   one bundled file (`scripts/build.mjs`), so that path does not exist in a packaged app.
 * - `tracesSampleRate: 0`: errors only. Vivid had a telemetry volume problem.
 * - `dataCollection`: this SDK version (core 11.1.0) has no `sendDefaultPii`. It collects by
 *   default and each kind is turned off by name; `userInfo: false` is also what tells Sentry not
 *   to record the address a report came from (`getSdkInfo` in `main/context.js`).
 * - `SentryMinidump` is left out. It uploads the crash dump Chromium writes when a process dies
 *   in native code, and a dump is a copy of that process's stack memory: it can hold the text of
 *   a Thread, and nothing here could cut that out. So a native crash is reported as the fact
 *   that the process ended (`ended`, told to report `crashed` and `oom` as well, which it
 *   otherwise leaves to the dump) and without the dump.
 * - `MainProcessSession` is left out: a session record for each launch is volume, not an error.
 * - `sendClientReports: false`: the SDK's own counts of what it dropped are not errors either.
 */
export const settings = (parts: Parts) =>
  ({
    transport: (given) => guarded(parts.queued((inner) => guarded(parts.online(inner)))(given)),
    beforeSend: scrub,
    beforeBreadcrumb: scrubBreadcrumb,
    ipcMode: parts.protocol,
    getSessions: parts.sessions,
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
      ...defaults.filter(({ name }) => !LEFT_OUT.has(name)),
      parts.ended({
        events: ['abnormal-exit', 'launch-failed', 'integrity-failure', 'crashed', 'oom'],
      }),
    ],
  }) satisfies ElectronMainOptions
