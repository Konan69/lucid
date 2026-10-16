import {
  EGRESS_DEADLINE_MILLIS,
  EGRESS_GRANT,
  EGRESS_LINK_BUDGET,
  EGRESS_PATH,
  EGRESS_PING_MILLIS,
  EGRESS_STREAM_BUDGET,
  EGRESS_WINDOW,
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
 * tunnel, and reconnecting after two seconds, doubling, to at most thirty. Six things are
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
 *   takes it, and sends the Computer whatever a target sends, however slowly the browser reads
 *   it. Here each direction of each stream has a window (the contract's "How much a hop may
 *   hold"): the Computer is granted more only as the target takes what was written, and a
 *   target is read only while the Computer has room for what it sends.
 * - The reference forgets a stream the moment the Computer closes it, with its socket still
 *   open. A socket this module dialled is this module's until it has closed.
 * - A stream's two directions end apart (the contract's `End`): a browser that has sent its
 *   whole request still gets the answer.
 * - The reference waits for its socket to close. A server that can no longer be reached closes
 *   nothing, so a socket that has brought nothing for the contract's deadline is ended here
 *   and dialled again (`QUIET_PINGS`).
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
 * How much may wait to be sent to the tunnel, for all streams together, before the targets are
 * no longer read: one mebibyte, the reference's own bound. A stream's window bounds what one
 * site may send ahead of its browser; this bounds many sites sending at once into a slow tunnel.
 */
export const QUEUE_BOUND = 1 << 20

/**
 * How long a target is given to take what was already written to it once the Computer has
 * dropped its stream. The browser's connection is gone, so nothing waits for this; it is a
 * courtesy to the site, and when it runs out the socket is destroyed.
 */
export const DRAIN = Duration.seconds(10)

/**
 * How long a dialled connection may be idle before this computer's TCP asks the far end whether
 * it is still there. Forty-five seconds is what Chromium sets on its own sockets
 * (`kTCPKeepAliveSeconds`; recalled, not read for this port). The Computer's browser would have
 * asked on a direct connection, and behind the proxy it cannot: the socket that reaches the
 * site is this one.
 */
const KEEP_ALIVE_MILLIS = 45_000

/**
 * Dials one checked address, as the app does.
 *
 * `allowHalfOpen`: a site that has finished sending does not end what the browser is still
 * sending, and a browser that has finished sending (`End`) still gets its answer, however long
 * the site takes. An `End` is a half-close and nothing more: an earlier version closed a stream
 * whose site was silent for a minute after it, and threw away answers that were only slow.
 *
 * `keepAlive`: what bounds a half-closed stream whose site has gone without a word is the
 * transport's own check, not a clock here. A site that no longer answers TCP fails the socket,
 * the socket closes, and the stream ends as it does when either real socket ends (`gone`).
 */
export const dialTarget = (address: string, port: number) =>
  NodeNet.createConnection({
    host: address,
    port,
    allowHalfOpen: true,
    keepAlive: true,
    keepAliveInitialDelay: KEEP_ALIVE_MILLIS,
  })

/**
 * How long a socket must stay open before its end is a drop and not a failure to hold: thirty
 * seconds, the longest the app ever waits between two tries (`redial`), so a socket that has
 * outlasted every wait is the only thing that makes the waits start over. The reference starts
 * over the moment a socket opens (`connect`, `reconnectAttempt = 0`); a server that accepts a
 * socket and ends its join at once (the Computer's proxy will not start, say) would then be
 * dialled, and its start command run on the Computer, every two seconds for ever.
 */
export const STEADY = Duration.seconds(30)

/**
 * How many pings' worth of time may go by with nothing arriving before the socket is gone (the
 * contract's `EGRESS_PING_MILLIS`). The server sends something with every ping, so a socket that
 * is there never comes near it.
 */
const QUIET_PINGS = EGRESS_DEADLINE_MILLIS / EGRESS_PING_MILLIS

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

/**
 * The socket did not hold: it closed before it opened (the server is not there, or said no),
 * or it opened and closed before `STEADY` had passed (the join it was given ended at once).
 * Both are answered the same way, by waiting longer before the next.
 */
class ExitUnsteady extends Schema.TaggedError<ExitUnsteady>()(
  'ExitUnsteady',
  {},
  { title: 'The egress tunnel did not stay open' },
) {}

export interface ExitDependencies {
  /** Opens the tunnel's socket as the app's session. Nothing means there is nobody to dial as. */
  readonly socket: () => Option.Option<ExitSocket>
  /** What a name leads to, asked on this computer (`reach.ts`, `resolveHost`). */
  readonly resolve: (host: string) => Effect.Effect<ReadonlyArray<string>, Unresolved>
  /** Dials one checked address: `dialTarget` in the app. */
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
 * Says whether the tunnel's own queue is full (`QUEUE_BOUND`), and calls back when it no longer
 * is.
 *
 * A web socket says nothing when it has sent, so the queue is asked on a timer; the timer does
 * nothing while nobody waits, and does not keep the app from quitting.
 */
const draining = (socket: ExitSocket) => {
  const waiting = new Set<() => void>()
  const timer = setInterval(() => {
    if (waiting.size === 0 || socket.bufferedAmount > QUEUE_BOUND) return
    const ready = [...waiting]
    waiting.clear()
    for (const again of ready) again()
  }, DRAIN_MILLIS)
  timer.unref()
  return {
    full: () => socket.bufferedAmount > QUEUE_BOUND,
    /** Calls `again` once, the next time the queue is seen under the bound. */
    wait: (again: () => void) => {
      waiting.add(again)
    },
    forget: (again: () => void) => {
      waiting.delete(again)
    },
    stop: () => {
      clearInterval(timer)
      waiting.clear()
    },
  }
}

/**
 * A stream whose target is still being resolved: what arrived for it meanwhile, and the word
 * that ends the resolving.
 *
 * The Computer has the first window for such a stream and is granted no more until a target
 * has taken something (`write`), so `pending` is at most `EGRESS_WINDOW` from a Computer that
 * keeps the rule. The resolving belongs to the stream: `forgotten` is the one way an entry
 * leaves the table without being dialled, and it stops the lookup and lets the bytes go. The
 * lookup was once only left to find its entry gone, and until it did (a resolver may take as
 * long as it likes) it kept the entry and every byte in it, counted against nothing.
 */
interface Resolving {
  readonly pending: Array<Uint8Array>
  /** The bytes of `pending`. */
  held: number
  /** The Computer has said it will send no more. */
  heardEnd: boolean
  /** Completed when the stream goes before it is dialled: the lookup races it. */
  readonly gone: Deferred.Deferred<void>
}

/**
 * A stream with a dialled target, and the two windows of the contract's "How much a hop may
 * hold". Toward the target this side is the receiver: `queued` is what it holds, and `taken` is
 * what it owes the Computer a grant for. From the target this side is the sender: `credit` is
 * what the Computer will still take, and `owed` is what the site sent beyond that.
 */
interface Relaying {
  readonly target: NodeNet.Socket
  /** Bytes written to the target that it has not taken yet. */
  queued: number
  /** Bytes the target has taken that the Computer has not been granted yet. */
  taken: number
  /** How many more of the site's bytes the Computer will take. */
  credit: number
  /** What the site sent that the Computer has no room for yet, in order. */
  readonly owed: Array<Uint8Array>
  /** Looks at this stream again: what `pour` is for it, as one value the link can call back. */
  readonly again: () => void
  /** The Computer has said it will send no more, and the target was told so. */
  heardEnd: boolean
  /** The site sent its last byte. The Computer is told once nothing is owed (`sentEnd`). */
  finished: boolean
  /** The Computer was told that the site sent its last byte. */
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
  /** Starts work that lives as long as the link: resolving a name, and the wait of `dropped`. */
  readonly fork: (work: Effect.Effect<void>) => void
  readonly flow: ReturnType<typeof draining>
  readonly resolving: Map<EgressStream, Resolving>
  readonly relaying: Map<EgressStream, Relaying>
  readonly leaving: Set<Relaying>
  /** `held` is every byte waiting for a target on this link: what the link's budget bounds. */
  readonly state: {
    open: boolean
    closed: boolean
    /** It has been open for `STEADY`. */
    steady: boolean
    /** How many pings' worth of time have gone by since anything arrived (`QUIET_PINGS`). */
    quiet: number
    relayed: number
    held: number
  }
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

/** Nothing of this leg is waiting any more, in either direction, whether or not it was taken. */
const settled = (link: Link, leg: Relaying) => {
  link.state.held -= leg.queued
  leg.queued = 0
  leg.owed.length = 0
  link.flow.forget(leg.again)
}

/**
 * Writes bytes already counted in `queued` and `held`. Once the target has taken them they are
 * uncounted, and the Computer is granted that many more when they come to `EGRESS_GRANT`: what
 * the target has not taken is never granted, so what waits here stays within the window.
 */
const write = (link: Link, stream: EgressStream, leg: Relaying, payload: Uint8Array) => {
  leg.target.write(payload, (failed) => {
    // A leg that is settled has nothing left to count, whatever a late callback says.
    const taken = Math.min(payload.length, leg.queued)
    leg.queued -= taken
    link.state.held -= taken
    // Bytes a failed socket gave up are not bytes it took, and a stream that is gone is owed
    // nothing.
    if (failed instanceof Error || link.relaying.get(stream) !== leg) return
    leg.taken += taken
    if (leg.taken < EGRESS_GRANT) return
    send(link, EgressFrame.cases.Grant.make({ stream, bytes: leg.taken }))
    leg.taken = 0
  })
}

/**
 * Sends the Computer what the site sent, as far as the Computer's window and the tunnel's queue
 * allow, and reads the site only while nothing of its is waiting here. Called whenever one of
 * those may have changed: the site sent or ended, a grant came, the tunnel's queue emptied.
 */
const pour = (link: Link, stream: EgressStream, leg: Relaying) => {
  // A stream the Computer dropped is read to its end and not passed on (`dropped`).
  if (link.relaying.get(stream) !== leg) return
  while (leg.credit > 0 && !link.flow.full()) {
    const next = leg.owed.shift()
    if (next === undefined) break
    const now = next.subarray(0, leg.credit)
    if (now.length < next.length) leg.owed.unshift(next.subarray(now.length))
    leg.credit -= now.length
    for (const frame of egressData(stream, now)) transmit(link, frame)
  }
  if (leg.owed.length > 0) {
    leg.target.pause()
    // Out of window, a grant calls this again; with the tunnel full, the link does.
    if (leg.credit > 0) link.flow.wait(leg.again)
    return
  }
  if (leg.finished && !leg.sentEnd) {
    leg.sentEnd = true
    send(link, EgressFrame.cases.End.make({ stream }))
  }
  leg.target.resume()
}

/**
 * Ends a stream from this side, now: its target is destroyed and the Computer is told. For a
 * stream over its budget, a number opened twice, and a grant of more than was sent.
 */
const cut = (link: Link, stream: EgressStream, leg: Relaying) => {
  link.relaying.delete(stream)
  settled(link, leg)
  leg.target.destroy()
  send(link, EgressFrame.cases.Close.make({ stream }))
  publish(link)
}

/** A stream leaves before it has a target: its bytes are let go and its lookup is stopped. */
const forgotten = (link: Link, stream: EgressStream, entry: Resolving) => {
  link.resolving.delete(stream)
  link.state.held -= entry.held
  entry.held = 0
  entry.pending.length = 0
  Deferred.doneUnsafe(entry.gone, Effect.void)
}

/** A stream that never got a target is forgotten, and the Computer is told. */
const refuse = (link: Link, stream: EgressStream, entry: Resolving) => {
  forgotten(link, stream, entry)
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

/**
 * The Computer will send no more: the target is told, and its answer is still carried, whenever
 * it comes. The stream ends when the site ends too, or when either socket closes.
 */
const ended = (leg: Relaying) => {
  leg.heardEnd = true
  leg.target.end()
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
  leg.owed.length = 0
  link.flow.forget(leg.again)
  leg.target.resume()
  leg.target.end()
  link.fork(Effect.sleep(DRAIN).pipe(Effect.andThen(Effect.sync(() => leg.target.destroy()))))
  publish(link)
}

/**
 * Resolves, checks and dials one target. When the stream goes first (the Computer closed it, or
 * it went over its budget) the lookup is interrupted where it stands and nothing is dialled.
 */
const open = Effect.fn('DesktopEgress.open')(function* (
  link: Link,
  stream: EgressStream,
  place: { readonly host: string; readonly port: number },
  entry: Resolving,
) {
  const found = yield* Effect.raceFirst(
    checkedAddress(place.host, link.dependencies).pipe(Effect.asSome),
    Deferred.await(entry.gone).pipe(Effect.as(Option.none<Option.Option<string>>())),
  )
  if (Option.isNone(found) || link.resolving.get(stream) !== entry) return
  const address = found.value
  // Unresolvable, or it leads into this computer's own networks: refused with a close.
  if (Option.isNone(address) || link.state.closed) return refuse(link, stream, entry)
  link.resolving.delete(stream)
  const target = link.dependencies.dial(address.value, place.port)
  const leg: Relaying = {
    target,
    queued: entry.held,
    taken: 0,
    // The Computer's side has a whole window for a stream it has just opened.
    credit: EGRESS_WINDOW,
    owed: [],
    again: () => pour(link, stream, leg),
    heardEnd: false,
    finished: false,
    sentEnd: false,
  }
  link.relaying.set(stream, leg)
  link.state.relayed += 1
  publish(link)
  target.on('data', (payload: Uint8Array) => {
    leg.owed.push(payload)
    pour(link, stream, leg)
  })
  target.on('end', () => {
    leg.finished = true
    pour(link, stream, leg)
  })
  // A failure is always followed by a close, which is where a target is let go.
  target.on('error', () => undefined)
  target.on('close', () => gone(link, stream, leg))
  for (const payload of entry.pending) write(link, stream, leg, payload)
  if (entry.heardEnd) ended(leg)
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
    write(link, stream, leg, payload)
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
      const entry: Resolving = {
        pending: [],
        held: 0,
        heardEnd: false,
        gone: Deferred.makeUnsafe<void>(),
      }
      link.resolving.set(stream, entry)
      link.fork(open(link, stream, { host, port }, entry))
      return undefined
    },
    Data: ({ stream, payload }) => taken(link, stream, payload),
    End: ({ stream }) => {
      const waiting = link.resolving.get(stream)
      const leg = link.relaying.get(stream)
      if (waiting !== undefined) waiting.heardEnd = true
      if (leg !== undefined && !leg.heardEnd) ended(leg)
    },
    // The Computer has room for more of what the site sends. A grant is for bytes that were
    // sent, so credit never comes to more than the window: one that would is for bytes that
    // never were (said twice, made up, or for a stream that has sent nothing because it has no
    // target yet), and it ends its stream as any other break of the window does. It was once
    // added as it came, and one grant of four gigabytes let a site send without any window.
    Grant: ({ stream, bytes }) => {
      const waiting = link.resolving.get(stream)
      const leg = link.relaying.get(stream)
      if (waiting !== undefined) return refuse(link, stream, waiting)
      if (leg === undefined) return undefined
      if (leg.credit + bytes > EGRESS_WINDOW) return cut(link, stream, leg)
      leg.credit += bytes
      return pour(link, stream, leg)
    },
    Close: ({ stream }) => {
      const waiting = link.resolving.get(stream)
      const leg = link.relaying.get(stream)
      // Never dialled: there is nothing to let out.
      if (waiting !== undefined) forgotten(link, stream, waiting)
      if (leg !== undefined) dropped(link, stream, leg)
    },
  })

/**
 * One open socket, from its first event to its close. Answers whether it held: opened, and
 * stayed open for `STEADY`.
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
    state: { open: false, closed: false, steady: false, quiet: 0, relayed: 0, held: 0 },
  }
  /**
   * This socket is done: it closed, it sent what no frame can be, or it has brought nothing for
   * the deadline.
   */
  const finished = () => {
    link.state.closed = true
    Deferred.doneUnsafe(over, Effect.void)
  }
  socket.binaryType = 'arraybuffer'
  socket.addEventListener('open', () => {
    link.state.open = true
    link.fork(
      Effect.sleep(STEADY).pipe(
        Effect.andThen(
          Effect.sync(() => {
            link.state.steady = true
          }),
        ),
      ),
    )
    // A web socket shows no ping and cannot send one, so the app cannot ask whether the server
    // is there. It listens: the server sends a message with every ping (`EGRESS_BEAT`), and a
    // socket that has brought nothing for the deadline is one whose server cannot be reached.
    // Nothing would otherwise say so, and this computer would stay "connected" to nothing while
    // the Person's other computer, or this one on a new socket, could have been the way out.
    link.fork(
      Effect.sleep(EGRESS_PING_MILLIS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            link.state.quiet += 1
            if (link.state.quiet >= QUIET_PINGS) finished()
          }),
        ),
        Effect.forever,
      ),
    )
    publish(link)
  })
  socket.addEventListener('message', (event) => {
    if (link.state.closed) return
    // Anything at all: a frame, the server's beat, or a word this build does not know.
    link.state.quiet = 0
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
      for (const [stream, entry] of link.resolving) forgotten(link, stream, entry)
      socket.close()
    }),
  )
  yield* Deferred.await(over)
  return link.state.steady
})

/**
 * How long to wait before dialling again: two seconds, doubling, never more than thirty. The
 * reference's `sand-egress-tunnel-reconnect` policy (`createRetryPolicy`: factor two, no
 * jitter). It starts over once a socket has held (`STEADY`), where the reference's starts over
 * once one has opened.
 */
export const redial = Schedule.min([
  Schedule.exponential('2 seconds'),
  Schedule.spaced('30 seconds'),
])

/**
 * Keeps this computer available as the way out for as long as someone is signed in.
 *
 * One pass is one socket. A socket that does not hold (it never opens, or it is closed as soon
 * as it opens) is dialled again on the schedule, each wait longer than the last; one that held
 * and then closed is dialled again after the schedule's first wait, and the schedule starts
 * over. With nobody to dial as, it rests until `restart`. Whether anything is carried is the
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

  /** One socket. `Resting`: nobody to dial as. `Dropped`: it had held, and has closed. */
  const pass = Effect.scoped(
    Effect.gen(function* () {
      const socket = dependencies.socket()
      if (Option.isNone(socket)) return 'Resting' as const
      publish(ExitStatus.cases.Connecting.make({}))
      const held = yield* carry(watching, socket.value)
      publish(ExitStatus.cases.Connecting.make({}))
      if (!held) return yield* new ExitUnsteady({})
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
