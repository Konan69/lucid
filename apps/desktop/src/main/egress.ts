import {
  EGRESS_LINK_BUDGET,
  EGRESS_PATH,
  EGRESS_STREAM_BUDGET,
  EgressFrame,
  EgressRefusal,
  type EgressStream,
  decodeEgressFrame,
  egressData,
  encodeEgressFrame,
} from '@vivid/contracts'
import * as NodeNet from 'node:net'
import * as Arr from 'effect/Array'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FiberSet from 'effect/FiberSet'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Result from 'effect/Result'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
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
 * tunnel, and reconnecting after two seconds, doubling, to at most thirty. Four things are
 * Vivid's:
 *
 * - The reference dials the machine's own hosted port. Vivid's Computer has no port a home
 *   network can be sure of reaching (it may have an IPv6 address only), so the app dials its
 *   server, as its own signed-in session, and the server joins the socket to the Computer over
 *   the SSH connection it already holds (`apps/server/src/computers/egress/`).
 * - The reference's socket is the `ws` package's, which calls back when a send has left. This
 *   app's is Electron's, a web `WebSocket`, which has no such call: the queue is looked at
 *   again on a short timer while a target is paused (`draining`).
 * - The reference writes whatever the Computer sends to a target, however slowly the target
 *   takes it, and forgets a stream the moment the Computer closes it, with its socket still
 *   open. Here what a target has not taken is counted and bounded (the contract's "How much a
 *   hop may hold"), and a socket this module dialled is this module's until it has closed.
 * - A stream's two directions end apart (the contract's `End`): a browser that has sent its
 *   whole request still gets the answer.
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

/**
 * How long a target is given to take what was already written to it once the Computer has
 * dropped its stream. The browser's connection is gone, so nothing waits for this; it is a
 * courtesy to the site, and when it runs out the socket is destroyed.
 */
export const DRAIN = Duration.seconds(10)

/**
 * How long a site may neither send nor take anything once the browser has finished sending,
 * before its stream is closed. A browser does not end its side of a connection it still uses,
 * so an end means it has let go; only this computer then holds the socket, and a site that
 * never answers would be held for ever. A minute is a web server's own usual patience with a
 * silent peer.
 */
export const QUIET = Duration.seconds(60)

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
  /**
   * Dials one checked address: `node:net`'s `createConnection` in the app, with `allowHalfOpen`,
   * so that a site that has finished sending does not end what the browser is still sending.
   */
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
  /** The bytes of `pending`. */
  held: number
  /** The Computer has said it will send no more. */
  heardEnd: boolean
}

/** A stream with a dialled target. */
interface Relaying {
  readonly target: NodeNet.Socket
  /** Bytes written to the target that it has not taken yet. */
  queued: number
  /** Bytes the target has sent or taken, ever: whether it is still doing anything (`QUIET`). */
  moved: number
  /** The Computer has said it will send no more, and the target was told so. */
  heardEnd: boolean
  /** The target sent its last byte, and the Computer was told so. */
  sentEnd: boolean
}

/**
 * One open socket's streams, and what they hold.
 *
 * A stream is in exactly one place. `resolving`: its name is being looked up. `relaying`: its
 * target is dialled and the Computer knows it by its number. `leaving`: the Computer dropped
 * it, and its target is being let out. A socket this module dialled is in `relaying` or
 * `leaving` until it has closed, so the scope that owns the link can always destroy it.
 */
interface Link {
  readonly dependencies: ExitDependencies
  readonly socket: ExitSocket
  /** Starts work that lives as long as the link: resolving a name, and the waits on the clock. */
  readonly fork: (work: Effect.Effect<void>) => void
  readonly flow: ReturnType<typeof draining>
  readonly resolving: Map<EgressStream, Resolving>
  readonly relaying: Map<EgressStream, Relaying>
  readonly leaving: Set<Relaying>
  /** `held` is every byte waiting for a target on this link: what the link's budget bounds. */
  readonly state: { open: boolean; closed: boolean; relayed: number; held: number }
}

const publish = (link: Link) =>
  link.dependencies.onStatus(
    link.state.open && !link.state.closed
      ? ExitStatus.cases.Connected.make({
          relayed: link.state.relayed,
          active: link.relaying.size,
        })
      : ExitStatus.cases.Connecting.make({}),
  )

const transmit = (link: Link, bytes: Uint8Array) => {
  if (link.state.open && !link.state.closed) link.socket.send(bytes)
}

const send = (link: Link, frame: EgressFrame) => transmit(link, encodeEgressFrame(frame))

/** The contract's third rule: whether a stream holding `own` bytes has crossed a bound. */
const overBudget = (link: Link, own: number) =>
  own > EGRESS_STREAM_BUDGET || link.state.held > EGRESS_LINK_BUDGET

/** Nothing of this leg is waiting any more, whether or not the target took it. */
const settled = (link: Link, leg: Relaying) => {
  link.state.held -= leg.queued
  leg.queued = 0
  link.flow.forget(leg.target)
}

/** Writes bytes already counted in `queued` and `held`, and uncounts them once they are taken. */
const write = (link: Link, leg: Relaying, payload: Uint8Array) => {
  leg.target.write(payload, () => {
    // A leg that is settled has nothing left to count, whatever a late callback says.
    const taken = Math.min(payload.length, leg.queued)
    leg.queued -= taken
    link.state.held -= taken
    leg.moved += taken
  })
}

/**
 * Ends a stream from this side, now: its target is destroyed and the Computer is told. For a
 * stream over its budget, a number opened twice, and a site that has gone silent.
 */
const cut = (link: Link, stream: EgressStream, leg: Relaying) => {
  link.relaying.delete(stream)
  settled(link, leg)
  leg.target.destroy()
  send(link, EgressFrame.cases.Close.make({ stream }))
  publish(link)
}

/** A stream that never got a target is forgotten, and the Computer is told. */
const refuse = (link: Link, stream: EgressStream, entry: Resolving) => {
  link.resolving.delete(stream)
  link.state.held -= entry.held
  send(link, EgressFrame.cases.Close.make({ stream }))
}

/**
 * A target's socket has closed, for any reason. If the Computer still knows the stream and the
 * two sides had not both finished, it is told; a stream that ended on both sides, or one the
 * Computer dropped, needs no word.
 */
const gone = (link: Link, stream: EgressStream, leg: Relaying) => {
  settled(link, leg)
  link.leaving.delete(leg)
  if (link.relaying.get(stream) !== leg) return
  link.relaying.delete(stream)
  if (!(leg.sentEnd && leg.heardEnd)) send(link, EgressFrame.cases.Close.make({ stream }))
  publish(link)
}

/** Closes a stream whose site has done nothing for `QUIET` since the browser finished. */
const watched = Effect.fn('DesktopEgress.watched')(function* (
  link: Link,
  stream: EgressStream,
  leg: Relaying,
) {
  for (;;) {
    const before = leg.moved
    yield* Effect.sleep(QUIET)
    if (link.relaying.get(stream) !== leg) return
    if (leg.moved === before) return cut(link, stream, leg)
  }
})

/** The Computer will send no more: the target is told, and its answer is still carried. */
const ended = (link: Link, stream: EgressStream, leg: Relaying) => {
  leg.heardEnd = true
  leg.target.end()
  link.fork(watched(link, stream, leg))
}

/**
 * The Computer dropped a stream. Its number is free at once, and the socket stays this
 * module's: what was written is let out for at most `DRAIN`, what the site still sends is read
 * and thrown away so that its close is seen, and then the socket is destroyed. The reference
 * ends the socket and forgets it (`handleFrame`), so a site that never took the bytes kept the
 * socket, and what was queued for it, for as long as the app ran.
 */
const dropped = (link: Link, stream: EgressStream, leg: Relaying) => {
  link.relaying.delete(stream)
  link.leaving.add(leg)
  link.flow.forget(leg.target)
  leg.target.resume()
  leg.target.end()
  link.fork(Effect.sleep(DRAIN).pipe(Effect.andThen(Effect.sync(() => leg.target.destroy()))))
  publish(link)
}

/**
 * Resolves, checks and dials one target. The stream may be gone by the time the name resolves
 * (the Computer closed it, or it went over its budget), and then nothing is dialled.
 */
const open = Effect.fn('DesktopEgress.open')(function* (
  link: Link,
  stream: EgressStream,
  place: { readonly host: string; readonly port: number },
  entry: Resolving,
) {
  const address = yield* checkedAddress(place.host, link.dependencies)
  if (link.resolving.get(stream) !== entry) return
  // Unresolvable, or it leads into this computer's own networks: refused with a close.
  if (Option.isNone(address) || link.state.closed) return refuse(link, stream, entry)
  link.resolving.delete(stream)
  const target = link.dependencies.dial(address.value, place.port)
  const leg: Relaying = { target, queued: entry.held, moved: 0, heardEnd: false, sentEnd: false }
  link.relaying.set(stream, leg)
  link.state.relayed += 1
  publish(link)
  target.on('data', (payload: Uint8Array) => {
    // A stream the Computer dropped is read to its end and not passed on.
    if (link.relaying.get(stream) !== leg) return
    leg.moved += payload.length
    for (const frame of egressData(stream, payload)) transmit(link, frame)
    link.flow.sent(target)
  })
  target.on('end', () => {
    if (link.relaying.get(stream) !== leg) return
    leg.sentEnd = true
    send(link, EgressFrame.cases.End.make({ stream }))
  })
  // A failure is always followed by a close, which is where a target is let go.
  target.on('error', () => undefined)
  target.on('close', () => gone(link, stream, leg))
  for (const payload of entry.pending) write(link, leg, payload)
  if (entry.heardEnd) ended(link, stream, leg)
})

/** Bytes for one stream: counted, then held for its name or written to its target. */
const taken = (link: Link, stream: EgressStream, payload: Uint8Array) => {
  const waiting = link.resolving.get(stream)
  const leg = link.relaying.get(stream)
  if (waiting !== undefined) {
    link.state.held += payload.length
    waiting.held += payload.length
    waiting.pending.push(payload)
    if (overBudget(link, waiting.held)) refuse(link, stream, waiting)
  }
  // After its end the Computer has no more to say on this stream; more is not the protocol.
  if (leg !== undefined && !leg.heardEnd) {
    link.state.held += payload.length
    leg.queued += payload.length
    write(link, leg, payload)
    if (overBudget(link, leg.queued)) cut(link, stream, leg)
  }
}

/** One frame from the Computer. A frame for a stream nobody has is passed over. */
const handle = (link: Link, frame: EgressFrame) =>
  EgressFrame.match(frame, {
    Open: ({ stream, host, port }) => {
      const waiting = link.resolving.get(stream)
      const leg = link.relaying.get(stream)
      // A number already in use cannot be two connections. The reference answers with a close
      // and keeps relaying the first, which the Computer then no longer knows; here both sides
      // forget the number.
      if (waiting !== undefined) return refuse(link, stream, waiting)
      if (leg !== undefined) return cut(link, stream, leg)
      const entry: Resolving = { pending: [], held: 0, heardEnd: false }
      link.resolving.set(stream, entry)
      link.fork(open(link, stream, { host, port }, entry))
      return undefined
    },
    Data: ({ stream, payload }) => taken(link, stream, payload),
    End: ({ stream }) => {
      const waiting = link.resolving.get(stream)
      const leg = link.relaying.get(stream)
      if (waiting !== undefined) waiting.heardEnd = true
      if (leg !== undefined && !leg.heardEnd) ended(link, stream, leg)
    },
    Close: ({ stream }) => {
      const waiting = link.resolving.get(stream)
      const leg = link.relaying.get(stream)
      // Never dialled: there is nothing to let out, and `open` finds the entry gone.
      if (waiting !== undefined) {
        link.resolving.delete(stream)
        link.state.held -= waiting.held
      }
      if (leg !== undefined) dropped(link, stream, leg)
    },
  })

/**
 * One open socket, from its first event to its close. Answers whether it ever opened.
 *
 * A message is handled where it arrives, whole, before the next one: nothing waits in a queue
 * of this module's between the socket and a stream, so every byte held is held by a stream and
 * counted against the budgets. The scope owns everything: when it closes, what was forked is
 * interrupted, every target is destroyed, the timer is cleared and the socket is closed.
 */
const carry = Effect.fn('DesktopEgress.carry')(function* (
  dependencies: ExitDependencies,
  socket: ExitSocket,
) {
  const over = yield* Deferred.make<void>()
  const run = yield* FiberSet.makeRuntime<never, void, never>()
  const link: Link = {
    dependencies,
    socket,
    fork: (work) => {
      run(work)
    },
    flow: draining(socket),
    resolving: new Map(),
    relaying: new Map(),
    leaving: new Set(),
    state: { open: false, closed: false, relayed: 0, held: 0 },
  }
  /** This socket is done, by its own close or because it sent what no frame can be. */
  const finished = () => {
    link.state.closed = true
    Deferred.doneUnsafe(over, Effect.void)
  }
  socket.binaryType = 'arraybuffer'
  socket.addEventListener('open', () => {
    link.state.open = true
    publish(link)
  })
  socket.addEventListener('message', (event) => {
    if (link.state.closed) return
    Option.map(messageBytes(event), (bytes) =>
      Result.match(decodeEgressFrame(bytes), {
        onSuccess: (frame) => handle(link, frame),
        onFailure: (refusal) =>
          EgressRefusal.match(refusal, {
            // Not this protocol at all: this socket is ended, and a new one is dialled.
            Oversized: finished,
            Short: () => undefined,
            Unknown: () => undefined,
            Unopenable: ({ stream }) => send(link, EgressFrame.cases.Close.make({ stream })),
          }),
      }),
    )
  })
  // A failure is always followed by a close, which is what ends this socket.
  socket.addEventListener('error', () => undefined)
  socket.addEventListener('close', finished)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      link.state.closed = true
      link.flow.stop()
      for (const leg of [...link.relaying.values(), ...link.leaving]) leg.target.destroy()
      link.relaying.clear()
      link.leaving.clear()
      link.resolving.clear()
      socket.close()
    }),
  )
  yield* Deferred.await(over)
  return link.state.open
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
