import { NodeHttpServerRequest } from '@effect/platform-node'
import { NodeWS } from '@effect/platform-node/NodeSocket'
import type * as NodeStream from 'node:stream'
import { Effect, Option } from 'effect'
import type { PersonId } from '@vivid/contracts'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as Socket from 'effect/socket/Socket'
import {
  EGRESS_BEAT,
  EGRESS_DEADLINE_MILLIS,
  EGRESS_FRAME_LIMIT,
  EGRESS_PATH,
  EGRESS_PING_MILLIS,
} from '@vivid/contracts'
import { authenticate } from '../../auth/session.ts'
import { ServerConfig } from '../../config.ts'
import { sessionEnded } from '../../live/query.ts'
import { screenOriginAllowed } from '../screen.ts'
import { Egress, type ExitSocket, flushed } from './relay.ts'

const notFound = () =>
  HttpServerResponse.empty({ status: 404, headers: { 'cache-control': 'no-store' } })

/**
 * Where an egress socket's messages are received: a WebSocket boundary of its own, which takes
 * no message longer than a frame (`EGRESS_FRAME_LIMIT`, which counts the frame's own five
 * bytes).
 *
 * The server's shared boundary (`NodeHttpServer`, `request.upgrade`) keeps the `ws` package's
 * limit of 100 MiB, which its other sockets rely on, and `ws` puts a message together before it
 * hands it over: a message sent in pieces was held whole, up to that limit, before the relay's
 * own check on its length ever ran. Here `ws` refuses at the piece that crosses the limit and
 * closes the socket with 1009, so a socket of this kind, joined or parked or waiting its turn,
 * never holds more than one frame of what the app sent.
 */
const receiving = new NodeWS.WebSocketServer({ noServer: true, maxPayload: EGRESS_FRAME_LIMIT })

/**
 * Nothing is handed on from the upgrade request's own read: a client sends no frame before it
 * has the answer to its handshake (RFC 6455, section 4.1), and the server's upgrade handler
 * does not give a route the bytes that came with the request.
 */
const NO_HEAD = Buffer.alloc(0)

/** The socket closed before it was a WebSocket: the handshake was refused, or the app went. */
const unopened = () =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({
      kind: 'Unknown',
      cause: new Error('The socket closed before the upgrade'),
    }),
  })

/**
 * Closes an egress socket and waits until its connection is gone.
 *
 * The wait is what keeps the connection clean. This route upgrades the connection itself, so
 * the server's handler does not know it was upgraded, and writes the route's HTTP response to
 * any connection that is still open when the route returns. A connection that has closed gets
 * nothing. `ws` closes it when the app answers the close, or after its own thirty seconds.
 */
const closed = (socket: NodeWS.WebSocket, wire: NodeStream.Duplex) =>
  Effect.callback<void>((resume) => {
    if (wire.destroyed) return resume(Effect.void)
    wire.once('close', () => resume(Effect.void))
    return socket.close(1000)
  })

/** How many pings in a row may go by with nothing heard before the socket is gone. */
const QUIET_PINGS = EGRESS_DEADLINE_MILLIS / EGRESS_PING_MILLIS

/**
 * Asks an egress socket whether its app is still there, for as long as the scope holds it, and
 * ends it when the answer stops coming (the contract's `EGRESS_PING_MILLIS`).
 *
 * Without this a socket was held until TCP said it had closed, and a computer that sleeps says
 * nothing: its socket stayed the Person's way out, the browser's connections went to it and
 * hung, and a second app waited behind it for as long as the server ran. This is the same for
 * every socket of this kind, joined or parked or waiting its turn, because it belongs to the
 * socket and not to what the relay is doing with it.
 *
 * Anything that arrives counts, a frame as much as the answer to a ping: an app that is busy
 * carrying a page is there. A check that finds the socket paused is not counted either way. It
 * is paused by this server, which has not yet passed on what the app sent (`relay.ts`,
 * `pumped`), and a socket that is not read can bring neither a frame nor an answer; holding the
 * app to a deadline then would end a healthy one for the Computer's slowness. The pause ends
 * when the Computer takes what waits or its channel goes, and the count goes on from there.
 *
 * `terminate` ends the connection without a close handshake, which a gone app would not answer.
 * The read of the socket then fails, and the hold ends as it does when an app closes its own.
 */
const watched = (socket: NodeWS.WebSocket) => {
  const quiet = { pings: 0 }
  const heard = () => {
    quiet.pings = 0
  }
  socket.on('pong', heard)
  socket.on('message', heard)
  const check = Effect.sync(() => {
    if (socket.readyState !== NodeWS.WebSocket.OPEN || socket.isPaused) return
    quiet.pings += 1
    if (quiet.pings >= QUIET_PINGS) return socket.terminate()
    socket.ping()
    // What a desktop app can see: its own deadline runs on this (`EGRESS_BEAT`).
    return socket.send(EGRESS_BEAT)
  })
  return Effect.forkScoped(
    Effect.sleep(EGRESS_PING_MILLIS).pipe(Effect.andThen(check), Effect.forever),
  )
}

/**
 * A request's upgraded WebSocket as the relay holds it (`relay.ts`, `ExitSocket`), upgraded at
 * the egress boundary (`receiving`).
 *
 * Effect's socket says nothing about what it has written and not sent, and the relay must know,
 * or it reads the Computer as fast as the Computer sends while a slow app's frames pile up
 * here. The frames are written by `ws` straight onto the request's own TCP socket (it holds
 * nothing back itself without compression, which this server does not turn on: `ws`
 * `bufferedAmount` is that socket's queue plus its own, and its own is the compressor's), so
 * that socket's queue is the true amount, and its `drain` is the moment it has gone.
 */
export const exitSocket = Effect.fn('Egress.exitSocket')(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const incoming = NodeHttpServerRequest.toIncomingMessage(request)
  const wire = incoming.socket
  const upgraded = yield* Effect.acquireRelease(
    Effect.callback<NodeWS.WebSocket, Socket.SocketError>((resume) => {
      const gone = () => resume(Effect.fail(unopened()))
      if (wire.destroyed) return gone()
      wire.once('close', gone)
      return receiving.handleUpgrade(incoming, wire, NO_HEAD, (opened) => {
        wire.off('close', gone)
        resume(Effect.succeed(opened))
      })
    }),
    (opened) => closed(opened, wire),
  )
  yield* watched(upgraded)
  const socket = yield* Socket.fromWebSocket(Effect.succeed(upgraded))
  const reader = yield* socket.reader
  const writer = yield* socket.writer
  const held: ExitSocket = {
    pull: reader.pull,
    write: writer.write,
    buffered: () => wire.writableLength,
    drained: flushed(wire),
  }
  return held
})

/**
 * Upgrades a request and holds its socket for a Person until the relay lets it go or `ended`
 * completes. The socket belongs to the scope: whichever way this ends, it is closed, and that
 * close is what tells the desktop app to end its streams and dial again.
 */
export const held = Effect.fn('Egress.held')(function* <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  person: PersonId,
  ended: Effect.Effect<void, E, R>,
) {
  const relay = yield* Egress
  yield* Effect.raceFirst(relay.carry(person, yield* exitSocket(request)), ended)
})

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
  yield* held(
    request,
    auth.value.person.id,
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
    // The app's socket closing, or never becoming one, is how every hold ends; it is not a fault.
    Effect.catchTag('SocketError', () => Effect.succeed(HttpServerResponse.empty())),
    Effect.catchTag(
      ['DatabaseFailure', 'DatabaseUnavailable', 'DatabaseConstraintViolation'],
      (error) =>
        Effect.logError('Egress authority check failed', error._tag).pipe(
          Effect.as(HttpServerResponse.empty({ status: 503 })),
        ),
    ),
  ),
)
