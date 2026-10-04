import { cutFault } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import * as Updates from 'expo-updates'
import { Platform } from 'react-native'
import { start } from './app'
import { origin } from './origin'

/**
 * Telling the server that the app failed, so the failure can be read in the server's log
 * (`Fault` in `@vivid/contracts`, `apps/server/src/http/faults.ts`). A phone has nowhere else its
 * errors can be seen: `ui/Recover.tsx` catches a screen that cannot be drawn so the Person keeps
 * a way on, and without this nobody but them would know.
 *
 * It depends on as little as it can, because it runs when something is already broken: the
 * build's own address (`origin.ts`), not a session, and one request with no retry. A report that
 * cannot be sent is dropped; there is nobody left to tell.
 */

class FaultUnsent extends Schema.TaggedError<FaultUnsent>()(
  'FaultUnsent',
  {},
  { title: 'Fault report not sent' },
) {}

/** Which build failed: the platform, the binary's runtime version and the update it is running. */
const build = () =>
  [
    Platform.OS,
    String(Platform.Version),
    `runtime ${Updates.runtimeVersion === null ? 'none' : Updates.runtimeVersion}`,
    `update ${Updates.updateId === null ? 'embedded' : Updates.updateId}`,
  ].join(' ')

/**
 * Reports one caught error. `components` is React's component stack when the error was caught
 * while drawing, and null otherwise. A build that was given no server has nowhere to report to.
 */
export const reportFault = (thrown: Error, components: string | null): void => {
  if (Option.isNone(origin)) return
  const address = `${origin.value}/api/faults`
  const body = JSON.stringify(cutFault({ surface: 'mobile', thrown, components, build: build() }))
  void start(
    Effect.tryPromise({
      try: () =>
        fetch(address, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
      catch: () => new FaultUnsent({}),
    }).pipe(Effect.ignore),
  )
}

/**
 * Also reports an error nothing caught: one thrown outside drawing, in an event handler or a
 * timer, which React's boundary never sees. React Native hands those to one global handler; this
 * reports and then does what the handler before it did, so a fatal error still ends the app the
 * way it would have. Called once at launch (`index.ts`).
 */
export const watchFaults = (): void => {
  const before = ErrorUtils.getGlobalHandler()
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    // JavaScript can throw any value; only an `Error` has a message and a stack to report.
    reportFault(error instanceof Error ? error : new Error(String(error)), null)
    before(error, isFatal)
  })
}
