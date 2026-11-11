import * as NodeWS from 'ws'
import { Duration, Effect, Option, Predicate, Redacted, Stream } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as Socket from 'effect/socket/Socket'
import { type PersonId, type SessionId } from '@vivid/contracts'
import { ServerConfig } from '../config.ts'
import { Changes, Topic, everyPart } from '../live/changes.ts'
import { authenticate, sessionWorkspace } from '../auth/session.ts'
import { ComputerStore, computerScreenAddress } from './store.ts'

/** Only bounds the upstream viewer opening handshake. Source: unmeasured. Expiry returns
 * 502 before the browser upgrade; established screen streams live with their route scope. */
const VIEWER_OPEN_DEADLINE = Duration.seconds(10)

const notFound = () =>
  HttpServerResponse.empty({ status: 404, headers: { 'cache-control': 'no-store' } })

/** An upgraded connection stays inside the route fiber and closes both transports when either leg ends. */
const relay = Effect.fn('Computer.screen.relay')(function* (
  request: HttpServerRequest.HttpServerRequest,
  endpoint: { readonly address: string; readonly authorization: Redacted.Redacted },
) {
  const upstream = yield* Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.sync(
        () =>
          new NodeWS.WebSocket(endpoint.address, ['binary'], {
            headers: { authorization: Redacted.value(endpoint.authorization) },
          }),
      ),
      (socket) => Effect.sync(() => socket.close(1000)),
    ),
    { openTimeout: VIEWER_OPEN_DEADLINE },
  )
  // Dial first: a dead provider must not leave the browser with a successful but unusable upgrade.
  const source = yield* upstream.reader
  const outgoing = yield* upstream.writer
  const client = yield* request.upgrade
  const incoming = yield* client.reader
  const destination = yield* client.writer
  yield* Effect.raceFirst(
    source.pull.pipe(
      Effect.flatMap((frames) => destination.writeAll(frames)),
      Effect.forever,
    ),
    incoming.pull.pipe(
      Effect.flatMap((frames) => outgoing.writeAll(frames)),
      Effect.forever,
    ),
  ).pipe(
    Effect.catchTag('SocketError', (error) =>
      Predicate.isTagged(error.reason, 'SocketCloseError') && error.reason.code === 1000
        ? Effect.void
        : Effect.logWarning('Computer screen transport ended', error.reason._tag),
    ),
  )
  return HttpServerResponse.empty()
})

/** Match the configured browser origin, including scheme and port; a cookie alone is insufficient. */
export const screenOriginAllowed = (origin: Option.Option<string>, publicUrl: URL): boolean => {
  if (Option.isNone(origin)) return false
  const parsed = URL.parse(origin.value)
  return parsed !== null && origin.value === parsed.origin && parsed.origin === publicUrl.origin
}

/** Subscribe before dialing so a Computer stop cannot be missed. Session revocation/expiry is
 * checked against fresh durable session state at least every five seconds, bypassing cookie cache.
 * Completing this effect interrupts the scoped relay and releases both socket acquisitions.
 */
export const screenLifetime = Effect.fn('Computer.screen.lifetime')(function* (identity: {
  readonly personId: PersonId
  readonly sessionId: SessionId
}) {
  const changes = yield* Changes
  const store = yield* ComputerStore
  const moved = yield* changes.subscribe([Topic.person(identity.personId)], everyPart)
  /** Session loss or provider absence ends transport authority even if neither socket has closed. */
  const check = Effect.fn('Computer.screen.checkLifetime')(function* () {
    yield* sessionWorkspace(identity.personId, identity.sessionId)
    return Option.isNone(yield* store.screen(identity.personId))
  })
  // @effect-diagnostics-next-line returnEffectInGen:off -- the subscription is acquired here, before dialing; the returned program is the lifetime the caller races beside the relay
  return Stream.concat(Stream.make(undefined), Stream.merge(moved, Stream.tick('5 seconds'))).pipe(
    Stream.mapEffect(() => check()),
    Stream.filter((ended) => ended),
    Stream.runHead,
    Effect.asVoid,
    Effect.catchTag('Unauthenticated', () => Effect.void),
  )
})

/** Only the exact cookie-authenticated RFB upgrade is served; container documents can never execute on Vivid's origin. */
const screen = Effect.fn('Computer.screen')(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const config = yield* ServerConfig
  const url = new URL(request.url, config.PUBLIC_URL)
  if (
    request.method !== 'GET' ||
    request.headers.upgrade !== 'websocket' ||
    url.pathname !== computerScreenAddress ||
    url.search !== '' ||
    !screenOriginAllowed(Option.fromUndefinedOr(request.headers.origin), config.PUBLIC_URL)
  )
    return notFound()
  const auth = yield* authenticate(new Headers(Object.entries(request.headers))).pipe(
    Effect.asSome,
    Effect.catchTag('Unauthenticated', () => Effect.succeedNone),
  )
  if (Option.isNone(auth)) return notFound()
  const store = yield* ComputerStore
  const endpoint = yield* store.screen(auth.value.person.id)
  if (Option.isNone(endpoint)) return notFound()
  const ended = yield* screenLifetime({
    personId: auth.value.person.id,
    sessionId: auth.value.sessionId,
  })
  return yield* Effect.raceFirst(
    relay(request, endpoint.value),
    ended.pipe(Effect.as(HttpServerResponse.empty())),
  )
})

/** NodeHttpServer's pinned upgrade handler invokes HttpRouter and supplies request.upgrade; no separate server hook is needed. */
export const computerScreenRoutes = HttpRouter.add(
  '*',
  '/api/computer/screen/*',
  screen().pipe(
    Effect.scoped,
    Effect.catchTags({
      SocketError: (error) =>
        Effect.logWarning('Computer screen could not connect', error.reason._tag).pipe(
          Effect.as(HttpServerResponse.empty({ status: 502 })),
        ),
      HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    }),
    Effect.catchTag(
      ['DatabaseFailure', 'DatabaseUnavailable', 'DatabaseConstraintViolation'],
      (error) =>
        Effect.logError('Computer screen authority check failed', error._tag).pipe(
          Effect.as(HttpServerResponse.empty({ status: 503 })),
        ),
    ),
  ),
)
