import { cutFault } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { send } from './app'

/**
 * Telling the server that the app failed to draw, so the failure can be read in the server's log
 * (`Fault` in `@vivid/contracts`, `apps/server/src/http/faults.ts`). `ui/Recover.tsx` catches a
 * part that cannot be drawn so the Person keeps a way on; without this only they would know.
 *
 * One request to the app's own origin with no retry, and nothing of the app's client: it runs
 * when something is already broken. A report that cannot be sent is dropped.
 */

class FaultUnsent extends Schema.TaggedError<FaultUnsent>()(
  'FaultUnsent',
  {},
  { title: 'Fault report not sent' },
) {}

/** Reports one error caught while drawing, with React's component stack for it. */
export const reportFault = (thrown: Error, components: string | null): void => {
  const body = JSON.stringify(
    cutFault({ surface: 'web', thrown, components, build: navigator.userAgent }),
  )
  void send(
    Effect.tryPromise({
      try: () =>
        fetch('/api/faults', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      catch: () => new FaultUnsent({}),
    }).pipe(Effect.ignore),
  )
}
