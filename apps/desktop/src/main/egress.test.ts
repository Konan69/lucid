import { describe, expect, it } from '@effect/vitest'
import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeHttp from 'node:http'
import * as NodeNet from 'node:net'
import * as NodeURL from 'node:url'
import {
  EGRESS_FRAME_LIMIT,
  EGRESS_LINK_BUDGET,
  EGRESS_PAYLOAD_LIMIT,
  EGRESS_STREAM_BUDGET,
  EgressFrame,
  EgressStream,
  decodeEgressFrame,
  encodeEgressFrame,
} from '@vivid/contracts'
import * as Arr from 'effect/Array'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import { Unresolved } from './reach.ts'
import {
  DRAIN,
  ExitStatus,
  QUEUE_BOUND,
  QUIET,
  checkedAddress,
  exitLink,
  type ExitDependencies,
  type ExitSocket,
} from './egress.ts'

/**
 * The exit client against the real program that runs on the Computer
 * (`apps/server/src/computers/egress/proxy.mjs`), over real sockets on loopback. The one leg that
 * is not the product's is the middle: in the product the app's WebSocket reaches the server,
 * which writes each message to the Computer's tunnel port with its length in front
 * (`apps/server/src/computers/egress/relay.ts`). Here `joined` does exactly that directly.
 */
const proxyFile = NodeURL.fileURLToPath(
  new URL('../../../server/src/computers/egress/proxy.mjs', import.meta.url),
)

const Ports = Schema.fromJsonString(Schema.Struct({ tunnel: Schema.Int, proxy: Schema.Int }))
const decodePorts = Schema.decodeUnknownEffect(Ports)

/** Starts the Computer's proxy on free ports and stops it with the scope. */
const computerProxy = Effect.fn('EgressTest.computerProxy')(function* () {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(process.execPath, [proxyFile, '0', '0'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    ),
    (spawned) => Effect.sync(() => spawned.kill()),
  )
  const line = yield* Effect.callback<string>((resume) => {
    child.stdout.once('data', (chunk: Buffer) => resume(Effect.succeed(chunk.toString('utf8'))))
  })
  return yield* decodePorts(line)
})

/** Where a listening server is bound, as Node reports it for a TCP listener. */
const decodeBound = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))

/** A server on a free loopback port, closed with the scope along with whatever it still holds. */
const listening = (server: NodeNet.Server) =>
  Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, '127.0.0.1', () => resume(Effect.void))
    }).pipe(
      Effect.andThen(Effect.suspend(() => decodeBound(server.address()))),
      Effect.map((bound) => bound.port),
      Effect.orDie,
    ),
    () =>
      Effect.sync(() => {
        if (server instanceof NodeHttp.Server) server.closeAllConnections()
        server.close()
      }),
  )

/**
 * The tunnel's socket as the exit client sees it, joined straight to the Computer's tunnel
 * port: each message is written with its length in front, and each length-prefixed frame that
 * arrives is one message. `bufferedAmount` is what the socket has not written yet, as a
 * WebSocket's is.
 */
const joined = (tunnelPort: number) => {
  const socket = NodeNet.connect(tunnelPort, '127.0.0.1')
  // The events a WebSocket has, from a real event target.
  const events = new EventTarget()
  let held = Buffer.alloc(0)
  socket.on('connect', () => events.dispatchEvent(new Event('open')))
  socket.on('error', () => undefined)
  socket.on('close', () => events.dispatchEvent(new Event('close')))
  socket.on('data', (chunk: Buffer) => {
    held = Buffer.concat([held, chunk])
    while (held.length >= 4 && held.length >= 4 + held.readUInt32BE(0)) {
      const size = held.readUInt32BE(0)
      events.dispatchEvent(
        new MessageEvent('message', { data: Uint8Array.from(held.subarray(4, 4 + size)) }),
      )
      held = held.subarray(4 + size)
    }
  })
  const exit: ExitSocket = {
    binaryType: 'arraybuffer',
    get bufferedAmount() {
      return socket.writableLength
    },
    send: (data) => {
      const size = Buffer.alloc(4)
      size.writeUInt32BE(data.length)
      socket.write(Buffer.concat([size, data]))
    },
    close: () => socket.destroy(),
    addEventListener: (type, listener) => events.addEventListener(type, listener),
  }
  return { exit, socket }
}

const never = () => Effect.fail(new Unresolved({}))

/** Runs an exit client joined to the Computer's proxy, and waits until its socket is open. */
const attached = Effect.fn(function* (
  tunnelPort: number,
  overrides: Partial<Pick<ExitDependencies, 'allowPrivateTargets' | 'resolve' | 'dial'>>,
) {
  const statuses = yield* Queue.unbounded<ExitStatus>()
  const tunnel = joined(tunnelPort)
  const link = yield* exitLink({
    socket: () => Option.some(tunnel.exit),
    resolve: never,
    dial: (address, port) => NodeNet.createConnection({ host: address, port, allowHalfOpen: true }),
    allowPrivateTargets: true,
    ...overrides,
    onStatus: (status) => {
      Queue.offerUnsafe(statuses, status)
    },
  })
  yield* Effect.forkScoped(link.run)
  const until = Effect.fn(function* (matches: (status: ExitStatus) => boolean) {
    for (;;) {
      const status = yield* Queue.take(statuses)
      if (matches(status)) return status
    }
  })
  yield* until(ExitStatus.guards.Connected)
  return { tunnel, until, state: link.state }
})

/**
 * One request through the proxy as a browser makes an HTTPS one: `CONNECT`, then bytes. The
 * request is sent in the same write as the `CONNECT`, so it also proves bytes that arrive with
 * the header are not lost. Answers everything that came back after the proxy's own reply.
 */
const tunnelled = (proxyPort: number, target: string, path: string) =>
  Effect.callback<Buffer>((resume) => {
    const socket = NodeNet.connect(proxyPort, '127.0.0.1')
    const chunks: Array<Buffer> = []
    socket.on('connect', () =>
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n` +
          `GET ${path} HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`,
      ),
    )
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      const all = Buffer.concat(chunks)
      resume(Effect.succeed(all.subarray(all.indexOf('\r\n\r\n') + 4)))
    })
    return Effect.sync(() => socket.destroy())
  })

/** The body of an HTTP reply: what follows its header. */
const bodyOf = (reply: Buffer) => reply.subarray(reply.indexOf('\r\n\r\n') + 4)

const digest = (bytes: Uint8Array) => NodeCrypto.createHash('sha256').update(bytes).digest('hex')

/** A site: answers every request with `body`, and counts the requests it saw. */
const site = (body: Buffer) => {
  const seen = { requests: 0 }
  const server = NodeHttp.createServer((_request, response) => {
    seen.requests += 1
    response.end(body)
  })
  return { server, seen }
}

/**
 * The tunnel's socket with the test at its far end, for what the Computer's real proxy never
 * does: frames that break the protocol, and streams held exactly where the test wants them.
 * What the exit client sends is read back as frames; `closed` is the client closing the socket.
 */
const byHand = Effect.fn('EgressTest.byHand')(function* () {
  const events = new EventTarget()
  const sent = yield* Queue.unbounded<EgressFrame>()
  const closed = yield* Deferred.make<void>()
  const exit: ExitSocket = {
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    send: (data) => {
      Queue.offerUnsafe(sent, Result.getOrThrow(decodeEgressFrame(data)))
    },
    close: () => {
      if (Deferred.doneUnsafe(closed, Effect.void)) events.dispatchEvent(new Event('close'))
    },
    addEventListener: (type, listener) => events.addEventListener(type, listener),
  }
  const raw = (bytes: Uint8Array) =>
    Effect.sync(() => events.dispatchEvent(new MessageEvent('message', { data: bytes })))
  return {
    exit,
    opened: Effect.sync(() => events.dispatchEvent(new Event('open'))),
    raw,
    say: (frame: EgressFrame) => raw(encodeEgressFrame(frame)),
    /** The next frame the exit client sent. */
    frame: Queue.take(sent),
    sent,
    closed: Deferred.await(closed),
  }
})

/** An exit client on a hand-driven socket, open, dialling loopback targets itself. */
const handDriven = Effect.fn('EgressTest.handDriven')(function* (
  overrides: Partial<Pick<ExitDependencies, 'resolve' | 'allowPrivateTargets'>>,
) {
  const hand = yield* byHand()
  const statuses = yield* Queue.unbounded<ExitStatus>()
  const targets = yield* Queue.unbounded<{
    readonly socket: NodeNet.Socket
    readonly closed: Effect.Effect<void>
  }>()
  const link = yield* exitLink({
    socket: () => Option.some(hand.exit),
    resolve: never,
    dial: (address, port) => {
      const socket = NodeNet.createConnection({ host: address, port, allowHalfOpen: true })
      const closed = Deferred.makeUnsafe<void>()
      socket.on('close', () => Deferred.doneUnsafe(closed, Effect.void))
      Queue.offerUnsafe(targets, { socket, closed: Deferred.await(closed) })
      return socket
    },
    allowPrivateTargets: true,
    ...overrides,
    onStatus: (status) => {
      Queue.offerUnsafe(statuses, status)
    },
  })
  const fiber = yield* Effect.forkScoped(link.run)
  const until = Effect.fn(function* (matches: (status: ExitStatus) => boolean) {
    for (;;) {
      const status = yield* Queue.take(statuses)
      if (matches(status)) return status
    }
  })
  yield* until(ExitStatus.guards.Connecting)
  yield* hand.opened
  /** Waits until this many targets have been dialled since the socket opened. */
  const dialled = (count: number) =>
    until((status) => ExitStatus.guards.Connected(status) && status.relayed === count)
  return {
    ...hand,
    fiber,
    until,
    dialled,
    /** The next socket this computer dialled, and its close: the socket's own, on this side. */
    target: Queue.take(targets),
  }
})

/**
 * A site that takes connections and never reads them. A socket that is not read never learns
 * that its far end went, so what a test watches is the socket this computer dialled
 * (`handDriven`, `target`).
 */
const stalledSite = Effect.fn('EgressTest.stalledSite')(function* () {
  const server = NodeNet.createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
    socket.on('error', () => undefined)
  })
  return { port: yield* listening(server) }
})

const one = EgressStream.make(1)
const two = EgressStream.make(2)
const openTo = (stream: EgressStream, port: number) =>
  EgressFrame.cases.Open.make({ stream, host: '127.0.0.1', port })
/** The longest frame of one stream, a megabyte, made once and sent as often as a test needs. */
const megabyte = (stream: EgressStream) =>
  encodeEgressFrame(
    EgressFrame.cases.Data.make({ stream, payload: new Uint8Array(EGRESS_PAYLOAD_LIMIT) }),
  )
const megabytes = (bytes: number) => Math.ceil(bytes / (1 << 20))

describe('egress through the Person’s computer', () => {
  it.live(
    'a page larger than the queue bound arrives whole, and the target is paused meanwhile',
    () =>
      Effect.gen(function* () {
        const body = NodeCrypto.randomBytes(QUEUE_BOUND * 4)
        const { server, seen } = site(body)
        const sitePort = yield* listening(server)
        const ports = yield* computerProxy()
        const paused = yield* Deferred.make<number>()
        const dialled: Array<string> = []
        const { tunnel } = yield* attached(ports.tunnel, {
          dial: (address, port) => {
            dialled.push(`${address}:${port}`)
            const target = NodeNet.createConnection({ host: address, port, allowHalfOpen: true })
            const pause = target.pause.bind(target)
            target.pause = () => {
              Deferred.doneUnsafe(paused, Effect.succeed(tunnel.socket.writableLength))
              return pause()
            }
            return target
          },
        })
        // Nothing leaves toward the Computer until the tunnel is uncorked, so the queue must fill
        // and the exit client must stop reading the site.
        tunnel.socket.cork()
        const reply = yield* Effect.forkScoped(tunnelled(ports.proxy, `127.0.0.1:${sitePort}`, '/'))
        // The stream's open went out before the cork; the site's answer is what queues behind it.
        const queued = yield* Deferred.await(paused)
        expect(queued).toBeGreaterThan(QUEUE_BOUND)
        expect(queued).toBeLessThan(body.length)
        tunnel.socket.uncork()
        const received = bodyOf(yield* Fiber.join(reply))
        expect(received.length).toBe(body.length)
        expect(digest(received)).toBe(digest(body))
        expect(dialled).toEqual([`127.0.0.1:${sitePort}`])
        expect(seen.requests).toBe(1)
      }),
  )

  it.live('a plain HTTP page is carried the same way', () =>
    Effect.gen(function* () {
      const body = Buffer.from('carried over plain HTTP')
      const { server } = site(body)
      const sitePort = yield* listening(server)
      const ports = yield* computerProxy()
      const dialled: Array<number> = []
      yield* attached(ports.tunnel, {
        dial: (address, port) => {
          dialled.push(port)
          return NodeNet.createConnection({ host: address, port, allowHalfOpen: true })
        },
      })
      const answer = yield* Effect.callback<string>((resume) => {
        NodeHttp.get(
          { host: '127.0.0.1', port: ports.proxy, path: `http://127.0.0.1:${sitePort}/page` },
          (response) => {
            const chunks: Array<Buffer> = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () => resume(Effect.succeed(Buffer.concat(chunks).toString())))
          },
        )
      })
      expect(answer).toBe('carried over plain HTTP')
      expect(dialled).toEqual([sitePort])
    }),
  )

  it.live('a target inside the Person’s own network is refused and never dialled', () =>
    Effect.gen(function* () {
      const { server, seen } = site(Buffer.from('the router’s own page'))
      const sitePort = yield* listening(server)
      const ports = yield* computerProxy()
      const dialled: Array<string> = []
      yield* attached(ports.tunnel, {
        allowPrivateTargets: false,
        // A name that leads home is refused after it is resolved, not only when written as one.
        resolve: (host) =>
          host === 'printer.home'
            ? Effect.succeed(['192.168.1.20'])
            : Effect.fail(new Unresolved({})),
        dial: (address, port) => {
          dialled.push(address)
          return NodeNet.createConnection({ host: address, port, allowHalfOpen: true })
        },
      })
      const loopback = yield* tunnelled(ports.proxy, `127.0.0.1:${sitePort}`, '/')
      const named = yield* tunnelled(ports.proxy, `printer.home:${sitePort}`, '/')
      const unknown = yield* tunnelled(ports.proxy, `nowhere.invalid:${sitePort}`, '/')
      // Each was told the tunnel stands and then met a closed connection with nothing in it.
      expect([loopback.length, named.length, unknown.length]).toEqual([0, 0, 0])
      expect(dialled).toEqual([])
      expect(seen.requests).toBe(0)
    }),
  )

  it.live(
    'the site closing ends the browser’s connection, and the browser closing ends the site’s',
    () =>
      Effect.gen(function* () {
        const ended = yield* Deferred.make<void>()
        const accepted = yield* Deferred.make<NodeNet.Socket>()
        const server = NodeNet.createServer((socket) => {
          socket.on('error', () => undefined)
          socket.on('close', () => Deferred.doneUnsafe(ended, Effect.void))
          Deferred.doneUnsafe(accepted, Effect.succeed(socket))
        })
        const sitePort = yield* listening(server)
        const ports = yield* computerProxy()
        const { until } = yield* attached(ports.tunnel, {})

        // The site hangs up: the browser's connection ends, and the exit client forgets the stream.
        const first = yield* Effect.forkScoped(tunnelled(ports.proxy, `127.0.0.1:${sitePort}`, '/'))
        const held = yield* Deferred.await(accepted)
        held.destroy()
        expect((yield* Fiber.join(first)).length).toBe(0)
        yield* until((status) => ExitStatus.guards.Connected(status) && status.active === 0)

        // The browser hangs up: the site's connection ends.
        const closing = yield* Deferred.make<void>()
        const again = yield* Deferred.make<void>()
        server.removeAllListeners('connection')
        server.on('connection', (socket) => {
          // Read, so that the far end hanging up is seen: an unread socket never reports its end.
          socket.resume()
          socket.on('error', () => undefined)
          socket.on('close', () => Deferred.doneUnsafe(closing, Effect.void))
          Deferred.doneUnsafe(again, Effect.void)
        })
        const second = yield* Effect.forkScoped(
          tunnelled(ports.proxy, `127.0.0.1:${sitePort}`, '/'),
        )
        yield* Deferred.await(again)
        yield* Fiber.interrupt(second)
        yield* Deferred.await(closing)
      }),
  )

  it.live('a request ended before its answer still gets the answer', () =>
    Effect.gen(function* () {
      // A site that answers only once it has read the whole request.
      const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
        const chunks: Array<Buffer> = []
        socket.on('data', (chunk: Buffer) => chunks.push(chunk))
        socket.on('end', () => socket.end(`heard ${Buffer.concat(chunks).toString('utf8')}`))
      })
      const sitePort = yield* listening(server)
      const ports = yield* computerProxy()
      const { until } = yield* attached(ports.tunnel, {})
      const answer = yield* Effect.callback<string>((resume) => {
        const socket = NodeNet.connect({
          port: ports.proxy,
          host: '127.0.0.1',
          allowHalfOpen: true,
        })
        const chunks: Array<Buffer> = []
        socket.on('connect', () =>
          socket.end(`CONNECT 127.0.0.1:${sitePort} HTTP/1.1\r\n\r\nthe whole request`),
        )
        socket.on('data', (chunk: Buffer) => chunks.push(chunk))
        socket.on('end', () => {
          socket.end()
          resume(Effect.succeed(Buffer.concat(chunks).toString('utf8')))
        })
        return Effect.sync(() => socket.destroy())
      })
      expect(answer.endsWith('heard the whole request')).toBe(true)
      // Both sides ended, so the stream is over, and nobody had to drop it.
      yield* until((status) => ExitStatus.guards.Connected(status) && status.active === 0)
    }),
  )

  it.live('a stream the Computer dropped is still this computer’s to end', () =>
    Effect.gen(function* () {
      const stalled = yield* stalledSite()
      const hand = yield* handDriven({})
      yield* hand.say(openTo(one, stalled.port))
      yield* hand.dialled(1)
      const target = yield* hand.target
      // More than the site's socket will take while it reads nothing, then the Computer drops it.
      const data = megabyte(one)
      for (let at = 0; at < 16; at += 1) yield* hand.raw(data)
      yield* hand.say(EgressFrame.cases.Close.make({ stream: one }))
      yield* hand.until((status) => ExitStatus.guards.Connected(status) && status.active === 0)
      // The link goes: every connection it made goes with it, the one being let out included.
      yield* Fiber.interrupt(hand.fiber)
      yield* target.closed
    }),
  )

  it.effect('a dropped stream’s target is given a bounded time to take what was written', () =>
    Effect.gen(function* () {
      const stalled = yield* stalledSite()
      const hand = yield* handDriven({})
      yield* hand.say(openTo(one, stalled.port))
      yield* hand.dialled(1)
      const target = yield* hand.target
      const data = megabyte(one)
      for (let at = 0; at < 16; at += 1) yield* hand.raw(data)
      yield* hand.say(EgressFrame.cases.Close.make({ stream: one }))
      yield* hand.until((status) => ExitStatus.guards.Connected(status) && status.active === 0)
      yield* TestClock.adjust(Duration.millis(Duration.toMillis(DRAIN) - 1))
      expect(target.socket.destroyed).toBe(false)
      yield* TestClock.adjust('1 millis')
      yield* target.closed
    }),
  )

  it.effect('a site that stays silent after the request ended is let go', () =>
    Effect.gen(function* () {
      const stalled = yield* stalledSite()
      const hand = yield* handDriven({})
      yield* hand.say(openTo(one, stalled.port))
      yield* hand.dialled(1)
      const target = yield* hand.target
      yield* hand.say(EgressFrame.cases.End.make({ stream: one }))
      yield* TestClock.adjust(QUIET)
      expect(yield* hand.frame).toEqual(EgressFrame.cases.Close.make({ stream: one }))
      yield* target.closed
    }),
  )

  it.live('a site that has stopped reading costs its own stream at the budget, and no other', () =>
    Effect.gen(function* () {
      const stalled = yield* stalledSite()
      const echo = NodeNet.createServer((socket) => socket.pipe(socket))
      const echoPort = yield* listening(echo)
      const hand = yield* handDriven({})
      yield* hand.say(openTo(one, stalled.port))
      yield* hand.say(openTo(two, echoPort))
      yield* hand.dialled(2)
      const target = yield* hand.target
      const data = megabyte(one)
      for (let at = 0; at < megabytes(EGRESS_STREAM_BUDGET) + 8; at += 1) yield* hand.raw(data)
      expect(yield* hand.frame).toEqual(EgressFrame.cases.Close.make({ stream: one }))
      yield* target.closed
      yield* hand.say(EgressFrame.cases.Data.make({ stream: two, payload: Buffer.from('ping') }))
      const back = yield* hand.frame
      expect(EgressFrame.guards.Data(back) && Buffer.from(back.payload).toString()).toBe('ping')
    }),
  )

  it.live('a stream whose name is still being resolved is held to the same budget', () =>
    Effect.gen(function* () {
      const hand = yield* handDriven({ resolve: () => Effect.never })
      yield* hand.say(EgressFrame.cases.Open.make({ stream: one, host: 'slow.example', port: 80 }))
      const data = megabyte(one)
      for (let at = 0; at <= megabytes(EGRESS_STREAM_BUDGET); at += 1) yield* hand.raw(data)
      expect(yield* hand.frame).toEqual(EgressFrame.cases.Close.make({ stream: one }))
    }),
  )

  it.live('all the streams of a link together are held to the link’s budget', () =>
    Effect.gen(function* () {
      const stalled = yield* stalledSite()
      const hand = yield* handDriven({})
      // Each stream stays under its own budget; together they go over the link's.
      const each = megabytes(EGRESS_STREAM_BUDGET) - 2
      const count = Math.ceil(megabytes(EGRESS_LINK_BUDGET) / each)
      const streams = Arr.makeBy(count, (at) => EgressStream.make(at + 1))
      for (const stream of streams) yield* hand.say(openTo(stream, stalled.port))
      yield* hand.dialled(count)
      for (const stream of streams) {
        const data = megabyte(stream)
        for (let at = 0; at < each; at += 1) yield* hand.raw(data)
      }
      // The stream whose bytes crossed the bound is the one that is closed.
      expect(yield* hand.frame).toEqual(
        EgressFrame.cases.Close.make({ stream: EgressStream.make(count) }),
      )
    }),
  )

  it.live('a frame that breaks the protocol costs at most its own stream', () =>
    Effect.gen(function* () {
      const stalled = yield* stalledSite()
      const hand = yield* handDriven({})
      // Short, of no known kind, and data for a stream nobody has: passed over.
      yield* hand.raw(Uint8Array.from([2, 0]))
      yield* hand.raw(Uint8Array.from([9, 0, 0, 0, 1]))
      yield* hand.say(EgressFrame.cases.Data.make({ stream: two, payload: Buffer.from('x') }))
      // An open that names no host: that stream is refused, so its browser is not left waiting.
      yield* hand.raw(Uint8Array.from([1, 0, 0, 0, 7, 0, 80]))
      expect(yield* hand.frame).toEqual(
        EgressFrame.cases.Close.make({ stream: EgressStream.make(7) }),
      )
      // A number in use cannot be two connections: both sides forget it, and the first target
      // is not left connected.
      yield* hand.say(openTo(one, stalled.port))
      yield* hand.dialled(1)
      const target = yield* hand.target
      yield* hand.say(openTo(one, stalled.port))
      expect(yield* hand.frame).toEqual(EgressFrame.cases.Close.make({ stream: one }))
      yield* target.closed
      // Data after a close is for a stream nobody has.
      yield* hand.say(EgressFrame.cases.Data.make({ stream: one, payload: Buffer.from('late') }))
      expect(yield* Queue.size(hand.sent)).toBe(0)
      // The number is free again.
      yield* hand.say(openTo(one, stalled.port))
      yield* hand.dialled(2)
    }),
  )

  it.live('a message longer than a frame ends the link, and it is dialled again', () =>
    Effect.gen(function* () {
      const stalled = yield* stalledSite()
      const hand = yield* handDriven({})
      yield* hand.say(openTo(one, stalled.port))
      yield* hand.dialled(1)
      const target = yield* hand.target
      const long = new Uint8Array(EGRESS_FRAME_LIMIT + 1)
      long.set([1, 0, 0, 0, 2, 0, 80])
      yield* hand.raw(long)
      yield* hand.closed
      yield* target.closed
      // Not a defect: the link is still running, and waits its two seconds to dial again.
      yield* hand.until(ExitStatus.guards.Connecting)
      expect(hand.fiber.pollUnsafe()).toBeUndefined()
    }),
  )

  it.live('with nothing attached the Computer’s proxy dials from the Computer itself', () =>
    Effect.gen(function* () {
      const body = Buffer.from('reached directly')
      const { server } = site(body)
      const sitePort = yield* listening(server)
      const ports = yield* computerProxy()
      const reply = yield* tunnelled(ports.proxy, `127.0.0.1:${sitePort}`, '/')
      expect(bodyOf(reply).toString()).toBe('reached directly')
    }),
  )

  it.effect(
    'dials again after the link drops: two seconds, then doubling while it cannot open',
    () =>
      Effect.gen(function* () {
        /** Each socket dialled, as the event target the test opens and closes by hand. */
        const sockets: Array<EventTarget> = []
        const happens = (index: number, type: 'open' | 'close') =>
          Option.map(Arr.get(sockets, index), (events) => events.dispatchEvent(new Event(type)))
        const statuses: Array<ExitStatus['_tag']> = []
        const link = yield* exitLink({
          socket: () => {
            const events = new EventTarget()
            sockets.push(events)
            return Option.some({
              binaryType: '',
              bufferedAmount: 0,
              send: () => undefined,
              close: () => undefined,
              addEventListener: (type, listener) => events.addEventListener(type, listener),
            })
          },
          resolve: never,
          dial: (address, port) =>
            NodeNet.createConnection({ host: address, port, allowHalfOpen: true }),
          allowPrivateTargets: false,
          onStatus: (status) => {
            statuses.push(status._tag)
          },
        })
        yield* Effect.forkScoped(link.run)
        yield* TestClock.adjust(0)
        expect(sockets.length).toBe(1)
        happens(0, 'open')
        expect(link.state()).toEqual(ExitStatus.cases.Connected.make({ relayed: 0, active: 0 }))

        // The link drops. Nothing is dialled until two seconds have passed.
        happens(0, 'close')
        yield* TestClock.adjust('1999 millis')
        expect(sockets.length).toBe(1)
        yield* TestClock.adjust('1 millis')
        expect(sockets.length).toBe(2)

        // The server is still away: the next tries wait two seconds, then four.
        happens(1, 'close')
        yield* TestClock.adjust('2 seconds')
        expect(sockets.length).toBe(3)
        happens(2, 'close')
        yield* TestClock.adjust('3999 millis')
        expect(sockets.length).toBe(3)
        yield* TestClock.adjust('1 millis')
        expect(sockets.length).toBe(4)
        happens(3, 'open')
        expect(link.state()._tag).toBe('Connected')
        expect(statuses.at(-1)).toBe('Connected')
      }),
  )

  it.effect('rests with nobody to dial as, and dials when told the session changed', () =>
    Effect.gen(function* () {
      const session = { signedIn: false, dials: 0 }
      const link = yield* exitLink({
        socket: () => {
          if (!session.signedIn) return Option.none()
          session.dials += 1
          return Option.some({
            binaryType: '',
            bufferedAmount: 0,
            send: () => undefined,
            close: () => undefined,
            addEventListener: () => undefined,
          })
        },
        resolve: never,
        dial: (address, port) =>
          NodeNet.createConnection({ host: address, port, allowHalfOpen: true }),
        allowPrivateTargets: false,
        onStatus: () => undefined,
      })
      yield* Effect.forkScoped(link.run)
      yield* TestClock.adjust('5 minutes')
      expect(session.dials).toBe(0)
      expect(link.state()).toEqual(ExitStatus.cases.Off.make({}))
      session.signedIn = true
      link.restart()
      yield* TestClock.adjust(0)
      expect(session.dials).toBe(1)
    }),
  )

  it.effect('the first address a name leads to that may be dialled is the one dialled', () =>
    Effect.gen(function* () {
      const resolve = () => Effect.succeed(['10.0.0.5', '93.184.216.34', '8.8.8.8'])
      expect(
        yield* checkedAddress('site.example', { resolve, allowPrivateTargets: false }),
      ).toEqual(Option.some('93.184.216.34'))
      expect(
        yield* checkedAddress('::ffff:10.0.0.5', { resolve, allowPrivateTargets: false }),
      ).toEqual(Option.none())
      // Local IPv6 ranges the reference lets through are passed over after a name is resolved,
      // and refused when written out.
      const local = () =>
        Effect.succeed(['fec0::1', '64:ff9b:1::a00:1', '2002:c0a8:101::1', '2606:4700:4700::1111'])
      expect(
        yield* checkedAddress('site.example', { resolve: local, allowPrivateTargets: false }),
      ).toEqual(Option.some('2606:4700:4700::1111'))
      expect(
        yield* checkedAddress('64:ff9b:1::a00:1', { resolve, allowPrivateTargets: false }),
      ).toEqual(Option.none())
    }),
  )
})
