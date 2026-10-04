import { Fault } from '@vivid/contracts'
import * as ByteSize from 'effect/ByteSize'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as HttpIncomingMessage from 'effect/unstable/http/HttpIncomingMessage'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { observeFailures } from '../observability/failure.ts'

/**
 * Where a client reports that it failed to draw (`Fault` in `@vivid/contracts`). The report is
 * written to the server's log and nowhere else: the log is what is read when something breaks,
 * and a phone has no other place its errors can be seen.
 *
 * It is plain HTTP and takes no session, because a screen can break before anyone has signed in
 * and a client that is failing may not have a working connection to anything else. That makes it
 * open to anyone, so three things bound what a stranger can do with it:
 * - A body that is not a `Fault` is refused and nothing of it is logged.
 * - A report is logged as one line of JSON. Its text is the sender's, and JSON escapes line
 *   breaks and control characters, so a report cannot write a second log line of its own.
 * - Only so many reports are logged in a minute, counted for the whole server, and the rest are
 *   turned away before their body is read. A real failure repeats; the first few say everything.
 */

/**
 * Several times the largest honest report: the contract bounds text in characters, and a
 * character can take three bytes and JSON escaping can double them. A body over the cap ends the
 * connection without an answer (Node drops the socket when the reader gives up), which only a
 * sender that ignores the contract ever sees.
 */
const LARGEST_REPORT = ByteSize.bytes(128 * 1024)

/** How many reports are logged in one window, across every client. */
export const REPORTS_PER_WINDOW = 30
export const WINDOW_MILLIS = 60_000

class ReportsOverBudget extends Schema.TaggedError<ReportsOverBudget>()(
  'ReportsOverBudget',
  {},
  { title: 'Fault reports over budget' },
) {}

interface Window {
  readonly startedAt: number
  readonly count: number
}

/** Counts one report against the current window, starting a new window once the old one is over. */
const admit = Effect.fn('Http.Faults.admit')(function* (budget: Ref.Ref<Window>) {
  const now = yield* Clock.currentTimeMillis
  const admitted = yield* Ref.modify(budget, (window) => {
    const current = now - window.startedAt >= WINDOW_MILLIS ? { startedAt: now, count: 0 } : window
    return current.count >= REPORTS_PER_WINDOW
      ? [false, current]
      : [true, { ...current, count: current.count + 1 }]
  })
  return yield* admitted ? Effect.void : Effect.fail(new ReportsOverBudget({}))
})

const report = Effect.fn('Http.Faults.report')(function* (budget: Ref.Ref<Window>) {
  yield* admit(budget)
  const fault = yield* HttpServerRequest.schemaBodyJson(Fault)
  yield* Effect.logError(`Client fault ${JSON.stringify(fault)}`)
  return HttpServerResponse.empty({ status: 204 })
})

export const faultRoutes = HttpRouter.use(
  Effect.fn('Http.Faults.register')(function* (router) {
    const budget = yield* Ref.make<Window>({ startedAt: 0, count: 0 })
    yield* router.add(
      'POST',
      '/api/faults',
      report(budget).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, LARGEST_REPORT),
        // A refused report (over budget, unreadable) is counted; the answer below is unchanged.
        observeFailures('http'),
        Effect.catchTags({
          ReportsOverBudget: () => Effect.succeed(HttpServerResponse.empty({ status: 429 })),
          SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
          HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
        }),
      ),
    )
  }),
)
