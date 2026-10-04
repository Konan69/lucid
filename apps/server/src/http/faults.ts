import { Fault } from '@vivid/contracts'
import * as ByteSize from 'effect/ByteSize'
import * as Effect from 'effect/Effect'
import * as HttpIncomingMessage from 'effect/unstable/http/HttpIncomingMessage'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'

/**
 * Where a client reports that it failed to draw (`Fault` in `@vivid/contracts`). The report is
 * written to the server's log and nowhere else: the log is what is read when something breaks,
 * and a phone has no other place its errors can be seen.
 *
 * It is plain HTTP and takes no session, because a screen can break before anyone has signed in
 * and a client that is failing may not have a working connection to anything else. That makes it
 * open to anyone, so the body is capped well above the contract's own limits and a body that is
 * not a `Fault` is refused without being logged.
 */
const LARGEST_REPORT = ByteSize.bytes(64 * 1024)

const report = Effect.fn('Http.Faults.report')(function* () {
  const fault = yield* HttpServerRequest.schemaBodyJson(Fault)
  yield* Effect.logError(`Client fault (${fault.surface}): ${fault.message}`).pipe(
    Effect.annotateLogs({
      build: fault.build,
      stack: fault.stack,
      components: fault.components,
    }),
  )
  return HttpServerResponse.empty({ status: 204 })
})

export const faultRoutes = HttpRouter.add(
  'POST',
  '/api/faults',
  report().pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, LARGEST_REPORT),
    Effect.catchTags({
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    }),
  ),
)
