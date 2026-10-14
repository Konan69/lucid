import { NodeHttpServer } from '@effect/platform-node'
import { NodeWS } from '@effect/platform-node/NodeSocket'
import { describe, expect, it } from '@effect/vitest'
import * as NodeChildProcess from 'node:child_process'
import * as NodeHttp from 'node:http'
import * as NodeNet from 'node:net'
import * as NodeURL from 'node:url'
import {
  EGRESS_BEAT,
  EGRESS_DEADLINE_MILLIS,
  EGRESS_FRAME_LIMIT,
  EGRESS_PING_MILLIS,
  EGRESS_WINDOW,
  EgressFrame,
  EgressStatus,
  PersonId,
  decodeEgressFrame,
  encodeEgressFrame,
} from '@vivid/contracts'
import {
  Array as Arr,
  Deferred,
  Effect,
  Fiber,
  Option,
  PubSub,
  Queue,
  Result,
  Schema,
  Stream,
} from 'effect'
import * as NetAddress from 'effect/net/NetAddress'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as TestClock from 'effect/testing/TestClock'
import { Changes } from '../../live/changes.ts'
import {
  Egress,
  QUEUE_LIMIT,
  type EgressService,
  type ExitSocket,
  egressRelay,
  frameCutter,
  lengthPrefixed,
} from './relay.ts'
import { CLOSE_DEADLINE_MILLIS, exitSocket, held } from './route.ts'

/**
 * The relay against the real program that runs on the Computer (`proxy.mjs`), over real sockets
 * on loopback. Two legs are stood in for, each by the plainest thing with the same shape: the
 * SSH channel to the Computer's tunnel port is a TCP connection to that port, and the desktop
 * app's WebSocket is a pair of queues the test reads and writes as that app would
 * (`apps/desktop/src/main/egress.test.ts` runs the app's real exit client against this same
 * proxy).
 */
const proxyFile = NodeURL.fileURLToPath(new URL('./proxy.mjs', import.meta.url))
const person = PersonId.make('person-egress-relay')

const Said = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ tunnel: Schema.Int, proxy: Schema.Int }),
    Schema.Struct({ attached: Schema.Boolean }),
  ]),
)
const decodeSaid = Schema.decodeUnknownOption(Said)

/** Where a listening server is bound, as Node reports it for a TCP listener. */
const decodeBound = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))

/** Listens on a free loopback port and answers which. */
const bound = (server: NodeNet.Server) =>
  Effect.callback<void>((resume) => {
    server.listen(0, '127.0.0.1', () => resume(Effect.void))
  }).pipe(
    Effect.andThen(Effect.suspend(() => decodeBound(server.address()))),
    Effect.map((address) => address.port),
    Effect.orDie,
  )

/** Starts the Computer's proxy on free ports. `said` is each line it prints, as it prints it. */
const computerProxy = Effect.fn('EgressTest.computerProxy')(function* () {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(process.execPath, [proxyFile, '0', '0'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    ),
    (spawned) => Effect.sync(() => spawned.kill()),
  )
  const said = yield* Queue.unbounded<typeof Said.Type>()
  let rest = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = `${rest}${chunk.toString('utf8')}`.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) Option.map(decodeSaid(line), (fact) => Queue.offerUnsafe(said, fact))
  })
  const first = yield* Queue.take(said)
  if (!('proxy' in first)) return yield* Effect.die('The proxy did not say where it listens')
  /** Waits for the proxy's own word that a tunnel attached, or went. */
  const attached = Effect.fn(function* (want: boolean) {
    for (;;) {
      const fact = yield* Queue.take(said)
      if ('attached' in fact && fact.attached === want) return
    }
  })
  return { ports: first, attached }
})

/** One request through the proxy as a browser makes an HTTPS one; answers what came back. */
const tunnelled = (proxyPort: number, target: string, sent: string) =>
  Effect.callback<string>((resume) => {
    const socket = NodeNet.connect(proxyPort, '127.0.0.1')
    const chunks: Array<Buffer> = []
    socket.on('connect', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${sent}`),
    )
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', () => undefined)
    socket.on('close', () => {
      const all = Buffer.concat(chunks).toString('utf8')
      resume(Effect.succeed(all.slice(all.indexOf('\r\n\r\n') + 4)))
    })
    return Effect.sync(() => socket.destroy())
  })

/** A relay over a real proxy, with the Person's two facts in the test's hands. */
const relaying = Effect.fn('EgressTest.relaying')(function* () {
  const proxy = yield* computerProxy()
  const hub = yield* PubSub.unbounded<void>()
  const changes = Changes.of({
    publish: () => PubSub.publish(hub, undefined).pipe(Effect.asVoid),
    subscribe: () => PubSub.subscribe(hub).pipe(Effect.map(Stream.fromSubscription)),
  })
  const facts = { chosen: false, running: true, started: 0 }
  const relay = egressRelay(
    {
      chosen: () => Effect.sync(() => facts.chosen),
      running: () => Effect.sync(() => facts.running),
    },
    {
      // The proxy is already running here; what is counted is that the relay asked for it.
      run: () =>
        Effect.sync(() => {
          facts.started += 1
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false }
        }),
      tunnel: () =>
        Effect.acquireRelease(
          Effect.callback<NodeNet.Socket>((resume) => {
            const socket = NodeNet.connect(proxy.ports.tunnel, '127.0.0.1')
            socket.on('error', () => undefined)
            socket.once('connect', () => resume(Effect.succeed(socket)))
          }),
          (socket) => Effect.sync(() => socket.destroy()),
        ),
    },
    changes,
  )
  /** A desktop app's socket: what the test sends as the app, and what the relay sent it. */
  const app = Effect.fn('EgressTest.app')(function* () {
    const sent = yield* Queue.unbounded<Uint8Array>()
    const received = yield* Queue.unbounded<Uint8Array>()
    const read = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkScoped(
      Effect.scoped(
        relay.carry(person, {
          pull: Deferred.succeed(read, undefined).pipe(
            Effect.andThen(Queue.take(sent)),
            Effect.map(Arr.of),
          ),
          write: (frame) => Queue.offer(received, frame).pipe(Effect.asVoid),
          // Queues take everything at once: nothing is ever waiting to leave.
          buffered: () => 0,
          drained: Effect.void,
        }),
      ),
    )
    const frame = Queue.take(received).pipe(
      Effect.map(decodeEgressFrame),
      Effect.map(Result.getOrThrow),
    )
    const say = (value: EgressFrame) => Queue.offer(sent, encodeEgressFrame(value))
    const raw = (bytes: Uint8Array) => Queue.offer(sent, bytes)
    /** The relay has this socket in hand: it has begun to read it. */
    return { fiber, frame, say, raw, received, held: Deferred.await(read) }
  })
  const turn = (change: Partial<typeof facts>) =>
    Effect.sync(() => Object.assign(facts, change)).pipe(Effect.andThen(changes.publish([])))
  return { proxy, relay, facts, app, turn, hub }
})

/**
 * A desktop app's WebSocket spoken by hand over a TCP connection, so that the test can do what
 * a WebSocket library will not: stop reading. Frames toward the server are masked with a key of
 * zeros, which a server must accept and which leaves the bytes as they are.
 */
const appSocket = Effect.fn('EgressTest.appSocket')(function* (port: number) {
  const upgraded = yield* Deferred.make<void>()
  const closing = yield* Deferred.make<void>()
  const frames = yield* Queue.unbounded<EgressFrame>()
  const seen = { bytes: 0, wanted: 0, reached: Deferred.makeUnsafe<void>() }
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => NodeNet.connect(port, '127.0.0.1')),
    (opened) => Effect.sync(() => opened.destroy()),
  )
  socket.on('error', () => undefined)
  socket.on('connect', () =>
    socket.write(
      'GET /egress HTTP/1.1\r\nHost: vivid.test\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    ),
  )
  let waiting = Buffer.alloc(0)
  /** Where a frame's payload begins and how long it is, once enough of its head has come. */
  const measured = () => {
    if (waiting.length < 2) return Option.none()
    const short = waiting.readUInt8(1) & 0x7f
    if (short < 126) return Option.some({ head: 2, size: short })
    if (short === 126)
      return waiting.length < 4
        ? Option.none()
        : Option.some({ head: 4, size: waiting.readUInt16BE(2) })
    return waiting.length < 10
      ? Option.none()
      : Option.some({ head: 10, size: Number(waiting.readBigUInt64BE(2)) })
  }
  /** One WebSocket frame from the server, which never masks: its opcode and its payload. */
  const frame = () =>
    Option.flatMap(measured(), ({ head, size }) => {
      if (waiting.length < head + size) return Option.none()
      const found = {
        opcode: waiting.readUInt8(0) & 0x0f,
        payload: Uint8Array.from(waiting.subarray(head, head + size)),
      }
      waiting = waiting.subarray(head + size)
      return Option.some(found)
    })
  socket.on('data', (chunk: Buffer) => {
    waiting = Buffer.concat([waiting, chunk])
    if (!Deferred.isDoneUnsafe(upgraded)) {
      const end = waiting.indexOf('\r\n\r\n')
      if (end < 0) return
      waiting = waiting.subarray(end + 4)
      Deferred.doneUnsafe(upgraded, Effect.void)
    }
    for (let next = frame(); Option.isSome(next); next = frame()) {
      seen.bytes += next.value.payload.length
      if (next.value.opcode === 8) {
        // Answered as an app answers it, so the server's side of the socket can finish too.
        socket.end(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
        Deferred.doneUnsafe(closing, Effect.void)
      }
      if (next.value.opcode === 2)
        Option.map(Result.getSuccess(decodeEgressFrame(next.value.payload)), (read) =>
          Queue.offerUnsafe(frames, read),
        )
      if (seen.bytes >= seen.wanted) Deferred.doneUnsafe(seen.reached, Effect.void)
    }
  })
  yield* Deferred.await(upgraded)
  return {
    frame: Queue.take(frames),
    say: (value: EgressFrame) =>
      Effect.sync(() => {
        const bytes = encodeEgressFrame(value)
        const head = Buffer.from([0x82, 0x80 | 126, 0, 0, 0, 0, 0, 0])
        head.writeUInt16BE(bytes.length, 2)
        socket.write(Buffer.concat([head, bytes]))
      }),
    /** Stops reading, as an app on a slow connection or a busy computer does. */
    stall: Effect.sync(() => socket.pause()),
    /** Reads again, and waits until this many bytes of frames have arrived in all. */
    read: (bytes: number) =>
      Effect.suspend(() => {
        seen.wanted = bytes
        seen.reached = Deferred.makeUnsafe<void>()
        socket.resume()
        return seen.bytes >= bytes ? Effect.void : Deferred.await(seen.reached)
      }),
    /** The server began closing the socket. */
    closing: Deferred.await(closing),
  }
})

describe('the egress relay', () => {
  it.live('carries nothing while egress is off, and the browser goes out from the Computer', () =>
    Effect.gen(function* () {
      const { proxy, relay, facts, app } = yield* relaying()
      const site = NodeHttp.createServer((_request, response) => response.end('direct'))
      const sitePort = yield* Effect.acquireRelease(bound(site), () =>
        Effect.sync(() => site.close()),
      )
      const desktop = yield* app()
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Off.make({}))
      const reply = yield* tunnelled(
        proxy.ports.proxy,
        `127.0.0.1:${sitePort}`,
        'GET / HTTP/1.1\r\nHost: site\r\nConnection: close\r\n\r\n',
      )
      expect(reply.endsWith('direct')).toBe(true)
      // The proxy on the Computer was never started for it, and the app was sent nothing.
      expect(facts.started).toBe(0)
      expect(yield* Queue.size(desktop.received)).toBe(0)
    }),
  )

  it.live(
    'turned on, the browser’s connection is opened by the desktop app and carried both ways',
    () =>
      Effect.gen(function* () {
        const { proxy, relay, app, turn } = yield* relaying()
        const desktop = yield* app()
        yield* turn({ chosen: true })
        yield* proxy.attached(true)
        expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 0 }))

        // A name only the Person's network could resolve: reaching it proves who dialled.
        const reply = yield* Effect.forkScoped(
          tunnelled(proxy.ports.proxy, 'intranet.invalid:443', 'ping'),
        )
        const open = yield* desktop.frame
        expect(EgressFrame.guards.Open(open) && [open.host, open.port]).toEqual([
          'intranet.invalid',
          443,
        ])
        expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 1 }))
        const data = yield* desktop.frame
        expect(EgressFrame.guards.Data(data) && Buffer.from(data.payload).toString()).toBe('ping')

        yield* desktop.say(
          EgressFrame.cases.Data.make({ stream: open.stream, payload: Buffer.from('pong') }),
        )
        yield* desktop.say(EgressFrame.cases.Close.make({ stream: open.stream }))
        expect(yield* Fiber.join(reply)).toBe('pong')
      }),
  )

  it.live('the Computer stopping, or egress turned off, ends the join and the app’s socket', () =>
    Effect.gen(function* () {
      const { proxy, relay, app, turn } = yield* relaying()
      const first = yield* app()
      yield* turn({ chosen: true })
      yield* proxy.attached(true)
      yield* turn({ running: false })
      yield* proxy.attached(false)
      // The hold is over: whoever held the socket closes it, and the app dials again.
      yield* Fiber.join(first.fiber)
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Waiting.make({}))
      const second = yield* app()
      yield* turn({ running: true })
      yield* proxy.attached(true)
      yield* turn({ chosen: false })
      yield* proxy.attached(false)
      yield* Fiber.join(second.fiber)
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Off.make({}))
    }),
  )

  it.live('a join made again starts with nothing of the one before', () =>
    Effect.gen(function* () {
      const { proxy, relay, app, turn } = yield* relaying()
      const first = yield* app()
      yield* turn({ chosen: true })
      yield* proxy.attached(true)
      // A connection is open through the Person's computer when egress is turned off.
      const cut = yield* Effect.forkScoped(tunnelled(proxy.ports.proxy, 'site.example:443', 'a'))
      const before = yield* first.frame
      expect(before._tag).toBe('Open')
      yield* turn({ chosen: false })
      // The browser's connection ends, and so does the hold on the app's socket: the app is
      // not left with a stream the Computer has forgotten.
      expect(yield* Fiber.join(cut)).toBe('')
      yield* Fiber.join(first.fiber)

      // The app dials again and egress is turned on again. The proxy numbers the streams of
      // the new attachment from one again, and the new socket has no stream by that number.
      const second = yield* app()
      yield* turn({ chosen: true })
      yield* proxy.attached(true)
      const reply = yield* Effect.forkScoped(tunnelled(proxy.ports.proxy, 'site.example:443', 'b'))
      const again = yield* second.frame
      expect(again).toEqual(before)
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 1 }))
      yield* second.say(
        EgressFrame.cases.Data.make({ stream: again.stream, payload: Buffer.from('new') }),
      )
      yield* second.say(EgressFrame.cases.Close.make({ stream: again.stream }))
      expect(yield* Fiber.join(reply)).toBe('new')
    }),
  )

  it.live('a stream that each side has ended is no longer counted', () =>
    Effect.gen(function* () {
      const { proxy, relay, app, turn } = yield* relaying()
      const desktop = yield* app()
      yield* turn({ chosen: true })
      yield* proxy.attached(true)
      const answer = yield* Effect.forkScoped(
        Effect.callback<string>((resume) => {
          const socket = NodeNet.connect({
            port: proxy.ports.proxy,
            host: '127.0.0.1',
            allowHalfOpen: true,
          })
          const chunks: Array<Buffer> = []
          socket.on('connect', () => socket.end('CONNECT site.example:443 HTTP/1.1\r\n\r\nask'))
          socket.on('data', (chunk: Buffer) => chunks.push(chunk))
          socket.on('end', () => resume(Effect.succeed(Buffer.concat(chunks).toString('utf8'))))
          return Effect.sync(() => socket.destroy())
        }),
      )
      const open = yield* desktop.frame
      yield* desktop.frame
      expect(yield* desktop.frame).toEqual(EgressFrame.cases.End.make({ stream: open.stream }))
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 1 }))
      yield* desktop.say(
        EgressFrame.cases.Data.make({ stream: open.stream, payload: Buffer.from('answer') }),
      )
      yield* desktop.say(EgressFrame.cases.End.make({ stream: open.stream }))
      expect((yield* Fiber.join(answer)).endsWith('answer')).toBe(true)
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 0 }))
    }),
  )

  it.live('a message from the app longer than a frame ends that app’s join, and nothing else', () =>
    Effect.gen(function* () {
      const { proxy, relay, app, turn } = yield* relaying()
      const first = yield* app()
      yield* turn({ chosen: true })
      yield* proxy.attached(true)
      yield* first.raw(new Uint8Array(EGRESS_FRAME_LIMIT + 1))
      yield* Fiber.join(first.fiber)
      yield* proxy.attached(false)
      // The relay goes on: the next socket of the same Person is joined.
      yield* app()
      yield* proxy.attached(true)
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 0 }))
    }),
  )

  it.live(
    'a second desktop app of the same Person waits, and takes over when the first’s socket goes',
    () =>
      Effect.gen(function* () {
        const { proxy, relay, facts, app, turn } = yield* relaying()
        const first = yield* app()
        yield* turn({ chosen: true })
        yield* proxy.attached(true)
        const second = yield* app()
        yield* second.held
        // The first is still the way out: a connection the browser opens now is opened by it.
        const page = yield* Effect.forkScoped(tunnelled(proxy.ports.proxy, 'site.example:443', 'a'))
        const carried = yield* Effect.raceFirst(
          first.frame.pipe(Effect.as('The first app carries it')),
          Effect.raceFirst(
            second.frame.pipe(Effect.as('The second app carries it')),
            Fiber.join(first.fiber).pipe(Effect.as('The first app was displaced')),
          ),
        )
        expect(carried).toBe('The first app carries it')
        // The second cost nothing: no second start on the Computer, and nothing sent to it.
        expect(facts.started).toBe(1)
        expect(yield* Queue.size(second.received)).toBe(0)

        // The first app's socket goes: the one that waited is the way out now.
        yield* Fiber.interrupt(first.fiber)
        yield* Fiber.join(page)
        yield* proxy.attached(true)
        expect(facts.started).toBe(2)
        yield* Effect.forkScoped(tunnelled(proxy.ports.proxy, 'site.example:443', 'b'))
        expect((yield* second.frame)._tag).toBe('Open')
        expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 1 }))
      }),
  )

  it.live(
    'over a real socket, an app that stops reading stops the Computer being read, and a join’s end closes the socket',
    () =>
      Effect.gen(function* () {
        const { proxy, relay, turn } = yield* relaying()
        // The relay as the server gives it to the route, with two things looked at in passing:
        // the socket it was handed, and the moment it first waits for that socket to empty.
        const waited = yield* Deferred.make<void>()
        const handed = yield* Deferred.make<ExitSocket>()
        const watched = Egress.of({
          status: relay.status,
          carry: (who, app) =>
            Deferred.succeed(handed, app).pipe(
              Effect.andThen(
                relay.carry(who, {
                  ...app,
                  drained: Deferred.succeed(waited, undefined).pipe(Effect.andThen(app.drained)),
                }),
              ),
            ),
        })
        const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
          host: '127.0.0.1',
          port: 0,
        })
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            yield* held(request, person, Effect.never)
            return HttpServerResponse.empty()
          }).pipe(
            Effect.scoped,
            Effect.provideService(Egress, watched),
            Effect.catchTags({
              SocketError: () => Effect.succeed(HttpServerResponse.empty()),
            }),
          ),
        )
        if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die('No TCP address')
        const desktop = yield* appSocket(server.address.port)
        yield* turn({ chosen: true })
        yield* proxy.attached(true)
        yield* desktop.stall

        // Several connections of the browser's upload at once, to an app that reads nothing and
        // so grants nothing: each may send one window, and together that is far more than may
        // wait for the app on this server.
        const pages = 4
        for (let at = 0; at < pages; at += 1) {
          const browser = yield* Effect.acquireRelease(
            Effect.sync(() => NodeNet.connect(proxy.ports.proxy, '127.0.0.1')),
            (socket) => Effect.sync(() => socket.destroy()),
          )
          browser.on('error', () => undefined)
          browser.on('connect', () => {
            browser.write('CONNECT site.example:443 HTTP/1.1\r\n\r\n')
            browser.write(Buffer.alloc(2 * EGRESS_WINDOW))
          })
        }
        yield* Deferred.await(waited)
        // What is held for the app is the bound and the frames of the one chunk that crossed it,
        // not the eight mebibytes the Computer was free to send.
        const app = yield* Deferred.await(handed)
        expect(app.buffered()).toBeGreaterThan(QUEUE_LIMIT)
        expect(app.buffered()).toBeLessThan(4 * QUEUE_LIMIT)

        // The app reads again: every stream's window arrives.
        yield* desktop.read(pages * EGRESS_WINDOW)

        // The join ends: the server closes the app's socket, not only the join.
        yield* turn({ chosen: false })
        yield* desktop.closing
      }),
    30_000,
  )

  it.live('with egress on and no desktop app, it says it is waiting', () =>
    Effect.gen(function* () {
      const { relay, turn } = yield* relaying()
      yield* turn({ chosen: true })
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Waiting.make({}))
    }),
  )
})

describe('the desktop app’s socket on the server', () => {
  /** A server that upgrades every request as the egress route does, and says what it read. */
  const upgrading = Effect.fn('EgressTest.upgrading')(function* () {
    const read = yield* Queue.unbounded<number>()
    const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
      host: '127.0.0.1',
      port: 0,
    })
    yield* server.serve(
      Effect.gen(function* () {
        const app = yield* exitSocket(yield* HttpServerRequest.HttpServerRequest)
        // Reads until the socket ends, which is a failure of the read and the end of this.
        return yield* app.pull.pipe(
          Effect.flatMap((messages) =>
            Effect.forEach(messages, (message) => Queue.offer(read, message.length)),
          ),
          Effect.forever,
        )
      }).pipe(
        Effect.scoped,
        Effect.catchTags({
          SocketError: () => Effect.succeed(HttpServerResponse.empty()),
        }),
      ),
    )
    if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die('No TCP address')
    const port = server.address.port
    const client = yield* Effect.acquireRelease(
      Effect.callback<NodeWS.WebSocket>((resume) => {
        const opened = new NodeWS.WebSocket(`ws://127.0.0.1:${port}`)
        opened.on('error', () => undefined)
        opened.on('open', () => resume(Effect.succeed(opened)))
      }),
      (opened) => Effect.sync(() => opened.terminate()),
    )
    return { client, read }
  })

  it.live('a message longer than a frame is refused before it is whole, however it is cut up', () =>
    Effect.gen(function* () {
      const { client, read } = yield* upgrading()
      const outcome = yield* Effect.callback<string>((resume) => {
        client.once('close', (code) => resume(Effect.succeed(`Closed with ${code}`)))
        client.once('pong', () => resume(Effect.succeed('The server went on taking it')))
        // Two pieces of one message, each within a frame and together over it. The message is
        // never finished, so a server that waits for the whole of it holds both.
        client.send(Buffer.alloc(EGRESS_FRAME_LIMIT), { binary: true, fin: false })
        client.send(Buffer.alloc(EGRESS_FRAME_LIMIT), { binary: true, fin: false })
        client.ping()
      })
      // 1009 is the WebSocket protocol's "message too big".
      expect(outcome).toBe('Closed with 1009')
      expect(yield* Queue.size(read)).toBe(0)
    }),
  )

  it.effect(
    'an app that never answers the close is let go at the close deadline, and no later',
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        const ended = yield* Deferred.make<void>()
        const reads = yield* Queue.unbounded<Buffer>()
        const dropped = yield* Deferred.make<void>()
        const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
          host: '127.0.0.1',
          port: 0,
        })
        // The route's own shape: the socket belongs to the request's scope, and the handler
        // returns only when that scope has closed.
        yield* server.serve(
          Effect.gen(function* () {
            yield* exitSocket(yield* HttpServerRequest.HttpServerRequest)
            yield* Deferred.await(release)
            return HttpServerResponse.empty()
          }).pipe(
            Effect.scoped,
            Effect.onExit(() => Deferred.succeed(ended, undefined)),
          ),
        )
        if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die('No TCP address')
        const port = server.address.port
        // A connection that upgrades and then says nothing more, whatever it is sent: a close
        // is read here and never answered.
        const app = yield* Effect.acquireRelease(
          Effect.sync(() => NodeNet.connect(port, '127.0.0.1')),
          (socket) => Effect.sync(() => socket.destroy()),
        )
        app.on('error', () => undefined)
        app.on('data', (bytes: Buffer) => Queue.offerUnsafe(reads, bytes))
        app.on('close', () => Deferred.doneUnsafe(dropped, Effect.void))
        app.on('connect', () =>
          app.write(
            'GET /egress HTTP/1.1\r\nHost: vivid.test\r\nUpgrade: websocket\r\n' +
              'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
          ),
        )
        expect((yield* Queue.take(reads)).toString()).toContain('101 Switching Protocols')
        yield* Deferred.succeed(release, undefined)
        // 0x88: the server's close, the whole of one WebSocket frame.
        expect((yield* Queue.take(reads)).readUInt8(0)).toBe(0x88)

        // Until the deadline the handler waits for the answer, as it does for an app that is
        // only slow. At the deadline the connection is ended under the socket, and only then
        // does the handler return: it never returns with the connection still open.
        yield* TestClock.adjust(CLOSE_DEADLINE_MILLIS - 1)
        expect(Deferred.isDoneUnsafe(ended)).toBe(false)
        expect(app.destroyed).toBe(false)
        yield* TestClock.adjust(1)
        yield* Deferred.await(ended)
        yield* Deferred.await(dropped)
        // Nothing was written to the connection after the close: no HTTP answer followed it.
        expect(yield* Queue.size(reads)).toBe(0)
      }),
  )

  it.live('the longest frame is taken whole', () =>
    Effect.gen(function* () {
      const { client, read } = yield* upgrading()
      client.send(Buffer.alloc(EGRESS_FRAME_LIMIT), { binary: true })
      expect(yield* Queue.take(read)).toBe(EGRESS_FRAME_LIMIT)
    }),
  )
})

describe('frames on the Computer’s byte stream', () => {
  it('are cut wherever the chunks fall', () => {
    const cut = frameCutter()
    const bytes = Buffer.concat([
      lengthPrefixed(Uint8Array.from([3, 0, 0, 0, 7])),
      lengthPrefixed(Uint8Array.from([2, 0, 0, 0, 7, 9, 9])),
    ])
    const frames = [bytes.subarray(0, 3), bytes.subarray(3, 11), bytes.subarray(11)].flatMap(
      (chunk) => Option.getOrThrow(cut(chunk)).map((frame) => Array.from(frame)),
    )
    expect(frames).toEqual([
      [3, 0, 0, 0, 7],
      [2, 0, 0, 0, 7, 9, 9],
    ])
  })

  it('a length no frame can have ends the reading', () => {
    expect(frameCutter()(Uint8Array.from([255, 255, 255, 255, 1]))).toEqual(Option.none())
    // The longest frame is taken; one byte more is refused on its length alone.
    const longest = lengthPrefixed(new Uint8Array(EGRESS_FRAME_LIMIT))
    expect(Option.map(frameCutter()(longest), (frames) => frames.length)).toEqual(Option.some(1))
    const over = lengthPrefixed(new Uint8Array(0)).slice()
    new DataView(over.buffer).setUint32(0, EGRESS_FRAME_LIMIT + 1)
    expect(frameCutter()(over)).toEqual(Option.none())
  })
})

describe('a desktop app that has gone without a word', () => {
  /**
   * The relay behind the real route's socket (`held`), on a real HTTP server. `held` answers
   * each time the relay begins to read a socket: that socket has its place in the Person's line.
   */
  const routed = Effect.fn('EgressTest.routed')(function* (relay: EgressService) {
    const began = yield* Queue.unbounded<void>()
    const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
      host: '127.0.0.1',
      port: 0,
    })
    yield* server.serve(
      Effect.gen(function* () {
        yield* held(yield* HttpServerRequest.HttpServerRequest, person, Effect.never)
        return HttpServerResponse.empty()
      }).pipe(
        Effect.scoped,
        Effect.provideService(
          Egress,
          Egress.of({
            status: relay.status,
            carry: (who, app) => {
              const read = Deferred.makeUnsafe<void>()
              return relay.carry(who, {
                ...app,
                pull: Effect.suspend(() =>
                  Deferred.doneUnsafe(read, Effect.void)
                    ? Queue.offer(began, undefined)
                    : Effect.void,
                ).pipe(Effect.andThen(app.pull)),
              })
            },
          }),
        ),
        Effect.catchTags({ SocketError: () => Effect.succeed(HttpServerResponse.empty()) }),
      ),
    )
    if (!NetAddress.isInetAddress(server.address)) return yield* Effect.die('No TCP address')
    return { port: server.address.port, held: Queue.take(began) }
  })

  /**
   * A desktop app's socket, from the `ws` package. One that `answers` does what every WebSocket
   * client does with a ping. One that does not is the computer that went to sleep: its
   * connection is still open, and nothing comes back over it.
   */
  const desktopApp = Effect.fn('EgressTest.desktopApp')(function* (port: number, answers: boolean) {
    const pings = yield* Queue.unbounded<void>()
    const pongs = yield* Queue.unbounded<void>()
    const beats = yield* Queue.unbounded<string>()
    const frames = yield* Queue.unbounded<EgressFrame>()
    const closed = yield* Deferred.make<number>()
    const socket = yield* Effect.acquireRelease(
      Effect.callback<NodeWS.WebSocket>((resume) => {
        const opened = new NodeWS.WebSocket(`ws://127.0.0.1:${port}`, { autoPong: answers })
        opened.on('error', () => undefined)
        opened.on('ping', () => Queue.offerUnsafe(pings, undefined))
        opened.on('pong', () => Queue.offerUnsafe(pongs, undefined))
        opened.on('close', (code) => Deferred.doneUnsafe(closed, Effect.succeed(code)))
        opened.on('message', (data: Buffer, binary: boolean) => {
          if (binary)
            Option.map(Result.getSuccess(decodeEgressFrame(data)), (frame) =>
              Queue.offerUnsafe(frames, frame),
            )
          else Queue.offerUnsafe(beats, data.toString('utf8'))
        })
        opened.on('open', () => resume(Effect.succeed(opened)))
      }),
      (opened) => Effect.sync(() => opened.terminate()),
    )
    return {
      socket,
      /** The server's next ping arrived here. */
      pinged: Queue.take(pings),
      /** The next text message the server sent. */
      beat: Queue.take(beats),
      frame: Queue.take(frames),
      /**
       * The server has read everything this app sent so far, its answer to a ping included: a
       * ping of the app's own is read after them, and this is the server's answer to it.
       */
      read: Effect.sync(() => socket.ping()).pipe(Effect.andThen(Queue.take(pongs))),
      /** The socket closed, and with which code. */
      closed: Deferred.await(closed),
    }
  })

  const deadline = EGRESS_DEADLINE_MILLIS / EGRESS_PING_MILLIS

  it.effect(
    'is dropped at the deadline, and the app that waited behind it becomes the way out',
    () =>
      Effect.gen(function* () {
        const { proxy, relay, facts, turn } = yield* relaying()
        const server = yield* routed(relay)
        const asleep = yield* desktopApp(server.port, false)
        yield* server.held
        yield* turn({ chosen: true })
        yield* proxy.attached(true)
        const awake = yield* desktopApp(server.port, true)
        yield* server.held

        for (let ping = 1; ping < deadline; ping += 1) {
          yield* TestClock.adjust(EGRESS_PING_MILLIS)
          yield* asleep.pinged
          yield* awake.pinged
          yield* awake.read
          // Short of the deadline the first is still the way out, and the second still waits.
          expect(asleep.socket.readyState).toBe(NodeWS.WebSocket.OPEN)
          expect(yield* relay.status(person)).toEqual(
            EgressStatus.cases.Routing.make({ streams: 0 }),
          )
          expect(facts.started).toBe(1)
        }
        yield* TestClock.adjust(EGRESS_PING_MILLIS)
        // 1006: the connection was ended under the socket, with no close said first.
        expect(yield* asleep.closed).toBe(1006)

        // The one that waited is joined: the Computer's proxy is attached again, and a
        // connection the browser opens now is opened by the app that is awake.
        yield* proxy.attached(false)
        yield* proxy.attached(true)
        expect(facts.started).toBe(2)
        yield* Effect.forkScoped(tunnelled(proxy.ports.proxy, 'site.example:443', 'a'))
        expect((yield* awake.frame)._tag).toBe('Open')
        expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 1 }))
        expect(awake.socket.readyState).toBe(NodeWS.WebSocket.OPEN)
      }),
    20_000,
  )

  it.effect(
    'is dropped the same way while it is parked, or only waits its turn',
    () =>
      Effect.gen(function* () {
        const { proxy, relay, facts, turn } = yield* relaying()
        const server = yield* routed(relay)
        // Egress is off: the socket is parked, joined to nothing.
        const parked = yield* desktopApp(server.port, false)
        yield* server.held
        for (let ping = 1; ping < deadline; ping += 1) {
          yield* TestClock.adjust(EGRESS_PING_MILLIS)
          yield* parked.pinged
        }
        yield* TestClock.adjust(EGRESS_PING_MILLIS)
        expect(yield* parked.closed).toBe(1006)

        // An app that is awake is the way out, and one that is not waits behind it.
        const awake = yield* desktopApp(server.port, true)
        yield* server.held
        yield* turn({ chosen: true })
        yield* proxy.attached(true)
        const waiting = yield* desktopApp(server.port, false)
        yield* server.held
        for (let ping = 1; ping < deadline; ping += 1) {
          yield* TestClock.adjust(EGRESS_PING_MILLIS)
          yield* waiting.pinged
          yield* awake.pinged
          yield* awake.read
        }
        yield* TestClock.adjust(EGRESS_PING_MILLIS)
        expect(yield* waiting.closed).toBe(1006)
        // The one in front lost nothing by it.
        yield* awake.pinged
        yield* awake.read
        expect(awake.socket.readyState).toBe(NodeWS.WebSocket.OPEN)
        expect(facts.started).toBe(1)
        expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 0 }))
      }),
    20_000,
  )

  it.effect(
    'with no other app, the Person is said to be waiting once it is dropped',
    () =>
      Effect.gen(function* () {
        const { proxy, relay, turn, hub } = yield* relaying()
        const server = yield* routed(relay)
        const asleep = yield* desktopApp(server.port, false)
        yield* server.held
        yield* turn({ chosen: true })
        yield* proxy.attached(true)
        expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 0 }))
        const told = yield* PubSub.subscribe(hub)
        for (let ping = 1; ping < deadline; ping += 1) {
          yield* TestClock.adjust(EGRESS_PING_MILLIS)
          yield* asleep.pinged
        }
        yield* TestClock.adjust(EGRESS_PING_MILLIS)
        yield* asleep.closed
        yield* proxy.attached(false)
        // Read at each change the Person's watchers are told of, until it is the one meant.
        let said = yield* relay.status(person)
        while (!EgressStatus.guards.Waiting(said)) {
          yield* PubSub.take(told)
          said = yield* relay.status(person)
        }
        expect(said).toEqual(EgressStatus.cases.Waiting.make({}))
      }),
    20_000,
  )

  it.effect(
    'is kept for as long as it answers, parked or joined, with nothing carried',
    () =>
      Effect.gen(function* () {
        const { proxy, relay, facts, turn } = yield* relaying()
        const server = yield* routed(relay)
        const awake = yield* desktopApp(server.port, true)
        yield* server.held
        /** Twice the deadline goes by, a ping at a time, each one answered and the answer read. */
        const idle = Effect.fn('EgressTest.idle')(function* () {
          for (let ping = 0; ping < 2 * deadline; ping += 1) {
            yield* TestClock.adjust(EGRESS_PING_MILLIS)
            yield* awake.pinged
            // What a desktop app can see of the ping (`EGRESS_BEAT`).
            expect(yield* awake.beat).toBe(EGRESS_BEAT)
            yield* awake.read
          }
        })
        yield* idle()
        expect(awake.socket.readyState).toBe(NodeWS.WebSocket.OPEN)

        yield* turn({ chosen: true })
        yield* proxy.attached(true)
        yield* idle()
        expect(awake.socket.readyState).toBe(NodeWS.WebSocket.OPEN)
        expect(facts.started).toBe(1)
        yield* Effect.forkScoped(tunnelled(proxy.ports.proxy, 'site.example:443', 'a'))
        expect((yield* awake.frame)._tag).toBe('Open')
        expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 1 }))
      }),
    20_000,
  )
})
