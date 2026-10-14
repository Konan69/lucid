import { describe, expect, it } from '@effect/vitest'
import * as NodeChildProcess from 'node:child_process'
import * as NodeHttp from 'node:http'
import * as NodeNet from 'node:net'
import * as NodeURL from 'node:url'
import {
  EGRESS_FRAME_LIMIT,
  EGRESS_LINK_BUDGET,
  EGRESS_STREAM_BUDGET,
  EgressFrame,
  type EgressStream,
  decodeEgressFrame,
  egressData,
  encodeEgressFrame,
} from '@vivid/contracts'
import { Cause, Deferred, Effect, Option, Queue, Result, Schema } from 'effect'
import { frameCutter, lengthPrefixed } from './relay.ts'

/**
 * The program that runs on the Computer (`proxy.mjs`), alone: a browser's connections on one
 * side, over real sockets, and on the other the tunnel, spoken by hand in the contract's own
 * frames. What the far end of the tunnel does with a stream is the desktop app's
 * (`apps/desktop/src/main/egress.test.ts` runs that app's real exit client against this same
 * program); here it is whatever the test says, so each thing the proxy must do is asked alone.
 */
const proxyFile = NodeURL.fileURLToPath(new URL('./proxy.mjs', import.meta.url))

const Said = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ tunnel: Schema.Int, proxy: Schema.Int }),
    Schema.Struct({ attached: Schema.Boolean }),
  ]),
)
const decodeSaid = Schema.decodeUnknownOption(Said)
const decodeBound = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))

/** A server on a free loopback port, closed with the scope along with what it still holds. */
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

/** A port nothing listens on: taken for a moment to learn its number, then given back. */
const closedPort = Effect.fn('ProxyTest.closedPort')(function* () {
  const probe = NodeNet.createServer()
  const port = yield* Effect.scoped(listening(probe))
  yield* Effect.callback<void>((resume) => {
    probe.close(() => resume(Effect.void))
  })
  return port
})

/** Starts the proxy on free ports. `attached` waits for its own word that a tunnel came or went. */
const computerProxy = Effect.fn('ProxyTest.computerProxy')(function* () {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(process.execPath, [proxyFile, '0', '0'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      }),
    ),
    (spawned) => Effect.sync(() => spawned.kill()),
  )
  const said = yield* Queue.unbounded<typeof Said.Type>()
  const exited = yield* Deferred.make<void>()
  child.on('exit', () => Deferred.doneUnsafe(exited, Effect.void))
  let rest = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const lines = `${rest}${chunk.toString('utf8')}`.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) Option.map(decodeSaid(line), (fact) => Queue.offerUnsafe(said, fact))
  })
  const first = yield* Queue.take(said)
  if (!('proxy' in first)) return yield* Effect.die('The proxy did not say where it listens')
  const attached = Effect.fn(function* (want: boolean) {
    for (;;) {
      const fact = yield* Queue.take(said)
      if ('attached' in fact && fact.attached === want) return
    }
  })
  return { ports: first, attached, exited: Deferred.isDone(exited) }
})

/**
 * The far end of the tunnel, by hand: a connection to the tunnel port that reads each frame the
 * proxy writes and writes the frames it is told to.
 */
const tunnelEnd = Effect.fn('ProxyTest.tunnelEnd')(function* (port: number) {
  const frames = yield* Queue.unbounded<EgressFrame, Cause.Done>()
  const cut = frameCutter()
  const socket = yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Socket>((resume) => {
      const opened = NodeNet.connect(port, '127.0.0.1')
      opened.on('error', () => undefined)
      opened.once('connect', () => resume(Effect.succeed(opened)))
    }),
    (opened) => Effect.sync(() => opened.destroy()),
  )
  socket.on('data', (chunk: Buffer) => {
    for (const frame of Option.getOrThrow(cut(chunk)))
      Queue.offerUnsafe(frames, Result.getOrThrow(decodeEgressFrame(Uint8Array.from(frame))))
  })
  socket.on('close', () => Queue.endUnsafe(frames))
  const raw = (bytes: Uint8Array) =>
    Effect.callback<void>((resume) => {
      socket.write(bytes, () => resume(Effect.void))
    })
  return {
    socket,
    /** The next frame the proxy wrote. */
    frame: Queue.take(frames),
    /** The next frame of one kind for one stream, passing over the rest. */
    next: Effect.fn(function* (tag: EgressFrame['_tag'], stream: EgressStream) {
      for (;;) {
        const frame = yield* Queue.take(frames)
        if (frame._tag === tag && frame.stream === stream) return frame
      }
    }),
    say: (frame: EgressFrame) => raw(lengthPrefixed(encodeEgressFrame(frame))),
    /** Bytes of one stream, as however many frames they need. */
    send: (stream: EgressStream, payload: Uint8Array) =>
      raw(Buffer.concat(egressData(stream, payload).map(lengthPrefixed))),
    raw,
  }
})

/** The proxy with the far end of the tunnel attached, as the proxy itself reports it. */
const attachedProxy = Effect.fn('ProxyTest.attachedProxy')(function* () {
  const proxy = yield* computerProxy()
  const tunnel = yield* tunnelEnd(proxy.ports.tunnel)
  yield* proxy.attached(true)
  return { proxy, tunnel }
})

/**
 * A browser's connection to the proxy: what it received, as it arrives, and its end. Its own
 * side stays open when the far side ends, so a test can end the request and still read the
 * answer. `closed` is the proxy ending its side, after which the browser hangs up as a browser
 * does, and the connection is gone.
 */
const browser = Effect.fn('ProxyTest.browser')(function* (proxyPort: number, first: string) {
  const received = yield* Queue.unbounded<Buffer>()
  const ended = yield* Deferred.make<void>()
  const closed = yield* Deferred.make<void>()
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => NodeNet.connect({ port: proxyPort, host: '127.0.0.1', allowHalfOpen: true })),
    (opened) => Effect.sync(() => opened.destroy()),
  )
  socket.on('connect', () => socket.write(first))
  socket.on('data', (chunk: Buffer) => Queue.offerUnsafe(received, chunk))
  socket.on('error', () => undefined)
  socket.on('end', () => Deferred.doneUnsafe(ended, Effect.void))
  socket.on('close', () => Deferred.doneUnsafe(closed, Effect.void))
  /** Reads until `text` has arrived, and answers everything received so far. */
  const until = Effect.fn(function* (text: string) {
    let all = Buffer.alloc(0)
    while (!all.includes(text)) all = Buffer.concat([all, yield* Queue.take(received)])
    return all.toString('utf8')
  })
  return {
    socket,
    until,
    ended: Deferred.await(ended),
    closed: Deferred.await(ended).pipe(
      Effect.andThen(Effect.sync(() => socket.end())),
      Effect.andThen(Deferred.await(closed)),
    ),
  }
})

const connect = (target: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`
const ESTABLISHED = '200 Connection Established\r\n\r\n'

/** The text of a frame's payload, when it is data. */
const text = (frame: EgressFrame) =>
  EgressFrame.guards.Data(frame) ? Buffer.from(frame.payload).toString('utf8') : frame._tag

describe('the Computer’s egress proxy', () => {
  it.live('a browser that has sent its whole request still gets the answer', () =>
    Effect.gen(function* () {
      const { proxy, tunnel } = yield* attachedProxy()
      const page = yield* browser(proxy.ports.proxy, connect('site.example:443'))
      yield* page.until(ESTABLISHED)
      page.socket.end('request')
      const open = yield* tunnel.frame
      expect(open._tag).toBe('Open')
      expect(text(yield* tunnel.frame)).toBe('request')
      // The browser ended its side. That is said as an end, and the stream stays open the other
      // way: the answer is still to come.
      expect(yield* tunnel.frame).toEqual(EgressFrame.cases.End.make({ stream: open.stream }))
      yield* tunnel.send(open.stream, Buffer.from('answer'))
      yield* tunnel.say(EgressFrame.cases.End.make({ stream: open.stream }))
      expect(yield* page.until('answer')).toContain('answer')
      yield* page.ended
      yield* page.closed
    }),
  )

  it.live('with nothing attached, a request ended before its answer is answered directly', () =>
    Effect.gen(function* () {
      // A site that answers only once it has read the whole request.
      const site = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
        const chunks: Array<Buffer> = []
        socket.on('data', (chunk: Buffer) => chunks.push(chunk))
        socket.on('end', () => socket.end(`heard ${Buffer.concat(chunks).toString('utf8')}`))
      })
      const sitePort = yield* listening(site)
      const proxy = yield* computerProxy()
      const page = yield* browser(proxy.ports.proxy, connect(`127.0.0.1:${sitePort}`))
      yield* page.until(ESTABLISHED)
      page.socket.end('request')
      expect(yield* page.until('heard request')).toContain('heard request')
      yield* page.closed
    }),
  )

  it.live('the far end closing a stream ends the browser’s connection after what it sent', () =>
    Effect.gen(function* () {
      const { proxy, tunnel } = yield* attachedProxy()
      const page = yield* browser(proxy.ports.proxy, connect('site.example:443'))
      const open = yield* tunnel.frame
      yield* tunnel.send(open.stream, Buffer.from('last words'))
      yield* tunnel.say(EgressFrame.cases.Close.make({ stream: open.stream }))
      expect(yield* page.until('last words')).toContain('last words')
      yield* page.closed
      // Bytes for a stream that is over are for nobody, and the tunnel stays.
      yield* tunnel.send(open.stream, Buffer.from('late'))
      const again = yield* browser(proxy.ports.proxy, connect('site.example:443'))
      expect((yield* tunnel.frame)._tag).toBe('Open')
      yield* again.until(ESTABLISHED)
    }),
  )

  it.live('an HTTP upgrade is sent on and the two ends are joined, through the tunnel', () =>
    Effect.gen(function* () {
      const { proxy, tunnel } = yield* attachedProxy()
      const page = yield* browser(
        proxy.ports.proxy,
        'GET http://chat.example:8080/room?id=7 HTTP/1.1\r\nHost: chat.example:8080\r\n' +
          'Connection: Upgrade\r\nUpgrade: websocket\r\nProxy-Connection: keep-alive\r\n\r\n',
      )
      const open = yield* tunnel.frame
      expect(EgressFrame.guards.Open(open) && [open.host, open.port]).toEqual([
        'chat.example',
        8080,
      ])
      // The site is asked in the form a site is asked in, with the header that was for the proxy
      // taken out.
      expect(text(yield* tunnel.frame)).toBe(
        'GET /room?id=7 HTTP/1.1\r\nHost: chat.example:8080\r\n' +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      )
      yield* tunnel.send(open.stream, Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\nhello'))
      expect(yield* page.until('hello')).toBe('HTTP/1.1 101 Switching Protocols\r\n\r\nhello')
      page.socket.write('from the page')
      expect(text(yield* tunnel.frame)).toBe('from the page')
    }),
  )

  it.live('an HTTP upgrade works with nothing attached', () =>
    Effect.gen(function* () {
      const site = NodeHttp.createServer()
      site.on('upgrade', (request, socket) => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n\r\nasked ${request.url}`)
        socket.on('data', (chunk: Buffer) => socket.write(`echo ${chunk.toString('utf8')}`))
        socket.on('error', () => undefined)
      })
      const sitePort = yield* listening(site)
      const proxy = yield* computerProxy()
      const page = yield* browser(
        proxy.ports.proxy,
        `GET http://127.0.0.1:${sitePort}/room HTTP/1.1\r\nHost: 127.0.0.1:${sitePort}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      )
      yield* page.until('asked /room')
      page.socket.write('ping')
      expect(yield* page.until('echo ping')).toContain('echo ping')
    }),
  )

  it.live('what it cannot do is answered or closed at once, and it goes on', () =>
    Effect.gen(function* () {
      const nowhere = yield* closedPort()
      const { proxy, tunnel } = yield* attachedProxy()
      const ask = (first: string) => browser(proxy.ports.proxy, first)

      // A request line that is not one.
      yield* (yield* ask('this is not HTTP\r\n\r\n')).closed
      // A target that is not a host and a port.
      expect(yield* (yield* ask(connect('nowhere'))).until('\r\n\r\n')).toContain('400')
      expect(yield* (yield* ask(connect('site.example:99999'))).until('\r\n\r\n')).toContain('400')
      // A request for the proxy itself, and one for something that is not plain HTTP.
      expect(yield* (yield* ask('GET / HTTP/1.1\r\nHost: x\r\n\r\n')).until('\r\n\r\n')).toContain(
        '400',
      )
      expect(
        yield* (yield* ask('GET ftp://site.example/ HTTP/1.1\r\nHost: x\r\n\r\n')).until(
          '\r\n\r\n',
        ),
      ).toContain('400')
      const upgrade = yield* ask(
        'GET /room HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      )
      expect(yield* upgrade.until('\r\n\r\n')).toContain('400')
      yield* upgrade.closed

      // A target the far end refuses: told the tunnel stands, then closed.
      const refused = yield* ask(connect('printer.home:80'))
      const open = yield* tunnel.frame
      yield* tunnel.say(EgressFrame.cases.Close.make({ stream: open.stream }))
      yield* refused.closed
      // A plain request the far end refuses is answered, not left open.
      const plain = yield* ask('GET http://printer.home/ HTTP/1.1\r\nHost: printer.home\r\n\r\n')
      const asked = yield* tunnel.frame
      yield* tunnel.say(EgressFrame.cases.Close.make({ stream: asked.stream }))
      expect(yield* plain.until('\r\n\r\n')).toContain('502')

      // The tunnel goes while a connection is open through it: the connection ends.
      const cut = yield* ask(connect('site.example:443'))
      yield* cut.until(ESTABLISHED)
      tunnel.socket.destroy()
      yield* proxy.attached(false)
      yield* cut.closed

      // With nothing attached, a site that is not there is a closed connection, and for a plain
      // request an answer.
      yield* (yield* ask(connect(`127.0.0.1:${nowhere}`))).closed
      expect(
        yield* (yield* ask(`GET http://127.0.0.1:${nowhere}/ HTTP/1.1\r\nHost: x\r\n\r\n`)).until(
          '\r\n\r\n',
        ),
      ).toContain('502')
      expect(yield* proxy.exited).toBe(false)
    }),
  )

  it.live('a frame longer than a frame ends that tunnel and nothing else', () =>
    Effect.gen(function* () {
      const { proxy, tunnel } = yield* attachedProxy()
      const page = yield* browser(proxy.ports.proxy, connect('site.example:443'))
      yield* tunnel.frame
      // Only the length is sent: the proxy must not wait for a megabyte it will refuse.
      const length = Buffer.alloc(4)
      length.writeUInt32BE(EGRESS_FRAME_LIMIT + 1)
      yield* tunnel.raw(length)
      yield* proxy.attached(false)
      yield* page.closed
      // The proxy is still there, and takes the next tunnel.
      const next = yield* tunnelEnd(proxy.ports.tunnel)
      yield* proxy.attached(true)
      const again = yield* browser(proxy.ports.proxy, connect('site.example:443'))
      expect((yield* next.frame)._tag).toBe('Open')
      yield* again.until(ESTABLISHED)
      expect(yield* proxy.exited).toBe(false)
    }),
  )

  it.live('frames that are short, unknown or for no stream are passed over', () =>
    Effect.gen(function* () {
      const { proxy, tunnel } = yield* attachedProxy()
      const page = yield* browser(proxy.ports.proxy, connect('site.example:443'))
      const open = yield* tunnel.frame
      yield* tunnel.raw(lengthPrefixed(Uint8Array.from([2, 0])))
      yield* tunnel.raw(lengthPrefixed(Uint8Array.from([9, 0, 0, 0, 1, 7])))
      yield* tunnel.raw(lengthPrefixed(new Uint8Array(0)))
      // An open is the Computer's to send, never the far end's.
      yield* tunnel.raw(lengthPrefixed(Uint8Array.from([1, 0, 0, 0, 9, 0, 80, 97])))
      yield* tunnel.raw(lengthPrefixed(Uint8Array.from([2, 0, 0, 0, 77, 1, 2, 3])))
      yield* tunnel.send(open.stream, Buffer.from('still here'))
      expect(yield* page.until('still here')).toContain('still here')
    }),
  )

  it.live('a connection the browser has stopped reading is closed at its budget, alone', () =>
    Effect.gen(function* () {
      const { proxy, tunnel } = yield* attachedProxy()
      const stalled = yield* browser(proxy.ports.proxy, connect('video.example:443'))
      yield* stalled.until(ESTABLISHED)
      stalled.socket.pause()
      const open = yield* tunnel.frame
      const other = yield* browser(proxy.ports.proxy, connect('site.example:443'))
      const second = yield* tunnel.frame
      yield* tunnel.send(open.stream, Buffer.alloc(EGRESS_STREAM_BUDGET + (4 << 20)))
      expect(yield* tunnel.next('Close', open.stream)).toEqual(
        EgressFrame.cases.Close.make({ stream: open.stream }),
      )
      yield* tunnel.send(second.stream, Buffer.from('unharmed'))
      expect(yield* other.until('unharmed')).toContain('unharmed')
    }),
  )

  it.live('all the connections of a tunnel together are held to the link’s budget', () =>
    Effect.gen(function* () {
      const { proxy, tunnel } = yield* attachedProxy()
      // Each is under its own budget; together they are over the link's.
      const each = EGRESS_STREAM_BUDGET - (2 << 20)
      const count = Math.ceil(EGRESS_LINK_BUDGET / each)
      const streams: Array<EgressStream> = []
      for (let at = 0; at < count; at += 1) {
        const page = yield* browser(proxy.ports.proxy, connect(`video${at}.example:443`))
        yield* page.until(ESTABLISHED)
        page.socket.pause()
        streams.push((yield* tunnel.frame).stream)
      }
      for (const stream of streams) yield* tunnel.send(stream, Buffer.alloc(each))
      // The one whose bytes crossed the bound is the one that is closed.
      const closed = yield* tunnel.frame
      expect(closed).toEqual(
        EgressFrame.cases.Close.make({ stream: streams.at(-1) ?? closed.stream }),
      )
    }),
  )
})
