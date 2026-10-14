import { NodeHttpServerRequest } from '@effect/platform-node'
import { NodeWS } from '@effect/platform-node/NodeSocket'
import type * as NodeStream from 'node:stream'
import { Deferred, Effect, Option } from 'effect'
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
 * How long an app is given to answer the close of its socket: five seconds. An app that is there
 * answers in one round trip; this is for the one that is not. The `ws` package's own wait is
 * thirty seconds, on a timer of its own that no test and no shutdown can move.
 */
export const CLOSE_DEADLINE_MILLIS = 5000

/** Completes once a connection has closed. Interrupted, it stops listening. */
const departed = (wire: NodeStream.Duplex) =>
  Effect.callback<void>((resume) => {
    if (wire.destroyed) return resume(Effect.void)
    const done = () => resume(Effect.void)
    wire.once('close', done)
    return Effect.sync(() => wire.off('close', done))
  })

/**
 * Closes an egress socket and waits until its connection is gone.
 *
 * The wait is what keeps the connection clean. This route upgrades the connection itself, so
 * the server's handler does not know it was upgraded, and writes the route's HTTP response to
 * any connection that is still open when the route returns. A connection that has closed gets
 * nothing.
 *
 * The wait is bounded. `ws` closes the connection when the app answers the close; an app that
 * never answers was waited for, uninterruptibly, for the thirty seconds `ws` takes to give up,
 * and that was how long one such socket held the server's shutdown. Past
 * `CLOSE_DEADLINE_MILLIS` the connection is ended under the socket (`terminate`), and its close
 * is still waited for, which is then a matter of the system and not of the app: the rule that
 * the connection is gone before the route returns holds either way.
 */
const closed = (socket: NodeWS.WebSocket, wire: NodeStream.Duplex) =>
  Effect.sync(() => socket.close(1000)).pipe(
    Effect.andThen(departed(wire)),
    Effect.timeoutOrElse({
      duration: CLOSE_DEADLINE_MILLIS,
      orElse: () => Effect.sync(() => socket.terminate()).pipe(Effect.andThen(departed(wire))),
    }),
  )

/** How many pings in a row may go by with nothing heard before the socket is gone. */
const QUIET_PINGS = EGRESS_DEADLINE_MILLIS / EGRESS_PING_MILLIS

/**
 * Asks an egress socket whether its app is still there, for as long as the scope holds it, and
 * ends it when the answer stops coming (the contract's `EGRESS_PING_MILLIS`). Answers the
 * moment the socket is over: it closed, or it was ended here.
 *
 * Without this a socket was held until TCP said it had closed, and a computer that sleeps says
 * nothing: its socket stayed the Person's way out, the browser's connections went to it and
 * hung, and a second app waited behind it for as long as the server ran. This is the same for
 * every socket of this kind, joined or parked or waiting its turn, because it belongs to the
 * socket and not to what the relay is doing with it.
 *
 * Anything that arrives counts, a frame as much as the answer to a ping: an app that is busy
 * carrying a page is there. One case is not the app's doing. While the Computer takes nothing
 * of what the app sent, this server stops reading the app (`relay.ts`, `pumped`), and a socket
 * that is not read brings neither a frame nor an answer. A Computer that is only slow is read
 * again with each piece it takes, and each piece read is heard here. One that takes nothing
 * for the whole deadline is a join that carries nothing, so its socket is ended like any
 * other, and the app dials again and is joined afresh. No exception is made for it: an
 * exception would keep a socket whose app had gone for as long as the Computer was stuck.
 *
 * `terminate` ends the connection without a close handshake, which a gone app would not answer.
 *
 * The end is told to whoever holds the socket (`held`), and not left for the relay to find when
 * it next reads: a relay that is waiting for the Computer to take something is not reading, and
 * would hold a socket that had ended, and the Person's way out with it, until the Computer
 * moved.
 */
const watched = Effect.fn('Egress.watched')(function* (socket: NodeWS.WebSocket) {
  const over = yield* Deferred.make<void>()
  const quiet = { pings: 0 }
  const heard = () => {
    quiet.pings = 0
  }
  const ended = () => {
    Deferred.doneUnsafe(over, Effect.void)
  }
  socket.on('pong', heard)
  socket.on('message', heard)
  socket.once('close', ended)
  const check = Effect.sync(() => {
    if (socket.readyState !== NodeWS.WebSocket.OPEN) return
    quiet.pings += 1
    if (quiet.pings >= QUIET_PINGS) {
      socket.terminate()
      ended()
      return
    }
    socket.ping()
    // What a desktop app can see: its own deadline runs on this (`EGRESS_BEAT`).
    socket.send(EGRESS_BEAT)
  })
  yield* Effect.forkScoped(
    Effect.sleep(EGRESS_PING_MILLIS).pipe(Effect.andThen(check), Effect.forever),
  )
  return Deferred.await(over)
})

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
  const gone = yield* watched(upgraded)
  const socket = yield* Socket.fromWebSocket(Effect.succeed(upgraded))
  const reader = yield* socket.reader
  const writer = yield* socket.writer
  const app: ExitSocket = {
    pull: reader.pull,
    write: writer.write,
    buffered: () => wire.writableLength,
    drained: flushed(wire),
  }
  /** `gone` completes when the socket is over, whatever the relay is doing with it then. */
  return { ...app, gone }
})

/**
 * Upgrades a request and holds its socket for a Person until the relay lets it go, `ended`
 * completes, or the socket is over (`watched`). The socket belongs to the scope: whichever way
 * this ends, it is closed, and that close is what tells the desktop app to end its streams and
 * dial again.
 */
export const held = Effect.fn('Egress.held')(function* <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  person: PersonId,
  ended: Effect.Effect<void, E, R>,
) {
  const relay = yield* Egress
  const app = yield* exitSocket(request)
  yield* Effect.raceFirst(relay.carry(person, app), Effect.raceFirst(ended, app.gone))
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
