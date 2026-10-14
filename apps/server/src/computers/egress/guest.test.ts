import { describe, expect, it } from '@effect/vitest'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeNet from 'node:net'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { Effect, Option, Schema } from 'effect'
import { startCommand } from './guest.ts'

/**
 * The command that puts the egress proxy on a Computer and starts it (`guest.ts`), run for real
 * by a real shell, in a home of its own and on ports of its own.
 */
const proxyFile = NodeURL.fileURLToPath(new URL('./proxy.mjs', import.meta.url))

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
  it.live(
    'started twice at the same moment, both succeed and one proxy runs',
    () =>
      Effect.gen(function* () {
        // Many times over, each in a home of its own: a race shows itself only sometimes.
        for (let round = 0; round < 8; round += 1) {
          const home = yield* Effect.acquireRelease(
            Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-egress-'))),
            (directory) =>
              Effect.sync(() => {
                Option.map(Option.liftThrowable(() => recorded(directory))(), (pid) =>
                  Option.liftThrowable(() => process.kill(pid))(),
                )
                NodeFS.rmSync(directory, { recursive: true, force: true })
              }),
          )
          const ports = { tunnel: yield* freePort, proxy: yield* freePort }
          const command = startCommand(NodeFS.readFileSync(proxyFile, 'utf8'), ports)
          const codes = yield* Effect.all([start(home, command), start(home, command)], {
            concurrency: 'unbounded',
          })
          expect(codes).toEqual([0, 0])
          // The one that holds the ports is the one on record, and it is the whole text.
          const pid = recorded(home)
          expect(Option.liftThrowable(() => process.kill(pid, 0))()).toEqual(Option.some(true))
          const files = NodeFS.readdirSync(NodePath.join(home, '.local/share/vivid/computer'))
          expect(files.filter((name) => name.endsWith('.new'))).toEqual([])
          const file = files.find((name) => name.endsWith('.mjs'))
          expect(
            NodeFS.readFileSync(
              NodePath.join(home, '.local/share/vivid/computer', file ?? ''),
              'utf8',
            ),
          ).toBe(`${NodeFS.readFileSync(proxyFile, 'utf8')}\n`)
        }
      }),
    60_000,
  )
})
