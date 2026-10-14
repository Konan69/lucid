import {
  EGRESS_PATH,
  EgressFrame,
  type EgressStream,
  decodeEgressFrame,
  encodeEgressFrame,
} from '@vivid/contracts'
import * as NodeNet from 'node:net'
import * as Arr from 'effect/Array'
import type * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Result from 'effect/Result'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import type { Unresolved } from './reach.ts'
import { isReserved } from './reserved.ts'

/**
 * This computer as the way out for the Computer's browser (`packages/contracts/src/egress.ts`).
 *
 * The app dials out to its server and holds one socket open. Over it the Computer asks for
 * connections; this module resolves each name here, dials the place from here, and carries the
 * bytes both ways. A site the Computer's browser opens therefore sees this computer's address,
 * which is the address the Person signed in from.
 *
 * It is a port of Grok Bot's exit client
 * (`grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts`,
 * `EgressTunnelExitClient`), and keeps its mechanism: the frames, a stream table keyed by the
 * stream number, bytes that arrive before the target is dialled held and then written in order,
 * a refused or unresolvable target answered with a close, a bound on what is queued toward the
 * tunnel, and reconnecting after two seconds, doubling, to at most thirty. Two things are
 * Vivid's:
 *
 * - The reference dials the machine's own hosted port. Vivid's Computer has no port a home
 *   network can be sure of reaching (it may have an IPv6 address only), so the app dials its
 *   server, as its own signed-in session, and the server joins the socket to the Computer over
 *   the SSH connection it already holds (`apps/server/src/computers/egress/`).
 * - The reference's socket is the `ws` package's, which calls back when a send has left. This
 *   app's is Electron's, a web `WebSocket`, which has no such call: the queue is looked at
 *   again on a short timer while a target is paused (`draining`).
 */

/** Where the tunnel is opened on a chosen server: the same origin, on the socket scheme. */
export const egressAddress = (origin: string) => `${origin.replace(/^http/u, 'ws')}${EGRESS_PATH}`

/**
 * Whether a cookie is the app's session: Better Auth's session token, whose name ends in
 * `session_token` whatever prefix the server gives it (`device.ts`, `sessionChanges`).
 */
export const isSessionCookie = (name: string) => name.endsWith('session_token')

/**
 * The part of a web `WebSocket` the exit client uses. Electron's `net.WebSocket` in the app, a
 * socket to the real Computer-side proxy in the tests.
 */
export interface ExitSocket {
  binaryType: string
  /** Bytes handed to `send` that have not left yet. */
  readonly bufferedAmount: number
  readonly send: (data: Uint8Array) => void
  readonly close: () => void
  readonly addEventListener: (
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: Event) => void,
  ) => void
}

/**
 * How much may wait to be sent to the tunnel before a target is paused: one mebibyte, the
 * reference's own bound. A fast site and a slow tunnel would otherwise fill this app's memory.
 */
export const QUEUE_BOUND = 1 << 20

/** How often the queue is looked at again while a target is paused, in milliseconds. */
const DRAIN_MILLIS = 10

/**
 * What the exit is doing, as last seen on this computer.
 *
 * - `Off`: nothing is dialled: no server is chosen or nobody is signed in.
 * - `Connecting`: dialling, or waiting to dial again.
 * - `Connected`: the socket is open. `active` connections are being carried now; `relayed` is
 *   how many were dialled since it opened.
 */
export const ExitStatus = Schema.TaggedUnion({
  Off: {},
  Connecting: {},
  Connected: { relayed: Schema.Int, active: Schema.Int },
})
export type ExitStatus = typeof ExitStatus.Type

/** The socket closed before it ever opened: the server is not there, or said no. */
class ExitUnopened extends Schema.TaggedError<ExitUnopened>()(
  'ExitUnopened',
  {},
  { title: 'The egress tunnel could not be opened' },
) {}

export interface ExitDependencies {
  /** Opens the tunnel's socket as the app's session. Nothing means there is nobody to dial as. */
  readonly socket: () => Option.Option<ExitSocket>
  /** What a name leads to, asked on this computer (`reach.ts`, `resolveHost`). */
  readonly resolve: (host: string) => Effect.Effect<ReadonlyArray<string>, Unresolved>
  /** Dials one checked address. `node:net`'s `createConnection` in the app. */
  readonly dial: (address: string, port: number) => NodeNet.Socket
  /**
   * Whether a target inside this computer's own networks may be dialled. Never in the app; a
   * test that serves from loopback says so.
   */
  readonly allowPrivateTargets: boolean
  readonly onStatus: (status: ExitStatus) => void
}

/**
 * The address to dial for a host, or nothing when there is none that may be dialled.
 *
 * A name is resolved here and the first address that is allowed is the one dialled: the
 * connection goes to the address that was checked, never to the name again, so a name that
 * answers differently a moment later (DNS rebinding) cannot move the connection into the
 * Person's network after the check (the reference's `resolveChecked`).
 */
export const checkedAddress = Effect.fn('DesktopEgress.checkedAddress')(function* (
  host: string,
  dependencies: Pick<ExitDependencies, 'resolve' | 'allowPrivateTargets'>,
) {
  const allowed = (address: string) => dependencies.allowPrivateTargets || !isReserved(address)
  if (NodeNet.isIP(host) !== 0) return allowed(host) ? Option.some(host) : Option.none<string>()
  const found = yield* dependencies
    .resolve(host)
    .pipe(Effect.catchTag('Unresolved', () => Effect.succeed<ReadonlyArray<string>>([])))
  return Arr.findFirst(found, allowed)
})

/**
 * The bytes of a message event. The socket is asked for `arraybuffer`; a socket over Node hands
 * over a `Buffer`. Anything else (text, another kind of event) is not a frame.
 */
const messageBytes = (event: Event): Option.Option<Uint8Array> => {
  if (!(event instanceof MessageEvent)) return Option.none()
  const data: unknown = event.data
  if (data instanceof Uint8Array) return Option.some(data)
  if (data instanceof ArrayBuffer) return Option.some(new Uint8Array(data))
  return Option.none()
}

/**
 * Holds back the targets that send faster than the tunnel drains (`QUEUE_BOUND`).
 *
 * A target is paused when what it just sent left more than the bound waiting, and every paused
 * target is resumed once the queue is back under it. A web socket says nothing when it has
 * sent, so the queue is asked on a timer; the timer does nothing while nothing is paused, and
 * does not keep the app from quitting.
 */
const draining = (socket: ExitSocket) => {
  const paused = new Set<NodeNet.Socket>()
  const timer = setInterval(() => {
    if (paused.size === 0 || socket.bufferedAmount > QUEUE_BOUND) return
    for (const target of paused) target.resume()
    paused.clear()
  }, DRAIN_MILLIS)
  timer.unref()
  return {
    /** Called after each send for a target: pauses it when the queue is over the bound. */
    sent: (target: NodeNet.Socket) => {
      if (socket.bufferedAmount <= QUEUE_BOUND) return
      target.pause()
      paused.add(target)
    },
    forget: (target: NodeNet.Socket) => {
      paused.delete(target)
    },
    stop: () => {
      clearInterval(timer)
      paused.clear()
    },
  }
}

/** A stream whose target is still being resolved: what arrived for it meanwhile. */
interface Resolving {
  readonly pending: Array<Uint8Array>
  closedByPeer: boolean
}

/**
 * One open socket, from its first event to its close. Answers whether it ever opened.
 *
 * Frames are handled one at a time, in the order they arrived; only resolving a name is forked,
 * so the data that follows an open is held for that stream and not lost. The scope owns
 * everything: when it closes, every target is destroyed, the timer is cleared and the socket is
 * closed.
 */
const carry = Effect.fn('DesktopEgress.carry')(function* (
  dependencies: ExitDependencies,
  socket: ExitSocket,
) {
  const inbox = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const resolving = new Map<EgressStream, Resolving>()
  const relaying = new Map<EgressStream, NodeNet.Socket>()
  const flow = draining(socket)
  const state = { open: false, closed: false, relayed: 0 }
  const publish = () =>
    dependencies.onStatus(
      state.open && !state.closed
        ? ExitStatus.cases.Connected.make({ relayed: state.relayed, active: relaying.size })
        : ExitStatus.cases.Connecting.make({}),
    )
  const send = (frame: EgressFrame) => {
    if (state.open && !state.closed) socket.send(encodeEgressFrame(frame))
  }

  socket.binaryType = 'arraybuffer'
  socket.addEventListener('open', () => {
    state.open = true
    publish()
  })
  socket.addEventListener('message', (event) => {
    Option.map(messageBytes(event), (bytes) => Queue.offerUnsafe(inbox, bytes))
  })
  // A failure is always followed by a close, which is what ends this socket.
  socket.addEventListener('error', () => undefined)
  socket.addEventListener('close', () => {
    state.closed = true
    Queue.endUnsafe(inbox)
  })
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      state.closed = true
      flow.stop()
      for (const target of relaying.values()) target.destroy()
      relaying.clear()
      resolving.clear()
      socket.close()
    }),
  )

  /** A target ended, by itself or by failing: the Computer is told once, and it is forgotten. */
  const ended = (stream: EgressStream, target: NodeNet.Socket) => {
    if (relaying.get(stream) !== target) return
    relaying.delete(stream)
    flow.forget(target)
    target.destroy()
    send(EgressFrame.cases.Close.make({ stream }))
    publish()
  }

  /**
   * Resolves, checks and dials one target. The stream may be gone by the time the name
   * resolves (the socket closed, or the Computer closed the stream and opened it again), and
   * then nothing is dialled.
   */
  const open = Effect.fn('DesktopEgress.open')(function* (
    stream: EgressStream,
    host: string,
    port: number,
    entry: Resolving,
  ) {
    const address = yield* checkedAddress(host, dependencies)
    if (resolving.get(stream) !== entry) return
    resolving.delete(stream)
    if (Option.isNone(address) || state.closed) {
      // Unresolvable, or it leads into this computer's own networks: refused with a close.
      send(EgressFrame.cases.Close.make({ stream }))
      return
    }
    const target = dependencies.dial(address.value, port)
    relaying.set(stream, target)
    state.relayed += 1
    publish()
    target.on('data', (payload: Uint8Array) => {
      send(EgressFrame.cases.Data.make({ stream, payload }))
      flow.sent(target)
    })
    target.on('error', () => ended(stream, target))
    target.on('close', () => ended(stream, target))
    for (const payload of entry.pending) target.write(payload)
    if (entry.closedByPeer) target.end()
  })

  const handle = (bytes: Uint8Array) =>
    Result.match(decodeEgressFrame(bytes), {
      // Not a frame of this protocol: dropped, and the tunnel stays (the reference's `handleFrame`).
      onFailure: () => Effect.void,
      onSuccess: (frame) =>
        EgressFrame.match(frame, {
          Open: ({ stream, host, port }) => {
            // A number already in use cannot be two connections: the second is refused.
            if (resolving.has(stream) || relaying.has(stream)) {
              send(EgressFrame.cases.Close.make({ stream }))
              return Effect.void
            }
            const entry: Resolving = { pending: [], closedByPeer: false }
            resolving.set(stream, entry)
            return Effect.forkScoped(open(stream, host, port, entry)).pipe(Effect.asVoid)
          },
          Data: ({ stream, payload }) => {
            const target = relaying.get(stream)
            const waiting = resolving.get(stream)
            if (target !== undefined) target.write(payload)
            else if (waiting !== undefined) waiting.pending.push(payload)
            return Effect.void
          },
          End: () => Effect.void,
          Close: ({ stream }) => {
            const target = relaying.get(stream)
            const waiting = resolving.get(stream)
            if (target !== undefined) {
              // What was written is still sent; the target's own close is not reported back.
              relaying.delete(stream)
              flow.forget(target)
              target.end()
              publish()
            } else if (waiting !== undefined) waiting.closedByPeer = true
            return Effect.void
          },
        }),
    })

  yield* Stream.fromQueue(inbox).pipe(Stream.runForEach(handle))
  return state.open
})

/**
 * How long to wait before dialling again: two seconds, doubling, never more than thirty. The
 * reference's `sand-egress-tunnel-reconnect` policy (`createRetryPolicy`: factor two, no
 * jitter), which starts over once a socket has opened.
 */
export const redial = Schedule.min([
  Schedule.exponential('2 seconds'),
  Schedule.spaced('30 seconds'),
])

/**
 * Keeps this computer available as the way out for as long as someone is signed in.
 *
 * One pass is one socket. A socket that never opens is dialled again on the schedule; one that
 * opened and then closed is dialled again after the schedule's first wait, as the reference
 * does. With nobody to dial as, it rests until `restart`. Whether anything is carried is the
 * server's decision (the Person's setting, and whether their Computer is running): the app only
 * holds the socket open, so turning egress on needs nothing from this computer.
 */
export const exitLink = Effect.fn('DesktopEgress.link')(function* (dependencies: ExitDependencies) {
  // At most one restart is remembered: several reasons to start over are one reason.
  const restarts = yield* Queue.sliding<void>(1)
  let status: ExitStatus = ExitStatus.cases.Off.make({})
  const publish = (next: ExitStatus) => {
    status = next
    dependencies.onStatus(next)
  }
  const watching: ExitDependencies = { ...dependencies, onStatus: publish }

  /** One socket. `Resting`: nobody to dial as. `Dropped`: it had opened, and has closed. */
  const pass = Effect.scoped(
    Effect.gen(function* () {
      const socket = dependencies.socket()
      if (Option.isNone(socket)) return 'Resting' as const
      publish(ExitStatus.cases.Connecting.make({}))
      const opened = yield* carry(watching, socket.value)
      publish(ExitStatus.cases.Connecting.make({}))
      if (!opened) return yield* new ExitUnopened({})
      return 'Dropped' as const
    }),
  )
  const settled = pass.pipe(
    Effect.retry(redial),
    Effect.tap((outcome) => (outcome === 'Dropped' ? Effect.sleep('2 seconds') : Effect.void)),
  )

  /** Runs until interrupted. A restart ends the socket in hand and begins a new pass at once. */
  const run = Effect.forever(
    Effect.gen(function* () {
      const outcome = yield* Effect.raceFirst(
        settled,
        Queue.take(restarts).pipe(Effect.as('Restarted' as const)),
      )
      if (outcome !== 'Resting') return
      publish(ExitStatus.cases.Off.make({}))
      yield* Queue.take(restarts)
    }),
  )

  return {
    run,
    /** What the exit is doing, as last seen. */
    state: () => status,
    /** The session or the server is different now: drop the socket and start over. */
    restart: () => {
      Queue.offerUnsafe(restarts, undefined)
    },
  }
})
