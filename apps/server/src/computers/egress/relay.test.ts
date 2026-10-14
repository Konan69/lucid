import { describe, expect, it } from '@effect/vitest'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeHttp from 'node:http'
import * as NodeNet from 'node:net'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import {
  EgressFrame,
  EgressStatus,
  PersonId,
  decodeEgressFrame,
  encodeEgressFrame,
} from '@vivid/contracts'
import { Array as Arr, Effect, Fiber, Option, PubSub, Queue, Result, Schema, Stream } from 'effect'
import { Changes } from '../../live/changes.ts'
import { startCommand } from './guest.ts'
import { egressRelay, frameCutter, lengthPrefixed } from './relay.ts'

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
    const fiber = yield* Effect.forkScoped(
      Effect.scoped(
        relay.carry(person, {
          pull: Queue.take(sent).pipe(Effect.map(Arr.of)),
          write: (frame) => Queue.offer(received, frame).pipe(Effect.asVoid),
        }),
      ),
    )
    const frame = Queue.take(received).pipe(
      Effect.map(decodeEgressFrame),
      Effect.map(Result.getOrThrow),
    )
    const say = (value: EgressFrame) => Queue.offer(sent, encodeEgressFrame(value))
    return { fiber, frame, say, received }
  })
  const turn = (change: Partial<typeof facts>) =>
    Effect.sync(() => Object.assign(facts, change)).pipe(Effect.andThen(changes.publish([])))
  return { proxy, relay, facts, app, turn }
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

  it.live('the Computer stopping, or egress turned off, lets the tunnel go', () =>
    Effect.gen(function* () {
      const { proxy, relay, app, turn } = yield* relaying()
      yield* app()
      yield* turn({ chosen: true })
      yield* proxy.attached(true)
      yield* turn({ running: false })
      yield* proxy.attached(false)
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Waiting.make({}))
      yield* turn({ running: true })
      yield* proxy.attached(true)
      yield* turn({ chosen: false })
      yield* proxy.attached(false)
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Off.make({}))
    }),
  )

  it.live('a newer socket of the same Person takes the place of the one before', () =>
    Effect.gen(function* () {
      const { proxy, relay, app, turn } = yield* relaying()
      const first = yield* app()
      yield* turn({ chosen: true })
      yield* proxy.attached(true)
      yield* app()
      yield* Fiber.join(first.fiber)
      // The second socket joins in its turn: the tunnel is let go and taken again.
      yield* proxy.attached(true)
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Routing.make({ streams: 0 }))
    }),
  )

  it.live('with egress on and no desktop app, it says it is waiting', () =>
    Effect.gen(function* () {
      const { relay, turn } = yield* relaying()
      yield* turn({ chosen: true })
      expect(yield* relay.status(person)).toEqual(EgressStatus.cases.Waiting.make({}))
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
  })
})

describe('starting the proxy on a Computer', () => {
  /** A free loopback port: taken for a moment to learn its number, then given back. */
  const freePort = Effect.suspend(() => {
    const probe = NodeNet.createServer()
    return bound(probe).pipe(
      Effect.tap(() =>
        Effect.callback<void>((resume) => {
          probe.close(() => resume(Effect.void))
        }),
      ),
    )
  })
  /** Runs the start command as the Computer's shell would, in a home of its own. */
  const start = (home: string, command: string) =>
    Effect.callback<number | null>((resume) => {
      const child = NodeChildProcess.spawn('bash', ['-c', command], {
        env: { ...process.env, HOME: home },
        stdio: 'ignore',
      })
      child.on('close', (code) => resume(Effect.succeed(code)))
    })
  const recorded = (home: string) =>
    Number(
      NodeFS.readFileSync(NodePath.join(home, '.local/share/vivid/computer/egress.pid'), 'utf8'),
    )

  it.live('starts it once, leaves a running one alone, and replaces an older text', () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-egress-'))),
        (directory) =>
          Effect.sync(() => {
            // The proxy this test started, by the process id it recorded itself.
            Option.map(Option.liftThrowable(() => recorded(directory))(), (pid) =>
              Option.liftThrowable(() => process.kill(pid))(),
            )
            NodeFS.rmSync(directory, { recursive: true, force: true })
          }),
      )
      const ports = { tunnel: yield* freePort, proxy: yield* freePort }
      const text = NodeFS.readFileSync(proxyFile, 'utf8')
      expect(yield* start(home, startCommand(text, ports))).toBe(0)
      const first = recorded(home)
      expect(yield* start(home, startCommand(text, ports))).toBe(0)
      expect(recorded(home)).toBe(first)
      // A server with a changed proxy ends the old one and starts its own.
      expect(yield* start(home, startCommand(`${text}\n// changed\n`, ports))).toBe(0)
      const second = recorded(home)
      expect(second).not.toBe(first)
      expect(Option.liftThrowable(() => process.kill(first, 0))()).toEqual(Option.none())
    }),
  )
})
