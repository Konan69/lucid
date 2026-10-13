import { Effect, Option } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { EGRESS_PATH } from '@vivid/contracts'
import { authenticate } from '../../auth/session.ts'
import { ServerConfig } from '../../config.ts'
import { sessionEnded } from '../../live/query.ts'
import { screenOriginAllowed } from '../screen.ts'
import { Egress } from './relay.ts'

const notFound = () =>
  HttpServerResponse.empty({ status: 404, headers: { 'cache-control': 'no-store' } })

/**
 * Where a desktop app opens its egress socket: one WebSocket upgrade, as the app's own signed-in
 * session, and nothing else at this address. It is checked the way the Computer's screen is
 * (`screen.ts`): the exact path, the server's own origin, and a session that is read from the
 * request, so a page elsewhere cannot open it with a Person's cookie.
 *
 * The socket lives as long as its session: `sessionEnded` fails the moment the session is signed
 * out, revoked or runs out, and the hold ends with it, so a signed-out app is never the way out.
 */
const egress = Effect.fn('Egress.route')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const url = new URL(request.url, config.PUBLIC_URL)
  if (
    request.method !== 'GET' ||
    request.headers.upgrade !== 'websocket' ||
    url.pathname !== EGRESS_PATH ||
    url.search !== '' ||
    !screenOriginAllowed(Option.fromUndefinedOr(request.headers.origin), config.PUBLIC_URL)
  )
    return notFound()
  const auth = yield* authenticate(new Headers(Object.entries(request.headers))).pipe(
    Effect.asSome,
    Effect.catchTag('Unauthenticated', () => Effect.succeedNone),
  )
  if (Option.isNone(auth)) return notFound()
  const relay = yield* Egress
  const socket = yield* request.upgrade
  const reader = yield* socket.reader
  const writer = yield* socket.writer
  yield* Effect.raceFirst(
    relay.carry(auth.value.person.id, { pull: reader.pull, write: writer.write }),
    sessionEnded(auth.value.person.id, auth.value.sessionId).pipe(
      Effect.catchTag('Unauthenticated', () => Effect.void),
    ),
  )
  return HttpServerResponse.empty()
})

/** NodeHttpServer's upgrade handler invokes HttpRouter and supplies `request.upgrade` (`screen.ts`). */
export const egressRoutes = HttpRouter.add(
  '*',
  EGRESS_PATH,
  egress().pipe(
    Effect.scoped,
    Effect.catchTags({
      // The app's socket closing is how every hold ends; it is not a fault.
      SocketError: () => Effect.succeed(HttpServerResponse.empty()),
      HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    }),
    Effect.catchTag(
      ['DatabaseFailure', 'DatabaseUnavailable', 'DatabaseConstraintViolation'],
      (error) =>
        Effect.logError('Egress authority check failed', error._tag).pipe(
          Effect.as(HttpServerResponse.empty({ status: 503 })),
        ),
    ),
  ),
)
