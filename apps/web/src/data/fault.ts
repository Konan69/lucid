import { cutFault } from '@vivid/contracts'
import { Effect, Schema } from 'effect'

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
  // The report is built inside the program, so nothing here can throw into the boundary that
  // called it: a report that cannot even be written is dropped like one unsent.
  const report = Effect.try({
    try: () =>
      JSON.stringify(cutFault({ surface: 'web', thrown, components, build: navigator.userAgent })),
    catch: () => new FaultUnsent({}),
  }).pipe(
    Effect.flatMap((body) =>
      Effect.tryPromise({
        try: () =>
          fetch('/api/faults', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          }),
        catch: () => new FaultUnsent({}),
      }),
    ),
    Effect.ignore,
  )
  // The runtime boundary (`./app`) opens the app's socket when it is first loaded, so it is
  // loaded here, when a fault is reported, and not when this module is: a component that only
  // draws (`ui/Recover.tsx`, and so `ui/Markdown.tsx`) must not need a browser page to be imported.
  // In the running app that module is already loaded, so this resolves at once.
  void import('./app').then(({ send }) => send(report))
}
