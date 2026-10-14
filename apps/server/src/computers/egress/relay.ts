import type * as NodeStream from 'node:stream'
import { and, eq } from 'drizzle-orm'
import type * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import type * as Socket from 'effect/socket/Socket'
import { EGRESS_FRAME_LIMIT, EgressStatus, type PersonId } from '@vivid/contracts'
import { Database, type DatabaseInfrastructureError } from '../../database/client.ts'
import { Changes, Topic, everyPart } from '../../live/changes.ts'
import { Machine, type MachineOperations } from '../machine.ts'
import { computerMachineKey } from '../store.ts'
import { computers } from '../tables.ts'
import { EGRESS_TUNNEL_PORT, startProxy } from './guest.ts'
import { egressChosen } from './setting.ts'

/**
 * Joins a Person's desktop app to their Computer, so the Computer's browser can go out through
 * the Person's own computer (`packages/contracts/src/egress.ts`).
 *
 * Grok Bot's desktop app dials its machine directly, on a port the machine's host publishes
 * (`ea2-window-lifecycle.ts`, `deriveEgressTunnelWsUrl`). Vivid's cannot: a Computer may have
 * only an IPv6 address, which a home network may not reach (`docs/04-computer.md`, "Finding the
 * machine"), and it publishes no port. The two things Vivid already has are a desktop app that
 * dials its server as a signed-in session, and a server that holds an SSH connection to each
 * awake Computer. So the app opens one more socket to its server, and the server writes what
 * arrives on it to the Computer's tunnel port through a channel on that SSH connection
 * (`ssh/link.ts`, `tunnel`), and back. The existing live connection is not used for this: it
 * carries JSON calls, has no stream from the app to the server, and a page's bytes would wait
 * behind the actions Vivid takes on that computer.
 *
 * The server does not read the tunnel beyond counting and measuring: a message from the app is
 * one frame, and toward the Computer each frame is written with its length in front, because an
 * SSH channel is a byte stream and does not keep a message's edges (`proxy.mjs` reads them the
 * same way). It holds nothing for any one stream (the contract's "How much a hop may hold",
 * rule 3): each side is read only as fast as the other takes what was read (`pumped`), and a
 * stream's `Grant` passes through like any other frame, so the two ends keep each stream's
 * window between themselves.
 *
 * A desktop app's socket is held whether or not egress is on. While it is off, or the Computer
 * is not running, the socket is parked: nothing is read from it but its end. Turning egress on
 * therefore needs nothing from the app, and issue 61, which removes the choice, changes one
 * condition here (`egressChosen`).
 *
 * One socket is one join. When a join ends for any reason (egress turned off, the Computer
 * stopped, the channel closed, a frame that is not one), the app's socket is closed with it and
 * the app dials again. The other way to end the app's streams would be a `Close` for each, on a
 * socket that is kept; but the app's bytes for those streams may still be on their way, the
 * proxy numbers the streams of each attachment from one again, and nothing in a frame says
 * which join it belongs to, so a late byte of an old stream would be read as a new stream's. A
 * socket that is closed takes everything in flight with it: the app ends every connection it
 * made (`apps/desktop/src/main/egress.ts`, the scope of `carry`) and starts with an empty table.
 */

/** What one held socket is doing. Only what is true while that socket is open. */
const Carrying = Schema.TaggedUnion({
  /** Held, joined to nothing. */
  Parked: {},
  /** Joined to the Computer. `streams` are the browser's connections open through it now. */
  Joined: { streams: Schema.Int },
  /** The Computer is running and could not be joined; tried again at the next change or tick. */
  Failed: {},
})
type Carrying = typeof Carrying.Type

/** One desktop app's socket: what it is doing, and the signal that a newer one took its place. */
interface Held {
  phase: Carrying
  readonly replaced: Deferred.Deferred<void>
}

/** The first five bytes of a frame: its kind and its stream (`egress.ts`). */
const OPEN = 1
const CLOSE = 3
const END = 4

/**
 * How much may wait toward the app before the Computer is no longer read: what the relay has
 * taken off the channel and not written yet, and what it has written that has not left this
 * server. One mebibyte each, the bound the app keeps the other way (`QUEUE_BOUND`).
 */
export const QUEUE_LIMIT = 1 << 20

/** How often a parked or failed socket looks again without being told anything changed. */
const LOOK_AGAIN = '30 seconds'

/** The tunnel from the Computer said something that is not its protocol. */
class TunnelInvalid extends Schema.TaggedError<TunnelInvalid>()(
  'TunnelInvalid',
  {},
  { title: 'The egress tunnel sent something that is not a frame' },
) {}

/** The desktop app sent a message longer than any frame (`EGRESS_FRAME_LIMIT`). */
class ExitInvalid extends Schema.TaggedError<ExitInvalid>()(
  'ExitInvalid',
  {},
  { title: 'The desktop app sent something that is not a frame' },
) {}

/**
 * Cuts the Computer's byte stream into frames. Chunks arrive at any boundary, so an unfinished
 * frame is held until the rest comes. Nothing means a length no frame can have.
 */
export const frameCutter = () => {
  let held: Uint8Array = new Uint8Array(0)
  return (chunk: Uint8Array): Option.Option<ReadonlyArray<Uint8Array>> => {
    const joined = new Uint8Array(held.length + chunk.length)
    joined.set(held)
    joined.set(chunk, held.length)
    held = joined
    const frames: Array<Uint8Array> = []
    for (;;) {
      if (held.length < 4) return Option.some(frames)
      const size = new DataView(held.buffer, held.byteOffset, 4).getUint32(0)
      if (size > EGRESS_FRAME_LIMIT) return Option.none()
      if (held.length < 4 + size) return Option.some(frames)
      frames.push(held.subarray(4, 4 + size))
      held = held.subarray(4 + size)
    }
  }
}

/** One frame as the Computer's tunnel port takes it: its length, then the frame. */
export const lengthPrefixed = (frame: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(4 + frame.length)
  new DataView(bytes.buffer).setUint32(0, frame.length)
  bytes.set(frame, 4)
  return bytes
}

export interface EgressService {
  /** What egress is doing for a Person at this moment. */
  readonly status: (person: PersonId) => Effect.Effect<EgressStatus, DatabaseInfrastructureError>
  /**
   * Holds one desktop app's socket, parked until egress is on and the Computer runs, then
   * joined to the Person's Computer. It returns when that join ends or a newer socket of the
   * Person's takes its place (a Person has one way out at a time), and whoever called it then
   * closes the socket. The scope owns the channel to the Computer.
   */
  readonly carry: (
    person: PersonId,
    app: ExitSocket,
  ) => Effect.Effect<void, Socket.SocketError, Scope.Scope>
}

export class Egress extends Context.Service<Egress, EgressService>()('vivid/Egress') {}

/**
 * The two facts that decide whether egress is carried for a Person, as the relay asks them.
 * `egressLayer` reads both from the database; they are named apart from it so that the relay's
 * behaviour is a matter of these answers and nothing else.
 */
export interface EgressReads {
  /** The Person turned egress on (`setting.ts`). */
  readonly chosen: (person: PersonId) => Effect.Effect<boolean, DatabaseInfrastructureError>
  /** The Person's Computer is recorded as running. Never the provider, and never a wake. */
  readonly running: (person: PersonId) => Effect.Effect<boolean, DatabaseInfrastructureError>
}

/**
 * The app's socket as the relay uses it: messages in, in order, and frames out.
 *
 * A message that is not pulled is not read off the network (Effect's reader pauses a `ws`
 * socket once 64 KiB waits, `Socket.fromWebSocket`), so not pulling is how the app is slowed.
 * Writing is the other matter: `write` hands the frame to the socket and succeeds at once
 * (Effect 4.0.2 `Socket.ts`, `fromWebSocket`: `ws.send(chunk)` with no callback, then
 * `Effect.void`), whether or not the app is taking anything. So the socket also says how much
 * it still holds, and when that has gone (`route.ts`, `exitSocket`).
 */
export interface ExitSocket {
  readonly pull: Socket.Reader['pull']
  readonly write: (frame: Uint8Array) => Effect.Effect<void, Socket.SocketError>
  /** Bytes written that have not left this server yet. */
  readonly buffered: () => number
  /** Completes once what was written has left, or the socket has closed. */
  readonly drained: Effect.Effect<void>
}

/** Waits until a Node stream has taken what was written to it, or has closed. */
export const flushed = (stream: NodeStream.Writable) =>
  Effect.callback<void>((resume) => {
    if (!stream.writableNeedDrain || stream.destroyed) return resume(Effect.void)
    const done = () => resume(Effect.void)
    stream.once('drain', done)
    stream.once('close', done)
    return Effect.sync(() => {
      stream.off('drain', done)
      stream.off('close', done)
    })
  })

/**
 * How many of the browser's connections are open through a join, read from the frames that
 * pass: an open from the Computer adds one, a close from either side takes it away, and so does
 * the second of the two ends (each side says `End` once, and the stream is then over without a
 * close).
 */
const streamCount = () => {
  const open = new Map<number, { computer: boolean; app: boolean }>()
  return (frame: Uint8Array, fromComputer: boolean): number => {
    if (frame.length < 5) return open.size
    const stream = new DataView(frame.buffer, frame.byteOffset, 5).getUint32(1)
    const ends = open.get(stream)
    if (fromComputer && frame[0] === OPEN) open.set(stream, { computer: false, app: false })
    if (frame[0] === CLOSE) open.delete(stream)
    if (frame[0] === END && ends !== undefined) {
      ends[fromComputer ? 'computer' : 'app'] = true
      if (ends.computer && ends.app) open.delete(stream)
    }
    return open.size
  }
}

/**
 * Carries frames both ways between the app's socket and the channel to the Computer, until one
 * side is done. `counted` hears how many of the browser's connections are open each time a
 * frame passes.
 *
 * Each direction waits for the side it writes to. Toward the Computer, the app is not pulled
 * while the channel has more than it will take. Toward the app, the channel is not read while
 * more than `QUEUE_LIMIT` waits to be written or has been written and not left; the channel's
 * own flow control then slows the Computer, whose proxy pauses the browser.
 *
 * It ends, without failing, when the Computer's side ends for any reason (the Computer stopped,
 * the proxy ended, the SSH connection went), or when either side sends what no frame can be. It
 * fails only with the app's socket.
 */
const pumped = Effect.fn('Egress.pumped')(function* (
  app: ExitSocket,
  tunnel: NodeStream.Duplex,
  counted: (streams: number) => void,
) {
  const count = streamCount()
  const toComputer = app.pull.pipe(
    Effect.flatMap((messages) =>
      Effect.suspend(() => {
        for (const message of messages) {
          // A frame is binary; text is not this protocol and is passed over.
          if (Predicate.isString(message)) continue
          if (message.length > EGRESS_FRAME_LIMIT) return Effect.fail(new ExitInvalid({}))
          counted(count(message, false))
          tunnel.write(lengthPrefixed(message))
        }
        return flushed(tunnel)
      }),
    ),
    Effect.forever,
  )
  const cut = frameCutter()
  // The channel's bytes, in order, as they arrive; the queue ends when the channel does.
  const chunks = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const waiting = { bytes: 0 }
  tunnel.on('data', (chunk: Uint8Array) => {
    waiting.bytes += chunk.length
    if (waiting.bytes > QUEUE_LIMIT) tunnel.pause()
    Queue.offerUnsafe(chunks, chunk)
  })
  // An error is followed by a close, and a close for any reason is the end of this join.
  tunnel.on('error', () => undefined)
  tunnel.on('close', () => Queue.endUnsafe(chunks))
  const toDesktop = Stream.fromQueue(chunks).pipe(
    Stream.runForEach(
      Effect.fn('Egress.toDesktop')(function* (chunk: Uint8Array) {
        const frames = cut(chunk)
        if (Option.isNone(frames)) return yield* new TunnelInvalid({})
        for (const frame of frames.value) {
          counted(count(frame, true))
          yield* app.write(frame)
        }
        // The frames are in the socket, not yet with the app. Until they have left, this
        // chunk still counts as waiting, so the channel stays paused behind a slow app.
        if (app.buffered() > QUEUE_LIMIT) yield* app.drained
        waiting.bytes -= chunk.length
        if (waiting.bytes <= QUEUE_LIMIT && tunnel.isPaused()) tunnel.resume()
        return undefined
      }),
    ),
  )
  yield* Effect.raceFirst(toComputer, toDesktop).pipe(
    Effect.catchTags({
      TunnelInvalid: () => Effect.logWarning('The egress tunnel ended: not a frame.'),
      ExitInvalid: () => Effect.logWarning('The egress tunnel ended: the app sent no frame.'),
    }),
  )
})

export const egressRelay = (
  reads: EgressReads,
  machine: Pick<MachineOperations, 'run' | 'tunnel'>,
  changes: Changes['Service'],
): EgressService => {
  /** In this process only: a socket is held by the server that accepted it. */
  const held = new Map<PersonId, Held>()
  const told = (person: PersonId) => changes.publish([Topic.person(person)])
  const { chosen, running } = reads
  const wanted = Effect.fn('Egress.wanted')(function* (person: PersonId) {
    return (yield* chosen(person)) && (yield* running(person))
  })

  const status = Effect.fn('Egress.status')(function* (person: PersonId) {
    if (!(yield* chosen(person))) return EgressStatus.cases.Off.make({})
    const entry = held.get(person)
    if (entry === undefined) return EgressStatus.cases.Waiting.make({})
    return Carrying.match(entry.phase, {
      Parked: (): EgressStatus => EgressStatus.cases.Waiting.make({}),
      Joined: ({ streams }): EgressStatus => EgressStatus.cases.Routing.make({ streams }),
      Failed: (): EgressStatus => EgressStatus.cases.Failed.make({ reason: 'Computer' }),
    })
  })

  /**
   * Joined: frames are carried until the Computer's side ends (`pumped`), and this socket's
   * status says so meanwhile. Watchers are told that the join was made, and not each time the
   * count moves: a change to a Person's topic makes every open screen of theirs read again, and
   * the count moves with every connection the browser opens. Whoever reads the status gets the
   * count as it is then.
   */
  const joined = Effect.fn('Egress.joined')(function* (
    person: PersonId,
    entry: Held,
    app: ExitSocket,
    tunnel: NodeStream.Duplex,
  ) {
    entry.phase = Carrying.cases.Joined.make({ streams: 0 })
    yield* told(person)
    yield* pumped(app, tunnel, (streams) => {
      entry.phase = Carrying.cases.Joined.make({ streams })
    })
  })

  /**
   * One try at joining: the proxy is made sure of, the channel is opened, and frames are
   * carried until the Computer's side ends or `leave` completes. Answers whether it joined.
   */
  const attempt = Effect.fn('Egress.attempt')(function* (
    person: PersonId,
    entry: Held,
    app: ExitSocket,
    leave: Effect.Effect<void>,
  ) {
    // The machine a Person's Computer runs on: the one every action of theirs uses.
    const key = computerMachineKey(person)
    if (!(yield* startProxy(machine, key))) return false
    const tunnel = yield* machine.tunnel({ key, port: EGRESS_TUNNEL_PORT }).pipe(
      Effect.asSome,
      Effect.catch((failure) =>
        Effect.logWarning('The egress tunnel could not be opened.', failure._tag).pipe(
          Effect.as(Option.none<NodeStream.Duplex>()),
        ),
      ),
    )
    if (Option.isNone(tunnel)) return false
    yield* Effect.raceFirst(joined(person, entry, app, tunnel.value), leave)
    return true
  })

  const carry = Effect.fn('Egress.carry')(function* (person: PersonId, app: ExitSocket) {
    const entry: Held = {
      phase: Carrying.cases.Parked.make({}),
      replaced: yield* Deferred.make<void>(),
    }
    const before = held.get(person)
    held.set(person, entry)
    if (before !== undefined) yield* Deferred.succeed(before.replaced, undefined)
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        if (held.get(person) !== entry) return Effect.void
        held.delete(person)
        return told(person)
      }),
    )
    // Subscribed before the first look, so a change between the look and the wait is not lost.
    // Every reason to look again is one reason: a change to anything of this Person's (their
    // setting, their Computer starting or stopping), or time passing.
    const looks = yield* Queue.sliding<void>(1)
    const moved = yield* changes.subscribe([Topic.person(person)], everyPart)
    yield* Effect.forkScoped(
      Stream.merge(moved, Stream.tick(LOOK_AGAIN)).pipe(
        Stream.runForEach(() => Queue.offer(looks, undefined)),
      ),
    )
    /** Waits for the look at which the answer to "carry egress for this Person?" is `want`. */
    const until = Effect.fn('Egress.until')(function* (want: boolean) {
      for (;;) {
        yield* Queue.take(looks)
        // A record that could not be read says nothing either way: look again at the next one.
        const now = yield* wanted(person).pipe(Effect.option)
        if (Option.isSome(now) && now.value === want) return
      }
    })
    const park = (phase: Carrying) =>
      Effect.suspend(() => {
        const changed = entry.phase._tag !== phase._tag
        entry.phase = phase
        return changed ? told(person) : Effect.void
      })
    /**
     * Parked, then joined once, and then over: a join that ends for any reason ends the hold,
     * which closes the socket (see the module's note on one socket being one join). Exactly one
     * thing reads the socket at a time: while parked nothing is expected from the app, and what
     * arrives is read and dropped so that its close is seen; while joined the join reads it. A
     * join that could not be made carried nothing, so the socket is kept and it is tried again
     * at the next look, never in a loop.
     */
    const life = Effect.fn('Egress.life')(function* () {
      for (;;) {
        yield* Effect.raceFirst(until(true), app.pull.pipe(Effect.forever))
        if (yield* Effect.scoped(attempt(person, entry, app, until(false)))) return
        yield* park(Carrying.cases.Failed.make({}))
      }
    })
    yield* told(person)
    yield* Queue.offer(looks, undefined)
    yield* Effect.raceFirst(life(), Deferred.await(entry.replaced))
  })

  return { status, carry }
}

/**
 * The relay over the server's own records: the Person's setting, and their Computer's row. The
 * row is read, not the provider: a parked socket asks on every change and every tick, and none
 * of those may wake a machine or spend a provider call.
 */
export const egressLayer = Layer.effect(
  Egress,
  Effect.gen(function* () {
    const database = yield* Database
    const running = Effect.fn('Egress.running')(function* (person: PersonId) {
      const rows = yield* database.run(
        database
          .select({ id: computers.id })
          .from(computers)
          .where(and(eq(computers.personId, person), eq(computers.status, 'running')))
          .limit(1),
      )
      return rows.length > 0
    })
    return Egress.of(
      egressRelay(
        {
          chosen: (person) => egressChosen(person).pipe(Effect.provideService(Database, database)),
          running,
        },
        yield* Machine,
        yield* Changes,
      ),
    )
  }),
)
